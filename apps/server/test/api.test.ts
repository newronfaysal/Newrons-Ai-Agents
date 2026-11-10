import { afterEach, describe, expect, it } from "vitest";
import { makeApp, ui, plain } from "./helpers.js";
import type { AppHandle } from "../src/app.js";

let h: AppHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  h!.app.inject({
    method,
    url,
    headers: method === "GET" ? plain(h!) : ui(h!),
    payload: payload as object | undefined,
  });

async function setup() {
  h = await makeApp();
  const p = (await call("POST", "/api/projects", { name: "Reel", kind: "video" })).json();
  const mk = async (title: string, extra = {}) =>
    (await call("POST", "/api/tasks", { projectId: p.id, title, ...extra })).json();
  return { p, mk };
}

describe("security", () => {
  it("rejects writes without the UI token", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...plain(h), "content-type": "application/json" },
      payload: { name: "x", kind: "app" },
    });
    expect(r.statusCode).toBe(401);
  });
  it("hands the UI token out only with the custom header", async () => {
    h = await makeApp();
    expect((await call("GET", "/api/bootstrap")).statusCode).toBe(400);
    const ok = await h.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { ...plain(h), "x-requested-with": "ai-office" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().uiToken).toBe(h.tokens.uiToken);
  });
  it("does not leak the hook token", async () => {
    h = await makeApp();
    const r = await h.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { ...plain(h), "x-requested-with": "ai-office" },
    });
    expect(r.body).not.toContain(h.tokens.hookToken);
  });
});

describe("projects and tasks", () => {
  it("creates video projects with 9:16 defaults and filters/searches", async () => {
    const { p } = await setup();
    expect(p.aspectRatio).toBe("9:16");
    expect(p.outputResolution).toBe("1080x1920");
    await call("POST", "/api/projects", { name: "My app", kind: "app" });
    expect((await call("GET", "/api/projects?kind=app")).json()).toHaveLength(1);
    expect((await call("GET", "/api/projects?q=Ree")).json()).toHaveLength(1);
    expect((await call("GET", "/api/projects?q=%25")).json()).toHaveLength(0); // LIKE wildcards are escaped
  });
  it("archives projects", async () => {
    const { p } = await setup();
    await call("PATCH", `/api/projects/${p.id}`, { archived: true });
    expect((await call("GET", "/api/projects")).json()).toHaveLength(0);
    expect((await call("GET", "/api/projects?archived=1")).json()).toHaveLength(1);
  });
  it("validates input", async () => {
    h = await makeApp();
    expect((await call("POST", "/api/projects", { name: "", kind: "app" })).statusCode).toBe(400);
    expect((await call("POST", "/api/tasks", { projectId: "missing", title: "x" })).statusCode).toBe(404);
  });
  it("walks a task through backlog -> completed and records history", async () => {
    const { mk } = await setup();
    const t = await mk("Cut hook");
    for (const to of ["planned", "in_progress", "qa", "completed"]) {
      const r = await call("POST", `/api/tasks/${t.id}/transition`, { to });
      expect(r.statusCode, to).toBe(200);
    }
    const hist = (await call("GET", `/api/tasks/${t.id}/history`)).json();
    expect(hist.transitions).toHaveLength(4);
  });
  it("rejects illegal transitions with a reason", async () => {
    const { mk } = await setup();
    const t = await mk("x");
    const r = await call("POST", `/api/tasks/${t.id}/transition`, { to: "completed" });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toMatch(/Cannot move/);
  });
  it("enforces dependencies and rejects cycles", async () => {
    const { mk } = await setup();
    const a = await mk("a");
    const b = await mk("b");
    expect(
      (await call("POST", `/api/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id })).statusCode,
    ).toBe(201);
    expect(
      (await call("POST", `/api/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id })).statusCode,
    ).toBe(409);
    await call("POST", `/api/tasks/${b.id}/transition`, { to: "planned" });
    const blocked = await call("POST", `/api/tasks/${b.id}/transition`, { to: "in_progress" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().reason).toMatch(/dependencies/);
  });
  it("requires human approval, and returning for revision expires it and bumps the version", async () => {
    const { mk } = await setup();
    const t = await mk("Final cut", { requiresApproval: true });
    for (const to of ["planned", "in_progress", "qa"])
      await call("POST", `/api/tasks/${t.id}/transition`, { to });
    expect((await call("POST", `/api/tasks/${t.id}/transition`, { to: "completed" })).statusCode).toBe(409);
    const ap = (await call("POST", `/api/tasks/${t.id}/request-approval`)).json();
    await call("POST", `/api/approvals/${ap.id}/decide`, { decision: "approved" });
    const back = await call("POST", `/api/tasks/${t.id}/transition`, { to: "revision" });
    expect(back.json().version).toBe(2);
    const row = h!.db.prepare("SELECT status FROM approvals WHERE id=?").get(ap.id) as { status: string };
    expect(row.status).toBe("expired");
  });
  it("requires evidence for QA when asked", async () => {
    const { mk } = await setup();
    const t = await mk("Edit", { requiresEvidenceForQa: true });
    for (const to of ["planned", "in_progress"]) await call("POST", `/api/tasks/${t.id}/transition`, { to });
    expect((await call("POST", `/api/tasks/${t.id}/transition`, { to: "qa" })).statusCode).toBe(409);
    await call("POST", `/api/tasks/${t.id}/artifacts`, {
      kind: "video",
      label: "final.mp4",
      path: "C:\\out\\final.mp4",
    });
    expect((await call("POST", `/api/tasks/${t.id}/transition`, { to: "qa" })).statusCode).toBe(200);
  });
  it("lets the dashboard never decide a Claude permission prompt", async () => {
    h = await makeApp();
    h.db
      .prepare(
        "INSERT INTO approvals(id, kind, status, summary, requested_at) VALUES ('ap_x','claude-permission','pending','Permission requested','2026-01-01T00:00:00Z')",
      )
      .run();
    const r = await call("POST", "/api/approvals/ap_x/decide", { decision: "approved" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("not_supported");
  });
  it("cascades deletes and enforces foreign keys", async () => {
    const { mk } = await setup();
    const t = await mk("x");
    expect((await call("DELETE", `/api/tasks/${t.id}`)).statusCode).toBe(204);
    expect(() =>
      h!.db
        .prepare(
          "INSERT INTO tasks(id,project_id,title,created_at,updated_at) VALUES ('t','nope','x','a','b')",
        )
        .run(),
    ).toThrow();
  });
});

describe("roles", () => {
  it("lets the user remap subagent types to roles", async () => {
    h = await makeApp();
    await call("PATCH", "/api/roles/video-editor", { subagentTypes: ["video-agent"] });
    const roles = (await call("GET", "/api/roles")).json();
    expect(roles.find((r: { id: string }) => r.id === "video-editor").subagentTypes).toEqual(["video-agent"]);
  });
});
