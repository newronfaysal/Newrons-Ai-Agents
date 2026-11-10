import { z } from "zod";

export const DepartmentId = z.enum(["planning", "video", "dev", "qa"]);
export type DepartmentId = z.infer<typeof DepartmentId>;

export interface RoleDefinition {
  id: string;
  name: string;
  departmentId: DepartmentId;
  /** Claude Code subagent types (SubagentStart.agent_type) that map to this role. User-configurable. */
  subagentTypes: string[];
}

export const DEPARTMENTS: { id: DepartmentId; name: string; blurb: string }[] = [
  { id: "planning", name: "Planning Team", blurb: "Collaborative meeting room with whiteboards" },
  { id: "video", name: "Video Editor Team", blurb: "Dark creative studio with editing monitors" },
  { id: "dev", name: "App Development Team", blurb: "Workstations with dual monitors" },
  { id: "qa", name: "QA Team", blurb: "Bright verification lab with checklist screens" },
];

/** Default, editable role roster. A role is NOT a running process until linked to a real session/subagent. */
export const DEFAULT_ROLES: RoleDefinition[] = [
  { id: "project-manager", name: "Project Manager", departmentId: "planning", subagentTypes: ["Plan"] },
  {
    id: "research-analyst",
    name: "Research Analyst",
    departmentId: "planning",
    subagentTypes: ["Explore", "general-purpose"],
  },
  { id: "task-coordinator", name: "Task Coordinator", departmentId: "planning", subagentTypes: [] },
  { id: "script-writer", name: "Script Writer", departmentId: "video", subagentTypes: [] },
  { id: "video-editor", name: "Video Editor", departmentId: "video", subagentTypes: [] },
  { id: "caption-specialist", name: "Caption Specialist", departmentId: "video", subagentTypes: [] },
  { id: "thumbnail-designer", name: "Thumbnail Designer", departmentId: "video", subagentTypes: [] },
  { id: "frontend-dev", name: "Frontend Developer", departmentId: "dev", subagentTypes: [] },
  { id: "backend-dev", name: "Backend Developer", departmentId: "dev", subagentTypes: [] },
  { id: "ux-designer", name: "UI/UX Designer", departmentId: "dev", subagentTypes: [] },
  { id: "code-reviewer", name: "Code Reviewer", departmentId: "dev", subagentTypes: ["code-reviewer"] },
  { id: "app-tester", name: "Application Tester", departmentId: "qa", subagentTypes: [] },
  { id: "content-reviewer", name: "Content Reviewer", departmentId: "qa", subagentTypes: [] },
  { id: "issue-reporter", name: "Issue Reporter", departmentId: "qa", subagentTypes: [] },
];
