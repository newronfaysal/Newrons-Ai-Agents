import crypto from "node:crypto";
import {
  DEFAULT_ROUTING_SETTINGS,
  DEFAULT_RULES,
  DEPARTMENTS,
  RoutingRule,
  RoutingSettings,
  classifyActivity,
  classifyPrompt,
  departmentName,
  redact,
  safeRegex,
  type DepartmentId,
  type DepartmentState,
  type DepartmentStatus,
  type NormalizedEvent,
  type ProjectKind,
  type RoutingDecision,
  type WsMessage,
} from "@ai-office/shared";
import { tx, type DB } from "./db.js";
import type { AgentRegistry } from "./registry.js";

/**
 * Task Router: turns real Claude Code events into work items and department states.
 *
 *  - Runs only on events that were accepted (deduplicated) and persisted by the Ingestor.
 *  - Never ingests events itself, never calls a model, never launches agents, never executes commands.
 *    (Loop protection: a re-entrant call is refused and logged.)
 *  - Prompt text is classified in memory and dropped. Only rule ids, rule keywords and the prompt length are stored.
 *  - One Claude session = one avatar. The router moves that avatar to the department currently responsible; it
 *    does not invent extra workers.
 */

export interface RouterInput {
  event: NormalizedEvent;
  /** Present only for prompt.submit when the hook forwarded it. Never persisted. */
  promptText: string | null;
  /** Shell command text for tool events. Never persisted by the router. */
  command: string | null;
  projectKind: ProjectKind | null;
}

type Notify = (
  level: "info" | "success" | "warning" | "error" | "attention",
  title: string,
  body: string,
  refType: string | null,
  refId: string | null,
) => void;

export const OPEN_STATUSES = [
  "planning",
  "pending_approval",
  "assigned",
  "in_progress",
  "testing",
  "blocked",
  "revision",
  "awaiting_verification",
  "waiting",
  "error",
] as const;
export const CLOSED_STATUSES = [
  "completed",
  "accepted",
  "interrupted",
  "unknown",
  "superseded",
  "cancelled",
] as const;
export type ItemStatus = (typeof OPEN_STATUSES)[number] | (typeof CLOSED_STATUSES)[number];
const isOpen = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);

export interface ItemRow {
  id: string;
  source_event_id: string | null;
  session_id: string | null;
  project_id: string | null;
  task_id: string | null;
  title: string;
  intent: string;
  status: ItemStatus;
  turn: "running" | "ended";
  current_department: DepartmentId | null;
  decision: string;
  prompt_length: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_event_at: string;
  closed_at: string | null;
  close_reason: string | null;
}
export interface Evidence {
  eventId: string;
  correlationId: string | null;
  at: string;
  kind: "test-run" | "verification" | "note";
  result: "running" | "passed" | "failed" | "interrupted";
  summary: string;
}
export interface StageRow {
  work_item_id: string;
  department_id: DepartmentId;
  role: "coordinator" | "producer" | "verifier" | "support";
  state: DepartmentState;
  reason: string;
  rule_id: string | null;
  approved: number;
  activity_seen: number;
  qa_result: Evidence["result"] | null;
  evidence: string;
  sort_order: number;
  since: string;
  last_event_at: string | null;
}

const ACTIVE: DepartmentState[] = ["planning", "working", "testing", "reviewing", "blocked"];
/** Live activity first, then attention, results and queues. */
const PRECEDENCE: DepartmentState[] = [
  "blocked",
  "testing",
  "working",
  "reviewing",
  "planning",
  "error",
  "assigned",
  "waiting",
  "completed",
];

