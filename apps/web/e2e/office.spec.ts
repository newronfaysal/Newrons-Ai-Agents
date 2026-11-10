import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = path.join(os.tmpdir(), "ai-office-e2e-data");
const hookToken = () => fs.readFileSync(path.join(DATA, "hook-token"), "utf8").trim();
const hookPost = (page: Page, body: Record<string, unknown>) =>
  page.request.post("/api/hooks/claude", { headers: { "x-ai-office-token": hookToken() }, data: body });

const sceneReady = (page: Page) => page.waitForFunction(() => !!window.__aiOffice, null, { timeout: 20_000 });
const agent = (page: Page, id: string) =>
  page.evaluate((i) => window.__aiOffice!.state().agents.find((a) => a.id === i) ?? null, id);

test("office shows four departments with clearly marked roster placeholders", async ({ page }) => {
  await page.goto("/office");
  await sceneReady(page);
  const st = await page.evaluate(() => window.__aiOffice!.state());
  expect(new Set(st.agents.map((a) => a.dept))).toEqual(new Set(["planning", "video", "dev", "qa"]));
  expect(st.agents.every((a) => a.origin === "roster")).toBe(true);
  await expect(page.getByText("0 real · 0 simulated · 14 roster placeholders")).toBeVisible();
  await expect(page.getByTestId("demo-banner")).toHaveCount(0);
  await expect(page.getByTestId("conn-indicator")).toContainText("Connected");
});

test("demo mode is unmistakably simulated, animates avatars, and cleans up", async ({ page }) => {
  await page.goto("/office");
  await sceneReady(page);
  await page.getByTestId("demo-toggle").click();
  await expect(page.getByTestId("demo-banner")).toContainText("SIMULATED");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => window.__aiOffice!.state().agents.filter((a) => a.origin === "demo").length,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(2);
  const demo = await page.evaluate(() =>
    window.__aiOffice!.state().agents.filter((a) => a.origin === "demo"),
  );
  expect(
    demo.some((a) => a.activity === "meeting" || a.activity === "coding" || a.activity === "reading"),
  ).toBe(true);
  // nothing from the demo was persisted as real history
  const events = await (await page.request.get("/api/events?limit=50")).json();
  expect(events.filter((e: { sourceType: string }) => e.sourceType === "demo")).toHaveLength(0);
  await page.getByTestId("demo-toggle").click();
  await expect(page.getByTestId("demo-banner")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.__aiOffice!.state().agents.filter((a) => a.origin === "demo").length),
    )
    .toBe(0);
});

test("a real hook session creates a LIVE avatar, subagent, permission alert, and an honest end", async ({
  page,
}) => {
  await page.goto("/office");
  await sceneReady(page);
  const base = { session_id: "e2e-sess", cwd: "C:\\e2e\\proj" };
  expect((await hookPost(page, { ...base, hook_event_name: "SessionStart" })).status()).toBe(202);
  await expect.poll(() => agent(page, "sess:e2e-sess")).toMatchObject({ origin: "observed" });
  await hookPost(page, {
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: "t1",
    tool_input: { file_path: "C:\\e2e\\proj\\a.ts" },
  });
  await expect.poll(async () => (await agent(page, "sess:e2e-sess"))?.activity).toBe("coding");
  await hookPost(page, { ...base, hook_event_name: "SubagentStart", agent_id: "sa1", agent_type: "Plan" });
  await expect
    .poll(() => agent(page, "sub:e2e-sess:sa1"))
    .toMatchObject({ origin: "observed", dept: "planning" });
  await expect(page.getByText("2 real")).toBeVisible();
  await hookPost(page, {
    ...base,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf x" },
  });
  await expect.poll(async () => (await agent(page, "sess:e2e-sess"))?.activity).toBe("needs_attention");
  await expect(page.getByText("Claude is waiting for a permission decision").first()).toBeVisible();
  await hookPost(page, { ...base, hook_event_name: "SessionEnd", reason: "other" });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => fetch("/api/agents").then((r) => r.json()))).find(
          (a: { agentId: string }) => a.agentId === "sess:e2e-sess",
        )?.freshness,
    )
    .toBe("ended");
});

