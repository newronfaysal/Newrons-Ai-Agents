import type { NormalizedEvent } from "@ai-office/shared";
import { api } from "./api";
import { useStore } from "./store";

interface StoredEvent {
  eventId: string;
  timestamp: string;
  sourceType: NormalizedEvent["sourceType"];
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  taskId: string | null;
  departmentId: NormalizedEvent["departmentId"];
  eventType: NormalizedEvent["eventType"];
  status: NormalizedEvent["status"];
  summary: string;
}

/** The server stores only sanitized events, so history is rebuilt from those fields. Demo events are never stored. */
export function toEvent(r: StoredEvent): NormalizedEvent {
  return { ...r, parentSessionId: null, safeMetadata: {}, correlationId: null };
}

/**
 * Loads persisted events so the activity log and integration status are correct after a page
 * reload or reconnect, not only for events that arrived while this page was open.
 */
export async function loadHistory(fetcher: typeof api = api): Promise<number> {
  try {
    const rows = await fetcher<StoredEvent[]>("GET", "/api/events?limit=200");
    useStore.getState().mergeHistory(rows.filter((r) => r.sourceType !== "demo").map(toEvent));
    return rows.length;
  } catch {
    return 0; // history is best effort; live events still work
  }
}
