import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { backupDb, migrate, openAndMigrate, openDb, pruneEvents, seed } from "../src/db.js";
import { fixture, hook, makeApp, makeListening } from "./helpers.js";
import { DEMO_SCENARIO } from "../src/demo.js";
import { spoolDir, drainSpool } from "../src/spool.js";
import type { AppHandle } from "../src/app.js";
import type { WsMessage } from "@ai-office/shared";

const handles: AppHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});
const track = <T extends AppHandle>(h: T) => (handles.push(h), h);

describe("database migrations", () => {
  it("applies migrations once and is idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual(["001_init.sql", "002_routing.sql"]);
    expect(migrate(db)).toEqual([]);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    for (const t of [
      "projects",
      "tasks",
      "task_dependencies",
      "task_assignments",
      "workflow_transitions",
      "events",
      "artifacts",
      "approvals",
      "notifications",
      "integration_settings",
      "execution_jobs",
      "app_settings",
      "profile",
      "departments",
      "role_definitions",
      "agents",
      "sessions",
    ]) {
      expect(tables).toContain(t);
    }
  });
  it("seeds four departments and fourteen roles without overwriting edits", () => {
    const db = openAndMigrate(":memory:");
    expect((db.prepare("SELECT COUNT(*) n FROM departments").get() as { n: number }).n).toBe(4);
    expect((db.prepare("SELECT COUNT(*) n FROM role_definitions").get() as { n: number }).n).toBe(14);
    db.prepare("UPDATE role_definitions SET name='Renamed' WHERE id='video-editor'").run();
    migrate(db);
    seed(db); // re-running the seed must not overwrite the user's edit
    expect(
      (db.prepare("SELECT name FROM role_definitions WHERE id='video-editor'").get() as { name: string })
        .name,
    ).toBe("Renamed");
  });
  it("persists across reopen (projects and tasks survive restarts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-db-"));
    const file = path.join(dir, "t.db");
    let db = openAndMigrate(file);
    db.prepare(
      "INSERT INTO projects(id,name,kind,created_at,updated_at) VALUES ('p','Keep','app','a','a')",
    ).run();
    db.close();
    db = openAndMigrate(file);
    expect((db.prepare("SELECT name FROM projects WHERE id='p'").get() as { name: string }).name).toBe(
      "Keep",
    );
    expect(migrate(db)).toEqual([]);
    db.close();
  });
  it("makes a restorable backup and keeps only the newest N", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-bk-"));
    const db = openAndMigrate(path.join(dir, "t.db"));
    db.prepare(
      "INSERT INTO projects(id,name,kind,created_at,updated_at) VALUES ('p','Saved','app','a','a')",
    ).run();
    const files: string[] = [];
    for (let i = 0; i < 4; i++) {
      files.push(backupDb(db, dir, 2));
      fs.utimesSync(files.at(-1)!, new Date(), new Date());
    }
    const kept = fs.readdirSync(path.join(dir, "backups"));
    expect(kept.length).toBeLessThanOrEqual(2);
    const restored = new DatabaseSync(path.join(dir, "backups", kept.at(-1)!));
    expect((restored.prepare("SELECT name FROM projects").get() as { name: string }).name).toBe("Saved");
    restored.close();
    db.close();
  });
  it("prunes old events only (controlled retention)", () => {
    const db = openAndMigrate(":memory:");
    const ins = db.prepare(
      "INSERT INTO events(event_id,ts,received_at,source_type,event_type,status,summary) VALUES (?,?,?,?,?,?,?)",
    );
    ins.run("old-event-1", "2020-01-01T00:00:00.000Z", "x", "observed", "stop", "info", "old");
    ins.run("new-event-1", new Date().toISOString(), "x", "observed", "stop", "info", "new");
    expect(pruneEvents(db, 30)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBe(1);
  });
});