const nowIso = () => new Date().toISOString();
const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`;

export class TaskRouter {
  private broadcast: (m: WsMessage) => void = () => {};
  private busy = false;
  private rulesCache: RoutingRule[] | null = null;
  private settingsCache: RoutingSettings | null = null;
  private lastDeptHash = "";

  constructor(
    private db: DB,
    private registry: AgentRegistry,
    private notify: Notify,
  ) {
    this.seedRules();
  }

  setBroadcast(fn: (m: WsMessage) => void) {
    this.broadcast = fn;
  }

  // ------------------------------------------------------------------ rules & settings

  seedRules(): void {
    const t = nowIso();
    tx(this.db, () => {
      for (const r of DEFAULT_RULES)
        this.db
          .prepare(
            `INSERT OR IGNORE INTO routing_rules(id,name,description,department_id,trigger_type,keywords,context_words,priority,enabled,conditions,action,builtin,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          )
          .run(
            r.id,
            r.name,
            r.description,
            r.departmentId,
            r.triggerType,
            JSON.stringify(r.keywords),
            JSON.stringify(r.contextWords),
            r.priority,
            r.enabled ? 1 : 0,
            JSON.stringify(r.conditions),
            JSON.stringify(r.action),
            t,
            t,
          );
    });
    this.rulesCache = null;
  }

  rules(): RoutingRule[] {
    if (this.rulesCache) return this.rulesCache;
    const rows = this.db
      .prepare("SELECT * FROM routing_rules ORDER BY trigger_type DESC, priority DESC, id")
      .all() as Record<string, unknown>[];
    const out: RoutingRule[] = [];
    for (const r of rows) {
      const parsed = RoutingRule.safeParse({
        id: r.id,
        name: r.name,
        description: r.description,
        departmentId: r.department_id,
        triggerType: r.trigger_type,
        keywords: JSON.parse(String(r.keywords)),
        contextWords: JSON.parse(String(r.context_words)),
        priority: Number(r.priority),
        enabled: !!r.enabled,
        conditions: JSON.parse(String(r.conditions)),
        action: JSON.parse(String(r.action)),
        builtin: !!r.builtin,
        lastTriggeredAt: r.last_triggered_at ?? null,
        lastSourceEventId: r.last_source_event_id ?? null,
      });
      if (parsed.success) out.push(parsed.data);
    }
    this.rulesCache = out;
    return out;
  }

  /** Validate and store a rule (create or replace). Activity regexes must compile. */
  saveRule(input: RoutingRule, actor: "user" = "user"): RoutingRule {
    if (input.triggerType === "activity") {
      const bad = input.keywords.find((k) => !safeRegex(k));
      if (bad) throw Object.assign(new Error(`Invalid pattern: ${bad}`), { statusCode: 400 });
      if (!input.conditions.activity)
        throw Object.assign(new Error("Activity rules need an activity kind"), { statusCode: 400 });
    }
    const t = nowIso();
    const existing = this.db.prepare("SELECT builtin FROM routing_rules WHERE id=?").get(input.id) as
      { builtin: number } | undefined;
    this.db
      .prepare(
        `INSERT INTO routing_rules(id,name,description,department_id,trigger_type,keywords,context_words,priority,enabled,conditions,action,builtin,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, department_id=excluded.department_id,
           trigger_type=excluded.trigger_type, keywords=excluded.keywords, context_words=excluded.context_words, priority=excluded.priority,
           enabled=excluded.enabled, conditions=excluded.conditions, action=excluded.action, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        input.departmentId,
        input.triggerType,
        JSON.stringify([...new Set(input.keywords)]),
        JSON.stringify([...new Set(input.contextWords)]),
        input.priority,
        input.enabled ? 1 : 0,
        JSON.stringify(input.conditions),
        JSON.stringify(input.action),
        existing?.builtin ?? 0,
        t,
        t,
      );
    this.rulesCache = null;
    this.log({
      kind: "rule",
      actor,
      ruleId: input.id,
      summary: `Rule "${input.name}" ${existing ? "updated" : "created"}`,
    });
    this.changed(`Rule ${input.id} saved`);
    return this.rules().find((r) => r.id === input.id)!;
  }

  /** Custom rules are deleted; built-in rules can only be disabled (so a reset can restore them). */
  deleteRule(id: string): "deleted" | "builtin" | "not_found" {
    const r = this.db.prepare("SELECT builtin, name FROM routing_rules WHERE id=?").get(id) as
      { builtin: number; name: string } | undefined;
    if (!r) return "not_found";
    if (r.builtin) return "builtin";
    this.db.prepare("DELETE FROM routing_rules WHERE id=?").run(id);
    this.rulesCache = null;
    this.log({ kind: "rule", actor: "user", ruleId: id, summary: `Rule "${r.name}" deleted` });
    this.changed(`Rule ${id} deleted`);
    return "deleted";
  }

  /** Restore built-in rules to their defaults. Custom rules are kept. */
  resetBuiltinRules(): void {
    tx(this.db, () => this.db.prepare("DELETE FROM routing_rules WHERE builtin=1").run());
    this.seedRules();
    this.log({ kind: "rule", actor: "user", summary: "Built-in rules restored to defaults" });
    this.changed("Built-in rules reset");
  }

  settings(): RoutingSettings {
    if (this.settingsCache) return this.settingsCache;
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key='routing.settings'").get() as
      { value: string } | undefined;
    let s = DEFAULT_ROUTING_SETTINGS;
    if (row) {
      try {
        const p = RoutingSettings.safeParse({ ...DEFAULT_ROUTING_SETTINGS, ...JSON.parse(row.value) });
        if (p.success) s = p.data;
      } catch {
        /* corrupt settings fall back to defaults */
      }
    }
    this.settingsCache = s;
    return s;
  }

  saveSettings(patch: Partial<RoutingSettings>): RoutingSettings {
    const merged = RoutingSettings.parse({ ...this.settings(), ...patch });
    if (new Set(merged.departmentPriority).size !== 4)
      throw Object.assign(new Error("departmentPriority must list each department once"), {
        statusCode: 400,
      });
    this.db
      .prepare(
        "INSERT INTO app_settings(key,value,updated_at) VALUES ('routing.settings',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .run(JSON.stringify(merged), nowIso());
    this.settingsCache = null;
    this.log({
      kind: "settings",
      actor: "user",
      summary: `Automation settings changed: ${Object.keys(patch).join(", ")}`,
    });
    this.changed("Settings saved");
    this.publishDepartments(true);
    return merged;
  }

  /** Dry run for the "Test prompt" tool. No side effects, nothing stored. */
  test(prompt: string, projectKind: ProjectKind | null = null): RoutingDecision {
    return classifyPrompt(prompt, this.rules(), this.settings(), { projectKind });
  }

  // ------------------------------------------------------------------ event handling

  handle(input: RouterInput): void {
    const e = input.event;
    if (e.sourceType === "demo" || !e.sessionId) return;
    if (this.busy) {
      this.log({
        kind: "error",
        sessionId: e.sessionId,
        sourceEventId: e.eventId,
        summary: "Re-entrant routing call refused (loop protection)",
      });
      return;
    }
    this.busy = true;
    let touched = false;
    try {
      const projectKind = input.projectKind ?? this.projectKind(e.projectId);
      touched = tx(this.db, () => this.dispatch(e, input, projectKind));
    } catch (err) {
      // Routing must never break ingestion: record and continue.
      try {
        this.log({
          kind: "error",
          sessionId: e.sessionId,
          sourceEventId: e.eventId,
          summary: `Routing failed for ${e.eventType}: ${redact(String((err as Error)?.message ?? err), 200)}`,
        });
      } catch {
        /* ignore */
      }
    } finally {
      this.busy = false;
    }
    if (touched) {
      this.changed(e.eventType);
      this.publishDepartments(true);
    }
  }

  private dispatch(e: NormalizedEvent, input: RouterInput, kind: ProjectKind | null): boolean {
    switch (e.eventType) {
      case "prompt.submit":
        return this.onPrompt(e, input.promptText, kind);
      case "tool.pre":
        return this.onToolPre(e, input.command, kind);
      case "tool.post":
      case "tool.failure":
        return this.onToolPost(e);
      case "subagent.start":
      case "subagent.stop":
        return this.onSubagent(e);
      case "permission.request":
        return this.onAttention(e);
      case "notification":
        return e.status === "needs_attention" ? this.onAttention(e) : this.touch(e);
      case "stop":
        return this.onStop(e);
      case "stop.failure":
        return this.onStopFailure(e);
      case "session.end":
        return this.onSessionEnd(e);
      default:
        return this.touch(e);
    }
  }

  private projectKind(projectId: string | null): ProjectKind | null {
    if (!projectId) return null;
    const r = this.db.prepare("SELECT kind FROM projects WHERE id=?").get(projectId) as
      { kind: ProjectKind } | undefined;
    return r?.kind ?? null;
  }

  private current(sessionId: string): ItemRow | null {
    const r = this.db
      .prepare("SELECT * FROM work_items WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(sessionId) as ItemRow | undefined;
    return r && isOpen(r.status) ? r : null;
  }

  stages(itemId: string): StageRow[] {
    return this.db
      .prepare("SELECT * FROM work_item_stages WHERE work_item_id=? ORDER BY sort_order")
      .all(itemId) as unknown as StageRow[];
  }

  private stage(itemId: string, dept: DepartmentId): StageRow | undefined {
    return this.db
      .prepare("SELECT * FROM work_item_stages WHERE work_item_id=? AND department_id=?")
      .get(itemId, dept) as StageRow | undefined;
  }

  private primary(itemId: string): DepartmentId {
    const st = this.stages(itemId);
    return (
      st.find((s) => s.role === "producer")?.department_id ??
      st.find((s) => s.role === "verifier")?.department_id ??
      "planning"
    );
  }

  private setStage(
    item: ItemRow,
    dept: DepartmentId,
    state: DepartmentState,
    reason: string,
    at: string,
    extra: { activity?: boolean; eventId?: string | null; ruleId?: string | null } = {},
  ): void {
    const cur = this.stage(item.id, dept);
    if (!cur) return;
    const changedState = cur.state !== state;
    this.db
      .prepare(
        `UPDATE work_item_stages SET state=?, reason=?, since=CASE WHEN state<>? THEN ? ELSE since END, last_event_at=?,
           activity_seen=MAX(activity_seen, ?) WHERE work_item_id=? AND department_id=?`,
      )
      .run(state, redact(reason, 200), state, at, at, extra.activity ? 1 : 0, item.id, dept);
    if (changedState)
      this.log({
        kind: "state",
        itemId: item.id,
        sessionId: item.session_id,
        dept,
        from: cur.state,
        to: state,
        sourceEventId: extra.eventId ?? null,
        ruleId: extra.ruleId ?? null,
        summary: `${departmentName(dept)}: ${cur.state} → ${state} (${redact(reason, 120)})`,
      });
  }

  /** Insert a stage unless the department already has one on this item (UNIQUE prevents duplicates). */
  private addStage(
    item: ItemRow,
    dept: DepartmentId,
    role: StageRow["role"],
    state: DepartmentState,
    reason: string,
    at: string,
    ruleId: string | null,
    approved: boolean,
    eventId: string | null,
  ): boolean {
    const order = (
      this.db.prepare("SELECT COUNT(*) AS n FROM work_item_stages WHERE work_item_id=?").get(item.id) as {
        n: number;
      }
    ).n;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO work_item_stages(work_item_id,department_id,role,state,reason,rule_id,approved,sort_order,since,last_event_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(item.id, dept, role, state, redact(reason, 200), ruleId, approved ? 1 : 0, Number(order), at, at);
    if (Number(r.changes))
      this.log({
        kind: "assign",
        itemId: item.id,
        sessionId: item.session_id,
        dept,
        to: state,
        ruleId,
        sourceEventId: eventId,
        summary: `${departmentName(dept)} ${approved ? "assigned" : "proposed (awaiting approval)"}: ${redact(reason, 160)}`,
      });
    return Number(r.changes) > 0;
  }

  private updateItem(item: ItemRow, patch: Partial<ItemRow>, at: string): ItemRow {
    const next = { ...item, ...patch, updated_at: at, last_event_at: at };
    this.db
      .prepare(
        `UPDATE work_items SET status=?, turn=?, current_department=?, task_id=?, version=?, title=?, intent=?, decision=?,
           updated_at=?, last_event_at=MAX(last_event_at, ?), closed_at=?, close_reason=? WHERE id=?`,
      )
      .run(
        next.status,
        next.turn,
        next.current_department,
        next.task_id,
        next.version,
        next.title,
        next.intent,
        next.decision,
        at,
        at,
        next.closed_at,
        next.close_reason,
        item.id,
      );
    if (patch.status && patch.status !== item.status)
      this.log({
        kind: isOpen(patch.status) ? "state" : "close",
        itemId: item.id,
        sessionId: item.session_id,
        from: item.status,
        to: patch.status,
        summary: `Task "${item.title}": ${item.status} → ${patch.status}${patch.close_reason ? ` (${patch.close_reason})` : ""}`,
      });
    return next;
  }

  private close(
    item: ItemRow,
    status: (typeof CLOSED_STATUSES)[number],
    reason: string,
    at: string,
  ): ItemRow {
    return this.updateItem(
      item,
      { status, closed_at: at, close_reason: redact(reason, 200), turn: "ended" },
      at,
    );
  }

  private moveAgent(e: NormalizedEvent, dept: DepartmentId): void {
    const id =
      e.agentId && (e.agentId.startsWith("sess:") || !this.registry.get(e.agentId)?.roleId)
        ? e.agentId
        : null;
    if (id) this.registry.setDepartment(id, dept);
  }

  private activeTaskFor(sessionId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT task_id FROM task_assignments WHERE session_id=? AND released_at IS NULL ORDER BY assigned_at DESC LIMIT 1",
      )
      .get(sessionId) as { task_id: string } | undefined;
    return r?.task_id ?? null;
  }

  private titleFor(d: RoutingDecision): string {
    const first = d.matches[0];
    const route = d.departments.map(departmentName).join(" → ");
    if (d.intent === "unavailable") return "Prompt (not classified)";
    if (d.intent === "inquiry") return "Research / planning request";
    if (!first) return "Request (no clear department)";
    const kw =
      first.how === "explicit"
        ? "Assigned"
        : first.how === "project-context"
          ? "Project work"
          : `"${first.keyword}"`;
    return redact(`${kw} request · ${route}`, 160);
  }

  private createItem(
    e: NormalizedEvent,
    d: RoutingDecision,
    opts: { intent?: string; title?: string; planningState?: DepartmentState } = {},
  ): ItemRow | null {
    const s = this.settings();
    const approval = s.assignmentMode === "approval";
    const at = e.timestamp;
    const id = "wi_" + crypto.randomUUID();
    const hasWork = d.departments.length > 1;
    const status: ItemStatus = hasWork ? (approval ? "pending_approval" : "assigned") : "planning";
    const decisionJson = JSON.stringify({
      intent: d.intent,
      departments: d.departments,
      matches: d.matches,
      suppressed: d.suppressed.slice(0, 30),
      suggestions: d.suggestions,
      explicit: d.explicit,
      complex: d.complex,
      explanation: d.explanation,
    });
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO work_items(id,source_event_id,session_id,project_id,task_id,title,intent,status,turn,current_department,decision,prompt_length,created_at,updated_at,last_event_at)
         VALUES (?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?)`,
      )
      .run(
        id,
        e.eventId,
        e.sessionId,
        e.projectId,
        this.activeTaskFor(e.sessionId!),
        opts.title ?? this.titleFor(d),
        opts.intent ?? d.intent,
        status,
        "planning",
        decisionJson,
        typeof e.safeMetadata.promptLength === "number" ? e.safeMetadata.promptLength : null,
        at,
        at,
        at,
      );
    if (!Number(r.changes)) return null; // same prompt event already routed
    const item = this.db.prepare("SELECT * FROM work_items WHERE id=?").get(id) as unknown as ItemRow;
    this.log({
      kind: "decision",
      itemId: id,
      sessionId: e.sessionId,
      dept: "planning",
      sourceEventId: e.eventId,
      summary: redact(
        `${d.explanation}${d.matches.length ? ` · matched ${d.matches.map((m) => `"${m.keyword}"→${m.departmentId}`).join(", ")}` : ""}${
          d.suppressed.length ? ` · ignored ${d.suppressed.length} trigger word(s)` : ""
        }`,
        300,
      ),
    });
    for (const st of d.stages) {
      const isPlanning = st.departmentId === "planning";
      this.addStage(
        item,
        st.departmentId,
        st.role,
        isPlanning ? (opts.planningState ?? "planning") : approval ? "waiting" : "assigned",
        isPlanning
          ? hasWork
            ? "Classified the request and delegated it"
            : "Handling the request"
          : approval
            ? `Awaiting your approval · ${st.reason}`
            : st.reason,
        at,
        st.ruleId,
        isPlanning || !approval,
        e.eventId,
      );
    }
    if (d.complex)
      this.log({
        kind: "decision",
        itemId: id,
        sessionId: e.sessionId,
        summary:
          "Complex request. No Planning Agent was launched: no supported execution method is configured, so it was routed deterministically.",
      });
    const ids = [...new Set(d.matches.map((m) => m.ruleId).filter((x): x is string => !!x))];
    for (const rid of ids)
      this.db
        .prepare("UPDATE routing_rules SET last_triggered_at=?, last_source_event_id=? WHERE id=?")
        .run(at, e.eventId, rid);
    if (ids.length) this.rulesCache = null;
    return item;
  }

  private onPrompt(e: NormalizedEvent, text: string | null, kind: ProjectKind | null): boolean {
    const s = this.settings();
    const sid = e.sessionId!;
    let d: RoutingDecision;
    if (!s.promptClassification || text === null) {
      d = classifyPrompt("", this.rules(), s);
      d.intent = "unavailable";
      d.explanation = !s.promptClassification
        ? "Prompt classification is off: Planning keeps the request."
        : "Prompt text was not available (offline replay or forwarding disabled): Planning keeps the request.";
    } else {
      d = classifyPrompt(text, this.rules(), s, { projectKind: kind });
    }
    const cur = this.current(sid);
    if (cur) {
      const curDepts = this.stages(cur.id).map((x) => x.department_id);
      const producers = d.departments.filter((x) => x !== "planning");
      const continuing =
        d.intent === "continuation" ||
        (cur.turn === "ended" &&
          ["revision", "awaiting_verification", "error", "waiting"].includes(cur.status) &&
          producers.length > 0 &&
          producers.every((x) => curDepts.includes(x)));
      if (continuing) {
        this.continueItem(cur, d, e);
        this.moveAgent(e, "planning");
        return true;
      }
      if (cur.turn === "running")
        this.close(
          cur,
          "superseded",
          "A new prompt arrived before this turn ended; outcome not tracked separately",
          e.timestamp,
        );
    }
    const item = this.createItem(e, d);
    if (!item) return false;
    this.moveAgent(e, "planning");
    return true;
  }

  private continueItem(cur: ItemRow, d: RoutingDecision, e: NormalizedEvent): void {
    const at = e.timestamp;
    const revision = ["revision", "awaiting_verification", "error"].includes(cur.status);
    for (const st of d.stages)
      this.addStage(
        cur,
        st.departmentId,
        st.role,
        "assigned",
        st.reason,
        at,
        st.ruleId,
        this.settings().assignmentMode === "automatic",
        e.eventId,
      );
    for (const st of this.stages(cur.id)) {
      if (st.department_id === "planning")
        this.setStage(cur, "planning", "planning", "Continuing the existing task", at);
      else if (["completed", "waiting", "error"].includes(st.state) && st.approved)
        this.setStage(
          cur,
          st.department_id,
          "assigned",
          revision ? "Revision requested by a new prompt" : "Continued by a new prompt",
          at,
        );
    }
    this.updateItem(
      cur,
      {
        status: "assigned",
        turn: "running",
        version: cur.version + (revision ? 1 : 0),
        current_department: "planning",
      },
      at,
    );
    this.log({
      kind: "decision",
      itemId: cur.id,
      sessionId: cur.session_id,
      sourceEventId: e.eventId,
      summary: `Continued existing task (${d.intent === "continuation" ? "continuation prompt" : "revision of the same departments"})`,
    });
  }

  /** Activity seen without a prompt (hooks installed mid-session, or prompt hook missing). */
  private implicitItem(e: NormalizedEvent, kind: ProjectKind | null): ItemRow | null {
    const d = classifyPrompt("", this.rules(), this.settings());
    if (kind && kind !== "general") {
      const dept: DepartmentId = kind === "video" ? "video" : "dev";
      d.departments.push(dept);
      d.stages.push({
        departmentId: dept,
        role: "producer",
        reason: `Activity in a ${kind} project`,
        ruleId: null,
      });
    }
    d.explanation = "Activity observed without a prompt event; created from the session's project.";
    return this.createItem({ ...e, eventId: `implicit:${e.eventId}` }, d, {
      intent: "observed",
      title: "Observed activity (no prompt seen)",
      planningState: "completed",
    });
  }

  private onToolPre(e: NormalizedEvent, command: string | null, kind: ProjectKind | null): boolean {
    const item = this.current(e.sessionId!) ?? this.implicitItem(e, kind);
    if (!item) return false;
    const s = this.settings();
    const tool = typeof e.safeMetadata.tool === "string" ? e.safeMetadata.tool : null;
    const act = classifyActivity(tool, command, this.rules(), s);
    const stages = this.stages(item.id);
    const agent = e.agentId ? this.registry.get(e.agentId) : undefined;
    const subDept = e.agentId?.startsWith("sub:") && agent?.roleId ? agent.departmentId : null;
    let target: DepartmentId;
    if (act.departmentId && act.kind !== "work") {
      const inScope =
        act.scope === "always" ||
        stages.some((x) => x.department_id === act.departmentId) ||
        (act.departmentId === "video" && kind === "video");
      target = inScope ? act.departmentId : this.primary(item.id);
    } else target = subDept ?? this.primary(item.id);
    if (s.disabledDepartments.includes(target)) target = "planning";

    const at = e.timestamp;
    if (!stages.some((x) => x.department_id === target)) {
      const why =
        act.kind === "test-command"
          ? "QA joined: a real test run was observed"
          : act.kind === "verification-command"
            ? "QA joined: a verification command was observed"
            : act.kind === "media-command"
              ? "Video Editor joined: a media command was observed"
              : `${departmentName(target)} joined: observed work`;
      this.addStage(
        item,
        target,
        target === "qa" ? "verifier" : "support",
        "assigned",
        why,
        at,
        act.ruleId,
        true,
        e.eventId,
      );
      if (act.ruleId)
        this.db
          .prepare("UPDATE routing_rules SET last_triggered_at=?, last_source_event_id=? WHERE id=?")
          .run(at, e.eventId, act.ruleId);
      this.rulesCache = null;
    }
    const st = this.stage(item.id, target)!;
    const verifying = act.kind === "test-command" || act.kind === "verification-command";
    const state: DepartmentState = target === "qa" ? (verifying ? "testing" : "reviewing") : "working";
    const label = redact(e.summary, 140);
    if (!st.approved) {
      this.setStage(item, target, "waiting", `Awaiting your approval (activity observed: ${label})`, at, {
        activity: true,
        eventId: e.eventId,
      });
    } else {
      this.setStage(
        item,
        target,
        state,
        act.kind === "media-command" ? `${label} · progress not measured` : label,
        at,
        {
          activity: true,
          eventId: e.eventId,
          ruleId: act.ruleId,
        },
      );
    }
    if (verifying) {
      const ev: Evidence[] = JSON.parse(this.stage(item.id, target)!.evidence);
      ev.push({
        eventId: e.eventId,
        correlationId: e.correlationId,
        at,
        kind: act.kind === "test-command" ? "test-run" : "verification",
        result: "running",
        summary: label,
      });
      this.db
        .prepare("UPDATE work_item_stages SET evidence=? WHERE work_item_id=? AND department_id=?")
        .run(JSON.stringify(ev.slice(-20)), item.id, target);
      if (e.agentId) this.registry.overrideActivity(e.agentId, "testing");
    }
    // One session executes one thing at a time: the previously active department now waits.
    for (const other of this.stages(item.id))
      if (other.department_id !== target) {
        if (other.department_id === "planning" && other.state === "planning")
          this.setStage(item, "planning", "completed", `Delegated to ${departmentName(target)}`, at);
        else if (["working", "testing", "reviewing"].includes(other.state))
          this.setStage(
            item,
            other.department_id,
            "waiting",
            `Waiting while ${departmentName(target)} works`,
            at,
          );
      }
    const status: ItemStatus =
      item.status === "revision" && target !== "qa"
        ? "revision"
        : state === "testing"
          ? "testing"
          : "in_progress";
    this.updateItem(
      item,
      { status: st.approved ? status : item.status, turn: "running", current_department: target },
      at,
    );
    this.moveAgent(e, target);
    return true;
  }

  private onToolPost(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    if (!item) return false;
    const at = e.timestamp;
    for (const st of this.stages(item.id)) {
      const ev: Evidence[] = JSON.parse(st.evidence);
      const run =
        (e.correlationId && ev.find((x) => x.result === "running" && x.correlationId === e.correlationId)) ||
        (!e.correlationId ? [...ev].reverse().find((x) => x.result === "running") : undefined);
      if (!run) continue;
      const failed = e.eventType === "tool.failure";
      run.result = failed ? (e.safeMetadata.interrupted === true ? "interrupted" : "failed") : "passed";
      this.db
        .prepare(
          "UPDATE work_item_stages SET evidence=?, qa_result=? WHERE work_item_id=? AND department_id=?",
        )
        .run(JSON.stringify(ev), run.result, item.id, st.department_id);
      this.log({
        kind: "evidence",
        itemId: item.id,
        sessionId: item.session_id,
        dept: st.department_id,
        sourceEventId: e.eventId,
        summary: `Observed ${run.kind === "test-run" ? "test run" : "verification"} ${run.result}: ${run.summary}`,
      });
      this.attachEvidence(item, run, at);
      if (run.result === "passed") {
        this.setStage(item, st.department_id, "completed", "Verification passed (observed)", at, {
          eventId: e.eventId,
        });
        this.updateItem(item, { status: "in_progress" }, at);
      } else if (run.result === "interrupted") {
        this.setStage(item, st.department_id, "waiting", "Verification interrupted before it finished", at, {
          eventId: e.eventId,
        });
      } else {
        const owner =
          this.stages(item.id).find((x) => x.role === "producer" && x.department_id !== "qa")
            ?.department_id ?? "planning";
        this.setStage(
          item,
          st.department_id,
          "error",
          `Verification failed; returned to ${departmentName(owner)}`,
          at,
          { eventId: e.eventId },
        );
        this.setStage(item, owner, "assigned", "Returned by QA: verification failed (revision)", at, {
          eventId: e.eventId,
        });
        this.updateItem(item, { status: "revision" }, at);
        this.notify(
          "warning",
          "QA: verification failed",
          `${item.title} was returned to ${departmentName(owner)}`,
          "work_item",
          item.id,
        );
      }
      return true;
    }
    return this.touch(e);
  }

  /** Observed QA evidence is linked to the kanban task (if the session is linked to one). Never moves the task. */
  private attachEvidence(item: ItemRow, run: Evidence, at: string) {
    if (!item.task_id || run.result === "running") return;
    const t = this.db.prepare("SELECT project_id, version FROM tasks WHERE id=?").get(item.task_id) as
      { project_id: string; version: number } | undefined;
    if (!t) return;
    this.db
      .prepare(
        "INSERT INTO artifacts(id,task_id,project_id,kind,label,path,task_version,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "a_" + crypto.randomUUID(),
        item.task_id,
        t.project_id,
        "test-result",
        redact(
          `Observed ${run.kind === "test-run" ? "test run" : "verification"} ${run.result}: ${run.summary}`,
          200,
        ),
        null,
        t.version,
        JSON.stringify({ source: "observed", eventId: run.eventId, workItemId: item.id, result: run.result }),
        at,
      );
  }

  private onSubagent(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    const agent = e.agentId ? this.registry.get(e.agentId) : undefined;
    if (!item || !agent?.roleId) return this.touch(e);
    const dept = agent.departmentId;
    const at = e.timestamp;
    if (e.eventType === "subagent.start") {
      this.addStage(
        item,
        dept,
        dept === "qa" ? "verifier" : "support",
        "assigned",
        `${agent.displayName} subagent started`,
        at,
        null,
        true,
        e.eventId,
      );
      this.setStage(
        item,
        dept,
        dept === "qa" ? "reviewing" : "working",
        `${agent.displayName} subagent running`,
        at,
        { activity: true, eventId: e.eventId },
      );
    } else {
      const st = this.stage(item.id, dept);
      if (st && st.role === "support")
        this.setStage(item, dept, "completed", `${agent.displayName} subagent finished`, at, {
          eventId: e.eventId,
        });
    }
    this.updateItem(item, {}, at);
    return true;
  }

  private onAttention(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    if (!item) return false;
    const dept = item.current_department ?? this.primary(item.id);
    this.setStage(
      item,
      dept,
      "blocked",
      "Waiting for your decision in Claude (permission prompt)",
      e.timestamp,
      { eventId: e.eventId },
    );
    this.updateItem(item, { status: "blocked" }, e.timestamp);
    return true;
  }

  private onStop(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    if (!item || item.turn === "ended") return this.touch(e);
    const at = e.timestamp;
    const stages = this.stages(item.id);
    const planningOnly = stages.every((s) => s.department_id === "planning");
    let qaFailed = false;
    let qaMissing = false;
    let pendingApproval = false;
    let idleProducer = false;
    for (const st of stages) {
      const d = st.department_id;
      if (d === "planning" && st.role === "coordinator") {
        if (["planning", "working", "waiting", "assigned"].includes(st.state))
          this.setStage(
            item,
            d,
            "completed",
            planningOnly ? "Request handled (turn ended)" : "Coordinated; delegation done",
            at,
          );
        continue;
      }
      if (!st.approved) {
        pendingApproval = true;
        continue;
      }
      if (d === "qa" || st.role === "verifier") {
        if (st.qa_result === "passed")
          this.setStage(item, d, "completed", "Verification passed (observed)", at);
        else if (st.qa_result === "failed") qaFailed = true;
        else if (st.role === "verifier") {
          qaMissing = true;
          this.setStage(item, d, "waiting", "Verification required; no completed test run observed yet", at);
        } else if (st.activity_seen) this.setStage(item, d, "completed", "Review finished (turn ended)", at);
        continue;
      }
      if (st.state === "error") continue;
      if (st.state === "assigned" && st.activity_seen && /Returned by QA/.test(st.reason)) continue; // revision still open
      if (st.activity_seen)
        this.setStage(
          item,
          d,
          "completed",
          "Turn ended normally after observed work (outcome not independently verified)",
          at,
        );
      else {
        idleProducer = true;
        this.setStage(item, d, "waiting", "Turn ended with no observed work for this department", at);
      }
    }
    if (qaFailed) this.updateItem(item, { status: "revision", turn: "ended" }, at);
    else if (pendingApproval) this.updateItem(item, { status: "pending_approval", turn: "ended" }, at);
    else if (qaMissing) this.updateItem(item, { status: "awaiting_verification", turn: "ended" }, at);
    else if (idleProducer) this.updateItem(item, { status: "waiting", turn: "ended" }, at);
    else
      this.close(
        item,
        "completed",
        planningOnly
          ? "Turn ended; handled by Planning"
          : "Turn ended; all assigned work observed and finished",
        at,
      );
    return true;
  }

  private onStopFailure(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    if (!item) return false;
    const dept = item.current_department ?? this.primary(item.id);
    this.setStage(item, dept, "error", redact(e.summary, 160), e.timestamp, { eventId: e.eventId });
    this.updateItem(item, { status: "error", turn: "ended" }, e.timestamp);
    return true;
  }

  private onSessionEnd(e: NormalizedEvent): boolean {
    const items = this.db
      .prepare(
        `SELECT * FROM work_items WHERE session_id=? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
      )
      .all(e.sessionId, ...OPEN_STATUSES) as unknown as ItemRow[];
    let any = false;
    for (const item of items) {
      if (item.turn !== "running") continue; // parked items (awaiting verification etc.) keep their history and stay open
      for (const st of this.stages(item.id))
        if (ACTIVE.includes(st.state) || st.state === "assigned")
          this.setStage(
            item,
            st.department_id,
            "error",
            "Session ended before the turn finished",
            e.timestamp,
            { eventId: e.eventId },
          );
      this.close(
        item,
        "interrupted",
        "Session ended unexpectedly; outcome unknown (not assumed complete)",
        e.timestamp,
      );
      this.notify(
        "warning",
        "Task interrupted",
        `${item.title}: the Claude session ended mid-turn`,
        "work_item",
        item.id,
      );
      any = true;
    }
    return any;
  }

  private touch(e: NormalizedEvent): boolean {
    const item = this.current(e.sessionId!);
    if (!item) return false;
    this.db
      .prepare("UPDATE work_items SET last_event_at=MAX(last_event_at, ?) WHERE id=?")
      .run(e.timestamp, item.id);
    if (item.current_department)
      this.db
        .prepare("UPDATE work_item_stages SET last_event_at=? WHERE work_item_id=? AND department_id=?")
        .run(e.timestamp, item.id, item.current_department);
    return false;
  }

  // ------------------------------------------------------------------ manual overrides

  action(
    itemId: string,
    action: "approve" | "accept" | "cancel" | "reassign",
    opts: { departments?: DepartmentId[]; note?: string } = {},
  ): { ok: true } | { ok: false; status: number; error: string } {
    const item = this.db.prepare("SELECT * FROM work_items WHERE id=?").get(itemId) as unknown as
      ItemRow | undefined;
    if (!item) return { ok: false, status: 404, error: "not_found" };
    const at = nowIso();
    const note = opts.note ? ` · ${redact(opts.note, 160)}` : "";
    const done = tx(this.db, () => {
      if (action === "approve") {
        const pending = this.stages(itemId).filter((s) => !s.approved);
        if (!pending.length) return "nothing to approve";
        for (const st of pending) {
          this.db
            .prepare("UPDATE work_item_stages SET approved=1 WHERE work_item_id=? AND department_id=?")
            .run(itemId, st.department_id);
          const recent =
            st.last_event_at && Date.parse(at) - Date.parse(st.last_event_at) < this.settings().inactivityMs;
          this.setStage(
            item,
            st.department_id,
            st.activity_seen && recent && item.turn === "running" ? "working" : "assigned",
            `Approved by you${note}`,
            at,
          );
        }
        if (item.status === "pending_approval")
          this.updateItem(item, { status: item.turn === "running" ? "assigned" : "waiting" }, at);
      } else if (action === "accept") {
        if (!isOpen(item.status)) return "task is already closed";
        const qaFailed = this.stages(itemId).some((s) => s.qa_result === "failed");
        for (const st of this.stages(itemId))
          if (!["completed"].includes(st.state))
            this.setStage(
              item,
              st.department_id,
              "completed",
              qaFailed && st.department_id === "qa"
                ? `Accepted by you despite failed verification${note}`
                : `Accepted by you${note}`,
              at,
            );
        this.close(
          item,
          "accepted",
          qaFailed ? "Outcome accepted by you (verification had failed)" : "Outcome accepted by you",
          at,
        );
      } else if (action === "cancel") {
        if (!isOpen(item.status)) return "task is already closed";
        this.close(item, "cancelled", `Cancelled by you${note}`, at);
      } else {
        const want = [...new Set(opts.departments ?? [])].filter((d) => d !== "planning");
        if (!want.length) return "choose at least one department";
        for (const st of this.stages(itemId))
          if (st.department_id !== "planning" && !want.includes(st.department_id)) {
            this.db
              .prepare("DELETE FROM work_item_stages WHERE work_item_id=? AND department_id=?")
              .run(itemId, st.department_id);
            this.log({
              kind: "override",
              actor: "user",
              itemId,
              dept: st.department_id,
              summary: `${departmentName(st.department_id)} unassigned by you`,
            });
          }
        for (const d of want) {
          const created = this.addStage(
            item,
            d,
            d === "qa" ? "verifier" : "producer",
            "assigned",
            `Assigned by you${note}`,
            at,
            null,
            true,
            null,
          );
          if (!created) this.setStage(item, d, "assigned", `Reassigned by you${note}`, at);
        }
        this.updateItem(
          item,
          {
            status: isOpen(item.status) ? (item.turn === "running" ? "assigned" : "waiting") : "waiting",
            closed_at: null,
            close_reason: null,
          },
          at,
        );
      }
      this.log({
        kind: "override",
        actor: "user",
        itemId,
        sessionId: item.session_id,
        summary: `You chose "${action}" on "${item.title}"${note}`,
      });
      return null;
    });
    if (done) return { ok: false, status: 409, error: done };
    this.changed(`Task ${action}`);
    this.publishDepartments(true);
    return { ok: true };
  }

  /** Called when a session is linked to a kanban task: open work items of that session reference it. */
  linkSession(sessionId: string, taskId: string | null): void {
    this.db
      .prepare(
        `UPDATE work_items SET task_id=? WHERE session_id=? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
      )
      .run(taskId, sessionId, ...OPEN_STATUSES);
    this.changed("Session linked");
  }

  // ------------------------------------------------------------------ time-based handling & derivation

  /** Inactivity handling: silent mid-turn tasks become "unknown" (never "completed"). Returns true if anything changed. */
  tick(now = Date.now()): boolean {
    const s = this.settings();
    const cutoff = new Date(now - s.itemTimeoutMs).toISOString();
    const stale = this.db
      .prepare(
        `SELECT * FROM work_items WHERE turn='running' AND last_event_at < ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
      )
      .all(cutoff, ...OPEN_STATUSES) as unknown as ItemRow[];
    const at = new Date(now).toISOString();
    for (const item of stale)
      tx(this.db, () =>
        this.close(
          item,
          "unknown",
          `No events for ${mins(s.itemTimeoutMs)}; outcome unknown (not assumed complete)`,
          at,
        ),
      );
    if (stale.length) this.changed("Inactivity timeout");
    return this.publishDepartments(false, now) || stale.length > 0;
  }

  departmentStates(now = Date.now()): DepartmentStatus[] {
    const s = this.settings();
    const openCut = new Date(now - s.itemTimeoutMs).toISOString();
    const lingerCut = new Date(now - s.resultLingerMs).toISOString();
    const items = this.db
      .prepare(
        `SELECT * FROM work_items WHERE (closed_at IS NULL AND last_event_at >= ?) OR (closed_at IS NOT NULL AND closed_at >= ?)`,
      )
      .all(openCut, lingerCut) as unknown as ItemRow[];
    const byId = new Map(items.map((i) => [i.id, i]));
    const stages = items.length
      ? (this.db
          .prepare(`SELECT * FROM work_item_stages WHERE work_item_id IN (${items.map(() => "?").join(",")})`)
          .all(...items.map((i) => i.id)) as unknown as StageRow[])
      : [];
    const delegated = new Set(
      stages.filter((x) => x.department_id !== "planning").map((x) => x.work_item_id),
    );
    const liveSession = this.registry
      .snapshot(now)
      .some((a) => a.origin === "observed" && a.freshness === "live");
    return DEPARTMENTS.map(({ id: dept }) => {
      if (s.disabledDepartments.includes(dept))
        return {
          departmentId: dept,
          state: "offline" as const,
          reason: "Switched off in Team Automation settings",
          mode: dept === "planning" ? ("idle" as const) : null,
          workItemIds: [],
          openCount: 0,
          since: null,
          lastEventAt: null,
          stale: false,
        };
      type Cand = {
        state: DepartmentState;
        reason: string;
        item: string;
        since: string;
        last: string | null;
        stale: boolean;
      };
      const cands: Cand[] = [];
      const open = new Set<string>();
      for (const st of stages) {
        if (st.department_id !== dept) continue;
        const item = byId.get(st.work_item_id)!;
        const since = Date.parse(st.since);
        const last = Date.parse(st.last_event_at ?? st.since);
        let state = st.state;
        let reason = st.reason;
        let staleFlag = false;
        if (item.closed_at && !["completed", "error"].includes(state)) continue;
        if (["completed", "error"].includes(state) && now - since > s.resultLingerMs) continue;
        if (!item.closed_at && state !== "completed") open.add(item.id);
        // The "planning" pulse ends once a request has been delegated. A planning-only request that is still in its
        // turn is real planning work and stays visible (the inactivity check below still applies).
        if (
          dept === "planning" &&
          state === "planning" &&
          now - since > s.planningPulseMs &&
          (delegated.has(item.id) || item.turn === "ended")
        )
          continue;
        if (["working", "testing", "reviewing", "planning"].includes(state) && now - last > s.inactivityMs) {
          state = "waiting";
          staleFlag = true;
          reason = `No events for ${mins(now - last)}; state unknown (not assumed finished)`;
        }
        cands.push({
          state,
          reason,
          item: item.id,
          since: st.since,
          last: st.last_event_at,
          stale: staleFlag,
        });
      }
      cands.sort(
        (a, b) =>
          PRECEDENCE.indexOf(a.state) - PRECEDENCE.indexOf(b.state) ||
          (b.last ?? "").localeCompare(a.last ?? ""),
      );
      const top = cands[0];
      const coordinating = dept === "planning" ? items.filter((i) => !i.closed_at).length : open.size;
      let state: DepartmentState = top?.state ?? "available";
      let reason = top?.reason ?? "";
      if (!top)
        reason =
          dept === "planning"
            ? s.promptClassification
              ? coordinating
                ? `Coordinating ${coordinating} open task${coordinating === 1 ? "" : "s"}`
                : "Ready for the next prompt"
              : "Prompt classification is off"
            : "Available";
      if (top && state === "completed" && dept === "planning") {
        state = "available";
        reason = coordinating
          ? `Last request delegated · coordinating ${coordinating} open task${coordinating === 1 ? "" : "s"}`
          : "Last request delegated";
      }
      const mode =
        dept !== "planning"
          ? null
          : state === "planning" || state === "working"
            ? ("active" as const)
            : s.promptClassification && liveSession
              ? ("monitoring" as const)
              : ("idle" as const);
      return {
        departmentId: dept,
        state,
        reason: redact(reason, 300),
        mode,
        workItemIds: [...new Set(cands.map((c) => c.item))].slice(0, 50),
        openCount: coordinating,
        since: top?.since ?? null,
        lastEventAt: top?.last ?? null,
        stale: top?.stale ?? false,
      };
    });
  }

  /** Re-apply the current department of every open task to its session avatar (after a restart). */
  syncAgents(): void {
    const rows = this.db
      .prepare(
        `SELECT session_id, current_department FROM work_items WHERE turn='running' AND status IN (${OPEN_STATUSES.map(() => "?").join(",")}) ORDER BY created_at`,
      )
      .all(...OPEN_STATUSES) as { session_id: string | null; current_department: DepartmentId | null }[];
    for (const r of rows)
      if (r.session_id && r.current_department)
        this.registry.setDepartment(`sess:${r.session_id}`, r.current_department);
  }

  publishDepartments(force: boolean, now = Date.now()): boolean {
    const deps = this.departmentStates(now);
    const h = JSON.stringify(deps.map((d) => [d.departmentId, d.state, d.reason, d.openCount, d.stale]));
    if (!force && h === this.lastDeptHash) return false;
    this.lastDeptHash = h;
    this.broadcast({ type: "departments", departments: deps });
    return true;
  }

  private changed(summary: string) {
    this.broadcast({ type: "routing-changed", summary: redact(summary, 200) });
  }

  // ------------------------------------------------------------------ audit log

  log(l: {
    kind: string;
    summary: string;
    itemId?: string | null;
    sessionId?: string | null;
    dept?: DepartmentId | null;
    from?: string | null;
    to?: string | null;
    ruleId?: string | null;
    sourceEventId?: string | null;
    actor?: "router" | "user";
  }): void {
    this.db
      .prepare(
        `INSERT INTO routing_log(ts,kind,work_item_id,session_id,department_id,from_state,to_state,rule_id,source_event_id,actor,summary)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        nowIso(),
        l.kind,
        l.itemId ?? null,
        l.sessionId ?? null,
        l.dept ?? null,
        l.from ?? null,
        l.to ?? null,
        l.ruleId ?? null,
        l.sourceEventId ?? null,
        l.actor ?? "router",
        redact(l.summary, 300),
      );
  }

  pruneLog(retentionDays: number, now = Date.now()): number {
    const r = this.db
      .prepare("DELETE FROM routing_log WHERE ts < ?")
      .run(new Date(now - retentionDays * 86_400_000).toISOString());
    return Number(r.changes);
  }
}