test("inspector opens on avatar click and states observation limits", async ({ page }) => {
  await page.goto("/office");
  await sceneReady(page);
  await hookPost(page, { hook_event_name: "SessionStart", session_id: "insp", cwd: "C:\\x\\inspect-me" });
  await expect.poll(() => agent(page, "sess:insp")).not.toBeNull();
  await page.evaluate(() => window.__aiOffice!.focus("planning"));
  await page.waitForTimeout(700);
  const canvas = page.getByTestId("office-canvas");
  const box = (await canvas.boundingBox())!;
  const p = (await page.evaluate(() => window.__aiOffice!.screenPos("sess:insp")))!;
  await page.mouse.click(box.x + p.x, box.y + p.y);
  const insp = page.getByRole("complementary", { name: "Agent inspector" });
  await expect(insp).toBeVisible();
  await expect(insp).toContainText("LIVE · OBSERVED");
  await expect(insp).toContainText("cannot start, pause, cancel or answer prompts");
  await page.keyboard.press("Escape");
  await expect(insp).toHaveCount(0);
});

test("camera: room buttons and keyboard move the view; reduced motion is honored", async ({ page }) => {
  await page.goto("/office");
  await sceneReady(page);
  const before = await page.evaluate(() => window.__aiOffice!.state().view);
  await page.getByRole("button", { name: "QA", exact: true }).click();
  await expect
    .poll(async () => await page.evaluate(() => window.__aiOffice!.state().view.scale))
    .toBeGreaterThan(before.scale * 1.3);
  await page.keyboard.press("0");
  await expect
    .poll(async () => await page.evaluate(() => window.__aiOffice!.state().view.scale))
    .toBeCloseTo(before.scale, 1);
  await page.getByRole("button", { name: /Reduced motion/ }).click();
  expect(await page.evaluate(() => window.__aiOffice!.state().reduced)).toBe(true);
  await page.getByRole("button", { name: "Pause animation" }).click();
  expect(await page.evaluate(() => window.__aiOffice!.state().paused)).toBe(true);
});

test("projects: create, add tasks, enforce workflow rules, approval gate, persistence across reload", async ({
  page,
}) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("June reels");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "June reels" })).toBeVisible();
  await expect(page.getByText("1080x1920")).toBeVisible();
  await page.getByLabel("New task title").fill("Cut the hook");
  await page.getByLabel("New task title").press("Enter");
  const card = page.getByTestId("task-card").filter({ hasText: "Cut the hook" });
  await expect(card).toBeVisible();
  // illegal jump is rejected with an explanation and the task stays put
  await card.getByLabel("Move Cut the hook").selectOption("completed");
  await expect(page.getByText(/Cannot move a task from backlog to completed/)).toBeVisible();
  await expect(page.getByTestId("col-backlog").getByText("Cut the hook")).toBeVisible();
  for (const to of ["planned", "in_progress", "qa"]) {
    await page
      .getByTestId("task-card")
      .filter({ hasText: "Cut the hook" })
      .getByLabel("Move Cut the hook")
      .selectOption(to);
    await expect(page.getByTestId(`col-${to}`).getByText("Cut the hook")).toBeVisible();
  }
  // approval gate
  await page
    .getByTestId("task-card")
    .filter({ hasText: "Cut the hook" })
    .getByRole("button", { name: /Cut the hook/ })
    .click();
  await page.getByLabel("Requires human approval to complete").click();
  await expect(page.getByLabel("Requires human approval to complete")).toBeChecked();
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await page
    .getByTestId("task-card")
    .filter({ hasText: "Cut the hook" })
    .getByLabel("Move Cut the hook")
    .selectOption("completed");
  await expect(page.getByText(/Human approval is required/)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page
    .getByTestId("task-card")
    .filter({ hasText: "Cut the hook" })
    .getByLabel("Move Cut the hook")
    .selectOption("completed");
  await expect(page.getByTestId("col-completed").getByText("Cut the hook")).toBeVisible();
  await page.reload();
  await page.getByText("June reels").first().click();
  await expect(page.getByTestId("col-completed").getByText("Cut the hook")).toBeVisible();
});

test("integration page is honest about capabilities", async ({ page }) => {
  await page.goto("/integration");
  await expect(
    page.getByText("Not enabled. This build never starts, pauses, cancels or retries Claude tasks."),
  ).toBeVisible();
  await expect(page.getByText(/project-local hooks/i).first()).toBeVisible();
});

