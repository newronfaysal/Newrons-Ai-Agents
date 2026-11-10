import crypto from "node:crypto";
import { activityForTool, redact, safePathLabel, type NormalizedEvent } from "@ai-office/shared";

/** Fields the hook script forwards. Anything else is ignored. Never includes full prompts or tool output. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string; path?: string; command?: string; url?: string; [k: string]: unknown };
  task_id?: string;
  task_subject?: string;
  notification_type?: string;
  message?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  source?: string;
  reason?: string;
  model?: string;
  prompt_length?: number;
  /** Prompt text, forwarded by the hook to localhost for in-memory routing only. NEVER stored or put in an event. */
  prompt_text?: string;
  permission_mode?: string;
  ts?: string;
  eventId?: string;
}

export interface NormalizeOptions {
  captureCommandText: boolean;
}

export interface Normalized {
  event: NormalizedEvent;
  /** Full cwd, used only transiently to link a session to a project. Never stored. */
  cwd: string | null;
  /** Claude Code's own agent_id/agent_type when the event fired inside a subagent. */
  claudeAgentId: string | null;
  agentType: string | null;
  /** Transient values for the Task Router. Never stored. */
  promptText: string | null;
  command: string | null;
}

export const SUPPORTED_HOOKS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Notification",
  "PermissionRequest",
  "Stop",
  "StopFailure",
] as const;

function str(v: unknown, max = 120): string | null {
  return typeof v === "string" && v.length ? redact(v, max) : null;
}

