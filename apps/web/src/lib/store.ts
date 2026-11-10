import { create } from "zustand";
import type { AgentSnapshot, DepartmentStatus, NormalizedEvent } from "@ai-office/shared";

export type Conn = "connecting" | "open" | "closed";

export interface Toast {
  id: number;
  level: "info" | "success" | "warning" | "error" | "attention";
  text: string;
}

interface Prefs {
  dayNight: "day" | "night";
  theme: "dark" | "light";
  reducedMotion: boolean;
  paused: boolean;
}

const load = (): Prefs => {
  const d: Prefs = {
    dayNight: "day",
    theme: "dark",
    reducedMotion:
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    paused: false,
  };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem("ai-office-prefs") ?? "{}") as Partial<Prefs>) };
  } catch {
    return d;
  }
};

interface State {
  agents: AgentSnapshot[];
  /** Department states from the Task Router (derived from real events and routing decisions). */
  departments: DepartmentStatus[];
  events: NormalizedEvent[]; // newest first, capped
  conn: Conn;
  lastServerPing: number | null;
  demo: boolean;
  selectedAgentId: string | null;
  toasts: Toast[];
  prefs: Prefs;
  setAgents(a: AgentSnapshot[]): void;
  setDepartments(d: DepartmentStatus[]): void;
  addEvent(e: NormalizedEvent): void;
  mergeHistory(list: NormalizedEvent[]): void;
  setConn(c: Conn): void;
  ping(): void;
  setDemo(d: boolean): void;
  select(id: string | null): void;
  toast(level: Toast["level"], text: string): void;
  dismissToast(id: number): void;
  setPrefs(p: Partial<Prefs>): void;
}

let toastId = 1;
export const useStore = create<State>((set, get) => ({
  agents: [],
  departments: [],
  events: [],
  conn: "connecting",
  lastServerPing: null,
  demo: false,
  selectedAgentId: null,
  toasts: [],
  prefs: load(),
  setAgents: (agents) => set({ agents }),
  setDepartments: (departments) => set({ departments }),
  addEvent: (e) => set((s) => ({ events: [e, ...s.events].slice(0, 500) })),
  mergeHistory: (list) =>
    set((s) => {
      const seen = new Set<string>();
      const merged = [...s.events, ...list]
        .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return { events: merged.slice(0, 500) };
    }),
  setConn: (conn) => set({ conn }),
  ping: () => set({ lastServerPing: Date.now() }),
  setDemo: (demo) => set({ demo }),
  select: (selectedAgentId) => set({ selectedAgentId }),
  toast: (level, text) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, level, text }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPrefs: (p) =>
    set((s) => {
      const prefs = { ...s.prefs, ...p };
      try {
        localStorage.setItem("ai-office-prefs", JSON.stringify(prefs));
      } catch {
        /* ignore */
      }
      return { prefs };
    }),
}));
