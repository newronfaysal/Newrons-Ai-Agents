import { useEffect, useMemo, useRef, useState } from "react";
import { DEPARTMENTS, type DepartmentId } from "@ai-office/shared";
import { OfficeScene } from "../office/scene";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { useTasks } from "../lib/queries";
import { ORIGIN_LABEL } from "../lib/format";
import { Inspector } from "../components/Inspector";
import { ActivityLog } from "../components/ActivityLog";
import { STATE_HEX, STATE_STYLE, TeamStatusBar } from "../components/TeamStatus";

declare global {
  interface Window {
    __aiOffice?: {
      state(): ReturnType<OfficeScene["debugState"]>;
      focus(d: DepartmentId | "all"): void;
      screenPos(id: string): { x: number; y: number } | null;
    };
  }
}

export function OfficeView() {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [logOpen, setLogOpen] = useState(true);
  const agents = useStore((s) => s.agents);
  const departments = useStore((s) => s.departments);
  const events = useStore((s) => s.events);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const demo = useStore((s) => s.demo);
  const conn = useStore((s) => s.conn);
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);
  const tasks = useTasks();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scene = new OfficeScene(el, {
      onSelect: (id) => select(id),
      onHover: (id, x, y) => setHover(id ? { id, x, y } : null),
    });
    sceneRef.current = scene;
    let alive = true;
    scene
      .init()
      .then(() => {
        if (!alive) return;
        const st = useStore.getState();
        scene.setReduced(st.prefs.reducedMotion);
        scene.setPaused(st.prefs.paused);
        scene.setNight(st.prefs.dayNight === "night");
        scene.setAgents(st.agents);
        window.__aiOffice = {
          state: () => scene.debugState(),
          focus: (d) => scene.fit(true, d),
          screenPos: (id) => scene.screenPosOf(id),
        };
        setReady(true);
      })
      .catch((e) => setFailed(String(e?.message ?? e)));
    return () => {
      alive = false;
      sceneRef.current = null;
      delete window.__aiOffice;
      scene.destroy();
    };
  }, [select]);

  useEffect(() => {
    sceneRef.current?.setAgents(agents);
  }, [agents, ready]);
  useEffect(() => {
    sceneRef.current?.setReduced(prefs.reducedMotion);
  }, [prefs.reducedMotion, ready]);
  useEffect(() => {
    sceneRef.current?.setPaused(prefs.paused);
  }, [prefs.paused, ready]);
  useEffect(() => {
    sceneRef.current?.setNight(prefs.dayNight === "night");
  }, [prefs.dayNight, ready]);

  const roomInfo = useMemo(() => {
    const out: Partial<Record<DepartmentId, { text: string; color?: number }>> = {};
    for (const d of DEPARTMENTS) {
      const mine =
        tasks.data?.filter(
          (t) => t.departmentId === d.id && t.status !== "completed" && t.status !== "backlog",
        ) ?? [];
      const attention = agents.filter(
        (a) => a.departmentId === d.id && a.activity === "needs_attention" && a.origin !== "roster",
      ).length;
      const st = departments.find((x) => x.departmentId === d.id);
      const state = st
        ? `${STATE_STYLE[st.state]?.label ?? st.state}${st.stale ? " (no signal)" : ""} · `
        : "";
      out[d.id] = {
        text: `${state}${mine.length} open task${mine.length === 1 ? "" : "s"}${attention ? ` · ${attention} need attention` : ""}`,
        color: st && st.state !== "available" ? STATE_HEX[st.state] : undefined,
      };
    }
    return out;
  }, [tasks.data, agents, departments]);
  useEffect(() => {
    sceneRef.current?.setRoomInfo(roomInfo);
  }, [roomInfo, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,select,textarea")) return;
      const map: Record<string, DepartmentId | "all"> = {
        "0": "all",
        "1": "planning",
        "2": "video",
        "3": "dev",
        "4": "qa",
      };
      const d = map[e.key];
      if (d) sceneRef.current?.fit(true, d);
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const toggleDemo = async () => {
    try {
      await api("POST", demo ? "/api/demo/stop" : "/api/demo/start", demo ? undefined : { speed: 1 });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const real = agents.filter((a) => a.origin === "observed" || a.origin === "orchestrated");
  const hovered = hover ? agents.find((a) => a.agentId === hover.id) : undefined;
  const counts = {
    real: real.length,
    demo: agents.filter((a) => a.origin === "demo").length,
    roster: agents.filter((a) => a.origin === "roster").length,
  };

  return (
    <div className="relative flex h-full flex-col">
      <div
        className="flex flex-wrap items-center gap-2 p-2"
        style={{ borderBottom: "1px solid var(--line)" }}
        role="toolbar"
        aria-label="Office controls"
      >
        <button className="btn" onClick={() => sceneRef.current?.fit(true, "all")} title="Show all rooms (0)">
          All rooms
        </button>
        {DEPARTMENTS.map((d, i) => (
          <button
            key={d.id}
            className="btn"
            onClick={() => sceneRef.current?.fit(true, d.id)}
            title={`${d.blurb} (${i + 1})`}
          >
            {d.name.replace(" Team", "")}
          </button>
        ))}
        <span className="mx-1 h-5 w-px" style={{ background: "var(--line)" }} />
        <button className="btn" onClick={() => sceneRef.current?.zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
        <button className="btn" onClick={() => sceneRef.current?.zoomBy(0.8)} aria-label="Zoom out">
          −
        </button>
        <button
          className="btn"
          onClick={() => setPrefs({ paused: !prefs.paused })}
          aria-pressed={prefs.paused}
        >
          {prefs.paused ? "Resume animation" : "Pause animation"}
        </button>
        <button
          className="btn"
          onClick={() => setPrefs({ reducedMotion: !prefs.reducedMotion })}
          aria-pressed={prefs.reducedMotion}
        >
          Reduced motion: {prefs.reducedMotion ? "on" : "off"}
        </button>
        <button
          className="btn"
          onClick={() => setPrefs({ dayNight: prefs.dayNight === "day" ? "night" : "day" })}
          title="Cosmetic only; unrelated to real activity"
        >
          {prefs.dayNight === "day" ? "Night look" : "Day look"}
        </button>
        <span className="flex-1" />
        <button
          className={`btn ${demo ? "" : "btn-primary"}`}
          onClick={() => void toggleDemo()}
          data-testid="demo-toggle"
        >
          {demo ? "Stop demo" : "Start demo (simulated)"}
        </button>
      </div>
      {demo && (
        <div
          className="badge-sim px-3 py-1.5 text-center text-sm font-semibold"
          role="status"
          data-testid="demo-banner"
        >
          SIMULATED ACTIVITY: demo data only. No Claude agent is running these avatars.
        </div>
      )}
      <TeamStatusBar />
      {conn !== "open" && (
        <div
          className="px-3 py-1.5 text-center text-sm font-semibold text-[var(--bad)]"
          role="alert"
          style={{ background: "color-mix(in srgb, var(--bad) 15%, transparent)" }}
        >
          {conn === "connecting"
            ? "Connecting to the local AI Office server…"
            : "Disconnected from the local server. Showing last known state, which may be outdated. Reconnecting…"}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" data-testid="office-canvas" />
        {!ready && !failed && (
          <div className="absolute inset-0 grid place-items-center text-sm muted">Loading the office…</div>
        )}
        {failed && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="panel max-w-md p-5">
              <div className="mb-2 text-base font-semibold">The office view could not start</div>
              <p className="muted text-sm">
                This view needs WebGL. Your projects, tasks and the activity log still work in the other
                views. Details: {failed}
              </p>
            </div>
          </div>
        )}
        <div className="panel absolute left-3 top-3 z-10 p-2 text-[11px] opacity-95" aria-label="Legend">
          <div className="mb-1 font-semibold">Who is who</div>
          {(["observed", "demo", "manual", "roster"] as const).map((k) => (
            <div key={k} className="mb-0.5 flex items-center gap-1.5">
              <span className={`badge ${ORIGIN_LABEL[k]!.cls}`}>{ORIGIN_LABEL[k]!.label}</span>
            </div>
          ))}
          <div className="muted mt-1">
            {counts.real} real · {counts.demo} simulated · {counts.roster} roster placeholders
          </div>
        </div>
        {hover && hovered && (
          <div
            className="panel pointer-events-none absolute z-30 max-w-[260px] p-2 text-xs shadow-lg"
            style={{
              left: Math.min(hover.x + 14, (host.current?.clientWidth ?? 800) - 270),
              top: hover.y + 14,
            }}
            role="tooltip"
          >
            <div className="font-semibold">{hovered.displayName}</div>
            <div>
              <span className={`badge ${ORIGIN_LABEL[hovered.origin]!.cls}`}>
                {ORIGIN_LABEL[hovered.origin]!.label}
              </span>
            </div>
            <div className="mt-1">
              {hovered.origin === "roster"
                ? "No active agent in this role."
                : (hovered.lastOperation ?? "No operation seen yet")}
            </div>
          </div>
        )}
        <Inspector />
      </div>
      <div style={{ borderTop: "1px solid var(--line)" }}>
        <button
          className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm font-semibold"
          onClick={() => setLogOpen(!logOpen)}
          aria-expanded={logOpen}
        >
          <span>Activity ({events.length})</span>
          <span className="muted">{logOpen ? "Hide" : "Show"}</span>
        </button>
        {logOpen && (
          <ActivityLog events={events} height={150} onPick={(e) => e.agentId && select(e.agentId)} />
        )}
      </div>
    </div>
  );
}
