import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_SETTINGS,
  DEFAULT_RULES,
  classifyActivity,
  classifyPrompt,
  matchPhraseAt,
  stripNonInstructions,
  type RoutingRule,
} from "./routing.js";

const route = (p: string, ctx = {}) =>
  classifyPrompt(p, DEFAULT_RULES, DEFAULT_ROUTING_SETTINGS, ctx).departments;

describe("classifyPrompt: required scenarios", () => {
  it("A: 'Develop a new inventory app' → Planning + App Development", () =>
    expect(route("Develop a new inventory app")).toEqual(["planning", "dev"]));
  it("B: 'Edit this product reel' → Planning + Video Editor", () =>
    expect(route("Edit this product reel")).toEqual(["planning", "video"]));
  it("C: 'Research the market for power stations' → Planning only", () =>
    expect(route("Research the market for power stations")).toEqual(["planning"]));
  it("D: 'Run unit tests' → Planning + QA", () =>
    expect(route("Run unit tests")).toEqual(["planning", "qa"]));
  it("E: 'Develop an application and run tests' → Planning → App Development → QA, in sequence", () => {
    const d = classifyPrompt("Develop an application and run tests", DEFAULT_RULES);
    expect(d.departments).toEqual(["planning", "dev", "qa"]);
    expect(d.stages.map((s) => s.role)).toEqual(["coordinator", "producer", "verifier"]);
  });
  it("F: 'Research how to develop a mobile app' → Planning only", () =>
    expect(route("Research how to develop a mobile app")).toEqual(["planning"]));
  it("H: 'develop' inside quoted documentation does not activate App Development", () => {
    const d = classifyPrompt(
      'Summarize this paragraph from our docs: "We develop and build custom software for retail clients."',
      DEFAULT_RULES,
    );
    expect(d.departments).toEqual(["planning"]);
    expect(d.suppressed.some((s) => s.keyword === "develop" && /quoted/.test(s.reason))).toBe(true);
  });
  it("H: 'develop' in code blocks and block quotes is ignored", () => {
    expect(route("Proofread this:\n```\nnpm run develop && build app\n```")).toEqual(["planning"]);
    expect(route("> We develop software\nWhat does this mean?")).toEqual(["planning"]);
  });
  it("H: 'develop' in an unrelated statement is not an instruction", () =>
    expect(
      route("Our company develops software for retailers. Write a tagline for the homepage banner"),
    ).toEqual(["planning"]));
});

