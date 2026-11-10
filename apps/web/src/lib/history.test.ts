import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHistory, toEvent } from "./history";
import { useStore } from "./store";

const row = (id: string, ts: string, sourceType = "observed", summary = id) => ({
  eventId: id,
  timestamp: ts,
  sourceType,
  sessionId: "s",
  agentId: null,
  projectId: null,
  taskId: null,
  departmentId: null,
  eventType: "tool.pre",
  status: "ok",
  summary,
});

beforeEach(() => useStore.setState({ events: [] }));

describe("loadHistory", () => {
  it("fills the log from stored events, newest first", async () => {
    const f = vi.fn().mockResolvedValue([row("a", "2026-01-01T10:00:00Z"), row("b", "2026-01-01T11:00:00Z")]);
    await loadHistory(f as never);
    expect(useStore.getState().events.map((e) => e.eventId)).toEqual(["b", "a"]);
  });
  it("does not duplicate events that also arrived live, and never lets demo rows in", async () => {
    useStore.getState().addEvent(toEvent(row("a", "2026-01-01T10:00:00Z") as never));
    const f = vi
      .fn()
      .mockResolvedValue([row("a", "2026-01-01T10:00:00Z"), row("d", "2026-01-01T12:00:00Z", "demo")]);
    await loadHistory(f as never);
    expect(useStore.getState().events.map((e) => e.eventId)).toEqual(["a"]);
  });
  it("keeps working when the server is unreachable", async () => {
    const f = vi.fn().mockRejectedValue(new Error("down"));
    expect(await loadHistory(f as never)).toBe(0);
    expect(useStore.getState().events).toEqual([]);
  });
});
