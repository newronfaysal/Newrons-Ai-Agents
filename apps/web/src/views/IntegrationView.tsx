import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { HOOK_STATE_TEXT, useHealth, useIntegrationStatus, useRoles } from "../lib/queries";
import { ago } from "../lib/format";
import { NavLink } from "react-router-dom";
import { AutomationView } from "./AutomationView";

function Code({ children }: { children: string }) {
  return (
    <pre className="panel2 overflow-x-auto p-2 text-xs">
      <code>{children}</code>
    </pre>
  );
}

function Tabs() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-[var(--panel2)] font-semibold" : "muted"}`;
  return (
    <nav className="flex gap-1" aria-label="Integration sections">
      <NavLink to="/integration" end className={cls}>
        Claude Code
      </NavLink>
      <NavLink to="/integration/automation" className={cls} data-testid="tab-automation">
        Team Automation Rules
      </NavLink>
    </nav>
  );
}

export function IntegrationView({ tab = "claude" }: { tab?: "claude" | "automation" }) {
  if (tab === "automation")
    return (
      <div className="mx-auto max-w-5xl space-y-4 overflow-y-auto p-4" style={{ height: "100%" }}>
        <h2 className="text-lg font-semibold">Integration</h2>
        <Tabs />
        <AutomationView />
      </div>
    );
  return <ClaudeIntegration />;
}

function ClaudeIntegration() {
  const agents = useStore((s) => s.agents);
  const conn = useStore((s) => s.conn);
  const toast = useStore((s) => s.toast);
  const health = useHealth();
  const roles = useRoles();
  const status = useIntegrationStatus();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Record<string, string>>({});
  const observed = agents.filter((a) => a.origin === "observed");
  const lastObserved = status.data?.lastObserved ?? null;
  const save = async (id: string) => {
    try {
      const subagentTypes = (edit[id] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await api("PATCH", `/api/roles/${id}`, { subagentTypes });
      void qc.invalidateQueries({ queryKey: ["roles"] });
      toast("success", "Role mapping saved. It applies to subagents that start from now on.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-4 overflow-y-auto p-4" style={{ height: "100%" }}>
      <h2 className="text-lg font-semibold">Integration</h2>
      <Tabs />
      <section className="panel space-y-2 p-4" aria-label="Status">
        <h3 className="font-semibold">Status</h3>
        <dl className="grid grid-cols-[200px_1fr] gap-y-1 text-sm">
          <dt className="muted">Local server</dt>
          <dd>
            {conn === "open" ? "Connected" : conn === "connecting" ? "Connecting…" : "Disconnected"}
            {health.data ? ` · ${health.data.clients} dashboard connection(s)` : ""}
          </dd>
          <dt className="muted">Observed Claude sessions</dt>
          <dd>
            {observed.length ? `${observed.length} visible now` : "None visible now"}
            {status.data ? ` · ${status.data.observedSessionsLast24h} in the last 24 h` : ""}
          </dd>
          <dt className="muted">Last real event</dt>
          <dd data-testid="last-real-event">
            {lastObserved
              ? `${ago(lastObserved.timestamp)}: ${lastObserved.summary}`
              : status.isLoading
                ? "Checking…"
                : "No real events received yet. Install the hooks below, then start a new Claude Code session."}
            {status.data && status.data.observedEventsTotal > 0
              ? ` (${status.data.observedEventsTotal} stored)`
              : ""}
          </dd>
          <dt className="muted">Buffered while offline</dt>
          <dd>
            {status.data
              ? status.data.spoolPendingFiles
                ? `${status.data.spoolPendingFiles} file(s) waiting to be imported`
                : "Nothing waiting"
              : "…"}
          </dd>
          <dt className="muted">Observability</dt>
          <dd>Claude Code hooks (observe only)</dd>
          <dt className="muted">Managed execution</dt>
          <dd>Not enabled. This build never starts, pauses, cancels or retries Claude tasks.</dd>
        </dl>
      </section>
      <section className="panel space-y-2 p-4">
        <h3 className="font-semibold">Observe Claude Code (project-local hooks)</h3>
        <p className="muted text-sm">
          Hooks are installed into one project's <code>.claude/settings.local.json</code> only, never your
          global Claude settings. They run in the background, never block Claude, send only tool names, file
          names and status (not prompts or tool output), and buffer to disk while this dashboard is closed.
          Works with the Claude Code Desktop app for sessions in that folder.
        </p>
        <p className="text-sm font-medium">1. Preview (changes nothing):</p>
        <Code>{'pnpm hooks:install --project "C:\\Projects\\your-project" --dry-run'}</Code>
        <p className="text-sm font-medium">
          2. Install (asks for confirmation, backs up existing settings first):
        </p>
        <Code>{'pnpm hooks:install --project "C:\\Projects\\your-project"'}</Code>
        <p className="text-sm font-medium">
          3. Start a new Claude Code session in that folder. Hooks are read when a session starts.
        </p>
        <p className="text-sm font-medium">Remove completely:</p>
        <Code>{'pnpm hooks:uninstall --project "C:\\Projects\\your-project"'}</Code>
        <p className="muted text-xs">
          Observability does not imply control: you cannot steer an existing Desktop session from here. No
          events arriving does not mean a task finished; silent agents are shown as "no signal", never as
          complete.
        </p>
      </section>
      <section className="panel space-y-2 p-4" aria-label="Hooks per project">
        <h3 className="font-semibold">Hooks per project</h3>
        <p className="muted text-sm">
          Read-only check of each project folder's <code>.claude/settings.local.json</code>. Set a folder on a
          project (Projects page) to see it here.
        </p>
        {status.data?.projects.length ? (
          <ul className="space-y-1 text-sm" data-testid="hook-projects">
            {status.data.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className={p.hooks.state === "installed" ? "text-green-400" : "muted"}>
                  {HOOK_STATE_TEXT[p.hooks.state]}
                </span>
                {p.hooks.state === "partial" ? (
                  <span className="muted text-xs">missing: {p.hooks.missing.join(", ")}</span>
                ) : null}
                <span className="muted text-xs">{p.folderPath ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">No projects yet.</p>
        )}
      </section>
      <section className="panel space-y-2 p-4">
        <h3 className="font-semibold">Role mapping</h3>
        <p className="muted text-sm">
          A role is only a seat in the office. It becomes active when a real Claude subagent whose type
          matches (comma-separated, case-insensitive) starts.
        </p>
        <div className="space-y-1.5">
          {roles.data?.map((r) => (
            <div key={r.id} className="grid grid-cols-[180px_90px_1fr_auto] items-center gap-2 text-sm">
              <span>{r.name}</span>
              <span className="muted text-xs">{r.departmentId}</span>
              <input
                className="input"
                aria-label={`Subagent types for ${r.name}`}
                placeholder="e.g. Plan, code-reviewer"
                value={edit[r.id] ?? r.subagentTypes.join(", ")}
                onChange={(e) => setEdit({ ...edit, [r.id]: e.target.value })}
              />
              <button className="btn" disabled={edit[r.id] === undefined} onClick={() => void save(r.id)}>
                Save
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="panel space-y-1 p-4 text-sm">
        <h3 className="font-semibold">Privacy and data</h3>
        <p className="muted">
          Everything stays on this computer in a local SQLite file. Full prompts and transcripts are never
          stored. Shell command text is not stored unless you set <code>AI_OFFICE_CAPTURE_COMMANDS=on</code>{" "}
          (it is redacted and truncated when enabled).
        </p>
      </section>
    </div>
  );
}
