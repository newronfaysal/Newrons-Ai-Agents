import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLES, DEPARTMENTS } from "@ai-office/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../migrations");

// Loaded via require so bundlers/test runners that strip the "node:" prefix cannot break the built-in module.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export type DB = DatabaseSyncType;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
  );
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function migrate(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      (r) => r.version,
    ),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        f,
        new Date().toISOString(),
      );
    });
    ran.push(f);
  }
  return ran;
}

/** Idempotent seed of departments + default role definitions (never overwrites user edits). */
export function seed(db: DB): void {
  tx(db, () => {
    DEPARTMENTS.forEach((d, i) =>
      db
        .prepare("INSERT OR IGNORE INTO departments(id, name, sort_order) VALUES (?,?,?)")
        .run(d.id, d.name, i),
    );
    DEFAULT_ROLES.forEach((r, i) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO role_definitions(id, name, department_id, subagent_types, sort_order) VALUES (?,?,?,?,?)",
        )
        .run(r.id, r.name, r.departmentId, JSON.stringify(r.subagentTypes), i),
    );
    db.prepare("INSERT OR IGNORE INTO profile(id, display_name, created_at) VALUES ('local','Me',?)").run(
      new Date().toISOString(),
    );
  });
}

export function openAndMigrate(file: string): DB {
  const db = openDb(file);
  migrate(db);
  seed(db);
  return db;
}

/** Consistent online backup using VACUUM INTO, keeping the newest `keep` files. */
export function backupDb(db: DB, dataDir: string, keep = 7): string {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `ai-office-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("ai-office-") && f.endsWith(".db"))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep)))
    fs.rmSync(path.join(dir, old), { force: true });
  return target;
}

export function pruneEvents(db: DB, retentionDays: number, now = Date.now()): number {
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  const r = db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
  return Number(r.changes);
}
