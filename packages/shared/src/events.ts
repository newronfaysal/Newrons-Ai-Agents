import { z } from "zod";
import { DepartmentId } from "./departments.js";
import { DepartmentStatus } from "./routing.js";

/** How trustworthy the event's origin is. Drives the visible badge on every avatar. */
export const SourceType = z.enum(["observed", "orchestrated", "manual", "demo"]);
export type SourceType = z.infer<typeof SourceType>;

export const EventType = z.enum([
  "session.start",
  "session.end",
  "prompt.submit",
  "tool.pre",
  "tool.post",
  "tool.failure",
  "subagent.start",
  "subagent.stop",
  "task.created",
  "task.completed",
  "notification",
  "permission.request",
  "stop",
  "stop.failure",
  "agent.state", // manual / orchestrated explicit state update
  "task.state", // manual task move
  "heartbeat",
]);
export type EventType = z.infer<typeof EventType>;

export const EventStatus = z.enum([
  "started",
  "running",
  "succeeded",
  "failed",
  "needs_attention",
  "finished",
  "info",
]);
export type EventStatus = z.infer<typeof EventStatus>;

const MetaValue = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

export const NormalizedEvent = z.object({
  eventId: z.string().min(8).max(128),
  timestamp: z.string().datetime({ offset: true }),
  sourceType: SourceType,
  sessionId: z.string().max(128).nullable(),
  parentSessionId: z.string().max(128).nullable().default(null),
  agentId: z.string().max(128).nullable().default(null),
  projectId: z.string().max(64).nullable().default(null),
  taskId: z.string().max(64).nullable().default(null),
  departmentId: DepartmentId.nullable().default(null),
  eventType: EventType,
  status: EventStatus,
  summary: z.string().max(300),
  safeMetadata: z.record(z.string().max(64), MetaValue).default({}),
  correlationId: z.string().max(128).nullable().default(null),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;

/** Input accepted by POST /api/events (server fills defaults). */
export const EventInput = NormalizedEvent.partial({
  eventId: true,
  timestamp: true,
  parentSessionId: true,
  agentId: true,
  projectId: true,
  taskId: true,
  departmentId: true,
  safeMetadata: true,
  correlationId: true,
});
export type EventInput = z.infer<typeof EventInput>;

/** Live agent state broadcast to the UI. */
export const AgentActivity = z.enum([
  "idle",
  "reading",
  "researching",
  "coding",
  "testing",
  "rendering",
  "meeting",
  "thinking",
  "needs_attention",
  "finished",
  "error",
]);
export type AgentActivity = z.infer<typeof AgentActivity>;

export const AgentOrigin = z.enum(["observed", "orchestrated", "manual", "demo", "roster"]);
export type AgentOrigin = z.infer<typeof AgentOrigin>;

export const AgentSnapshot = z.object({
  agentId: z.string(),
  displayName: z.string(),
  roleId: z.string().nullable(),
  departmentId: DepartmentId,
  origin: AgentOrigin, // "roster" = decorative, no real process linked
  sessionId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  activity: AgentActivity,
  lastOperation: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  /** "live" = events seen recently; "stale" = no recent events (state is unknown, NOT assumed finished). */
  freshness: z.enum(["live", "stale", "ended", "none"]),
  errorMessage: z.string().nullable(),
  recent: z.array(z.object({ at: z.string(), type: EventType, summary: z.string() })).max(20),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;

export const WsMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), serverTime: z.string(), mode: z.object({ demo: z.boolean() }) }),
  z.object({ type: z.literal("event"), event: NormalizedEvent }),
  z.object({ type: z.literal("agents"), agents: z.array(AgentSnapshot) }),
  z.object({ type: z.literal("tasks-changed") }),
  z.object({ type: z.literal("ping"), t: z.number() }),
  /** Department states derived by the Task Router from real events and router decisions. */
  z.object({ type: z.literal("departments"), departments: z.array(DepartmentStatus) }),
  /** Something changed in routing (work items, rules or the audit log): refetch. */
  z.object({ type: z.literal("routing-changed"), summary: z.string().max(300) }),
]);
export type WsMessage = z.infer<typeof WsMessage>;
