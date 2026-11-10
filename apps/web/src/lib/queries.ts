import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoutingRule, RoutingSettings, RoutingDecision } from "@ai-office/shared";
import { api, type Approval, type Project, type Role, type Task } from "./api";

export const useProjects = (kind?: string, q?: string, archived = false) =>
  useQuery({
    queryKey: ["projects", kind ?? "", q ?? "", archived],
    queryFn: () =>
      api<Project[]>(
        "GET",
        `/api/projects?archived=${archived ? 1 : 0}${kind ? `&kind=${kind}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
  });
export const useTasks = (projectId?: string) =>
  useQuery({
    queryKey: ["tasks", projectId ?? "all"],
    queryFn: () => api<Task[]>("GET", `/api/tasks${projectId ? `?projectId=${projectId}` : ""}`),
  });
export const useApprovals = () =>
  useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<Approval[]>("GET", "/api/approvals?status=pending"),
  });
export const useRoles = () =>
  useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("GET", "/api/roles") });
export const useHealth = () =>
  useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ ok: boolean; demo: boolean; clients: number; time: string }>("GET", "/api/health"),
    refetchInterval: 15000,
  });
export const useNotifications = () =>
  useQuery({
    queryKey: ["notifications"],
    queryFn: () =>
      api<
        {
          id: string;
          level: string;
          title: string;
          body: string;
          created_at: string;
          read_at: string | null;
        }[]
      >("GET", "/api/notifications"),
    refetchInterval: 20000,
  });
export const useTaskHistory = (id: string | null) =>
  useQuery({
    queryKey: ["task-history", id],
    enabled: !!id,
    queryFn: () =>
      api<{
        transitions: { from_status: string; to_status: string; created_at: string; note: string }[];
        events: { ts: string; event_type: string; summary: string; source_type: string }[];
        artifacts: { id: string; kind: string; label: string; path: string | null; task_version: number }[];
      }>("GET", `/api/tasks/${id}/history`),
  });

export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["projects", "tasks", "approvals", "notifications", "task-history"])
      void qc.invalidateQueries({ queryKey: [k] });
  };
}

export interface IntegrationStatus {
  serverTime: string;
  lastObserved: { timestamp: string; eventType: string; summary: string } | null;
  observedEventsTotal: number;
  observedSessionsLast24h: number;
  spoolPendingFiles: number;
  projects: {
    id: string;
    name: string;
    folderPath: string | null;
    hooks: {
      state: "installed" | "partial" | "not_installed" | "no_folder" | "folder_missing" | "unreadable";
      missing: string[];
    };
  }[];
}
export const useIntegrationStatus = () =>
  useQuery({
    queryKey: ["integration-status"],
    queryFn: () => api<IntegrationStatus>("GET", "/api/integration/status"),
    refetchInterval: 5000,
  });

export const HOOK_STATE_TEXT: Record<IntegrationStatus["projects"][number]["hooks"]["state"], string> = {
  installed: "Hooks installed",
  partial: "Hooks partly installed",
  not_installed: "Hooks not installed",
  no_folder: "No project folder set",
  folder_missing: "Folder not found",
  unreadable: "Settings file unreadable",
};

// ---- Team Automation (Task Router)

export interface WorkItemStage {
  departmentId: "planning" | "dev" | "video" | "qa";
  role: "coordinator" | "producer" | "verifier" | "support";
  state: string;
  reason: string;
  ruleId: string | null;
  approved: boolean;
  activitySeen: boolean;
  qaResult: string | null;
  evidence: { eventId: string; at: string; kind: string; result: string; summary: string }[];
  since: string;
  lastEventAt: string | null;
}
export interface WorkItem {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  taskId: string | null;
  title: string;
  intent: string;
  status: string;
  turn: "running" | "ended";
  currentDepartment: string | null;
  decision: Partial<RoutingDecision>;
  promptLength: number | null;
  version: number;
  createdAt: string;
  lastEventAt: string;
  closedAt: string | null;
  closeReason: string | null;
  stages: WorkItemStage[];
}
export interface RoutingLogEntry {
  id: number;
  ts: string;
  kind: string;
  workItemId: string | null;
  sessionId: string | null;
  departmentId: string | null;
  fromState: string | null;
  toState: string | null;
  ruleId: string | null;
  sourceEventId: string | null;
  actor: "router" | "user";
  summary: string;
}

export const useRoutingRules = () =>
  useQuery({ queryKey: ["routing-rules"], queryFn: () => api<RoutingRule[]>("GET", "/api/routing/rules") });
export const useRoutingSettings = () =>
  useQuery({
    queryKey: ["routing-settings"],
    queryFn: () => api<RoutingSettings>("GET", "/api/routing/settings"),
  });
export const useWorkItems = (status: "open" | "all" = "all", limit = 30) =>
  useQuery({
    queryKey: ["routing-items", status, limit],
    queryFn: () => api<WorkItem[]>("GET", `/api/routing/items?status=${status}&limit=${limit}`),
  });
export const useRoutingLog = (limit = 80) =>
  useQuery({
    queryKey: ["routing-log", limit],
    queryFn: () => api<RoutingLogEntry[]>("GET", `/api/routing/log?limit=${limit}`),
  });

export function useRefreshRouting() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["routing-rules", "routing-settings", "routing-items", "routing-log"])
      void qc.invalidateQueries({ queryKey: [k] });
  };
}
