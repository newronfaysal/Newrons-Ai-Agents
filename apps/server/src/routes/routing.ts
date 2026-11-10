import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DepartmentId, ProjectKind, RoutingRuleInput, RoutingSettings } from "@ai-office/shared";
import type { DB } from "../db.js";
import type { TaskRouter, ItemRow, StageRow } from "../router.js";
import { OPEN_STATUSES } from "../router.js";
import { requireAuth, type Tokens } from "../security.js";

const itemOut = (i: ItemRow, stages: StageRow[]) => ({
  id: i.id,
  sessionId: i.session_id,
  projectId: i.project_id,
  taskId: i.task_id,
  title: i.title,
  intent: i.intent,
  status: i.status,
  turn: i.turn,
  currentDepartment: i.current_department,
  decision: JSON.parse(i.decision || "{}") as Record<string, unknown>,
  promptLength: i.prompt_length,
  version: i.version,
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  lastEventAt: i.last_event_at,
  closedAt: i.closed_at,
  closeReason: i.close_reason,
  stages: stages.map((s) => ({
    departmentId: s.department_id,
    role: s.role,
    state: s.state,
    reason: s.reason,
    ruleId: s.rule_id,
    approved: !!s.approved,
    activitySeen: !!s.activity_seen,
    qaResult: s.qa_result,
    evidence: JSON.parse(s.evidence || "[]") as unknown[],
    since: s.since,
    lastEventAt: s.last_event_at,
  })),
});

/** Team Automation Rules API. Reads are open (Host/Origin-guarded like the rest); writes need the UI token. */
export function registerRouting(app: FastifyInstance, db: DB, router: TaskRouter, tokens: Tokens) {
  const write = { preHandler: requireAuth(tokens, ["ui"]) };

  app.get("/api/routing/rules", async () => router.rules());

  app.post("/api/routing/rules", write, async (req, reply) => {
    const b = RoutingRuleInput.parse(req.body);
    if (router.rules().some((r) => r.id === b.id))
      return reply.code(409).send({ error: "exists", reason: "A rule with that id exists." });
    reply.code(201);
    return router.saveRule({ ...b, builtin: false, lastTriggeredAt: null, lastSourceEventId: null });
  });

  app.patch("/api/routing/rules/:id", write, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const cur = router.rules().find((r) => r.id === id);
    if (!cur) return reply.code(404).send({ error: "not_found" });
    const patch = RoutingRuleInput.omit({ id: true }).partial().parse(req.body);
    const merged = RoutingRuleInput.parse({
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    if (cur.builtin && merged.triggerType !== cur.triggerType)
      return reply.code(409).send({ error: "builtin", reason: "Built-in rules cannot change trigger type." });
    return router.saveRule({ ...cur, ...merged });
  });

  app.delete("/api/routing/rules/:id", write, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = router.deleteRule(id);
    if (r === "not_found") return reply.code(404).send({ error: "not_found" });
    if (r === "builtin")
      return reply
        .code(409)
        .send({ error: "builtin", reason: "Built-in rules can be disabled, not deleted." });
    return reply.code(204).send();
  });

  app.post("/api/routing/rules/reset", write, async () => {
    router.resetBuiltinRules();
    return { ok: true };
  });

  app.get("/api/routing/settings", async () => router.settings());
  app.patch("/api/routing/settings", write, async (req) =>
    router.saveSettings(RoutingSettings.partial().parse(req.body)),
  );

  // Dry run. The prompt is classified in memory and discarded; nothing is stored or logged.
  app.post("/api/routing/test", write, async (req) => {
    const b = z.object({ prompt: z.string().max(8000), projectKind: ProjectKind.nullish() }).parse(req.body);
    return router.test(b.prompt, b.projectKind ?? null);
  });

  app.get("/api/routing/departments", async () => router.departmentStates());

  app.get("/api/routing/items", async (req) => {
    const q = z
      .object({
        status: z.enum(["open", "all"]).default("all"),
        sessionId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const open = q.status === "open";
    const rows = db
      .prepare(
        `SELECT * FROM work_items WHERE (? = 0 OR status IN (${OPEN_STATUSES.map(() => "?").join(",")}))
           AND (? IS NULL OR session_id = ?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        open ? 1 : 0,
        ...OPEN_STATUSES,
        q.sessionId ?? null,
        q.sessionId ?? null,
        q.limit,
      ) as unknown as ItemRow[];
    return rows.map((r) => itemOut(r, router.stages(r.id)));
  });

  app.post("/api/routing/items/:id/action", write, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        action: z.enum(["approve", "accept", "cancel", "reassign"]),
        departments: z.array(DepartmentId).max(4).optional(),
        note: z.string().max(300).optional(),
      })
      .parse(req.body);
    const r = router.action(id, b.action, { departments: b.departments, note: b.note });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, reason: r.error });
    return { ok: true };
  });

  app.get("/api/routing/log", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100), itemId: z.string().optional() })
      .parse(req.query);
    return db
      .prepare(
        `SELECT id, ts, kind, work_item_id AS workItemId, session_id AS sessionId, department_id AS departmentId, from_state AS fromState,
                to_state AS toState, rule_id AS ruleId, source_event_id AS sourceEventId, actor, summary
         FROM routing_log WHERE (? IS NULL OR work_item_id = ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(q.itemId ?? null, q.itemId ?? null, q.limit);
  });
}
