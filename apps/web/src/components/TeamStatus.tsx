import { DEPARTMENTS, type DepartmentStatus } from "@ai-office/shared";
import { useStore } from "../lib/store";
import { ago } from "../lib/format";

/** Colour + label for each department state. Colours come from theme tokens so both themes work. */
export const STATE_STYLE: Record<string, { label: string; color: string; pulse?: boolean }> = {
  available: { label: "Available", color: "var(--muted)" },
  planning: { label: "Planning", color: "var(--accent)", pulse: true },
  assigned: { label: "Assigned", color: "var(--accent)" },
  working: { label: "Working", color: "var(--good)", pulse: true },
  waiting: { label: "Waiting", color: "var(--warn)" },
  testing: { label: "Testing", color: "var(--good)", pulse: true },
  reviewing: { label: "Reviewing", color: "var(--good)", pulse: true },
  blocked: { label: "Blocked", color: "var(--bad)" },
  completed: { label: "Completed", color: "var(--good)" },
  error: { label: "Error", color: "var(--bad)" },
  offline: { label: "Offline", color: "var(--muted)" },
};

/** Hex colours for the Pixi scene (it cannot read CSS variables). */
export const STATE_HEX: Record<string, number> = {
  available: 0x9aa3ba,
  planning: 0x7dd3fc,
  assigned: 0x7dd3fc,
  working: 0x4ade80,
  waiting: 0xfbbf24,
  testing: 0x4ade80,
  reviewing: 0x4ade80,
  blocked: 0xf87171,
  completed: 0x4ade80,
  error: 0xf87171,
  offline: 0x6b7280,
};

const MODE_LABEL = { monitoring: "Monitoring", active: "Active planning", idle: "Idle" } as const;

export function StateBadge({ state, stale }: { state: string; stale?: boolean }) {
  const s = STATE_STYLE[state] ?? { label: state, color: "var(--muted)" };
  return (
    <span
      className="badge inline-flex items-center gap-1"
      style={{ color: s.color, borderColor: s.color }}
      data-state={state}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${s.pulse && !stale ? "animate-pulse" : ""}`}
        style={{ background: s.color }}
      />
      {s.label}
      {stale ? " · no signal" : ""}
    </span>
  );
}

export function DepartmentCard({ d }: { d: DepartmentStatus }) {
  const meta = DEPARTMENTS.find((x) => x.id === d.departmentId)!;
  return (
    <div className="panel2 min-w-0 flex-1 p-2 text-xs" data-testid={`dept-${d.departmentId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold">{meta.name}</span>
        <StateBadge state={d.state} stale={d.stale} />
      </div>
      <div className="muted mt-1 truncate" title={d.reason}>
        {d.mode ? `${MODE_LABEL[d.mode]} · ` : ""}
        {d.reason}
      </div>
      {d.lastEventAt ? <div className="muted mt-0.5">last event {ago(d.lastEventAt)}</div> : null}
    </div>
  );
}

/** Compact strip of the four departments, driven only by router state from the server. */
export function TeamStatusBar() {
  const deps = useStore((s) => s.departments);
  if (!deps.length) return null;
  return (
    <div
      className="flex flex-wrap gap-2 p-2"
      style={{ borderBottom: "1px solid var(--line)" }}
      aria-label="Department status"
      role="status"
    >
      {deps.map((d) => (
        <DepartmentCard key={d.departmentId} d={d} />
      ))}
    </div>
  );
}
