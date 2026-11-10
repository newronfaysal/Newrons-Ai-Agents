import { afterEach, describe, expect, it } from "vitest";
import { fixture, hook, makeApp, plain } from "./helpers.js";
import { normalizeHook } from "../src/normalize.js";
import type { AppHandle } from "../src/app.js";

let h: AppHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const post = (name: string, extra: Record<string, unknown> = {}) =>
  h!.app.inject({
    method: "POST",
    url: "/api/hooks/claude",
    headers: hook(h!),
    payload: { ...fixture(name), ...extra },
  });

describe("hook payload fixtures -> normalized events", () => {
  const opts = { captureCommandText: false };
  it("maps every documented fixture to the expected event type", () => {
    const expected: Record<string, string> = {
      "session-start": "session.start",
      "user-prompt": "prompt.submit",
      "pretool-read": "tool.pre",
      posttool: "tool.post",
      "posttool-failure": "tool.failure",
      "subagent-start": "subagent.start",
      "subagent-stop": "subagent.stop",
      "permission-request": "permission.request",
      "notification-permission": "notification",
      "task-created": "task.created",
      "task-completed": "task.completed",
      stop: "stop",
      "stop-failure": "stop.failure",
      "session-end": "session.end",
    };
    for (const [name, type] of Object.entries(expected)) {
      expect(normalizeHook(fixture(name), opts)?.event.eventType, name).toBe(type);
    }
  });
  it("ignores unsupported hook events", () =>
    expect(normalizeHook(fixture("unknown-event"), opts)).toBeNull());
  it("is deterministic for identical payloads (dedup key)", () => {
    const ts = new Date("2026-01-01T00:00:00Z");
    expect(normalizeHook(fixture("pretool-read"), opts, ts)?.event.eventId).toBe(
      normalizeHook(fixture("pretool-read"), opts, ts)?.event.eventId,
    );
  });
  it("classifies ffmpeg and test commands without storing command text by default", () => {
    const ff = normalizeHook(fixture("pretool-bash-ffmpeg"), opts)!;
    expect(ff.event.safeMetadata.activity).toBe("rendering");
    expect(ff.event.safeMetadata.command).toBeUndefined();
    const t = normalizeHook(fixture("pretool-bash-test"), opts)!;
    expect(t.event.safeMetadata.activity).toBe("testing");
  });
  it("redacts secrets when command capture is enabled", () => {
    const n = normalizeHook(fixture("pretool-bash-secret"), { captureCommandText: true })!;
    const cmd = String(n.event.safeMetadata.command);
    expect(cmd).not.toContain("abcdefghijklmnopqrstuv");
    expect(cmd).not.toContain("supersecretvalue123");
  });
  it("hides sensitive file names", () => {
    const n = normalizeHook(fixture("pretool-edit-env"), opts)!;
    expect(n.event.safeMetadata.file).toBe("[sensitive file]");
    expect(JSON.stringify(n.event)).not.toContain(".env");
  });
});

describe("hook endpoint", () => {
  it("rejects missing or wrong tokens", async () => {
    h = await makeApp();
    const none = await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: { ...plain(h), "content-type": "application/json" },
      payload: fixture("session-start"),
    });
    expect(none.statusCode).toBe(401);
    const bad = await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: { ...hook(h), "x-ai-office-token": "x".repeat(64) },
      payload: fixture("session-start"),
    });
    expect(bad.statusCode).toBe(401);
  });
  it("does not accept the UI token on the hook endpoint", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: {
        "x-ai-office-ui": h.tokens.uiToken,
        "content-type": "application/json",
        host: `127.0.0.1:${h.cfg.port}`,
      },
      payload: fixture("session-start"),
    });
    expect(r.statusCode).toBe(401);
  });
  it("rejects foreign Host headers (DNS rebinding) and foreign origins", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "evil.example:4317" },
    });
    expect(r.statusCode).toBe(403);
    const o = await h.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { ...plain(h), origin: "http://evil.example" },
    });
    expect(o.statusCode).toBe(403);
  });
  it("accepts, deduplicates, and ignores", async () => {
    h = await makeApp();
    const a = await post("session-start", { eventId: "fixed-id-0001" });
    expect(a.statusCode).toBe(202);
    expect(a.json().status).toBe("accepted");
    const b = await post("session-start", { eventId: "fixed-id-0001" });
    expect(b.json().status).toBe("duplicate");
    const c = await post("unknown-event");
    expect(c.json().status).toBe("ignored");
    const count = h.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });
  it("refuses to let the observed/demo source be forged through /api/events", async () => {
    h = await makeApp();
    const base = { sessionId: "s", eventType: "agent.state", status: "info", summary: "x" };
    for (const sourceType of ["observed", "demo"]) {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/events",
        headers: hook(h),
        payload: { ...base, sourceType },
      });
      expect(r.statusCode).toBe(400);
    }
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/events",
      headers: hook(h),
      payload: { ...base, sourceType: "manual", agentId: "man:1" },
    });
    expect(ok.statusCode).toBe(202);
  });
  it("rejects invalid event bodies with a helpful error", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "POST",
      url: "/api/events",
      headers: hook(h),
      payload: { sourceType: "manual", eventType: "nope", status: "info", summary: "x", sessionId: null },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_event");
  });
});

