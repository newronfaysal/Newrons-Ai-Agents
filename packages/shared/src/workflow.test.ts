import { describe, expect, it } from "vitest";
import { checkTransition, suggestedDepartment, wouldCreateCycle } from "./workflow.js";

const base = { requiresApproval: false, approved: false, dependencyStatuses: [] as const };

describe("checkTransition", () => {
  it("allows the happy path", () => {
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "backlog", to: "planned" }).ok).toBe(
      true,
    );
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "planned", to: "in_progress" }).ok).toBe(
      true,
    );
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "in_progress", to: "qa" }).ok).toBe(true);
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "qa", to: "completed" }).ok).toBe(true);
  });
  it("rejects skipping stages", () => {
    const r = checkTransition({ ...base, dependencyStatuses: [], from: "backlog", to: "completed" });
    expect(r.ok).toBe(false);
  });
  it("rejects no-op moves", () => {
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "qa", to: "qa" }).ok).toBe(false);
  });
  it("blocks on unfinished dependencies", () => {
    const r = checkTransition({
      ...base,
      dependencyStatuses: ["in_progress"],
      from: "planned",
      to: "in_progress",
    });
    expect(r).toEqual({ ok: false, reason: "Blocked by unfinished dependencies." });
  });
  it("allows start when dependencies are completed", () => {
    expect(
      checkTransition({ ...base, dependencyStatuses: ["completed"], from: "planned", to: "in_progress" }).ok,
    ).toBe(true);
  });
  it("requires approval to complete when flagged", () => {
    const denied = checkTransition({
      ...base,
      dependencyStatuses: [],
      requiresApproval: true,
      from: "qa",
      to: "completed",
    });
    expect(denied.ok).toBe(false);
    const ok = checkTransition({
      ...base,
      dependencyStatuses: [],
      requiresApproval: true,
      approved: true,
      from: "qa",
      to: "completed",
    });
    expect(ok.ok).toBe(true);
  });
  it("supports return-for-revision loop", () => {
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "qa", to: "revision" }).ok).toBe(true);
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "revision", to: "in_progress" }).ok).toBe(
      true,
    );
  });
  it("requires evidence for QA when the task asks for it", () => {
    const r = checkTransition({
      ...base,
      dependencyStatuses: [],
      requiresEvidenceForQa: true,
      hasEvidence: false,
      from: "in_progress",
      to: "qa",
    });
    expect(r.ok).toBe(false);
    const ok = checkTransition({
      ...base,
      dependencyStatuses: [],
      requiresEvidenceForQa: true,
      hasEvidence: true,
      from: "in_progress",
      to: "qa",
    });
    expect(ok.ok).toBe(true);
  });
  it("allows reopening a completed task into revision only", () => {
    expect(checkTransition({ ...base, dependencyStatuses: [], from: "completed", to: "revision" }).ok).toBe(
      true,
    );
    expect(
      checkTransition({ ...base, dependencyStatuses: [], from: "completed", to: "in_progress" }).ok,
    ).toBe(false);
  });
});

describe("wouldCreateCycle", () => {
  const edges = new Map<string, string[]>([
    ["b", ["a"]],
    ["c", ["b"]],
  ]);
  it("detects direct and transitive cycles", () => {
    expect(wouldCreateCycle(edges, "a", "a")).toBe(true);
    expect(wouldCreateCycle(edges, "a", "c")).toBe(true);
  });
  it("accepts valid edges", () => {
    expect(wouldCreateCycle(edges, "c", "a")).toBe(false);
    expect(wouldCreateCycle(edges, "d", "c")).toBe(false);
  });
});

describe("suggestedDepartment", () => {
  it("routes by status and project kind", () => {
    expect(suggestedDepartment("video", "in_progress")).toBe("video");
    expect(suggestedDepartment("app", "in_progress")).toBe("dev");
    expect(suggestedDepartment("app", "qa")).toBe("qa");
    expect(suggestedDepartment("general", "planned")).toBe("planning");
  });
});
