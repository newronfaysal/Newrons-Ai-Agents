import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WORKFLOWS, suggestedDepartment } from "@ai-office/shared";
import { api, ApiError, type Project, type Task, type TaskStatus } from "../lib/api";
import { useApprovals, useProjects, useTaskHistory, useTasks } from "../lib/queries";
import { useStore } from "../lib/store";
import { ago } from "../lib/format";

const COLS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "planned", label: "Planned" },
  { id: "in_progress", label: "In Progress" },
  { id: "qa", label: "QA" },
  { id: "revision", label: "Revision" },
  { id: "blocked", label: "Blocked" },
  { id: "completed", label: "Completed" },
];
const PRIO: Record<string, string> = {
  low: "muted",
  normal: "",
  high: "text-[var(--warn)]",
  urgent: "text-[var(--bad)]",
};

export function ProjectsView() {
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projects = useProjects(kind || undefined, q || undefined, archived);
  const project = projects.data?.find((p) => p.id === sel) ?? null;
  return (
    <div className="flex h-full min-h-0">
      <aside
        className="flex w-72 shrink-0 flex-col gap-2 p-3"
        style={{ borderRight: "1px solid var(--line)" }}
      >
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="Search projects"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search projects"
          />
        </div>
        <div className="flex gap-2">
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            <option value="video">Video</option>
            <option value="app">App</option>
            <option value="general">General</option>
          </select>
          <button className="btn" onClick={() => setArchived(!archived)} aria-pressed={archived}>
            {archived ? "Archived" : "Active"}
          </button>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New project
        </button>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {projects.isLoading && <div className="muted text-sm">Loading…</div>}
          {projects.data?.length === 0 && (
            <div className="muted p-2 text-sm">
              {archived
                ? "No archived projects."
                : "No projects yet. Create one to start tracking tasks through Planning, Development or Editing, and QA."}
            </div>
          )}
          {projects.data?.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p.id)}
              className={`panel2 w-full p-2 text-left ${sel === p.id ? "ring-2 ring-[var(--accent)]" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{p.name}</span>
                <span className="badge badge-manual">{p.kind}</span>
              </div>
              <div className="muted mt-0.5 text-xs">
                {p.taskDone ?? 0}/{p.taskTotal ?? 0} tasks completed
              </div>
            </button>
          ))}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-3">
        {creating && (
          <NewProject
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setSel(id);
              setCreating(false);
            }}
          />
        )}
        {!project && !creating && (
          <div className="muted grid h-full place-items-center text-sm">
            Select or create a project to see its board.
          </div>
        )}
        {project && <ProjectBoard project={project} />}
      </section>
    </div>
  );
}

function NewProject({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const qc = useQueryClient();
  const toast = useStore((s) => s.toast);
  const [f, setF] = useState({ name: "", kind: "video", folderPath: "", repoPath: "" });
  const submit = async () => {
    try {
      const p = await api<Project>("POST", "/api/projects", {
        name: f.name,
        kind: f.kind,
        folderPath: f.folderPath || null,
        repoPath: f.repoPath || null,
      });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(p.id);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <div className="panel mb-3 max-w-xl space-y-2 p-4" role="dialog" aria-label="New project">
      <div className="text-base font-semibold">New project</div>
      <input
        className="input"
        placeholder="Name"
        value={f.name}
        onChange={(e) => setF({ ...f, name: e.target.value })}
        aria-label="Project name"
        autoFocus
      />
      <select
        className="input"
        value={f.kind}
        onChange={(e) => setF({ ...f, kind: e.target.value })}
        aria-label="Project type"
      >
        <option value="video">Video (9:16 reel defaults)</option>
        <option value="app">App</option>
        <option value="general">General</option>
      </select>
      <input
        className="input"
        placeholder="Project folder (optional), e.g. C:\Projects\june-reels"
        value={f.folderPath}
        onChange={(e) => setF({ ...f, folderPath: e.target.value })}
        aria-label="Project folder"
      />
      {f.kind === "app" && (
        <input
          className="input"
          placeholder="Git repository path (optional)"
          value={f.repoPath}
          onChange={(e) => setF({ ...f, repoPath: e.target.value })}
          aria-label="Repository path"
        />
      )}
      <p className="muted text-xs">
        Claude sessions whose working directory is inside this folder are automatically labeled with this
        project.
      </p>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={!f.name.trim()} onClick={() => void submit()}>
          Create
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ProjectBoard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const toast = useStore((s) => s.toast);
  const tasks = useTasks(project.id);
  const approvals = useApprovals();
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const wf = WORKFLOWS[project.kind];
  const byStatus = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks.data ?? []) m.set(t.status, [...(m.get(t.status) ?? []), t]);
    return m;
  }, [tasks.data]);
  const done = tasks.data?.filter((t) => t.status === "completed") ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["approvals"] });
  };
  const move = async (id: string, to: TaskStatus) => {
    try {
      await api("POST", `/api/tasks/${id}/transition`, { to });
      refresh();
    } catch (e) {
      toast("warning", e instanceof ApiError ? e.message : "Could not move the task");
    }
  };
  const add = async () => {
    if (!title.trim()) return;
    try {
      await api("POST", "/api/tasks", { projectId: project.id, title: title.trim() });
      setTitle("");
      refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const archive = async () => {
    await api("PATCH", `/api/projects/${project.id}`, { archived: !project.archived });
    refresh();
  };
  const pending =
    approvals.data?.filter(
      (a) => a.kind === "task-completion" && tasks.data?.some((t) => t.id === a.task_id),
    ) ?? [];
  const claudePending = approvals.data?.filter((a) => a.kind === "claude-permission") ?? [];
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        <span className="badge badge-manual">{project.kind}</span>
        {project.kind === "video" && (
          <span className="muted text-xs">
            {project.aspectRatio} · {project.outputResolution}
          </span>
        )}
        <span className="muted text-xs">{project.folderPath ?? "no folder linked"}</span>
        <span className="flex-1" />
        <div className="muted text-xs" title="Progress counts completed tasks only; it is not an estimate.">
          {done.length} of {tasks.data?.length ?? 0} tasks completed
        </div>
        <button className="btn" onClick={() => void archive()}>
          {project.archived ? "Unarchive" : "Archive"}
        </button>
      </header>
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Workflow">
        {wf.map((s, i) => (
          <li key={s.id} className="panel2 px-2 py-1">
            {i + 1}. {s.label}
            {s.departmentId ? (
              <span className="muted"> · {s.departmentId}</span>
            ) : (
              <span className="muted"> · you</span>
            )}
          </li>
        ))}
      </ol>
      {(pending.length > 0 || claudePending.length > 0) && (
        <div className="panel p-3" role="region" aria-label="Approval queue">
          <div className="mb-1 font-semibold">Approval queue</div>
          {pending.map((a) => (
            <div key={a.id} className="flex items-center gap-2 py-1 text-sm">
              <span className="flex-1">{a.summary}</span>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await api("POST", `/api/approvals/${a.id}/decide`, { decision: "approved" });
                  refresh();
                }}
              >
                Approve
              </button>
              <button
                className="btn"
                onClick={async () => {
                  await api("POST", `/api/approvals/${a.id}/decide`, { decision: "rejected" });
                  refresh();
                }}
              >
                Reject
              </button>
            </div>
          ))}
          {claudePending.map((a) => (
            <div key={a.id} className="flex items-center gap-2 py-1 text-sm">
              <span className="badge badge-bad">CLAUDE</span>
              <span className="flex-1">{a.summary}. Answer it in Claude; this dashboard cannot.</span>
              <button
                className="btn"
                onClick={async () => {
                  await api("POST", `/api/approvals/${a.id}/dismiss`);
                  refresh();
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="input max-w-md"
          placeholder="Add a task and press Enter"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          aria-label="New task title"
        />
        <button className="btn" onClick={() => void add()}>
          Add
        </button>
      </div>
      <div
        className="grid gap-2 overflow-x-auto"
        style={{ gridTemplateColumns: "repeat(7, minmax(190px, 1fr))" }}
      >
        {COLS.map((c) => (
          <div
            key={c.id}
            className="panel2 min-h-[160px] p-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("text/task");
              if (id) void move(id, c.id);
            }}
            data-testid={`col-${c.id}`}
          >
            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
              <span>{c.label}</span>
              <span className="muted">{byStatus.get(c.id)?.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {byStatus.get(c.id)?.map((t) => (
                <article
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)}
                  className="panel cursor-grab p-2 text-sm"
                  data-testid="task-card"
                >
                  <button className="w-full text-left" onClick={() => setOpen(t.id)}>
                    <div className="font-medium">{t.title}</div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                      <span className={PRIO[t.priority]}>{t.priority}</span>
                      {t.version > 1 && <span className="badge badge-bad">v{t.version}</span>}
                      {t.dependsOn.length > 0 && <span className="muted">⛓ {t.dependsOn.length}</span>}
                      {t.requiresApproval && <span className="muted">needs approval</span>}
                    </div>
                  </button>
                  <select
                    className="input mt-1.5 !py-0.5 text-xs"
                    value={t.status}
                    onChange={(e) => void move(t.id, e.target.value as TaskStatus)}
                    aria-label={`Move ${t.title}`}
                  >
                    {COLS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
      {open && tasks.data?.find((t) => t.id === open) && (
        <TaskDrawer
          task={tasks.data.find((t) => t.id === open)!}
          project={project}
          all={tasks.data}
          onClose={() => setOpen(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function TaskDrawer({
  task,
  project,
  all,
  onClose,
  onChange,
}: {
  task: Task;
  project: Project;
  all: Task[];
  onClose(): void;
  onChange(): void;
}) {
  const toast = useStore((s) => s.toast);
  const hist = useTaskHistory(task.id);
  const [f, setF] = useState({
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
  });
  const [art, setArt] = useState({ kind: "video", label: "", path: "" });
  const sugg = suggestedDepartment(project.kind, task.status);
  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
      void hist.refetch();
    } catch (e) {
      toast("warning", (e as Error).message);
    }
  };
  return (
    <aside
      className="panel fixed bottom-3 right-3 top-3 z-40 flex w-[400px] flex-col overflow-hidden text-sm shadow-2xl"
      role="dialog"
      aria-label="Task details"
    >
      <header className="flex items-center gap-2 p-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <div className="flex-1 font-semibold">
          Task · {task.status.replace("_", " ")} · v{task.version}
        </div>
        <button className="btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <input
          className="input"
          value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })}
          aria-label="Title"
        />
        <textarea
          className="input"
          rows={3}
          placeholder="Description"
          value={f.description}
          onChange={(e) => setF({ ...f, description: e.target.value })}
        />
        <textarea
          className="input"
          rows={3}
          placeholder="Acceptance criteria (what QA verifies)"
          value={f.acceptanceCriteria}
          onChange={(e) => setF({ ...f, acceptanceCriteria: e.target.value })}
        />
        <div className="flex gap-2">
          <button
            className="btn btn-primary"
            onClick={() => void wrap(() => api("PATCH", `/api/tasks/${task.id}`, f))}
          >
            Save
          </button>
          <button
            className="btn"
            onClick={() =>
              void wrap(async () => {
                await api("DELETE", `/api/tasks/${task.id}`);
                onClose();
              })
            }
          >
            Delete
          </button>
        </div>
        <div className="panel2 p-2 text-xs">
          Suggested owner for this stage: <strong>{sugg}</strong>. Suggestions never move tasks automatically;
          observed Claude sessions cannot be controlled from here.
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={task.requiresApproval}
            onChange={(e) =>
              void wrap(() => api("PATCH", `/api/tasks/${task.id}`, { requiresApproval: e.target.checked }))
            }
          />{" "}
          Requires human approval to complete
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={task.requiresEvidenceForQa}
            onChange={(e) =>
              void wrap(() =>
                api("PATCH", `/api/tasks/${task.id}`, { requiresEvidenceForQa: e.target.checked }),
              )
            }
          />{" "}
          Needs an artifact before QA
        </label>
        {task.requiresApproval && task.status === "qa" && (
          <button
            className="btn"
            onClick={() => void wrap(() => api("POST", `/api/tasks/${task.id}/request-approval`))}
          >
            Request approval
          </button>
        )}
        <div>
          <div className="mb-1 font-semibold">Depends on</div>
          {task.dependsOn.map((d) => (
            <div key={d} className="flex items-center gap-2 text-xs">
              <span className="flex-1">{all.find((t) => t.id === d)?.title ?? d}</span>
              <button
                className="btn !py-0"
                onClick={() => void wrap(() => api("DELETE", `/api/tasks/${task.id}/dependencies/${d}`))}
              >
                remove
              </button>
            </div>
          ))}
          <select
            className="input mt-1"
            value=""
            onChange={(e) =>
              e.target.value &&
              void wrap(() =>
                api("POST", `/api/tasks/${task.id}/dependencies`, { dependsOnTaskId: e.target.value }),
              )
            }
            aria-label="Add dependency"
          >
            <option value="">Add dependency…</option>
            {all
              .filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </div>
        <div>
          <div className="mb-1 font-semibold">Artifacts and evidence</div>
          {hist.data?.artifacts.map((a) => (
            <div key={a.id} className="text-xs">
              <span className="badge badge-manual">{a.kind}</span> {a.label}{" "}
              <span className="muted">{a.path}</span> <span className="muted">v{a.task_version}</span>
            </div>
          ))}
          <div className="mt-1 grid grid-cols-[90px_1fr] gap-1">
            <select
              className="input"
              value={art.kind}
              onChange={(e) => setArt({ ...art, kind: e.target.value })}
              aria-label="Artifact kind"
            >
              {[
                "video",
                "subtitle",
                "thumbnail",
                "code",
                "test-result",
                "build-result",
                "report",
                "other",
              ].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input
              className="input"
              placeholder="Label"
              value={art.label}
              onChange={(e) => setArt({ ...art, label: e.target.value })}
              aria-label="Artifact label"
            />
            <span />
            <input
              className="input"
              placeholder="File path (optional)"
              value={art.path}
              onChange={(e) => setArt({ ...art, path: e.target.value })}
              aria-label="Artifact path"
            />
          </div>
          <button
            className="btn mt-1"
            disabled={!art.label.trim()}
            onClick={() =>
              void wrap(async () => {
                await api("POST", `/api/tasks/${task.id}/artifacts`, {
                  kind: art.kind,
                  label: art.label,
                  path: art.path || null,
                });
                setArt({ ...art, label: "", path: "" });
              })
            }
          >
            Link artifact
          </button>
        </div>
        <div>
          <div className="mb-1 font-semibold">History</div>
          {hist.data?.transitions.map((t, i) => (
            <div key={i} className="text-xs">
              <span className="muted">{ago(t.created_at)}</span> {t.from_status} → {t.to_status}
            </div>
          ))}
          {hist.data?.events.map((e, i) => (
            <div key={"e" + i} className="text-xs">
              <span className="muted">{ago(e.ts)}</span> {e.summary}
            </div>
          ))}
          {!hist.data?.transitions.length && !hist.data?.events.length && (
            <div className="muted text-xs">No history yet.</div>
          )}
        </div>
      </div>
    </aside>
  );
}
