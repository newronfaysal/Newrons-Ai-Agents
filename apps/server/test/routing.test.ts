import { afterEach, describe, expect, it } from "vitest";
import { hook, makeApp, plain, ui } from "./helpers.js";
import type { AppHandle } from "../src/app.js";

let h: AppHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

let clock = Date.now() - 60_000;
const get = (url: string) => h!.app.inject({ url, headers: plain(h!) });
const tick = () => new Date((clock += 1000)).toISOString();

const send = (payload: Record<string, unknown>) =>
  h!.app.inject({
    method: "POST",
    url: "/api/hooks/claude",
    headers: hook(h!),
    payload: { ts: tick(), ...payload },
  });
const prompt = (session: string, text: string) =>
  send({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    cwd: "C:\\work\\x",
    prompt_text: text,
    prompt_length: text.length,
  });
const pre = (session: string, tool: string, extra: Record<string, unknown> = {}) =>
  send({ hook_event_name: "PreToolUse", session_id: session, tool_name: tool, ...extra });
const post = (session: string, tool: string, id: string, failed = false) =>
  send({
    hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
    session_id: session,
    tool_name: tool,
    tool_use_id: id,
  });
const stop = (session: string) => send({ hook_event_name: "Stop", session_id: session });

type Item = {
  id: string;
  sessionId: string;
  status: string;
  turn: string;
  title: string;
  stages: {
    departmentId: string;
    state: string;
    role: string;
    qaResult: string | null;
    evidence: unknown[];
  }[];
  decision: Record<string, unknown>;
};
const items = async (session?: string): Promise<Item[]> =>
  (await get(`/api/routing/items${session ? `?sessionId=${session}` : ""}`)).json();
const latest = async (session: string) => (await items(session))[0]!;
const depts = (i: Item) => i.stages.map((s) => s.departmentId);
const stageOf = (i: Item, d: string) => i.stages.find((s) => s.departmentId === d);
const deptState = async (d: string) =>
  (
    (await get("/api/routing/departments")).json() as {
      departmentId: string;
      state: string;
      mode: string | null;
    }[]
  ).find((x) => x.departmentId === d)!;

describe("Task Router: prompts from real hook events", () => {
  it("A–E: routes prompts to the expected departments and moves the one session avatar", async () => {
    h = await makeApp();
    const cases: [string, string[]][] = [
      ["Develop a new inventory app", ["planning", "dev"]],
      ["Edit this product reel", ["planning", "video"]],
      ["Research the market for power stations", ["planning"]],
      ["Run unit tests", ["planning", "qa"]],
      ["Develop an application and run tests", ["planning", "dev", "qa"]],
    ];
    for (const [i, [text, want]] of cases.entries()) {
      const s = `sess-case-${i}`;
      expect((await prompt(s, text)).statusCode).toBe(202);
      expect(depts(await latest(s))).toEqual(want);
    }
    // Planning shows active planning right after a (fresh) prompt, and the session avatar sits in Planning
    await send({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-now",
      prompt_text: "Build an app",
      ts: new Date().toISOString(),
    });
    expect(await deptState("planning")).toMatchObject({ state: "planning", mode: "active" });
    expect(h.ingestor.registry.get("sess:sess-case-4")?.departmentId).toBe("planning");
  });

  it("never stores prompt text anywhere in the database", async () => {
    h = await makeApp();
    await prompt("s-priv", "Build the Quetzalcoatl dashboard for our secret client Zorblax");
    for (const t of ["events", "work_items", "work_item_stages", "routing_log", "notifications"]) {
      const dump = JSON.stringify(h.db.prepare(`SELECT * FROM ${t}`).all());
      expect(dump, t).not.toContain("Quetzalcoatl");
      expect(dump, t).not.toContain("Zorblax");
    }
    const ev = h.db.prepare("SELECT safe_metadata FROM events WHERE event_type='prompt.submit'").get() as {
      safe_metadata: string;
    };
    expect(JSON.parse(ev.safe_metadata).promptLength).toBeGreaterThan(10);
  });

  it("keeps a prompt in Planning when its text is unavailable (spooled/offline replay)", async () => {
    h = await makeApp();
    await send({ hook_event_name: "UserPromptSubmit", session_id: "s-off", prompt_length: 30 });
    const it0 = await latest("s-off");
    expect(depts(it0)).toEqual(["planning"]);
    expect(it0.decision.intent).toBe("unavailable");
  });

  it("deduplicates: the same prompt event never creates two tasks or duplicate assignments", async () => {
    h = await makeApp();
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-dup",
      prompt_text: "Build an app",
      ts: tick(),
    };
    await send(payload);
    expect((await send(payload)).json().status).toBe("duplicate");
    expect(await items("s-dup")).toHaveLength(1);
    const n = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM work_item_stages s JOIN work_items w ON w.id=s.work_item_id WHERE w.session_id='s-dup'",
      )
      .get() as { n: number };
    expect(Number(n.n)).toBe(2);
  });
});

