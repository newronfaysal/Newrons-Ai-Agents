import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { SUPPORTED_HOOKS } from "./normalize.js";
import { spoolDir } from "./spool.js";

export type HookState =
  "installed" | "partial" | "not_installed" | "no_folder" | "folder_missing" | "unreadable";

export interface HookCheck {
  state: HookState;
  /** Hook events that are not wired to the AI Office hook script (only for "partial"). */
  missing: string[];
}

const MARKER = "ai-office-hook";

/**
 * READ-ONLY check of `<folder>/.claude/settings.local.json`: are the AI Office hooks present?
 * Never writes, never returns file contents, only a status.
 */
export function checkProjectHooks(folder: string | null): HookCheck {
  if (!folder) return { state: "no_folder", missing: [] };
  try {
    if (!fs.statSync(folder).isDirectory()) return { state: "folder_missing", missing: [] };
  } catch {
    return { state: "folder_missing", missing: [] };
  }
  const file = path.join(folder, ".claude", "settings.local.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "not_installed", missing: [] }
      : { state: "unreadable", missing: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { state: "unreadable", missing: [] };
  }
  const hooks = (json as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return { state: "not_installed", missing: [] };
  const has = (ev: string): boolean => {
    const groups = (hooks as Record<string, unknown>)[ev];
    if (!Array.isArray(groups)) return false;
    return groups.some((g) => {
      const list = (g as { hooks?: unknown })?.hooks;
      return (
        Array.isArray(list) &&
        list.some(
          (h) =>
            typeof (h as { command?: unknown })?.command === "string" &&
            (h as { command: string }).command.includes(MARKER),
        )
      );
    });
  };
  const missing = SUPPORTED_HOOKS.filter((ev) => !has(ev));
  if (missing.length === SUPPORTED_HOOKS.length) return { state: "not_installed", missing: [] };
  return missing.length ? { state: "partial", missing: [...missing] } : { state: "installed", missing: [] };
}

export function registerIntegration(app: FastifyInstance, cfg: Config, db: DB) {
  app.get("/api/integration/status", async () => {
    const last = db
      .prepare(
        "SELECT ts AS timestamp, event_type AS eventType, summary FROM events WHERE source_type='observed' ORDER BY ts DESC LIMIT 1",
      )
      .get() as { timestamp: string; eventType: string; summary: string } | undefined;
    const total = db.prepare("SELECT COUNT(*) AS n FROM events WHERE source_type='observed'").get() as {
      n: number;
    };
    const sessions = db
      .prepare("SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE source_type='observed' AND ts >= ?")
      .get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number };
    let spoolPendingFiles = 0;
    try {
      spoolPendingFiles = fs.readdirSync(spoolDir(cfg.dataDir)).filter((n) => n.endsWith(".jsonl")).length;
    } catch {
      /* no spool dir yet */
    }
    const rows = db
      .prepare("SELECT id, name, folder_path AS folderPath FROM projects WHERE archived = 0 ORDER BY name")
      .all() as { id: string; name: string; folderPath: string | null }[];
    return {
      serverTime: new Date().toISOString(),
      lastObserved: last ?? null,
      observedEventsTotal: Number(total.n),
      observedSessionsLast24h: Number(sessions.n),
      spoolPendingFiles,
      projects: rows.map((r) => ({ ...r, hooks: checkProjectHooks(r.folderPath) })),
    };
  });
}
