import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoff, connectWs } from "./ws";
import { useStore } from "./store";
import { ago } from "./format";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const make = (u: string) => new FakeSocket(u) as unknown as WebSocket;

const agent = (id: string) => ({
  agentId: id,
  displayName: id,
  roleId: null,
  departmentId: "dev",
  origin: "observed",
  sessionId: "s",
  parentSessionId: null,
  projectId: null,
  taskId: null,
  activity: "coding",
  lastOperation: null,
  lastEventAt: null,
  freshness: "live",
  errorMessage: null,
  recent: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  useStore.setState({
    agents: [],
    events: [],
    conn: "connecting",
    demo: false,
    toasts: [],
    lastServerPing: null,
  });
});
afterEach(() => vi.useRealTimers());

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("connectWs", () => {
  it("tracks connection state and applies snapshots", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    expect(useStore.getState().conn).toBe("connecting");
    const s = FakeSocket.all[0]!;
    s.open();
    expect(useStore.getState().conn).toBe("open");
    s.msg({ type: "hello", serverTime: new Date().toISOString(), mode: { demo: true } });
    s.msg({ type: "agents", agents: [agent("a1")] });
    expect(useStore.getState().demo).toBe(true);
    expect(useStore.getState().agents.map((a) => a.agentId)).toEqual(["a1"]);
    stop();
  });
  it("reconnects with backoff after a drop and gets a fresh snapshot", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.msg({ type: "agents", agents: [agent("old")] });
    FakeSocket.all[0]!.close();
    expect(useStore.getState().conn).toBe("closed");
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.msg({ type: "agents", agents: [agent("new")] });
    expect(useStore.getState().conn).toBe("open");
    expect(useStore.getState().agents.map((a) => a.agentId)).toEqual(["new"]);
    stop();
  });
  it("backs off further on repeated failures and resets after success", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    FakeSocket.all[0]!.close(); // never opened
    vi.advanceTimersByTime(500);
    FakeSocket.all[1]!.close();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();
    FakeSocket.all[2]!.close();
    vi.advanceTimersByTime(501);
    expect(FakeSocket.all).toHaveLength(4); // back to the first step after a successful connection
    stop();
  });
  it("ignores malformed or unknown messages", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    const s = FakeSocket.all[0]!;
    s.open();
    s.onmessage?.({ data: "not json" });
    s.msg({ type: "nope" });
    s.msg({ type: "agents", agents: [{ broken: true }] });
    expect(useStore.getState().agents).toEqual([]);
    stop();
  });
  it("does not toast for simulated events but does for real permission requests", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    const s = FakeSocket.all[0]!;
    s.open();
    const ev = (sourceType: string) => ({
      type: "event",
      event: {
        eventId: "evt-" + sourceType + "1",
        timestamp: new Date().toISOString(),
        sourceType,
        sessionId: "s",
        parentSessionId: null,
        agentId: null,
        projectId: null,
        taskId: null,
        departmentId: null,
        eventType: "permission.request",
        status: "needs_attention",
        summary: "x",
        safeMetadata: {},
        correlationId: null,
      },
    });
    s.msg(ev("demo"));
    expect(useStore.getState().toasts).toHaveLength(0);
    s.msg(ev("observed"));
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(useStore.getState().toasts[0]!.text).toMatch(/Answer it in Claude/);
    stop();
  });
  it("refreshes task views when the server says tasks changed", () => {
    const cb = vi.fn();
    const stop = connectWs({ onTasksChanged: cb }, make);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.msg({ type: "tasks-changed" });
    expect(cb).toHaveBeenCalledOnce();
    stop();
  });
  it("force-reconnects a half-open socket that stops pinging", () => {
    const stop = connectWs({ onTasksChanged: vi.fn() }, make);
    const s = FakeSocket.all[0]!;
    s.open();
    vi.advanceTimersByTime(40_000); // no pings for >35s
    expect(useStore.getState().conn).toBe("closed");
    stop();
  });
});

describe("format.ago", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(ago("2026-01-01T11:59:58Z", now)).toBe("just now");
    expect(ago("2026-01-01T11:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-01-01T11:50:00Z", now)).toBe("10m ago");
    expect(ago(null, now)).toBe("never");
  });
});
