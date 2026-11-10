import { WsMessage } from "@ai-office/shared";
import { useStore } from "./store";

/** Backoff schedule for reconnects (ms). Exported for tests. */
export function backoff(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
}

export interface WsHooks {
  onTasksChanged(): void;
  /** Called on every (re)connect, e.g. to reload event history that arrived while disconnected. */
  onConnected?(): void;
  /** Routing rules, work items or the routing log changed. */
  onRoutingChanged?(): void;
}

/**
 * Reconnecting WebSocket. On every (re)connect the server sends a fresh snapshot, so a dropped
 * connection can never leave the UI showing stale state as if it were live.
 */
export function connectWs(
  hooks: WsHooks,
  makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
): () => void {
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const st = useStore.getState;

  const open = () => {
    if (stopped) return;
    st().setConn("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = makeSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      attempt = 0;
      st().setConn("open");
      st().ping();
      hooks.onConnected?.();
    };
    ws.onmessage = (m) => {
      let parsed;
      try {
        parsed = WsMessage.safeParse(JSON.parse(String(m.data)));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      st().ping();
      if (msg.type === "hello") st().setDemo(msg.mode.demo);
      else if (msg.type === "agents") st().setAgents(msg.agents);
      else if (msg.type === "tasks-changed") hooks.onTasksChanged();
      else if (msg.type === "departments") st().setDepartments(msg.departments);
      else if (msg.type === "routing-changed") hooks.onRoutingChanged?.();
      else if (msg.type === "event") {
        st().addEvent(msg.event);
        const e = msg.event;
        if (e.sourceType === "demo") return;
        if (e.eventType === "permission.request")
          st().toast("attention", "Claude is waiting for a permission decision. Answer it in Claude.");
        else if (e.eventType === "subagent.stop") st().toast("success", e.summary);
        else if (e.eventType === "stop.failure") st().toast("error", e.summary);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      st().setConn("closed");
      timer = setTimeout(open, backoff(attempt++));
    };
    ws.onerror = () => ws?.close();
  };
  open();
  // Debug/test handle: lets tests simulate a dropped connection without touching the network stack.
  (window as unknown as { __aiOfficeWs?: { drop(): void } }).__aiOfficeWs = { drop: () => ws?.close() };
  // The server pings every 10s; if we hear nothing for 35s the socket is half-open, so force a reconnect.
  watchdog = setInterval(() => {
    const last = st().lastServerPing;
    if (ws && ws.readyState === 1 && last && Date.now() - last > 35_000) ws.close();
  }, 5000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (watchdog) clearInterval(watchdog);
    ws?.close();
  };
}
