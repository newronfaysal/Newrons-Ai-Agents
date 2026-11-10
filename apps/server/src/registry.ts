import {
  AgentActivity,
  type AgentSnapshot,
  type DepartmentId,
  type NormalizedEvent,
  type ProjectKind,
} from "@ai-office/shared";

export interface RoleRow {
  id: string;
  name: string;
  departmentId: DepartmentId;
  subagentTypes: string[];
}

export interface ApplyContext {
  event: NormalizedEvent;
  claudeAgentId: string | null;
  agentType: string | null;
  projectId: string | null;
  projectKind: ProjectKind | null;
  taskId: string | null;
  cwdLabel: string | null;
}

export interface HydrateRow {
  id: string;
  displayName: string;
  roleId: string | null;
  departmentId: DepartmentId;
  origin: AgentSnapshot["origin"];
  sessionId: string | null;
  parentSessionId: string | null;
  projectId: string | null;
  taskId: string | null;
  lastEventAt: string | null;
  endedAt: string | null;
}

const ENDED_VISIBLE_MS = 10 * 60_000;
const STALE_DROP_MS = 6 * 3600_000;
const validActivity = (v: unknown): AgentActivity | null => {
  const r = AgentActivity.safeParse(v);
  return r.success ? r.data : null;
};

function kindToDept(kind: ProjectKind | null, fallback: DepartmentId): DepartmentId {
  return kind === "video" ? "video" : kind === "app" ? "dev" : kind === "general" ? "planning" : fallback;
}

export class AgentRegistry {
  private agents = new Map<string, AgentSnapshot>();
  private endedAt = new Map<string, number>();
  constructor(
    private getRoles: () => RoleRow[],
    private staleAfterMs: number,
    private defaultDept: DepartmentId = "planning",
  ) {}

  hydrate(rows: HydrateRow[]): void {
    for (const r of rows) {
      this.agents.set(r.id, {
        agentId: r.id,
        displayName: r.displayName,
        roleId: r.roleId,
        departmentId: r.departmentId,
        origin: r.origin,
        sessionId: r.sessionId,
        parentSessionId: r.parentSessionId,
        projectId: r.projectId,
        taskId: r.taskId,
        activity: "idle",
        lastOperation: null,
        lastEventAt: r.lastEventAt,
        freshness: r.endedAt ? "ended" : "live",
        errorMessage: null,
        recent: [],
      });
      if (r.endedAt) this.endedAt.set(r.id, Date.parse(r.endedAt));
    }
  }

  get(id: string): AgentSnapshot | undefined {
    return this.agents.get(id);
  }

  /** Remove every demo agent (demo events are never persisted). */
  clearOrigin(origin: AgentSnapshot["origin"]): void {
    for (const [id, a] of this.agents) if (a.origin === origin) this.agents.delete(id);
  }

  setLink(sessionId: string, projectId: string | null, taskId: string | null): AgentSnapshot[] {
    const touched: AgentSnapshot[] = [];
    for (const a of this.agents.values()) {
      if (a.sessionId === sessionId) {
        a.projectId = projectId;
        a.taskId = taskId;
        touched.push(a);
      }
    }
    return touched;
  }

  /** Task Router: move an agent to the department currently responsible for its work. Same identity, no new agent. */
  setDepartment(agentId: string, dept: DepartmentId): AgentSnapshot | null {
    const a = this.agents.get(agentId);
    if (!a || a.departmentId === dept) return null;
    a.departmentId = dept;
    return a;
  }

  /** Task Router: a configurable QA rule recognised a test command the built-in activity map did not. */
  overrideActivity(agentId: string, activity: AgentActivity): void {
    const a = this.agents.get(agentId);
    if (a && a.freshness !== "ended") a.activity = activity;
  }

  private roleForSubagent(agentType: string | null): RoleRow | null {
    if (!agentType) return null;
    const t = agentType.toLowerCase();
    return this.getRoles().find((r) => r.subagentTypes.some((s) => s.toLowerCase() === t)) ?? null;
  }

