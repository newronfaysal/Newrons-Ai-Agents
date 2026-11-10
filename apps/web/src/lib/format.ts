export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const ORIGIN_LABEL: Record<string, { label: string; cls: string; help: string }> = {
  observed: {
    label: "LIVE · OBSERVED",
    cls: "badge-live",
    help: "Real Claude Code activity observed through hooks. The dashboard cannot control this session.",
  },
  orchestrated: {
    label: "ORCHESTRATED",
    cls: "badge-live",
    help: "Started and managed by AI Office through a supported API.",
  },
  manual: {
    label: "MANUAL",
    cls: "badge-manual",
    help: "State set by you. Not observed from a running agent.",
  },
  demo: { label: "SIMULATED", cls: "badge-sim", help: "Demo data. No agent is actually running." },
  roster: {
    label: "ROSTER · NO ACTIVE AGENT",
    cls: "badge-roster",
    help: "A role placeholder. Nothing is running here.",
  },
};

export const ACTIVITY_LABEL: Record<string, string> = {
  idle: "Idle",
  reading: "Reading files",
  researching: "Researching",
  coding: "Working on files",
  testing: "Running tests",
  rendering: "Rendering (ffmpeg command seen)",
  meeting: "Delegating / meeting",
  thinking: "Working",
  needs_attention: "Needs attention",
  finished: "Finished",
  error: "Error",
};
