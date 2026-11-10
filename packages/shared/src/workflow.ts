import { z } from "zod";
import type { DepartmentId } from "./departments.js";

export const TaskStatus = z.enum([
  "backlog",
  "planned",
  "in_progress",
  "qa",
  "revision",
  "blocked",
  "completed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TASK_STATUSES = TaskStatus.options;

export const ProjectKind = z.enum(["video", "app", "general"]);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const Priority = z.enum(["low", "normal", "high", "urgent"]);
export type Priority = z.infer<typeof Priority>;

/** Allowed manual/suggested transitions. Anything else is rejected with a reason. */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["planned", "blocked"],
  planned: ["in_progress", "backlog", "blocked"],
  in_progress: ["qa", "blocked", "planned"],
  qa: ["completed", "revision", "blocked"],
  revision: ["in_progress", "blocked"],
  blocked: ["backlog", "planned", "in_progress", "revision"],
  completed: ["revision"], // reopen
};

export interface TransitionContext {
  from: TaskStatus;
  to: TaskStatus;
  requiresApproval: boolean;
  approved: boolean;
  /** statuses of tasks this task depends on */
  dependencyStatuses: TaskStatus[];
  /** whether evidence (artifact/test result) is linked — required to enter QA when the task asks for evidence */
  hasEvidence?: boolean;
  requiresEvidenceForQa?: boolean;
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

export function checkTransition(ctx: TransitionContext): TransitionResult {
  if (ctx.from === ctx.to) return { ok: false, reason: "Task is already in that status." };
  if (!ALLOWED[ctx.from].includes(ctx.to)) {
    return { ok: false, reason: `Cannot move a task from ${ctx.from} to ${ctx.to}.` };
  }
  if (
    (ctx.to === "in_progress" || ctx.to === "qa") &&
    ctx.dependencyStatuses.some((s) => s !== "completed")
  ) {
    return { ok: false, reason: "Blocked by unfinished dependencies." };
  }
  if (ctx.to === "qa" && ctx.requiresEvidenceForQa && !ctx.hasEvidence) {
    return { ok: false, reason: "Link an artifact or test evidence before sending to QA." };
  }
  if (ctx.to === "completed" && ctx.requiresApproval && !ctx.approved) {
    return { ok: false, reason: "Human approval is required before completing this task." };
  }
  return { ok: true };
}

/** Would adding edge task->dependsOn create a cycle? `edges` maps task id -> ids it depends on. */
export function wouldCreateCycle(edges: Map<string, string[]>, taskId: string, dependsOn: string): boolean {
  if (taskId === dependsOn) return true;
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) stack.push(next);
  }
  return false;
}

export interface WorkflowStage {
  id: string;
  label: string;
  departmentId: DepartmentId | null; // null = human/brief stage
  /** Kanban status new tasks of this stage normally sit in */
  status: TaskStatus;
}

export const WORKFLOWS: Record<ProjectKind, WorkflowStage[]> = {
  app: [
    { id: "brief", label: "Brief", departmentId: null, status: "backlog" },
    { id: "planning", label: "Planning", departmentId: "planning", status: "planned" },
    { id: "development", label: "Development", departmentId: "dev", status: "in_progress" },
    { id: "qa", label: "QA", departmentId: "qa", status: "qa" },
    { id: "approval", label: "Approval", departmentId: null, status: "qa" },
    { id: "completed", label: "Completed", departmentId: null, status: "completed" },
  ],
  video: [
    { id: "brief", label: "Brief", departmentId: null, status: "backlog" },
    { id: "planning", label: "Planning", departmentId: "planning", status: "planned" },
    { id: "editing", label: "Editing", departmentId: "video", status: "in_progress" },
    { id: "qa", label: "QA", departmentId: "qa", status: "qa" },
    { id: "approval", label: "Approval", departmentId: null, status: "qa" },
    { id: "delivery", label: "Export/Delivery", departmentId: null, status: "completed" },
  ],
  general: [
    { id: "brief", label: "Brief", departmentId: null, status: "backlog" },
    { id: "planning", label: "Planning", departmentId: "planning", status: "planned" },
    { id: "work", label: "Work", departmentId: "planning", status: "in_progress" },
    { id: "completed", label: "Completed", departmentId: null, status: "completed" },
  ],
};

/** Suggest (never auto-apply in observed mode) the department that should own a task in a given status. */
export function suggestedDepartment(kind: ProjectKind, status: TaskStatus): DepartmentId {
  if (status === "qa") return "qa";
  if (status === "backlog" || status === "planned") return "planning";
  return kind === "video" ? "video" : kind === "app" ? "dev" : "planning";
}
