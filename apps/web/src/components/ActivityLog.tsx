import { useRef, useState } from "react";
import type { NormalizedEvent } from "@ai-office/shared";
import { ORIGIN_LABEL } from "../lib/format";

const ROW = 30;

/** Windowed list: only rows in view are mounted, so long histories stay cheap. */
export function ActivityLog({
  events,
  onPick,
  height = 220,
}: {
  events: NormalizedEvent[];
  onPick?: (e: NormalizedEvent) => void;
  height?: number;
}) {
  const [top, setTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const start = Math.max(0, Math.floor(top / ROW) - 3);
  const end = Math.min(events.length, Math.ceil((top + height) / ROW) + 3);
  if (!events.length)
    return (
      <div className="muted p-3 text-sm">
        No activity yet. Start a Claude Code session in a project with hooks installed, or run the demo.
      </div>
    );
  return (
    <div
      ref={ref}
      style={{ height, overflowY: "auto" }}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      role="log"
      aria-label="Activity log"
    >
      <div style={{ height: events.length * ROW, position: "relative" }}>
        {events.slice(start, end).map((e, i) => {
          const o = ORIGIN_LABEL[e.sourceType];
          return (
            <button
              key={e.eventId}
              onClick={() => onPick?.(e)}
              className="absolute left-0 right-0 flex items-center gap-2 px-3 text-left text-[12px]"
              style={{ top: (start + i) * ROW, height: ROW }}
            >
              <span className="muted w-24 shrink-0 whitespace-nowrap tabular-nums">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
              <span className={`badge ${o?.cls ?? ""} shrink-0`}>
                {e.sourceType === "observed"
                  ? "LIVE"
                  : e.sourceType === "demo"
                    ? "SIM"
                    : e.sourceType.toUpperCase()}
              </span>
              <span
                className={`truncate ${e.status === "failed" ? "text-[var(--bad)]" : e.status === "needs_attention" ? "text-[var(--warn)]" : ""}`}
              >
                {e.summary}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
