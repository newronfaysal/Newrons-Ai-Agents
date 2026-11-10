import fs from "node:fs";
import path from "node:path";
import type { HookPayload } from "./normalize.js";
import type { Ingestor } from "./ingest.js";

export function spoolDir(dataDir: string): string {
  return path.join(dataDir, "spool");
}

/**
 * The hook script appends payloads here when the server is unreachable (safe buffering).
 * Draining is idempotent: events carry deterministic ids, so replays are deduplicated by the events table.
 */
export function drainSpool(dataDir: string, ingestor: Ingestor): { files: number; events: number } {
  const dir = spoolDir(dataDir);
  if (!fs.existsSync(dir)) return { files: 0, events: 0 };
  let files = 0;
  let events = 0;
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()) {
    const full = path.join(dir, f);
    const claimed = full + ".draining";
    try {
      fs.renameSync(full, claimed); // claim atomically so concurrent appenders start a fresh file
    } catch {
      continue;
    }
    const lines = fs.readFileSync(claimed, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(0, 5000)) {
      try {
        const r = ingestor.ingestHook(JSON.parse(line) as HookPayload);
        if (r.status === "accepted") events++;
      } catch {
        /* skip corrupt line */
      }
    }
    fs.rmSync(claimed, { force: true });
    files++;
  }
  return { files, events };
}
