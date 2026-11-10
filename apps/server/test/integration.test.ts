import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hook, makeApp, plain, ui } from "./helpers.js";
import { checkProjectHooks } from "../src/integration.js";
import { SUPPORTED_HOOKS } from "../src/normalize.js";
import type { AppHandle } from "../src/app.js";

let h: (AppHandle & { dataDir: string }) | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aio-proj-"));
function writeSettings(dir: string, events: readonly string[], extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  const hooks: Record<string, unknown> = {};
  for (const ev of events)
    hooks[ev] = [
      { matcher: "", hooks: [{ type: "command", command: 'node "C:/x/ai-office-hook.mjs"', async: true }] },
    ];
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ ...extra, hooks }));
}

describe("checkProjectHooks (read-only)", () => {
  it("reports every state without modifying anything", () => {
    expect(checkProjectHooks(null).state).toBe("no_folder");
    expect(checkProjectHooks(path.join(os.tmpdir(), "definitely-missing-aio")).state).toBe("folder_missing");

    const none = tmp();
    expect(checkProjectHooks(none).state).toBe("not_installed");

    const full = tmp();
    writeSettings(full, SUPPORTED_HOOKS);
    expect(checkProjectHooks(full)).toEqual({ state: "installed", missing: [] });

    const part = tmp();
    writeSettings(part, SUPPORTED_HOOKS.slice(0, 10));
    const r = checkProjectHooks(part);
    expect(r.state).toBe("partial");
    expect(r.missing).toEqual([...SUPPORTED_HOOKS.slice(10)]);

    const bad = tmp();
    fs.mkdirSync(path.join(bad, ".claude"));
    fs.writeFileSync(path.join(bad, ".claude", "settings.local.json"), "{ not json");
    expect(checkProjectHooks(bad).state).toBe("unreadable");

    // someone else's hooks and unrelated settings do not count as ours
    const foreign = tmp();
    fs.mkdirSync(path.join(foreign, ".claude"));
    fs.writeFileSync(
      path.join(foreign, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    expect(checkProjectHooks(foreign).state).toBe("not_installed");
    // the check never wrote anything
    expect(fs.readFileSync(path.join(bad, ".claude", "settings.local.json"), "utf8")).toBe("{ not json");
  });
});

describe("GET /api/integration/status", () => {
  it("is honest before and after the first real event", async () => {
    h = await makeApp();
    const before = (
      await h.app.inject({ method: "GET", url: "/api/integration/status", headers: plain(h) })
    ).json();
    expect(before.lastObserved).toBeNull();
    expect(before.observedEventsTotal).toBe(0);

    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/a", source: "startup" },
    });
    const after = (
      await h.app.inject({ method: "GET", url: "/api/integration/status", headers: plain(h) })
    ).json();
    expect(after.lastObserved.eventType).toBe("session.start");
    expect(after.observedEventsTotal).toBe(1);
    expect(after.observedSessionsLast24h).toBe(1);
  });

  it("does not count demo or manual events as real, and lists project hook state", async () => {
    h = await makeApp();
    const dir = tmp();
    writeSettings(dir, SUPPORTED_HOOKS);
    await h.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: ui(h),
      payload: { name: "P", kind: "app", folderPath: dir },
    });
    await h.app.inject({ method: "POST", url: "/api/demo/start", headers: ui(h) });
    const s = (
      await h.app.inject({ method: "GET", url: "/api/integration/status", headers: plain(h) })
    ).json();
    await h.app.inject({ method: "POST", url: "/api/demo/stop", headers: ui(h) });
    expect(s.observedEventsTotal).toBe(0);
    expect(s.lastObserved).toBeNull();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].hooks.state).toBe("installed");
  });

  it("counts spooled files that are waiting", async () => {
    h = await makeApp();
    fs.mkdirSync(path.join(h.dataDir, "spool"), { recursive: true });
    fs.writeFileSync(path.join(h.dataDir, "spool", "x.jsonl"), "");
    const s = (
      await h.app.inject({ method: "GET", url: "/api/integration/status", headers: plain(h) })
    ).json();
    expect(s.spoolPendingFiles).toBe(1);
  });
});

describe("registry: project linking after a session is already running", () => {
  it("moves the session to the project's department and lets subagents follow", async () => {
    h = await makeApp();
    const send = (payload: Record<string, unknown>) =>
      h!.app.inject({ method: "POST", url: "/api/hooks/claude", headers: hook(h!), payload });
    const cwd = "/work/linked/app";
    await send({ hook_event_name: "SessionStart", session_id: "S", cwd, source: "startup" });
    await send({
      hook_event_name: "SubagentStart",
      session_id: "S",
      cwd,
      agent_id: "A1",
      agent_type: "SomethingElse",
    });
    const before = (await h.app.inject({ method: "GET", url: "/api/agents", headers: plain(h) })).json() as {
      agentId: string;
      projectId: string | null;
      departmentId: string;
    }[];
    expect(before.find((a) => a.agentId === "sess:S")?.projectId).toBeNull();

    await h.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: ui(h),
      payload: { name: "App", kind: "app", folderPath: "/work/linked" },
    });
    await send({
      hook_event_name: "PreToolUse",
      session_id: "S",
      cwd,
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: `${cwd}/a.ts` },
    });
    const after = (await h.app.inject({ method: "GET", url: "/api/agents", headers: plain(h) })).json() as {
      agentId: string;
      projectId: string | null;
      departmentId: string;
    }[];
    const sess = after.find((a) => a.agentId === "sess:S");
    const sub = after.find((a) => a.agentId === "sub:S:A1");
    expect(sess?.projectId).not.toBeNull();
    expect(sess?.departmentId).toBe("dev");
    expect(sub?.projectId).toBe(sess?.projectId);
  });
});