describe("restart recovery and interrupted sessions", () => {
  it("restores agents after a restart without claiming anything finished", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-rr-"));
    const dbFile = path.join(dir, "t.db");
    const a = await makeApp({ dataDir: dir, dbFile });
    for (const n of ["session-start", "pretool-read", "subagent-start"]) {
      await a.app.inject({ method: "POST", url: "/api/hooks/claude", headers: hook(a), payload: fixture(n) });
    }
    await a.close(); // simulates a crash/restart: no SessionEnd was ever received
    const b = track(await makeApp({ dataDir: dir, dbFile }));
    const agents = b.ingestor.registry.snapshot();
    const main = agents.find((x) => x.agentId === "sess:sess-abc")!;
    const sub = agents.find((x) => x.agentId === "sub:sess-abc:ag_1")!;
    expect(main).toBeTruthy();
    expect(sub).toBeTruthy();
    expect(main.freshness).toBe("live");
    expect(main.activity).not.toBe("finished");
    expect(main.lastOperation).toBeTruthy();
    // and a long silence afterwards leaves it stale, never "completed"
    const stale = b.ingestor.registry
      .snapshot(Date.now() + 30 * 60_000)
      .find((x) => x.agentId === "sess:sess-abc")!;
    expect(stale.freshness).toBe("stale");
  });
  it("keeps an aborted session (SessionEnd never sent) distinguishable from a finished one", async () => {
    const h = track(await makeApp());
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: { ...fixture("session-start"), session_id: "aborted" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: { ...fixture("session-start"), session_id: "done" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: { ...fixture("session-end"), session_id: "done" },
    });
    const snap = h.ingestor.registry.snapshot(Date.now() + 5 * 60_000);
    expect(snap.find((a) => a.agentId === "sess:aborted")?.freshness).toBe("stale");
    expect(snap.find((a) => a.agentId === "sess:done")?.freshness).toBe("ended");
  });
});

describe("spool (safe buffering)", () => {
  it("drains buffered hook payloads once and tolerates corrupt lines", async () => {
    const h = track(await makeApp());
    const dir = spoolDir(h.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ ...fixture("session-start"), eventId: "spool-evt-0001" }),
      "{not json",
      JSON.stringify({ ...fixture("pretool-read"), eventId: "spool-evt-0002" }),
    ];
    fs.writeFileSync(path.join(dir, "a.jsonl"), lines.join("\n") + "\n");
    expect(drainSpool(h.dataDir, h.ingestor)).toEqual({ files: 1, events: 2 });
    expect(fs.readdirSync(dir)).toHaveLength(0);
    fs.writeFileSync(path.join(dir, "b.jsonl"), lines[0] + "\n"); // replay => deduplicated
    expect(drainSpool(h.dataDir, h.ingestor).events).toBe(0);
  });
});