describe("classifyPrompt: intent awareness", () => {
  it.each([
    ["Build a new dashboard", ["planning", "dev"]],
    ["Implement this feature", ["planning", "dev"]],
    ["Refactor my existing code", ["planning", "dev"]],
    ["Fix the login bug", ["planning", "dev", "qa"]],
    ["Fix the bugs found during testing", ["planning", "dev", "qa"]],
    ["Create subtitles for my video", ["planning", "video"]],
    ["Render this video in 9:16", ["planning", "video"]],
    ["Trim the first five seconds", ["planning", "video"]],
    ["Edit a reel and verify the subtitles", ["planning", "video", "qa"]],
    ["Develop an app to edit videos", ["planning", "dev"]],
    ["Research software development trends", ["planning"]],
    ["Give me video ideas for my channel", ["planning"]],
    ["Create a content strategy for our reels", ["planning"]],
    ["Research how to develop and test a mobile app", ["planning"]],
    ["Research the market, then build a landing page", ["planning", "dev"]],
    ["Please can you build the backend API", ["planning", "dev"]],
    ["Test the checkout flow", ["planning", "qa"]],
    ["Hello there", ["planning"]],
    ["Don't build anything yet, just research competitors", ["planning"]],
  ])("%s", (p, want) => expect(route(p)).toEqual(want));

  it("keeps QA last even when it is mentioned first", () =>
    expect(route("Test and fix the login bug")).toEqual(["planning", "dev", "qa"]));
  it("honours explicit assignment and exclusions", () => {
    expect(route("Look at the export settings @video")).toEqual(["planning", "video"]);
    expect(route("Send this to the QA team: check the signup form")).toEqual(["planning", "qa"]);
    expect(route("Fix the login bug, skip tests")).toEqual(["planning", "dev"]);
    expect(route("Planning only: build an app for invoices")).toEqual(["planning"]);
  });
  it("uses project context only for generic work requests", () => {
    expect(route("Make it shorter", { projectKind: "video" })).toEqual(["planning", "video"]);
    expect(route("Make it shorter", { projectKind: "app" })).toEqual(["planning", "dev"]);
    expect(route("Make it shorter")).toEqual(["planning"]);
    expect(route("Why is it slow?", { projectKind: "app" })).toEqual(["planning"]);
  });
  it("recognises continuations", () =>
    expect(classifyPrompt("continue", DEFAULT_RULES).intent).toBe("continuation"));
  it("respects disabled rules and departments", () => {
    const rules = DEFAULT_RULES.map((r) => (r.id === "video-edit" ? { ...r, enabled: false } : r));
    expect(classifyPrompt("Edit this product reel", rules).departments).toEqual(["planning"]);
    const s = { ...DEFAULT_ROUTING_SETTINGS, disabledDepartments: ["qa" as const] };
    expect(classifyPrompt("Run unit tests", DEFAULT_RULES, s).departments).toEqual(["planning"]);
  });
  it("supports custom trigger words", () => {
    const custom: RoutingRule = {
      ...DEFAULT_RULES[2]!,
      id: "video-vlog",
      keywords: ["vlog"],
      contextWords: [],
    };
    expect(classifyPrompt("Vlog my trip to Rome", [...DEFAULT_RULES, custom]).departments).toEqual([
      "planning",
      "video",
    ]);
  });
  it("never echoes prompt text in the decision", () => {
    const d = classifyPrompt("Build the Zanzibar secret project dashboard", DEFAULT_RULES);
    expect(JSON.stringify(d)).not.toContain("Zanzibar");
  });
});

describe("text helpers", () => {
  it("strips quotes, inline code and fences", () => {
    const r = stripNonInstructions('say "hello world" and `rm -rf`');
    expect(r.removed).toHaveLength(2);
    expect(r.clean).not.toContain("hello");
  });
  it("matches phrases with small gaps and inflections", () => {
    expect(matchPhraseAt(["fix", "the", "login", "bug"], ["fix", "bug"], 0)).toBe(4);
    expect(matchPhraseAt(["fixing", "bugs"], ["fix", "bug"], 0)).toBe(2);
    expect(matchPhraseAt(["fix", "it", "for", "the", "bug"], ["fix", "bug"], 0)).toBe(-1);
  });
});

describe("classifyActivity", () => {
  it("detects real test commands as QA", () => {
    expect(classifyActivity("Bash", "pnpm test --reporter=dot", DEFAULT_RULES).departmentId).toBe("qa");
    expect(classifyActivity("Bash", "python -m pytest -q", DEFAULT_RULES).kind).toBe("test-command");
    expect(classifyActivity("Bash", "ls -la", DEFAULT_RULES).departmentId).toBeNull();
    expect(classifyActivity("Edit", undefined, DEFAULT_RULES).kind).toBe("work");
  });
  it("can turn QA auto-detection off", () =>
    expect(
      classifyActivity("Bash", "vitest run", DEFAULT_RULES, {
        ...DEFAULT_ROUTING_SETTINGS,
        qaAutoDetect: false,
      }).departmentId,
    ).toBeNull());
  it("routes ffmpeg to video, scoped to video tasks/projects", () => {
    const a = classifyActivity("Bash", "ffmpeg -i in.mp4 -vf scale=1080:1920 out.mp4", DEFAULT_RULES);
    expect(a).toMatchObject({ departmentId: "video", scope: "task-or-project" });
  });
  it("ignores invalid custom regexes instead of crashing", () => {
    const bad: RoutingRule = {
      ...DEFAULT_RULES.find((r) => r.id === "act-qa-test-runner")!,
      id: "bad",
      keywords: ["(("],
    };
    expect(classifyActivity("Bash", "((", [bad]).departmentId).toBeNull();
  });
});
