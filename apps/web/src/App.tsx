import { useEffect } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { OfficeView } from "./views/OfficeView";
import { ProjectsView } from "./views/ProjectsView";
import { IntegrationView } from "./views/IntegrationView";
import { Toasts } from "./components/Toasts";
import { connectWs } from "./lib/ws";
import { loadHistory } from "./lib/history";
import { useStore } from "./lib/store";
import { useApprovals, useRefreshAll, useRefreshRouting } from "./lib/queries";

function Nav() {
  const conn = useStore((s) => s.conn);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const approvals = useApprovals();
  const pending = approvals.data?.length ?? 0;
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-[var(--panel2)] font-semibold" : "muted"}`;
  const dot = conn === "open" ? "var(--good)" : conn === "connecting" ? "var(--warn)" : "var(--bad)";
  return (
    <header
      className="flex items-center gap-2 px-3 py-2"
      style={{ borderBottom: "1px solid var(--line)", background: "var(--panel)" }}
    >
      <div className="mr-3 font-bold tracking-wide">AI&nbsp;OFFICE</div>
      <nav className="flex gap-1" aria-label="Main">
        <NavLink to="/office" className={link}>
          Office
        </NavLink>
        <NavLink to="/projects" className={link}>
          Projects
          {pending ? (
            <span className="badge badge-bad ml-1" title="Pending approvals">
              {pending}
            </span>
          ) : null}
        </NavLink>
        <NavLink to="/integration" className={link}>
          Integration
        </NavLink>
      </nav>
      <span className="flex-1" />
      <span className="flex items-center gap-1.5 text-xs" role="status" data-testid="conn-indicator">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
        {conn === "open" ? "Connected" : conn === "connecting" ? "Connecting" : "Offline"}
      </span>
      <button
        className="btn"
        onClick={() => setPrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
        aria-label="Toggle light or dark theme"
      >
        {prefs.theme === "dark" ? "Light" : "Dark"}
      </button>
    </header>
  );
}

export default function App() {
  const prefs = useStore((s) => s.prefs);
  const refresh = useRefreshAll();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", prefs.theme === "dark");
    document.documentElement.classList.toggle("reduce-motion", prefs.reducedMotion);
  }, [prefs.theme, prefs.reducedMotion]);
  const refreshRouting = useRefreshRouting();
  useEffect(
    () =>
      connectWs({
        onTasksChanged: refresh,
        onConnected: () => void loadHistory(),
        onRoutingChanged: refreshRouting,
      }),
    [],
  );
  return (
    <div className="flex h-full flex-col">
      <Nav />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/office" replace />} />
          <Route path="/office" element={<OfficeView />} />
          <Route path="/projects" element={<ProjectsView />} />
          <Route path="/integration" element={<IntegrationView />} />
          <Route path="/integration/automation" element={<IntegrationView tab="automation" />} />
          <Route
            path="*"
            element={<div className="muted grid h-full place-items-center">Page not found.</div>}
          />
        </Routes>
      </main>
      <Toasts />
    </div>
  );
}
