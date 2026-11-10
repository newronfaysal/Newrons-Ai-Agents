import crypto from "node:crypto";
import {
  EventInput,
  NormalizedEvent,
  redact,
  type AgentSnapshot,
  type ProjectKind,
  type WsMessage,
} from "@ai-office/shared";
import { tx, type DB } from "./db.js";
import { AgentRegistry, type ApplyContext, type HydrateRow, type RoleRow } from "./registry.js";
import { normalizeHook, type HookPayload } from "./normalize.js";
import { TaskRouter } from "./router.js";

export type Broadcast = (msg: WsMessage) => void;

export interface IngestResult {
  status: "accepted" | "duplicate" | "ignored";
  eventId?: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export class Ingestor {
  readonly registry: AgentRegistry;
  readonly router: TaskRouter;
  private broadcast: Broadcast = () => {};
  captureCommandText: boolean;

  constructor(
    private db: DB,
    opts: { staleAfterMs: number; captureCommandText?: boolean },
  ) {
    this.captureCommandText = opts.captureCommandText ?? false;
    this.registry = new AgentRegistry(() => this.roles(), opts.staleAfterMs);
    this.router = new TaskRouter(db, this.registry, (level, title, body, refType, refId) =>
      this.notify(level, title, body, refType, refId),
    );
  }

  setBroadcast(fn: Broadcast) {
    this.broadcast = fn;
    this.router.setBroadcast(fn);
  }

  roles(): RoleRow[] {
    return (
      this.db
        .prepare(
          "SELECT id, name, department_id, subagent_types FROM role_definitions WHERE enabled=1 ORDER BY sort_order",
        )
        .all() as {
        id: string;
        name: string;
        department_id: RoleRow["departmentId"];
        subagent_types: string;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      departmentId: r.department_id,
      subagentTypes: JSON.parse(r.subagent_types) as string[],
    }));
  }

