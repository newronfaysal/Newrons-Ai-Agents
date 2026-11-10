import { useStore } from "../lib/store";

const COLOR: Record<string, string> = {
  info: "var(--accent)",
  success: "var(--good)",
  warning: "var(--warn)",
  error: "var(--bad)",
  attention: "var(--warn)",
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="panel pointer-events-auto flex items-start gap-2 p-3 text-sm shadow-lg"
          style={{ borderLeft: `4px solid ${COLOR[t.level]}` }}
          role="status"
        >
          <span className="flex-1">{t.text}</span>
          <button className="muted" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