describe("live session tracking from a replayed real-shaped session", () => {
  it("creates a real observed avatar, a real subagent, surfaces permissions, and ends honestly", async () => {
    h = await makeApp();
    for (const n of [
      "session-start",
      "pretool-read",
      "subagent-start",
      "subagent-tool",
      "permission-request",
    ])
      await post(n);
    let agents = h.ingestor.registry.snapshot();
    const main = agents.find((a) => a.agentId === "sess:sess-abc")!;
    const sub = agents.find((a) => a.agentId === "sub:sess-abc:ag_1")!;
    expect(main.origin).toBe("observed");
    expect(sub.origin).toBe("observed");
    expect(sub.roleId).toBe("project-manager"); // Plan -> Project Manager (configurable)
    expect(agents.find((a) => a.agentId === "roster:project-manager")).toBeUndefined(); // seat is occupied by a real agent
    expect(agents.find((a) => a.agentId === "roster:task-coordinator")?.origin).toBe("roster");
    expect(main.activity).toBe("needs_attention");
    const approvals = h.db.prepare("SELECT kind, status FROM approvals").all() as {
      kind: string;
      status: string;
    }[];
    expect(approvals).toEqual([{ kind: "claude-permission", status: "pending" }]);
    await post("subagent-stop");
    expect(h.ingestor.registry.snapshot().find((a) => a.agentId === "sub:sess-abc:ag_1")?.freshness).toBe(
      "ended",
    );
    await post("session-end");
    agents = h.ingestor.registry.snapshot();
    expect(agents.find((a) => a.agentId === "sess:sess-abc")?.freshness).toBe("ended");
  });
  it("clears needs_attention when later activity shows the prompt was resolved", async () => {
    h = await makeApp();
    await post("session-start");
    await post("permission-request");
    expect(h.ingestor.registry.get("sess:sess-abc")?.activity).toBe("needs_attention");
    await post("pretool-read");
    expect(h.ingestor.registry.get("sess:sess-abc")?.activity).toBe("reading");
  });
  it("never reports a silent session as finished: it becomes stale", async () => {
    h = await makeApp();
    await post("session-start");
    await post("pretool-read");
    const later = Date.now() + 10 * 60_000;
    const a = h.ingestor.registry.snapshot(later).find((x) => x.agentId === "sess:sess-abc")!;
    expect(a.freshness).toBe("stale");
    expect(a.activity).not.toBe("finished");
  });
  it("tool failure records an error but does not end the agent", async () => {
    h = await makeApp();
    await post("session-start");
    await post("posttool-failure");
    const a = h.ingestor.registry.get("sess:sess-abc")!;
    expect(a.errorMessage).toContain("exit code 1");
    expect(a.freshness).toBe("live");
  });
  it("Stop (end of turn) is idle, not session end", async () => {
    h = await makeApp();
    await post("session-start");
    await post("stop");
    const a = h.ingestor.registry.get("sess:sess-abc")!;
    expect(a.activity).toBe("idle");
    expect(a.freshness).toBe("live");
  });
  it("links sessions to a project by working directory and picks the department from its kind", async () => {
    h = await makeApp();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        "x-ai-office-ui": h.tokens.uiToken,
        "content-type": "application/json",
        host: `127.0.0.1:${h.cfg.port}`,
      },
      payload: { name: "June reels", kind: "video", folderPath: "C:\\Projects\\reels" },
    });
    const pid = created.json().id;
    await post("session-start");
    const a = h.ingestor.registry.get("sess:sess-abc")!;
    expect(a.departmentId).toBe("video");
    expect(a.projectId).toBe(pid);
  });
});
