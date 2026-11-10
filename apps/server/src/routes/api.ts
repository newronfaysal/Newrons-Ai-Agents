import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Priority,
  ProjectKind,
  TaskStatus,
  checkTransition,
  suggestedDepartment,
  wouldCreateCycle,
  DepartmentId,
  redact,
} from "@ai-office/shared";
import { tx, type DB } from "../db.js";
import type { Ingestor } from "../ingest.js";
import type { Tokens } from "../security.js";
import { requireAuth } from "../security.js";

const now = () => new Date().toISOString();
const id = (p: string) => `${p}_${crypto.randomUUID()}`;

const ProjectIn = z.object({
  name: z.string().trim().min(1).max(120),
  kind: ProjectKind,
  description: z.string().max(2000).default(""),
  folderPath: z.string().max(500).nullish(),
  repoPath: z.string().max(500).nullish(),
  aspectRatio: z.string().max(20).nullish(),
  outputResolution: z.string().max(20).nullish(),
  targetDurationS: z.number().positive().max(86_400).nullish(),
  frameRate: z.number().positive().max(240).nullish(),
});
const ProjectPatch = ProjectIn.partial().extend({ archived: z.boolean().optional() });

const TaskIn = z.object({
  projectId: z.string(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  acceptanceCriteria: z.string().max(5000).default(""),
  priority: Priority.default("normal"),
  departmentId: DepartmentId.nullish(),
  deadline: z.string().datetime({ offset: true }).nullish(),
  requiresApproval: z.boolean().default(false),
  requiresEvidenceForQa: z.boolean().default(false),
});
const TaskPatch = TaskIn.omit({ projectId: true })
  .partial()
  .extend({ blockedReason: z.string().max(500).nullish() });

const projectRow = (r: Record<string, unknown>) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  description: r.description,
  folderPath: r.folder_path,
  repoPath: r.repo_path,
  aspectRatio: r.aspect_ratio,
  outputResolution: r.output_resolution,
  targetDurationS: r.target_duration_s,
  frameRate: r.frame_rate,
  archived: !!r.archived,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const taskRow = (r: Record<string, unknown>) => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  acceptanceCriteria: r.acceptance_criteria,
  status: r.status,
  priority: r.priority,
  departmentId: r.department_id,
  deadline: r.deadline,
  version: r.version,
  requiresApproval: !!r.requires_approval,
  requiresEvidenceForQa: !!r.requires_evidence_for_qa,
  blockedReason: r.blocked_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

export function registerApi(
  app: FastifyInstance,
  db: DB,
  ingestor: Ingestor,
  tokens: Tokens,
  notifyChange: () => void,
) {
  const write = { preHandler: requireAuth(tokens, ["ui"]) };

  // ---- projects
  app.get("/api/projects", async (req) => {
    const q = z
      .object({
        kind: ProjectKind.optional(),
        q: z.string().optional(),
        archived: z.enum(["0", "1"]).default("0"),
      })
      .parse(req.query);
    const rows = db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS task_total,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='completed') AS task_done
         FROM projects p WHERE p.archived = ? AND (? IS NULL OR p.kind = ?) AND (? IS NULL OR p.name LIKE ? ESCAPE '\\')
         ORDER BY p.updated_at DESC`,
      )
      .all(
        Number(q.archived),
        q.kind ?? null,
        q.kind ?? null,
        q.q ?? null,
        q.q ? `%${q.q.replace(/[%_\\]/g, "\\$&")}%` : null,
      ) as Record<string, unknown>[];
    return rows.map((r) => ({ ...projectRow(r), taskTotal: r.task_total, taskDone: r.task_done }));
  });

  app.post("/api/projects", write, async (req, reply) => {
    const b = ProjectIn.parse(req.body);
    const pid = id("p");
    const t = now();
    db.prepare(
      `INSERT INTO projects(id,name,kind,description,folder_path,repo_path,aspect_ratio,output_resolution,target_duration_s,frame_rate,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      pid,
      b.name,
      b.kind,
      b.description,
      b.folderPath ?? null,
      b.repoPath ?? null,
      b.aspectRatio ?? (b.kind === "video" ? "9:16" : null),
      b.outputResolution ?? (b.kind === "video" ? "1080x1920" : null),
      b.targetDurationS ?? null,
      b.frameRate ?? null,
      t,
      t,
    );
    reply.code(201);
    return projectRow(db.prepare("SELECT * FROM projects WHERE id=?").get(pid) as Record<string, unknown>);
  });

  app.patch("/api/projects/:id", write, async (req, reply) => {
    const { id: pid } = z.object({ id: z.string() }).parse(req.params);
    const b = ProjectPatch.parse(req.body);
    const cur = db.prepare("SELECT * FROM projects WHERE id=?").get(pid) as
      Record<string, unknown> | undefined;
    if (!cur) return reply.code(404).send({ error: "not_found" });
    const m = {
      ...projectRow(cur),
      ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
    } as ReturnType<typeof projectRow> & Record<string, unknown>;
    db.prepare(
      `UPDATE projects SET name=?, kind=?, description=?, folder_path=?, repo_path=?, aspect_ratio=?, output_resolution=?, target_duration_s=?, frame_rate=?, archived=?, updated_at=? WHERE id=?`,
    ).run(
      m.name as string,
      m.kind as string,
      m.description as string,
      (m.folderPath as string) ?? null,
      (m.repoPath as string) ?? null,
      (m.aspectRatio as string) ?? null,
      (m.outputResolution as string) ?? null,
      (m.targetDurationS as number) ?? null,
      (m.frameRate as number) ?? null,
      m.archived ? 1 : 0,
      now(),
      pid,
    );
    return projectRow(db.prepare("SELECT * FROM projects WHERE id=?").get(pid) as Record<string, unknown>);
  });

  // ---- tasks
  app.get("/api/tasks", async (req) => {
    const q = z.object({ projectId: z.string().optional(), status: TaskStatus.optional() }).parse(req.query);
    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR status=?) ORDER BY updated_at DESC LIMIT 1000",
      )
      .all(q.projectId ?? null, q.projectId ?? null, q.status ?? null, q.status ?? null) as Record<
      string,
      unknown
    >[];
    const deps = db.prepare("SELECT task_id, depends_on_task_id FROM task_dependencies").all() as {
      task_id: string;
      depends_on_task_id: string;
    }[];
    return rows.map((r) => ({
      ...taskRow(r),
      dependsOn: deps.filter((d) => d.task_id === r.id).map((d) => d.depends_on_task_id),
    }));
  });

  app.post("/api/tasks", write, async (req, reply) => {
    const b = TaskIn.parse(req.body);
    const proj = db.prepare("SELECT kind FROM projects WHERE id=?").get(b.projectId) as
      { kind: ProjectKind } | undefined;
    if (!proj) return reply.code(404).send({ error: "project_not_found" });
    const tid = id("t");
    const t = now();
    db.prepare(
      `INSERT INTO tasks(id,project_id,title,description,acceptance_criteria,status,priority,department_id,deadline,requires_approval,requires_evidence_for_qa,created_at,updated_at)
       VALUES (?,?,?,?,?,'backlog',?,?,?,?,?,?,?)`,
    ).run(
      tid,
      b.projectId,
      b.title,
      b.description,
      b.acceptanceCriteria,
      b.priority,
      b.departmentId ?? suggestedDepartment(proj.kind, "backlog"),
      b.deadline ?? null,
      b.requiresApproval ? 1 : 0,
      b.requiresEvidenceForQa ? 1 : 0,
      t,
      t,
    );
    notifyChange();
    reply.code(201);
    return taskRow(db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Record<string, unknown>);
  });

  app.patch("/api/tasks/:id", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const b = TaskPatch.parse(req.body);
    const cur = db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Record<string, unknown> | undefined;
    if (!cur) return reply.code(404).send({ error: "not_found" });
    const m = {
      ...taskRow(cur),
      ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
    } as ReturnType<typeof taskRow> & Record<string, unknown>;
    db.prepare(
      `UPDATE tasks SET title=?, description=?, acceptance_criteria=?, priority=?, department_id=?, deadline=?, requires_approval=?, requires_evidence_for_qa=?, blocked_reason=?, updated_at=? WHERE id=?`,
    ).run(
      m.title as string,
      m.description as string,
      m.acceptanceCriteria as string,
      m.priority as string,
      (m.departmentId as string) ?? null,
      (m.deadline as string) ?? null,
      m.requiresApproval ? 1 : 0,
      m.requiresEvidenceForQa ? 1 : 0,
      (m.blockedReason as string) ?? null,
      now(),
      tid,
    );
    notifyChange();
    return taskRow(db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Record<string, unknown>);
  });

  app.delete("/api/tasks/:id", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const r = db.prepare("DELETE FROM tasks WHERE id=?").run(tid);
    if (!Number(r.changes)) return reply.code(404).send({ error: "not_found" });
    notifyChange();
    return reply.code(204).send();
  });

  app.post("/api/tasks/:id/transition", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        to: TaskStatus,
        note: z.string().max(500).default(""),
        blockedReason: z.string().max(500).optional(),
      })
      .parse(req.body);
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Record<string, unknown> | undefined;
    if (!task) return reply.code(404).send({ error: "not_found" });
    const deps = db
      .prepare(
        "SELECT t.status FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=?",
      )
      .all(tid) as { status: z.infer<typeof TaskStatus> }[];
    const lastApproval = db
      .prepare(
        "SELECT status FROM approvals WHERE task_id=? AND kind='task-completion' ORDER BY requested_at DESC LIMIT 1",
      )
      .get(tid) as { status: string } | undefined;
    const evidence = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=?").get(tid) as {
      n: number;
    };
    const res = checkTransition({
      from: task.status as z.infer<typeof TaskStatus>,
      to: b.to,
      requiresApproval: !!task.requires_approval,
      approved: lastApproval?.status === "approved",
      dependencyStatuses: deps.map((d) => d.status),
      hasEvidence: Number(evidence.n) > 0,
      requiresEvidenceForQa: !!task.requires_evidence_for_qa,
    });
    if (!res.ok) return reply.code(409).send({ error: "transition_rejected", reason: res.reason });
    tx(db, () => {
      const t = now();
      const newVersion = b.to === "revision" ? Number(task.version) + 1 : Number(task.version);
      db.prepare(
        "UPDATE tasks SET status=?, version=?, updated_at=?, completed_at=?, blocked_reason=? WHERE id=?",
      ).run(
        b.to,
        newVersion,
        t,
        b.to === "completed" ? t : null,
        b.to === "blocked" ? (b.blockedReason ?? b.note ?? null) : null,
        tid,
      );
      db.prepare(
        "INSERT INTO workflow_transitions(id,task_id,from_status,to_status,actor,note,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(id("wt"), tid, task.status as string, b.to, "user", redact(b.note, 500), t);
      if (b.to === "revision")
        db.prepare(
          "UPDATE approvals SET status='expired' WHERE task_id=? AND status IN ('approved','pending') AND kind='task-completion'",
        ).run(tid);
    });
    ingestor.notify(
      b.to === "completed" ? "success" : "info",
      `Task moved to ${b.to}`,
      String(task.title),
      "task",
      tid,
    );
    notifyChange();
    return taskRow(db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Record<string, unknown>);
  });

  app.post("/api/tasks/:id/dependencies", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const { dependsOnTaskId } = z.object({ dependsOnTaskId: z.string() }).parse(req.body);
    const exists = db
      .prepare("SELECT id, project_id FROM tasks WHERE id IN (?,?)")
      .all(tid, dependsOnTaskId) as { id: string; project_id: string }[];
    if (exists.length !== 2) return reply.code(404).send({ error: "not_found" });
    const edges = new Map<string, string[]>();
    for (const d of db.prepare("SELECT task_id, depends_on_task_id FROM task_dependencies").all() as {
      task_id: string;
      depends_on_task_id: string;
    }[]) {
      edges.set(d.task_id, [...(edges.get(d.task_id) ?? []), d.depends_on_task_id]);
    }
    if (wouldCreateCycle(edges, tid, dependsOnTaskId))
      return reply.code(409).send({ error: "cycle", reason: "That dependency would create a cycle." });
    db.prepare("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_task_id) VALUES (?,?)").run(
      tid,
      dependsOnTaskId,
    );
    notifyChange();
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/tasks/:id/dependencies/:dep", write, async (req, reply) => {
    const p = z.object({ id: z.string(), dep: z.string() }).parse(req.params);
    db.prepare("DELETE FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?").run(p.id, p.dep);
    notifyChange();
    return reply.code(204).send();
  });

  app.get("/api/tasks/:id/history", async (req) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const transitions = db
      .prepare(
        "SELECT from_status, to_status, actor, note, created_at FROM workflow_transitions WHERE task_id=? ORDER BY created_at DESC",
      )
      .all(tid);
    const events = db
      .prepare(
        "SELECT ts, event_type, status, summary, source_type FROM events WHERE task_id=? ORDER BY ts DESC LIMIT 100",
      )
      .all(tid);
    const artifacts = db
      .prepare(
        "SELECT id, kind, label, path, task_version, created_at FROM artifacts WHERE task_id=? ORDER BY created_at DESC",
      )
      .all(tid);
    return { transitions, events, artifacts };
  });

  app.post("/api/tasks/:id/artifacts", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        kind: z.enum([
          "video",
          "subtitle",
          "thumbnail",
          "code",
          "test-result",
          "build-result",
          "report",
          "other",
        ]),
        label: z.string().min(1).max(200),
        path: z.string().max(500).nullish(),
      })
      .parse(req.body);
    const task = db.prepare("SELECT project_id, version FROM tasks WHERE id=?").get(tid) as
      { project_id: string; version: number } | undefined;
    if (!task) return reply.code(404).send({ error: "not_found" });
    const aid = id("a");
    db.prepare(
      "INSERT INTO artifacts(id,task_id,project_id,kind,label,path,task_version,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(aid, tid, task.project_id, b.kind, b.label, b.path ?? null, task.version, now());
    notifyChange();
    return reply.code(201).send({ id: aid });
  });

  // ---- approvals
  app.get("/api/approvals", async (req) => {
    const q = z
      .object({ status: z.enum(["pending", "approved", "rejected", "expired"]).default("pending") })
      .parse(req.query);
    return db
      .prepare("SELECT * FROM approvals WHERE status=? ORDER BY requested_at DESC LIMIT 200")
      .all(q.status);
  });

  app.post("/api/tasks/:id/request-approval", write, async (req, reply) => {
    const { id: tid } = z.object({ id: z.string() }).parse(req.params);
    const task = db.prepare("SELECT title FROM tasks WHERE id=?").get(tid) as { title: string } | undefined;
    if (!task) return reply.code(404).send({ error: "not_found" });
    const existing = db
      .prepare("SELECT id FROM approvals WHERE task_id=? AND kind='task-completion' AND status='pending'")
      .get(tid);
    if (existing) return reply.code(200).send(existing);
    const aid = id("ap");
    db.prepare(
      "INSERT INTO approvals(id, task_id, kind, status, summary, requested_at) VALUES (?,?,?,?,?,?)",
    ).run(aid, tid, "task-completion", "pending", `Approve completion: ${task.title}`, now());
    notifyChange();
    return reply.code(201).send({ id: aid });
  });

  app.post("/api/approvals/:id/decide", write, async (req, reply) => {
    const { id: aid } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(500).default("") })
      .parse(req.body);
    const ap = db.prepare("SELECT kind, status FROM approvals WHERE id=?").get(aid) as
      { kind: string; status: string } | undefined;
    if (!ap) return reply.code(404).send({ error: "not_found" });
    // Claude permission prompts can only be answered inside Claude itself — the dashboard must never decide them.
    if (ap.kind === "claude-permission")
      return reply.code(409).send({
        error: "not_supported",
        reason:
          "Claude permission prompts must be answered in Claude. The dashboard only shows that one is pending.",
      });
    if (ap.status !== "pending") return reply.code(409).send({ error: "already_decided" });
    db.prepare("UPDATE approvals SET status=?, decided_at=?, decision_note=? WHERE id=?").run(
      b.decision,
      now(),
      redact(b.note, 500),
      aid,
    );
    notifyChange();
    return { ok: true };
  });

  app.post("/api/approvals/:id/dismiss", write, async (req, reply) => {
    const { id: aid } = z.object({ id: z.string() }).parse(req.params);
    const r = db
      .prepare(
        "UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND kind='claude-permission' AND status='pending'",
      )
      .run(now(), aid);
    return Number(r.changes) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- notifications
  app.get("/api/notifications", async () =>
    db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all(),
  );
  app.post("/api/notifications/read", write, async () => {
    db.prepare("UPDATE notifications SET read_at=? WHERE read_at IS NULL").run(now());
    return { ok: true };
  });

  // ---- agents, roles, sessions, events, stats
  app.get("/api/agents", async () => ingestor.registry.snapshot());
  app.get("/api/roles", async () => ingestor.roles());
  app.patch("/api/roles/:id", write, async (req, reply) => {
    const { id: rid } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        name: z.string().min(1).max(60).optional(),
        departmentId: DepartmentId.optional(),
        subagentTypes: z.array(z.string().max(60)).max(20).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const cur = db.prepare("SELECT * FROM role_definitions WHERE id=?").get(rid) as
      Record<string, unknown> | undefined;
    if (!cur) return reply.code(404).send({ error: "not_found" });
    db.prepare(
      "UPDATE role_definitions SET name=?, department_id=?, subagent_types=?, enabled=? WHERE id=?",
    ).run(
      b.name ?? (cur.name as string),
      b.departmentId ?? (cur.department_id as string),
      JSON.stringify(b.subagentTypes ?? JSON.parse(cur.subagent_types as string)),
      b.enabled === undefined ? (cur.enabled as number) : b.enabled ? 1 : 0,
      rid,
    );
    return { ok: true };
  });

  app.post("/api/sessions/:id/link", write, async (req, reply) => {
    const { id: sid } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ projectId: z.string().nullable(), taskId: z.string().nullable() }).parse(req.body);
    const s = db.prepare("SELECT id FROM sessions WHERE id=?").get(sid);
    if (!s) return reply.code(404).send({ error: "session_not_found" });
    tx(db, () => {
      db.prepare("UPDATE sessions SET project_id=? WHERE id=?").run(b.projectId, sid);
      db.prepare("UPDATE task_assignments SET released_at=? WHERE session_id=? AND released_at IS NULL").run(
        now(),
        sid,
      );
      if (b.taskId)
        db.prepare("INSERT INTO task_assignments(id, task_id, session_id, assigned_at) VALUES (?,?,?,?)").run(
          id("as"),
          b.taskId,
          sid,
          now(),
        );
    });
    ingestor.registry.setLink(sid, b.projectId, b.taskId);
    ingestor.router.linkSession(sid, b.taskId);
    notifyChange();
    return { ok: true };
  });

  app.get("/api/events", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.string().optional(),
        sessionId: z.string().optional(),
        projectId: z.string().optional(),
      })
      .parse(req.query);
    return db
      .prepare(
        `SELECT event_id AS eventId, ts AS timestamp, source_type AS sourceType, session_id AS sessionId, agent_id AS agentId, project_id AS projectId, task_id AS taskId,
                department_id AS departmentId, event_type AS eventType, status, summary FROM events
         WHERE (? IS NULL OR ts < ?) AND (? IS NULL OR session_id = ?) AND (? IS NULL OR project_id = ?) ORDER BY ts DESC LIMIT ?`,
      )
      .all(
        q.before ?? null,
        q.before ?? null,
        q.sessionId ?? null,
        q.sessionId ?? null,
        q.projectId ?? null,
        q.projectId ?? null,
        q.limit,
      );
  });

  app.get("/api/stats", async () => {
    const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all();
    const evidence = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks t WHERE t.status='completed' AND EXISTS (SELECT 1 FROM artifacts a WHERE a.task_id=t.id)",
      )
      .get() as { n: number };
    const events24h = db
      .prepare("SELECT source_type AS source, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY source_type")
      .all(new Date(Date.now() - 86_400_000).toISOString());
    return { tasksByStatus: byStatus, completedWithEvidence: Number(evidence.n), eventsLast24h: events24h };
  });
}
