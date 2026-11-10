import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "../lib/store";
import { ACTIVITY_LABEL, ORIGIN_LABEL, ago } from "../lib/format";
import { api } from "../lib/api";
import { useProjects, useTaskHistory, useTasks } from "../lib/queries";

/** VIEW 3: Agent Inspector. Every field states what is known and what is not. */
export function Inspector() {
  const id = useStore((s) => s.selectedAgentId);
  const agent = useStore((s) => s.agents.find((a) => a.agentId === id));
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);
  const [, tick] = useState(0);
  const qc = useQueryClient();
  const projects = useProjects();
  const tasks = useTasks(agent?.projectId ?? undefined);
  const history = useTaskHistory(agent?.taskId ?? null);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!id) return null;
  if (!agent) {
    return (
      <aside className="panel absolute right-3 top-3 z-20 w-80 p-4 text-sm" aria-label="Agent inspector">
        <div className="muted">This agent is no longer shown (its session ended or went quiet long ago).</div>
        <button className="btn mt-3" onClick={() => select(null)}>
          Close
        </button>
      </aside>
    );
  }
  const o = ORIGIN_LABEL[agent.origin]!;
  const project = projects.data?.find((p) => p.id === agent.projectId);
  const task = tasks.data?.find((t) => t.id === agent.taskId);
  const real = agent.origin === "observed" || agent.origin === "orchestrated";
  const status =
    agent.origin === "roster"
      ? "No active agent"
      : agent.freshness === "ended"
        ? "Finished (session ended)"
        : agent.freshness === "stale"
          ? "Unknown: no events recently (not assumed finished)"
          : agent.activity === "needs_attention"
            ? "Blocked: needs attention"
            : agent.activity === "error"
              ? "Error"
              : agent.activity === "idle"
                ? "Idle"
                : "Running";
  const link = async (projectId: string | null, taskId: string | null) => {
    if (!agent.sessionId) return;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(agent.sessionId)}/link`, { projectId, taskId });
      void qc.invalidateQueries();
      toast("success", "Linked. This only labels the avatar; it does not control the session.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <aside
      className="panel absolute right-3 top-3 bottom-3 z-20 flex w-[340px] flex-col overflow-hidden text-sm"
      aria-label="Agent inspector"
    >
      <header className="flex items-start gap-2 p-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{agent.displayName}</div>
          <div className="muted text-xs">
            {agent.roleId ?? "no role mapped"} · {agent.departmentId}
          </div>
        </div>
        <button className="btn" onClick={() => select(null)} aria-label="Close inspector">
          ×
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <div>
          <span className={`badge ${o.cls}`}>{o.label}</span>
          <p className="muted mt-1 text-xs">{o.help}</p>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1.5">
          <dt className="muted">Status</dt>
          <dd>{status}</dd>
          <dt className="muted">Observed operation</dt>
          <dd>{agent.origin === "roster" ? "-" : (agent.lastOperation ?? "-")}</dd>
          <dt className="muted">Activity</dt>
          <dd>{agent.origin === "roster" ? "-" : (ACTIVITY_LABEL[agent.activity] ?? agent.activity)}</dd>
          <dt className="muted">Last updated</dt>
          <dd>
            {agent.lastEventAt
              ? `${ago(agent.lastEventAt)} (${new Date(agent.lastEventAt).toLocaleTimeString()})`
              : "never"}
          </dd>
          <dt className="muted">Session</dt>
          <dd className="break-all">{agent.sessionId ?? "none linked"}</dd>
          <dt className="muted">Parent session</dt>
          <dd className="break-all">{agent.parentSessionId ?? "-"}</dd>
          <dt className="muted">Project</dt>
          <dd>{project?.name ?? "not linked"}</dd>
          <dt className="muted">Task</dt>
          <dd>{task?.title ?? "not linked"}</dd>
        </dl>
        {agent.errorMessage && (
          <div className="panel2 p-2" role="alert">
            <div className="font-semibold text-[var(--bad)]">Last error</div>
            <div className="text-xs">{agent.errorMessage}</div>
          </div>
        )}
        {real && agent.sessionId && (
          <div className="panel2 space-y-2 p-2">
            <div className="font-semibold">Link to your work</div>
            <select
              className="input"
              value={agent.projectId ?? ""}
              onChange={(e) => void link(e.target.value || null, null)}
              aria-label="Project"
            >
              <option value="">No project</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              disabled={!agent.projectId}
              value={agent.taskId ?? ""}
              onChange={(e) => void link(agent.projectId, e.target.value || null)}
              aria-label="Task"
            >
              <option value="">No task</option>
              {tasks.data
                ?.filter((t) => t.status !== "completed")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </div>
        )}
        <div>
          <div className="mb-1 font-semibold">Output artifacts</div>
          {history.data?.artifacts.length ? (
            <ul className="space-y-1">
              {history.data.artifacts.map((a) => (
                <li key={a.id} className="text-xs">
                  <span className="badge badge-manual">{a.kind}</span> {a.label}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted text-xs">
              None recorded{agent.taskId ? " for the linked task." : ". Link a task to see its artifacts."}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 font-semibold">Recent events</div>
          {agent.recent.length ? (
            <ul className="space-y-1">
              {agent.recent.slice(0, 8).map((e, i) => (
                <li key={i} className="text-xs">
                  <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {e.summary}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted text-xs">No events.</div>
          )}
        </div>
        <div className="panel2 p-2 text-xs">
          <div className="mb-1 font-semibold">Controls available</div>
          {agent.origin === "observed" && (
            <p>
              None. This session is observed through hooks. The dashboard cannot start, pause, cancel or
              answer prompts for an existing Claude session. Permission prompts must be answered in Claude.
            </p>
          )}
          {agent.origin === "demo" && <p>None. This is simulated.</p>}
          {agent.origin === "roster" && (
            <p>None. Map this role to a real subagent type in Integration to see real activity here.</p>
          )}
          {agent.origin === "manual" && (
            <p>State is set manually through the API. No process is controlled.</p>
          )}
          {agent.origin === "orchestrated" && (
            <p>Managed execution is not enabled in this build, so no controls exist.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