  /** Restart recovery: rebuild agent state from persisted agents + recent events. Never claims completion for silent sessions. */
  restore(sinceMs = 6 * 3600_000, now = Date.now()): void {
    const since = new Date(now - sinceMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT a.id, a.display_name, a.role_id, a.department_id, a.origin, a.session_id, a.parent_session_id, a.last_event_at, a.ended_at,
                s.project_id,
                (SELECT task_id FROM task_assignments t WHERE t.session_id = a.session_id AND t.released_at IS NULL ORDER BY assigned_at DESC LIMIT 1) AS task_id
         FROM agents a LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.origin <> 'demo' AND a.origin <> 'roster' AND COALESCE(a.last_event_at, a.created_at) >= ?`,
      )
      .all(since) as Record<string, string | null>[];
    const hydrate: HydrateRow[] = rows.map((r) => ({
      id: r.id!,
      displayName: r.display_name!,
      roleId: r.role_id ?? null,
      departmentId: r.department_id as HydrateRow["departmentId"],
      origin: r.origin as HydrateRow["origin"],
      sessionId: r.session_id ?? null,
      parentSessionId: r.parent_session_id ?? null,
      projectId: r.project_id ?? null,
      taskId: r.task_id ?? null,
      lastEventAt: r.last_event_at ?? null,
      endedAt: r.ended_at ?? null,
    }));
    this.registry.hydrate(hydrate);
    const evs = this.db
      .prepare(
        `SELECT * FROM events WHERE source_type <> 'demo' AND agent_id IS NOT NULL AND ts >= ? ORDER BY ts ASC, rowid ASC LIMIT 5000`,
      )
      .all(since) as Record<string, string | null>[];
    for (const r of evs) {
      const event = this.rowToEvent(r);
      this.registry.apply({
        event,
        claudeAgentId: null,
        agentType: null,
        projectId: event.projectId,
        projectKind: null,
        taskId: event.taskId,
        cwdLabel: null,
      });
    }
    // Work items are persisted; put each session avatar back in the department responsible for its open task.
    this.router.syncAgents();
  }

  private rowToEvent(r: Record<string, string | null>): NormalizedEvent {
    return NormalizedEvent.parse({
      eventId: r.event_id,
      timestamp: r.ts,
      sourceType: r.source_type,
      sessionId: r.session_id ?? null,
      parentSessionId: r.parent_session_id ?? null,
      agentId: r.agent_id,
      projectId: r.project_id ?? null,
      taskId: r.task_id ?? null,
      departmentId: r.department_id,
      eventType: r.event_type,
      status: r.status,
      summary: r.summary,
      safeMetadata: JSON.parse(r.safe_metadata ?? "{}"),
      correlationId: r.correlation_id,
    });
  }

  private projectForCwd(cwd: string | null): { id: string; kind: ProjectKind } | null {
    if (!cwd) return null;
    const c = norm(cwd);
    const rows = this.db
      .prepare("SELECT id, kind, folder_path, repo_path FROM projects WHERE archived=0")
      .all() as {
      id: string;
      kind: ProjectKind;
      folder_path: string | null;
      repo_path: string | null;
    }[];
    let best: { id: string; kind: ProjectKind; len: number } | null = null;
    for (const p of rows) {
      for (const f of [p.folder_path, p.repo_path]) {
        if (!f) continue;
        const n = norm(f);
        if ((c === n || c.startsWith(n + "/")) && (!best || n.length > best.len))
          best = { id: p.id, kind: p.kind, len: n.length };
      }
    }
    return best ? { id: best.id, kind: best.kind } : null;
  }

  /** Accepts a payload from the Claude Code hook script. */
  ingestHook(payload: HookPayload, now = new Date()): IngestResult {
    const n = normalizeHook(payload, { captureCommandText: this.captureCommandText }, now);
    if (!n) return { status: "ignored" };
    const session = n.event.sessionId
      ? (this.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(n.event.sessionId) as
          { project_id: string | null } | undefined)
      : undefined;
    let projectId = session?.project_id ?? null;
    let projectKind: ProjectKind | null = null;
    const match = this.projectForCwd(n.cwd);
    if (match && !projectId) projectId = match.id;
    if (projectId) {
      const row = this.db.prepare("SELECT kind FROM projects WHERE id=?").get(projectId) as
        { kind: ProjectKind } | undefined;
      projectKind = row?.kind ?? match?.kind ?? null;
    }
    return this.commit(
      {
        event: { ...n.event, projectId },
        claudeAgentId: n.claudeAgentId,
        agentType: n.agentType,
        projectId,
        projectKind,
        taskId: null,
        cwdLabel: n.cwd ? basename(n.cwd).slice(0, 40) : null,
      },
      { promptText: n.promptText, command: n.command },
    );
  }

  /** Accepts a manual / orchestrated / demo event (POST /api/events). */
  ingestEvent(input: unknown, now = new Date()): IngestResult {
    const parsed = EventInput.parse(input);
    const ts = parsed.timestamp ?? now.toISOString();
    const event = NormalizedEvent.parse({
      ...parsed,
      eventId: parsed.eventId ?? "e_" + crypto.randomUUID(),
      timestamp: ts,
    });
    const clean: NormalizedEvent = {
      ...event,
      summary: redact(event.summary, 300),
      safeMetadata: Object.fromEntries(
        Object.entries(event.safeMetadata).map(([k, v]) => [k, typeof v === "string" ? redact(v, 200) : v]),
      ),
    };
    return this.commit({
      event: clean,
      claudeAgentId: null,
      agentType: null,
      projectId: clean.projectId,
      projectKind: null,
      taskId: clean.taskId,
      cwdLabel: null,
    });
  }

  private commit(
    ctx: ApplyContext,
    transient: { promptText: string | null; command: string | null } = { promptText: null, command: null },
  ): IngestResult {
    const e0 = ctx.event;
    const persist = e0.sourceType !== "demo"; // demo activity is broadcast-only; it can never pollute real history
    if (persist && this.db.prepare("SELECT 1 FROM events WHERE event_id=?").get(e0.eventId)) {
      return { status: "duplicate", eventId: e0.eventId };
    }
    const agentId = this.registry.resolveAgentId(ctx);
    const event: NormalizedEvent = { ...e0, agentId };
    const changed = this.registry.apply({ ...ctx, event });
    if (persist) {
      let duplicate = false;
      tx(this.db, () => {
        const r = this.db
          .prepare(
            `INSERT OR IGNORE INTO events(event_id, ts, received_at, source_type, session_id, parent_session_id, agent_id, project_id, task_id, department_id, event_type, status, summary, safe_metadata, correlation_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            event.eventId,
            event.timestamp,
            new Date().toISOString(),
            event.sourceType,
            event.sessionId,
            event.parentSessionId,
            agentId,
            event.projectId,
            event.taskId,
            event.departmentId,
            event.eventType,
            event.status,
            event.summary,
            JSON.stringify(event.safeMetadata),
            event.correlationId,
          );
        if (Number(r.changes) === 0) {
          duplicate = true;
          return;
        }
        if (event.sessionId) this.persistSession(event, ctx);
        for (const a of changed) this.persistAgent(a);
        if (event.eventType === "permission.request") {
          this.db
            .prepare(
              "INSERT INTO approvals(id, kind, status, summary, session_id, requested_at) VALUES (?,?,?,?,?,?)",
            )
            .run(
              "ap_" + crypto.randomUUID(),
              "claude-permission",
              "pending",
              event.summary,
              event.sessionId,
              event.timestamp,
            );
          this.notify("attention", "Claude needs permission", event.summary, "session", event.sessionId);
        }
        if (event.eventType === "tool.failure")
          this.notify("warning", "A tool call failed", event.summary, "session", event.sessionId);
        if (event.eventType === "stop.failure")
          this.notify("error", "A session turn failed", event.summary, "session", event.sessionId);
        if (event.eventType === "subagent.stop")
          this.notify("success", "Subagent finished", event.summary, "session", event.sessionId);
      });
      if (duplicate) return { status: "duplicate", eventId: event.eventId };
      // Route only events that were accepted and stored (dedup happens above). Errors are contained in the router.
      this.router.handle({
        event,
        promptText: transient.promptText,
        command: transient.command,
        projectKind: ctx.projectKind,
      });
    }
    this.broadcast({ type: "event", event });
    this.broadcast({ type: "agents", agents: this.registry.snapshot() });
    return { status: "accepted", eventId: event.eventId };
  }

  private persistSession(event: NormalizedEvent, ctx: ApplyContext) {
    const ended = event.eventType === "session.end";
    this.db
      .prepare(
        `INSERT INTO sessions(id, source_type, parent_session_id, project_id, cwd_label, started_at, last_event_at, ended_at, end_reason)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_event_at = MAX(last_event_at, excluded.last_event_at),
           project_id = COALESCE(sessions.project_id, excluded.project_id),
           cwd_label = COALESCE(sessions.cwd_label, excluded.cwd_label),
           ended_at = COALESCE(excluded.ended_at, CASE WHEN excluded.last_event_at > sessions.last_event_at THEN NULL ELSE sessions.ended_at END),
           end_reason = COALESCE(excluded.end_reason, sessions.end_reason)`,
      )
      .run(
        event.sessionId,
        event.sourceType,
        event.parentSessionId,
        ctx.projectId,
        ctx.cwdLabel,
        event.timestamp,
        event.timestamp,
        ended ? event.timestamp : null,
        ended ? event.summary : null,
      );
  }

  private persistAgent(a: AgentSnapshot) {
    if (a.origin === "demo" || a.origin === "roster") return;
    this.db
      .prepare(
        `INSERT INTO agents(id, display_name, role_id, department_id, origin, session_id, parent_session_id, created_at, last_event_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_event_at=excluded.last_event_at, ended_at=excluded.ended_at, department_id=excluded.department_id, role_id=excluded.role_id`,
      )
      .run(
        a.agentId,
        a.displayName,
        a.roleId,
        a.departmentId,
        a.origin,
        a.sessionId,
        a.parentSessionId,
        a.lastEventAt ?? new Date().toISOString(),
        a.lastEventAt,
        a.freshness === "ended" ? a.lastEventAt : null,
      );
  }

  notify(
    level: "info" | "success" | "warning" | "error" | "attention",
    title: string,
    body = "",
    refType: string | null = null,
    refId: string | null = null,
  ) {
    this.db
      .prepare(
        "INSERT INTO notifications(id, level, title, body, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "n_" + crypto.randomUUID(),
        level,
        redact(title, 120),
        redact(body, 300),
        refType,
        refId,
        new Date().toISOString(),
      );
  }
}