describe("demo mode", () => {
  it("emits only simulated, non-persisted events and cleans up on stop", async () => {
    const h = track(await makeApp());
    const seen: WsMessage[] = [];
    h.ingestor.setBroadcast((m) => seen.push(m));
    for (const step of DEMO_SCENARIO) h.demo.emit(step); // instant replay, deterministic
    const evs = seen.filter((m): m is Extract<WsMessage, { type: "event" }> => m.type === "event");
    expect(evs).toHaveLength(DEMO_SCENARIO.length);
    expect(evs.every((m) => m.event.sourceType === "demo" && m.event.summary.startsWith("[SIMULATED]"))).toBe(
      true,
    );
    expect((h.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBe(0);
    expect((h.db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n).toBe(0);
    const demoAgents = h.ingestor.registry.snapshot().filter((a) => a.origin === "demo");
    expect(demoAgents.length).toBeGreaterThanOrEqual(10);
    expect(new Set(demoAgents.map((a) => a.departmentId))).toEqual(
      new Set(["planning", "video", "dev", "qa"]),
    );
    h.demo.stop();
    expect(h.ingestor.registry.snapshot().some((a) => a.origin === "demo")).toBe(false);
  });
  it("demo agents are never mistaken for observed ones", async () => {
    const h = track(await makeApp());
    h.demo.emit(DEMO_SCENARIO[0]!);
    const a = h.ingestor.registry.snapshot().find((x) => x.agentId === "demo:project-manager")!;
    expect(a.origin).toBe("demo");
    expect(a.sessionId).toBe("demo-session");
  });
});

describe("websocket", () => {
  const connect = (url: string) =>
    new Promise<{ ws: WebSocket; msgs: WsMessage[] }>((resolve, reject) => {
      const ws = new WebSocket(url);
      const msgs: WsMessage[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
      ws.on("open", () => resolve({ ws, msgs }));
      ws.on("error", reject);
    });
  const until = async (fn: () => boolean, ms = 3000) => {
    const t = Date.now();
    while (!fn()) {
      if (Date.now() - t > ms) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  it("sends hello + snapshot on connect and streams live events", async () => {
    const h = track(await makeListening());
    const { ws, msgs } = await connect(`ws://127.0.0.1:${h.port}/ws`);
    await until(() => msgs.some((m) => m.type === "agents"));
    expect(msgs[0]?.type).toBe("hello");
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: fixture("session-start"),
    });
    await until(() => msgs.some((m) => m.type === "event"));
    expect(msgs.find((m) => m.type === "event")).toMatchObject({
      event: { eventType: "session.start", sourceType: "observed" },
    });
    ws.close();
  });
  it("lets a client reconnect and resync the current state after the socket drops", async () => {
    const h = track(await makeListening());
    const first = await connect(`ws://127.0.0.1:${h.port}/ws`);
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: fixture("session-start"),
    });
    first.ws.terminate();
    await h.app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: hook(h),
      payload: fixture("pretool-read"),
    }); // happens while disconnected
    const second = await connect(`ws://127.0.0.1:${h.port}/ws`);
    await until(() => second.msgs.some((m) => m.type === "agents"));
    const snap = second.msgs.find((m): m is Extract<WsMessage, { type: "agents" }> => m.type === "agents")!;
    expect(snap.agents.find((a) => a.agentId === "sess:sess-abc")?.activity).toBe("reading");
    second.ws.close();
  });
  it("rejects websocket upgrades from foreign origins", async () => {
    const h = track(await makeListening());
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { origin: "http://evil.example" });
        ws.on("open", () => resolve("open"));
        ws.on("unexpected-response", (_r, res) => reject(new Error(`status ${res.statusCode}`)));
        ws.on("error", reject);
      }),
    ).rejects.toThrow(/403/);
  });
});

describe("demo stop over a live socket", () => {
  it("removes simulated avatars from connected dashboards immediately", async () => {
    const h = track(await makeListening());
    const msgs: WsMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    const headers = {
      "x-ai-office-ui": h.tokens.uiToken,
      "content-type": "application/json",
      host: `127.0.0.1:${h.port}`,
    };
    await h.app.inject({ method: "POST", url: "/api/demo/start", headers, payload: { speed: 20 } });
    const agentsMsgs = () =>
      msgs.filter((m): m is Extract<WsMessage, { type: "agents" }> => m.type === "agents");
    const t0 = Date.now();
    while (!agentsMsgs().some((m) => m.agents.some((a) => a.origin === "demo")) && Date.now() - t0 < 3000)
      await new Promise((r) => setTimeout(r, 20));
    expect(agentsMsgs().some((m) => m.agents.some((a) => a.origin === "demo"))).toBe(true);
    msgs.length = 0;
    await h.app.inject({ method: "POST", url: "/api/demo/stop", headers });
    // Snapshots sent before the stop can still be in flight on the socket, so wait for the newest one to be
    // demo-free rather than asserting on whichever message happens to arrive first.
    const t1 = Date.now();
    while (
      (!agentsMsgs().length ||
        agentsMsgs()
          .at(-1)!
          .agents.some((a) => a.origin === "demo")) &&
      Date.now() - t1 < 3000
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(
      agentsMsgs()
        .at(-1)!
        .agents.some((a) => a.origin === "demo"),
    ).toBe(false);
    ws.close();
  });
});