describe("Task Router: observed activity", () => {
  it("G: a real test command during an app task activates QA and records evidence", async () => {
    h = await makeApp();
    await prompt("s-g", "Develop a new inventory app"); // no testing words in the prompt
    await pre("s-g", "Edit", { tool_input: { file_path: "C:\\x\\app.ts" } });
    let it0 = await latest("s-g");
    expect(stageOf(it0, "dev")!.state).toBe("working");
    expect(stageOf(it0, "planning")!.state).toBe("completed"); // delegated, back to monitoring
    expect(stageOf(it0, "qa")).toBeUndefined();
    expect(h.ingestor.registry.get("sess:s-g")?.departmentId).toBe("dev");

    await pre("s-g", "Bash", { tool_use_id: "tu-test-1", tool_input: { command: "pnpm vitest run" } });
    it0 = await latest("s-g");
    expect(stageOf(it0, "qa")!.state).toBe("testing");
    expect(stageOf(it0, "dev")!.state).toBe("waiting");
    expect((await deptState("qa")).state).toBe("testing");
    expect(h.ingestor.registry.get("sess:s-g")?.departmentId).toBe("qa"); // same avatar, walked to the QA lab

    await post("s-g", "Bash", "tu-test-1");
    it0 = await latest("s-g");
    expect(stageOf(it0, "qa")).toMatchObject({ state: "completed", qaResult: "passed" });
    expect(stageOf(it0, "qa")!.evidence).toHaveLength(1);
    await stop("s-g");
    it0 = await latest("s-g");
    expect(it0.status).toBe("completed");
  });

  it("G: a failing test run is not approval: it returns work to App Development as a revision", async () => {
    h = await makeApp();
    await prompt("s-fail", "Fix the login bug");
    await pre("s-fail", "Edit");
    await pre("s-fail", "Bash", { tool_use_id: "tu-f", tool_input: { command: "npm test" } });
    await post("s-fail", "Bash", "tu-f", true);
    let it0 = await latest("s-fail");
    expect(stageOf(it0, "qa")).toMatchObject({ state: "error", qaResult: "failed" });
    expect(stageOf(it0, "dev")!.state).toBe("assigned");
    expect(it0.status).toBe("revision");
    await stop("s-fail");
    it0 = await latest("s-fail");
    expect(it0.status).toBe("revision"); // never "completed" with failing tests
    // a follow-up fix prompt continues the same task as a new revision
    await prompt("s-fail", "Fix the bugs found during testing");
    expect(await items("s-fail")).toHaveLength(1);
    // user acceptance is explicit and recorded as such
    const r = await h.app.inject({
      method: "POST",
      url: `/api/routing/items/${it0.id}/action`,
      headers: ui(h),
      payload: { action: "accept" },
    });
    expect(r.statusCode).toBe(200);
    expect((await latest("s-fail")).status).toBe("accepted");
  });

  it("requires verification when QA was requested but no test ran", async () => {
    h = await makeApp();
    await prompt("s-v", "Develop an application and run tests");
    await pre("s-v", "Write");
    await stop("s-v");
    const it0 = await latest("s-v");
    expect(it0.status).toBe("awaiting_verification");
    expect(stageOf(it0, "qa")!.state).toBe("waiting");
  });

  it("does not claim work that was never observed", async () => {
    h = await makeApp();
    await prompt("s-nowork", "Develop a new inventory app");
    await stop("s-nowork"); // Claude only answered, no tools
    const it0 = await latest("s-nowork");
    expect(it0.status).toBe("waiting");
    expect(stageOf(it0, "dev")!.state).toBe("waiting");
  });

  it("I: a session that ends mid-turn marks the task interrupted, not completed, and keeps history", async () => {
    h = await makeApp();
    await prompt("s-i", "Build a new dashboard");
    await pre("s-i", "Edit");
    await send({ hook_event_name: "SessionEnd", session_id: "s-i", reason: "other" });
    const it0 = await latest("s-i");
    expect(it0.status).toBe("interrupted");
    expect(it0.stages.length).toBe(2);
    const log = (await get(`/api/routing/log?itemId=${it0.id}`)).json() as { kind: string }[];
    expect(log.some((l) => l.kind === "decision")).toBe(true);
    expect(log.some((l) => l.kind === "close")).toBe(true);
  });

  it("marks silent mid-turn tasks unknown after the inactivity timeout (never completed)", async () => {
    h = await makeApp();
    await prompt("s-quiet", "Build a new dashboard");
    await pre("s-quiet", "Edit");
    const later = clock + 31 * 60_000;
    // working → shown as waiting/stale after the inactivity timeout
    const mid = h.ingestor.router.departmentStates(clock + 5 * 60_000).find((d) => d.departmentId === "dev")!;
    expect(mid).toMatchObject({ state: "waiting", stale: true });
    h.ingestor.router.tick(later);
    expect((await latest("s-quiet")).status).toBe("unknown");
  });

  it("J: two concurrent sessions update their own tasks and departments without duplicates", async () => {
    h = await makeApp();
    await prompt("s-a", "Develop a new inventory app");
    await prompt("s-b", "Edit this product reel");
    await pre("s-a", "Edit");
    await pre("s-b", "Bash", { tool_input: { command: "ffmpeg -i in.mp4 -t 5 out.mp4" } });
    await pre("s-a", "Write");
    const a = await latest("s-a");
    const b = await latest("s-b");
    expect(depts(a)).toEqual(["planning", "dev"]);
    expect(depts(b)).toEqual(["planning", "video"]);
    expect(stageOf(a, "dev")!.state).toBe("working");
    expect(stageOf(b, "video")!.state).toBe("working");
    expect(h.ingestor.registry.get("sess:s-a")?.departmentId).toBe("dev");
    expect(h.ingestor.registry.get("sess:s-b")?.departmentId).toBe("video");
    expect((await deptState("dev")).state).toBe("working");
    expect((await deptState("video")).state).toBe("working");
    // exactly one avatar per session
    const mine = h.ingestor.registry.snapshot().filter((x) => x.sessionId === "s-a" || x.sessionId === "s-b");
    expect(mine).toHaveLength(2);
    await stop("s-a");
    expect((await latest("s-a")).status).toBe("completed");
    expect((await latest("s-b")).status).toBe("in_progress");
  });

  it("ffmpeg in an app task stays App Development work (no automatic Video Editor)", async () => {
    h = await makeApp();
    await prompt("s-app-ff", "Develop an app to edit videos");
    await pre("s-app-ff", "Bash", { tool_input: { command: "ffmpeg -version" } });
    const it0 = await latest("s-app-ff");
    expect(depts(it0)).toEqual(["planning", "dev"]);
    expect(stageOf(it0, "dev")!.state).toBe("working");
  });

  it("permission prompts block the active department until activity resumes", async () => {
    h = await makeApp();
    await prompt("s-perm", "Build a new dashboard");
    await pre("s-perm", "Edit");
    await send({ hook_event_name: "PermissionRequest", session_id: "s-perm", tool_name: "Bash" });
    expect(stageOf(await latest("s-perm"), "dev")!.state).toBe("blocked");
    await pre("s-perm", "Bash", { tool_input: { command: "ls" } });
    expect(stageOf(await latest("s-perm"), "dev")!.state).toBe("working");
  });
});