export function deterministicEventId(p: HookPayload, ts: string): string {
  const key = [
    p.hook_event_name,
    p.session_id,
    p.agent_id,
    p.tool_use_id,
    p.task_id,
    p.tool_name,
    p.notification_type,
    ts,
  ].join("|");
  return "h_" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function toolFileLabel(p: HookPayload): string | null {
  const f = p.tool_input?.file_path ?? p.tool_input?.path;
  return typeof f === "string" ? safePathLabel(f) : null;
}

function commandOf(p: HookPayload): string | undefined {
  return typeof p.tool_input?.command === "string" ? p.tool_input.command : undefined;
}

export function normalizeHook(p: HookPayload, opts: NormalizeOptions, now = new Date()): Normalized | null {
  const name = p.hook_event_name;
  if (!name || !(SUPPORTED_HOOKS as readonly string[]).includes(name)) return null;
  const ts = p.ts && !Number.isNaN(Date.parse(p.ts)) ? new Date(p.ts).toISOString() : now.toISOString();
  const meta: NormalizedEvent["safeMetadata"] = {};
  if (p.tool_name) meta.tool = redact(p.tool_name, 60);
  if (p.agent_type) meta.agentType = redact(p.agent_type, 60);
  if (p.permission_mode) meta.permissionMode = redact(p.permission_mode, 30);

  let eventType: NormalizedEvent["eventType"];
  let status: NormalizedEvent["status"] = "info";
  let summary = name;

  switch (name) {
    case "SessionStart":
      eventType = "session.start";
      status = "started";
      summary = `Session started${p.source ? ` (${redact(p.source, 20)})` : ""}`;
      if (p.model) meta.model = redact(p.model, 60);
      break;
    case "SessionEnd":
      eventType = "session.end";
      status = "finished";
      summary = `Session ended${p.reason ? ` (${redact(p.reason, 40)})` : ""}`;
      break;
    case "UserPromptSubmit":
      eventType = "prompt.submit";
      status = "running";
      summary = "User prompt received";
      if (typeof p.prompt_length === "number") meta.promptLength = p.prompt_length;
      else if (typeof p.prompt_text === "string") meta.promptLength = p.prompt_text.length;
      break;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const cmd = commandOf(p);
      const act = activityForTool(p.tool_name, cmd);
      const file = toolFileLabel(p);
      if (file) meta.file = file;
      meta.activity = act.activity;
      if (cmd && opts.captureCommandText) meta.command = redact(cmd, 100);
      if (typeof p.duration_ms === "number") meta.durationMs = Math.round(p.duration_ms);
      if (name === "PreToolUse") {
        eventType = "tool.pre";
        status = "running";
        summary = file ? `${act.label} (${file})` : act.label;
      } else if (name === "PostToolUse") {
        eventType = "tool.post";
        status = "succeeded";
        summary = `Finished: ${act.label}`;
      } else {
        eventType = "tool.failure";
        status = "failed";
        summary = `Tool failed: ${p.tool_name ?? "unknown"}`;
        const e = str(p.error, 120);
        if (e) meta.error = e;
        if (p.is_interrupt) meta.interrupted = true;
      }
      break;
    }
    case "SubagentStart":
      eventType = "subagent.start";
      status = "started";
      summary = `Subagent started${p.agent_type ? `: ${redact(p.agent_type, 40)}` : ""}`;
      break;
    case "SubagentStop":
      eventType = "subagent.stop";
      status = "finished";
      summary = `Subagent finished${p.agent_type ? `: ${redact(p.agent_type, 40)}` : ""}`;
      break;
    case "TaskCreated":
      eventType = "task.created";
      status = "info";
      summary = `Claude task created${p.task_subject ? `: ${redact(p.task_subject, 100)}` : ""}`;
      if (p.task_id) meta.claudeTaskId = redact(p.task_id, 60);
      break;
    case "TaskCompleted":
      eventType = "task.completed";
      status = "succeeded";
      summary = `Claude task completed${p.task_subject ? `: ${redact(p.task_subject, 100)}` : ""}`;
      if (p.task_id) meta.claudeTaskId = redact(p.task_id, 60);
      break;
    case "Notification":
      eventType = "notification";
      meta.notificationType = redact(p.notification_type ?? "unknown", 40);
      if (p.notification_type === "permission_prompt") {
        status = "needs_attention";
        summary = "Claude is waiting for a permission decision";
      } else if (p.notification_type === "idle_prompt") {
        status = "info";
        summary = "Claude is waiting for input";
      } else {
        summary = `Notification${p.message ? `: ${redact(p.message, 120)}` : ""}`;
      }
      break;
    case "PermissionRequest":
      eventType = "permission.request";
      status = "needs_attention";
      summary = `Permission requested${p.tool_name ? ` for ${redact(p.tool_name, 40)}` : ""}`;
      break;
    case "Stop":
      eventType = "stop";
      status = "info";
      summary = "Claude finished responding (turn ended)";
      break;
    default:
      eventType = "stop.failure";
      status = "failed";
      summary = "Turn ended with an error";
      {
        const e = str(p.error ?? p.reason, 120);
        if (e) meta.error = e;
      }
  }

  const sessionId = typeof p.session_id === "string" && p.session_id ? p.session_id.slice(0, 128) : null;
  const event: NormalizedEvent = {
    eventId: p.eventId && p.eventId.length >= 8 ? p.eventId.slice(0, 128) : deterministicEventId(p, ts),
    timestamp: ts,
    sourceType: "observed",
    sessionId,
    parentSessionId: null,
    agentId: null, // resolved by the agent registry
    projectId: null,
    taskId: null,
    departmentId: null,
    eventType,
    status,
    summary: redact(summary, 300),
    safeMetadata: meta,
    correlationId: p.tool_use_id ? redact(p.tool_use_id, 100) : null,
  };
  return {
    event,
    cwd: typeof p.cwd === "string" ? p.cwd : null,
    claudeAgentId: typeof p.agent_id === "string" ? p.agent_id.slice(0, 100) : null,
    agentType: typeof p.agent_type === "string" ? p.agent_type.slice(0, 60) : null,
    promptText:
      eventType === "prompt.submit" && typeof p.prompt_text === "string"
        ? p.prompt_text.slice(0, 8000)
        : null,
    command: commandOf(p)?.slice(0, 2000) ?? null,
  };
}