test("a dropped connection is shown honestly, then reconnects and resyncs missed state", async ({ page }) => {
  await page.goto("/office");
  await sceneReady(page);
  await hookPost(page, { hook_event_name: "SessionStart", session_id: "resync", cwd: "C:\\x\\resync" });
  await expect.poll(() => agent(page, "sess:resync")).not.toBeNull();
  await page.evaluate(() => (window as unknown as { __aiOfficeWs: { drop(): void } }).__aiOfficeWs.drop());
  await expect(page.getByRole("alert").filter({ hasText: /Disconnected|Connecting/ })).toBeVisible();
  // something happens while we are disconnected
  await hookPost(page, {
    hook_event_name: "PreToolUse",
    session_id: "resync",
    cwd: "C:\\x\\resync",
    tool_name: "Read",
    tool_use_id: "r1",
    tool_input: { file_path: "C:\\x\\a.md" },
  });
  await expect(page.getByTestId("conn-indicator")).toContainText("Connected", { timeout: 15_000 });
  await expect
    .poll(async () => (await agent(page, "sess:resync"))?.activity, { timeout: 10_000 })
    .toBe("reading");
});

test("after a reload, real event history and integration status are still shown (not 'no events yet')", async ({
  page,
}) => {
  await page.goto("/office");
  await sceneReady(page);
  const base = { session_id: "e2e-history", cwd: "C:\\e2e\\history" };
  await hookPost(page, { ...base, hook_event_name: "SessionStart", source: "startup" });
  await hookPost(page, {
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_use_id: "h1",
    tool_input: { file_path: "C:\\e2e\\history\\notes.md" },
  });
  await expect.poll(() => agent(page, "sess:e2e-history")).toMatchObject({ origin: "observed" });

  await page.reload(); // everything that arrived "live" is gone from the page; only the server remembers
  await sceneReady(page);
  await expect(page.getByRole("log", { name: "Activity log" })).toBeVisible();
  await expect(page.getByRole("log", { name: "Activity log" })).toContainText(
    /reading files|Session started/,
  );

  await page.goto("/integration");
  const last = page.getByTestId("last-real-event");
  await expect(last).not.toContainText("No real events received yet");
  await expect(last).toContainText(/stored/);
});

test("task routing: prompt → Planning → App Development → QA, visible in the office and automation page", async ({
  page,
}) => {
  await page.goto("/office");
  await sceneReady(page);
  const base = { session_id: "e2e-route", cwd: "C:\\e2e\\route" };
  const now = () => new Date().toISOString();
  await hookPost(page, { ...base, hook_event_name: "SessionStart", ts: now() });
  await hookPost(page, {
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt_text: "Develop a new inventory app",
    ts: now(),
  });
  await expect(page.getByTestId("dept-planning")).toContainText("Planning");
  await expect.poll(async () => (await agent(page, "sess:e2e-route"))?.dept).toBe("planning");
  await hookPost(page, {
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: "r1",
    ts: now(),
  });
  await expect(page.getByTestId("dept-dev")).toContainText("Working");
  await expect.poll(async () => (await agent(page, "sess:e2e-route"))?.dept).toBe("dev");
  // a real test command activates QA even though the prompt never mentioned tests
  await hookPost(page, {
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "r2",
    tool_input: { command: "pnpm vitest run" },
    ts: now(),
  });
  await expect(page.getByTestId("dept-qa")).toContainText("Testing");
  await expect.poll(async () => (await agent(page, "sess:e2e-route"))?.dept).toBe("qa");
  await hookPost(page, {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "r2",
    ts: now(),
  });
  await expect(page.getByTestId("dept-qa")).toContainText("Completed");

  await page.goto("/integration/automation");
  await expect(page.getByTestId("automation-view")).toBeVisible();
  await page.getByLabel("Prompt to test").fill("Research how to develop a mobile app");
  await page.getByTestId("test-prompt-run").click();
  await expect(page.getByTestId("test-prompt-result")).toContainText("Planning handles it");
  await expect(page.getByTestId("work-item").first()).toContainText("tests passed");
  await expect(page.getByText("Routing history")).toBeVisible();
});
