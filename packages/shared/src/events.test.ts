import { describe, expect, it } from "vitest";
import { EventInput, NormalizedEvent } from "./events.js";
import { redact, safePathLabel } from "./sanitize.js";
import { activityForTool } from "./activity.js";

const valid = {
  eventId: "evt-12345678",
  timestamp: "2026-11-10T04:00:00.000Z",
  sourceType: "observed",
  sessionId: "s1",
  parentSessionId: null,
  agentId: null,
  projectId: null,
  taskId: null,
  departmentId: "dev",
  eventType: "tool.pre",
  status: "running",
  summary: "Edit: changing a file",
  safeMetadata: { tool: "Edit" },
  correlationId: null,
};

describe("NormalizedEvent schema", () => {
  it("accepts a valid event", () => expect(NormalizedEvent.safeParse(valid).success).toBe(true));
  it("rejects unknown event types", () =>
    expect(NormalizedEvent.safeParse({ ...valid, eventType: "rm -rf" }).success).toBe(false));
  it("rejects unknown source types", () =>
    expect(NormalizedEvent.safeParse({ ...valid, sourceType: "trusted" }).success).toBe(false));
  it("rejects overlong summaries", () =>
    expect(NormalizedEvent.safeParse({ ...valid, summary: "x".repeat(301) }).success).toBe(false));
  it("rejects nested metadata objects", () =>
    expect(NormalizedEvent.safeParse({ ...valid, safeMetadata: { a: { b: 1 } } }).success).toBe(false));
  it("rejects bad timestamps", () =>
    expect(NormalizedEvent.safeParse({ ...valid, timestamp: "yesterday" }).success).toBe(false));
  it("EventInput allows omitting server-filled fields", () => {
    expect(
      EventInput.safeParse({
        sourceType: "manual",
        sessionId: null,
        eventType: "agent.state",
        status: "info",
        summary: "x",
      }).success,
    ).toBe(true);
  });
});

describe("redact", () => {
  it("removes API keys and tokens", () => {
    expect(redact("curl -H 'Authorization: Bearer abcdefghijklmnop' x")).not.toContain("abcdefghijklmnop");
    expect(redact("key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV")).toContain("[REDACTED]");
    expect(redact("API_KEY=hunter2hunter2 run")).not.toContain("hunter2");
    expect(redact("run --token abcdef123456")).not.toContain("abcdef123456");
  });
  it("truncates and collapses whitespace", () => {
    expect(redact("a   b\n\nc")).toBe("a b c");
    expect(redact("x".repeat(500), 50).length).toBe(50);
  });
});

describe("safePathLabel", () => {
  it("keeps basename only", () => expect(safePathLabel("C:\\Users\\me\\proj\\src\\app.ts")).toBe("app.ts"));
  it("hides sensitive files", () => {
    expect(safePathLabel("/home/me/.env")).toBe("[sensitive file]");
    expect(safePathLabel("C:\\keys\\id_rsa")).toBe("[sensitive file]");
  });
});

describe("activityForTool", () => {
  it("maps tools conservatively", () => {
    expect(activityForTool("Read").activity).toBe("reading");
    expect(activityForTool("Edit").activity).toBe("coding");
    expect(activityForTool("Bash", "pnpm test").activity).toBe("testing");
    expect(activityForTool("Bash", "ffmpeg -i a.mp4 b.mp4").activity).toBe("rendering");
    expect(activityForTool("Bash", "ls").activity).toBe("coding");
    expect(activityForTool("WebSearch").activity).toBe("researching");
    expect(activityForTool("SomethingNew").activity).toBe("thinking");
  });
});
