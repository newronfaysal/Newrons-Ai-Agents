let uiToken: string | null = null;
let boot: Promise<string> | null = null;

export async function getToken(): Promise<string> {
  if (uiToken) return uiToken;
  boot ??= fetch("/api/bootstrap", { headers: { "x-requested-with": "ai-office" } })
    .then((r) => {
      if (!r.ok) throw new Error(`bootstrap failed (${r.status})`);
      return r.json() as Promise<{ uiToken: string }>;
    })
    .then((j) => (uiToken = j.uiToken))
    .catch((e) => {
      boot = null;
      throw e;
    });
  return boot;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["x-ai-office-ui"] = await getToken();
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!r.ok) {
    const reason =
      (json.reason as string | undefined) ??
      (json.error as string | undefined) ??
      `Request failed (${r.status})`;
    throw new ApiError(reason, r.status, json.error as string | undefined);
  }
  return json as T;
}

export interface Project {
  id: string;
  name: string;
  kind: "video" | "app" | "general";
  description: string;
  folderPath: string | null;
  repoPath: string | null;
  aspectRatio: string | null;
  outputResolution: string | null;
  targetDurationS: number | null;
  frameRate: number | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  taskTotal?: number;
  taskDone?: number;
}
export type TaskStatus = "backlog" | "planned" | "in_progress" | "qa" | "revision" | "blocked" | "completed";
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  departmentId: string | null;
  deadline: string | null;
  version: number;
  requiresApproval: boolean;
  requiresEvidenceForQa: boolean;
  blockedReason: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface Approval {
  id: string;
  task_id: string | null;
  kind: "task-completion" | "claude-permission" | "other";
  status: string;
  summary: string;
  session_id: string | null;
  requested_at: string;
}
export interface EventRow {
  eventId: string;
  timestamp: string;
  sourceType: string;
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  taskId: string | null;
  departmentId: string | null;
  eventType: string;
  status: string;
  summary: string;
}
export interface Role {
  id: string;
  name: string;
  departmentId: string;
  subagentTypes: string[];
}