  /** Decide which avatar an event belongs to, creating it if needed. Returns the agent id. */
  resolveAgentId(c: ApplyContext): string | null {
    const e = c.event;
    if (e.agentId) return e.agentId;
    if (!e.sessionId) return null;
    const isSub =
      c.claudeAgentId !== null || e.eventType === "subagent.start" || e.eventType === "subagent.stop";
    if (isSub && c.claudeAgentId) return `sub:${e.sessionId}:${c.claudeAgentId}`;
    return `sess:${e.sessionId}`;
  }

  private ensure(id: string, c: ApplyContext): AgentSnapshot {
    let a = this.agents.get(id);
    if (a) return a;
    const e = c.event;
    const origin = e.sourceType;
    let displayName: string;
    let roleId: string | null = null;
    let dept: DepartmentId;
    if (id.startsWith("sub:")) {
      const role = this.roleForSubagent(c.agentType);
      const parent = this.agents.get(`sess:${e.sessionId}`);
      roleId = role?.id ?? null;
      dept = role?.departmentId ?? parent?.departmentId ?? kindToDept(c.projectKind, this.defaultDept);
      displayName = role ? role.name : c.agentType ? `${c.agentType} subagent` : "Subagent";
    } else if (id.startsWith("sess:")) {
      dept = kindToDept(c.projectKind, this.defaultDept);
      displayName = `Claude · ${c.cwdLabel ?? (e.sessionId ?? "session").slice(0, 8)}`;
    } else {
      const m = e.safeMetadata;
      const role = typeof m.roleId === "string" ? this.getRoles().find((r) => r.id === m.roleId) : undefined;
      roleId = role?.id ?? null;
      dept = e.departmentId ?? role?.departmentId ?? this.defaultDept;
      displayName = typeof m.displayName === "string" ? m.displayName : (role?.name ?? id);
    }
    a = {
      agentId: id,
      displayName,
      roleId,
      departmentId: dept,
      origin,
      sessionId: e.sessionId,
      parentSessionId: id.startsWith("sub:") ? e.sessionId : null,
      projectId:
        c.projectId ??
        (id.startsWith("sub:") ? (this.agents.get(`sess:${e.sessionId}`)?.projectId ?? null) : null),
      taskId: c.taskId,
      activity: "idle",
      lastOperation: null,
      lastEventAt: null,
      freshness: "live",
      errorMessage: null,
      recent: [],
    };
    this.agents.set(id, a);
    return a;
  }