describe("Team Automation API", () => {
  it("test prompt is a dry run: decision returned, nothing stored", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "POST",
      url: "/api/routing/test",
      headers: ui(h),
      payload: { prompt: "Edit a reel and verify the subtitles" },
    });
    expect(r.json().departments).toEqual(["planning", "video", "qa"]);
    expect(await items()).toHaveLength(0);
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM routing_log").get() as { n: number }).n)).toBe(0);
  });

  it("lets you add trigger words, disable rules and protects built-ins", async () => {
    h = await makeApp();
    const rules = (await get("/api/routing/rules")).json() as { id: string; keywords: string[] }[];
    const video = rules.find((r) => r.id === "video-edit")!;
    await h.app.inject({
      method: "PATCH",
      url: "/api/routing/rules/video-edit",
      headers: ui(h),
      payload: { keywords: [...video.keywords, "vlog"] },
    });
    const t = await h.app.inject({
      method: "POST",
      url: "/api/routing/test",
      headers: ui(h),
      payload: { prompt: "Vlog my day" },
    });
    expect(t.json().departments).toEqual(["planning", "video"]);
    expect(
      (await h.app.inject({ method: "DELETE", url: "/api/routing/rules/video-edit", headers: ui(h) }))
        .statusCode,
    ).toBe(409);
    await h.app.inject({
      method: "PATCH",
      url: "/api/routing/rules/video-edit",
      headers: ui(h),
      payload: { enabled: false },
    });
    const t2 = await h.app.inject({
      method: "POST",
      url: "/api/routing/test",
      headers: ui(h),
      payload: { prompt: "Vlog my day" },
    });
    expect(t2.json().departments).toEqual(["planning"]);
    // custom rules: invalid activity regex rejected; valid one created and deletable
    const bad = await h.app.inject({
      method: "POST",
      url: "/api/routing/rules",
      headers: ui(h),
      payload: {
        id: "qa-lint",
        name: "Lint as QA",
        departmentId: "qa",
        triggerType: "activity",
        keywords: ["(("],
        conditions: { activity: "verification-command" },
      },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/routing/rules",
      headers: ui(h),
      payload: {
        id: "qa-lint",
        name: "Lint as QA",
        departmentId: "qa",
        triggerType: "activity",
        keywords: ["\\beslint\\b"],
        conditions: { activity: "verification-command" },
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(
      (await h.app.inject({ method: "DELETE", url: "/api/routing/rules/qa-lint", headers: ui(h) }))
        .statusCode,
    ).toBe(204);
    // reset restores built-ins
    await h.app.inject({ method: "POST", url: "/api/routing/rules/reset", headers: ui(h) });
    const t3 = await h.app.inject({
      method: "POST",
      url: "/api/routing/test",
      headers: ui(h),
      payload: { prompt: "Edit this product reel" },
    });
    expect(t3.json().departments).toEqual(["planning", "video"]);
  });

  it("writes require the UI token", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "PATCH",
      url: "/api/routing/settings",
      headers: { host: `127.0.0.1:${h.cfg.port}`, "content-type": "application/json" },
      payload: { assignmentMode: "approval" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("approval mode holds assignments until you approve them", async () => {
    h = await makeApp();
    await h.app.inject({
      method: "PATCH",
      url: "/api/routing/settings",
      headers: ui(h),
      payload: { assignmentMode: "approval" },
    });
    await prompt("s-ap", "Build a new dashboard");
    let it0 = await latest("s-ap");
    expect(it0.status).toBe("pending_approval");
    expect(stageOf(it0, "dev")!.state).toBe("waiting");
    await pre("s-ap", "Edit");
    expect(stageOf(await latest("s-ap"), "dev")!.state).toBe("waiting");
    await h.app.inject({
      method: "POST",
      url: `/api/routing/items/${it0.id}/action`,
      headers: ui(h),
      payload: { action: "approve" },
    });
    it0 = await latest("s-ap");
    expect(stageOf(it0, "dev")!.state).toBe("working");
  });

  it("offline departments and QA auto-detection are configurable", async () => {
    h = await makeApp();
    await h.app.inject({
      method: "PATCH",
      url: "/api/routing/settings",
      headers: ui(h),
      payload: { qaAutoDetect: false, disabledDepartments: ["video"] },
    });
    expect((await deptState("video")).state).toBe("offline");
    await prompt("s-noqa", "Build a new dashboard");
    await pre("s-noqa", "Bash", { tool_input: { command: "pnpm test" } });
    expect(stageOf(await latest("s-noqa"), "qa")).toBeUndefined();
  });

  it("manual reassign and cancel are logged as user overrides", async () => {
    h = await makeApp();
    await prompt("s-re", "Research the market for power stations");
    const it0 = await latest("s-re");
    await h.app.inject({
      method: "POST",
      url: `/api/routing/items/${it0.id}/action`,
      headers: ui(h),
      payload: { action: "reassign", departments: ["dev", "qa"] },
    });
    expect(depts(await latest("s-re"))).toEqual(["planning", "dev", "qa"]);
    await h.app.inject({
      method: "POST",
      url: `/api/routing/items/${it0.id}/action`,
      headers: ui(h),
      payload: { action: "cancel" },
    });
    expect((await latest("s-re")).status).toBe("cancelled");
    const log = (await get(`/api/routing/log?itemId=${it0.id}`)).json() as { actor: string }[];
    expect(log.filter((l) => l.actor === "user").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses re-entrant routing (loop protection) without breaking ingestion", async () => {
    h = await makeApp();
    const router = h.ingestor.router as unknown as { busy: boolean };
    router.busy = true;
    const r = await prompt("s-loop", "Build an app");
    router.busy = false;
    expect(r.statusCode).toBe(202); // event still stored
    expect(await items("s-loop")).toHaveLength(0);
    const err = h.db.prepare("SELECT summary FROM routing_log WHERE kind='error'").get() as {
      summary: string;
    };
    expect(err.summary).toMatch(/loop protection/);
  });

  it("restores avatar departments from persisted tasks after a restart", async () => {
    h = await makeApp();
    await prompt("s-rs", "Build a new dashboard");
    await pre("s-rs", "Edit");
    h.ingestor.registry.setDepartment("sess:s-rs", "planning");
    h.ingestor.router.syncAgents();
    expect(h.ingestor.registry.get("sess:s-rs")?.departmentId).toBe("dev");
  });
});

describe("Planning department visibility", () => {
  it("a planning-only request stays 'planning' during its turn, goes stale when silent, and frees Planning after Stop", async () => {
    h = await makeApp();
    const t0 = Date.now();
    await send({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-research",
      prompt_text: "Research the market for power stations",
      ts: new Date(t0).toISOString(),
    });
    const at = (ms: number) =>
      h!.ingestor.router.departmentStates(t0 + ms).find((d) => d.departmentId === "planning")!;
    expect(at(30_000)).toMatchObject({ state: "planning", mode: "active" }); // past the 8 s pulse, still its turn
    expect(at(5 * 60_000)).toMatchObject({ state: "waiting", stale: true });
    await send({
      hook_event_name: "Stop",
      session_id: "s-research",
      ts: new Date(t0 + 60_000).toISOString(),
    });
    expect(at(61_000).state).toBe("available");
  });
  it("a delegated request frees Planning after the short pulse", async () => {
    h = await makeApp();
    const t0 = Date.now();
    await send({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-deleg",
      prompt_text: "Build a new dashboard",
      ts: new Date(t0).toISOString(),
    });
    const planning = (ms: number) =>
      h!.ingestor.router.departmentStates(t0 + ms).find((d) => d.departmentId === "planning")!;
    expect(planning(1000).state).toBe("planning");
    expect(planning(30_000)).toMatchObject({ state: "available", reason: "Coordinating 1 open task" });
  });
});