  /** Apply one event. Returns the agents whose state changed. */
  apply(c: ApplyContext): AgentSnapshot[] {
    const e = c.event;
    const id = this.resolveAgentId(c);
    if (!id) return [];
    const a = this.ensure(id, c);
    const changed = new Set<AgentSnapshot>([a]);
    if (c.projectId && !a.projectId) {
      a.projectId = c.projectId;
      if (id.startsWith("sess:")) {
        // A session that was already running when its project appeared moves to the project's department,
        // and its subagents (which have no cwd of their own to match) follow it.
        if (!a.roleId) a.departmentId = kindToDept(c.projectKind, a.departmentId);
        for (const o of this.agents.values()) {
          if (o.parentSessionId === e.sessionId && !o.projectId) {
            o.projectId = c.projectId;
            changed.add(o);
          }
        }
      }
    }
    if (c.taskId && !a.taskId) a.taskId = c.taskId;
    a.lastEventAt = e.timestamp;
    a.recent = [{ at: e.timestamp, type: e.eventType, summary: e.summary }, ...a.recent].slice(0, 20);
    const explicit = validActivity(e.safeMetadata.activity);

    switch (e.eventType) {
      case "session.start":
        a.activity = "idle";
        a.lastOperation = e.summary;
        a.freshness = "live";
        this.endedAt.delete(a.agentId);
        a.errorMessage = null;
        break;
      case "prompt.submit":
        a.activity = "thinking";
        a.lastOperation = e.summary;
        break;
      case "tool.pre":
        a.activity = explicit ?? "thinking";
        a.lastOperation = e.summary;
        break;
      case "tool.post":
        a.activity = "thinking";
        a.lastOperation = e.summary;
        break;
      case "tool.failure":
        a.activity = "thinking";
        a.lastOperation = e.summary;
        a.errorMessage = typeof e.safeMetadata.error === "string" ? e.safeMetadata.error : e.summary;
        break;
      case "subagent.start": {
        a.activity = "thinking";
        a.lastOperation = e.summary;
        break;
      }
      case "subagent.stop":
        a.activity = "finished";
        a.lastOperation = e.summary;
        this.markEnded(a, e.timestamp);
        break;
      case "permission.request":
        a.activity = "needs_attention";
        a.lastOperation = e.summary;
        break;
      case "notification":
        if (e.status === "needs_attention") a.activity = "needs_attention";
        else if (e.safeMetadata.notificationType === "idle_prompt") a.activity = "idle";
        a.lastOperation = e.summary;
        break;
      case "stop":
        a.activity = "idle";
        a.lastOperation = e.summary;
        break;
      case "stop.failure":
        a.activity = "error";
        a.lastOperation = e.summary;
        a.errorMessage = typeof e.safeMetadata.error === "string" ? e.safeMetadata.error : e.summary;
        break;
      case "session.end":
        // ending the session ends the main agent and every subagent of that session
        for (const other of this.agents.values()) {
          if (other.sessionId === e.sessionId && other.origin === a.origin) {
            other.activity = "finished";
            this.markEnded(other, e.timestamp);
            changed.add(other);
          }
        }
        a.lastOperation = e.summary;
        break;
      case "agent.state":
        a.activity = explicit ?? a.activity;
        a.lastOperation = e.summary;
        if (e.status === "failed") a.errorMessage = e.summary;
        if (explicit === "finished") this.markEnded(a, e.timestamp);
        else {
          a.freshness = "live";
          this.endedAt.delete(a.agentId);
        }
        break;
      case "task.created":
      case "task.completed":
      case "task.state":
      case "heartbeat":
        if (e.eventType !== "heartbeat") a.lastOperation = e.summary;
        break;
    }
    if (e.eventType !== "subagent.stop" && e.eventType !== "session.end" && a.freshness !== "ended")
      a.freshness = "live";
    return [...changed];
  }

  private markEnded(a: AgentSnapshot, ts: string) {
    a.freshness = "ended";
    this.endedAt.set(a.agentId, Date.parse(ts));
  }

  /** Visible agents: live/stale/recently-ended real agents + roster seats that no real agent occupies. */
  snapshot(now = Date.now()): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    const occupied = new Set<string>();
    for (const a of this.agents.values()) {
      const last = a.lastEventAt ? Date.parse(a.lastEventAt) : 0;
      const ended = this.endedAt.get(a.agentId);
      if (ended !== undefined) {
        if (now - ended > ENDED_VISIBLE_MS) continue;
        a.freshness = "ended";
      } else {
        if (last && now - last > STALE_DROP_MS) continue;
        a.freshness = last && now - last > this.staleAfterMs ? "stale" : "live";
      }
      out.push({ ...a });
      if (a.roleId && a.freshness !== "ended") occupied.add(a.roleId);
    }
    for (const r of this.getRoles()) {
      if (occupied.has(r.id)) continue;
      out.push({
        agentId: `roster:${r.id}`,
        displayName: r.name,
        roleId: r.id,
        departmentId: r.departmentId,
        origin: "roster",
        sessionId: null,
        parentSessionId: null,
        projectId: null,
        taskId: null,
        activity: "idle",
        lastOperation: null,
        lastEventAt: null,
        freshness: "none",
        errorMessage: null,
        recent: [],
      });
    }
    return out;
  }
}
