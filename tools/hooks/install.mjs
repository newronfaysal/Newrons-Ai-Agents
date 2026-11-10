#!/usr/bin/env node
// Reversible installer for the AI Office Claude Code hooks.
//
//   node tools/hooks/install.mjs install   --project <dir> [--dry-run] [--yes]
//   node tools/hooks/install.mjs uninstall --project <dir> [--yes]
//   node tools/hooks/install.mjs status    --project <dir>
//
// Safety:
//  * Only touches <project>/.claude/settings.local.json (project-local, git-ignored by Claude Code). Never ~/.claude.
//  * Explicit consent: shows the exact change first; nothing is written without --yes or typing "y".
//  * Backs up the existing file before every change and records a manifest so uninstall removes ONLY our entries.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const HOOK_EVENTS = [
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
];
const MARKER = "ai-office-hook.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.join(here, MARKER);

export function hookCommand(script = hookScript) {
  return `node "${script.replace(/\\/g, "/")}"`;
}

const isOurs = (h) => h && typeof h.command === "string" && h.command.includes(MARKER);

/** Pure: returns a new settings object with our hooks added (idempotent). */
export function addHooks(settings, command = hookCommand()) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    const groups = (out.hooks[ev] ??= []);
    const already = groups.some((g) => (g.hooks ?? []).some(isOurs));
    if (already) continue;
    // async: runs in the background and never delays Claude. timeout is a hard cap.
    groups.push({ matcher: "", hooks: [{ type: "command", command, async: true, timeout: 5 }] });
  }
  return out;
}

/** Pure: removes only our entries; drops groups/events/hooks keys that became empty because of us. */
export function removeHooks(settings) {
  const out = structuredClone(settings ?? {});
  if (!out.hooks) return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups = out.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export function status(settings) {
  const events = HOOK_EVENTS.filter((ev) =>
    (settings?.hooks?.[ev] ?? []).some((g) => (g.hooks ?? []).some(isOurs)),
  );
  return {
    installed: events.length === HOOK_EVENTS.length,
    partial: events.length > 0 && events.length < HOOK_EVENTS.length,
    events,
  };
}

const paths = (project) => {
  const dir = path.join(path.resolve(project), ".claude");
  return {
    dir,
    file: path.join(dir, "settings.local.json"),
    manifest: path.join(dir, "ai-office-hooks.manifest.json"),
  };
};

function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, existed: false, raw: null };
  const raw = fs.readFileSync(file, "utf8");
  try {
    return { settings: raw.trim() ? JSON.parse(raw) : {}, existed: true, raw };
  } catch (e) {
    throw new Error(
      `Refusing to modify ${file}: it is not valid JSON (${e.message}). Fix or move it, then retry.`,
    );
  }
}

export function install(project, { dryRun = false, command = hookCommand() } = {}) {
  const p = paths(project);
  const { settings, existed, raw } = readSettings(p.file);
  const next = addHooks(settings, command);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  if (dryRun || !changed) return { changed, written: false, file: p.file, next };
  fs.mkdirSync(p.dir, { recursive: true });
  let backup = null;
  if (existed) {
    backup = `${p.file}.ai-office-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.writeFileSync(backup, raw);
  }
  fs.writeFileSync(p.file, JSON.stringify(next, null, 2) + "\n");
  fs.writeFileSync(
    p.manifest,
    JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        settingsExisted: existed,
        backup: backup && path.basename(backup),
        events: HOOK_EVENTS,
      },
      null,
      2,
    ) + "\n",
  );
  return { changed: true, written: true, file: p.file, backup, next };
}

export function uninstall(project) {
  const p = paths(project);
  if (!fs.existsSync(p.file)) return { changed: false, file: p.file };
  const { settings } = readSettings(p.file);
  const next = removeHooks(settings);
  const manifest = fs.existsSync(p.manifest) ? JSON.parse(fs.readFileSync(p.manifest, "utf8")) : null;
  if (Object.keys(next).length === 0 && manifest && manifest.settingsExisted === false)
    fs.rmSync(p.file); // we created it, so remove it
  else fs.writeFileSync(p.file, JSON.stringify(next, null, 2) + "\n");
  fs.rmSync(p.manifest, { force: true });
  return { changed: true, file: p.file, backupKept: manifest?.backup ?? null };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (n) => process.argv.includes(`--${n}`);

async function confirm(q) {
  if (flag("yes")) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

async function cli() {
  const cmd = process.argv[2];
  const project = arg("project");
  if (!cmd || !["install", "uninstall", "status"].includes(cmd) || !project) {
    console.log(
      "Usage: node tools/hooks/install.mjs <install|uninstall|status> --project <dir> [--dry-run] [--yes]",
    );
    process.exit(cmd ? 2 : 0);
  }
  const p = paths(project);
  if (cmd === "status") {
    const { settings } = readSettings(p.file);
    console.log(JSON.stringify(status(settings), null, 2));
    return;
  }
  if (cmd === "install") {
    const preview = install(project, { dryRun: true });
    console.log(`Target (project-local only): ${preview.file}`);
    console.log(`Adds async, non-blocking command hooks for: ${HOOK_EVENTS.join(", ")}`);
    console.log(`Command: ${hookCommand()}`);
    console.log("Existing settings are backed up first; uninstall removes only these entries.");
    if (!preview.changed) return console.log("Already installed. Nothing to do.");
    if (flag("dry-run")) return console.log("\n--dry-run: nothing written.");
    if (!(await confirm("Install these hooks?"))) return console.log("Cancelled. Nothing was changed.");
    const r = install(project);
    console.log(`Installed. ${r.backup ? "Backup: " + r.backup : "No previous settings file existed."}`);
    return;
  }
  if (!(await confirm(`Remove AI Office hooks from ${p.file}?`)))
    return console.log("Cancelled. Nothing was changed.");
  const r = uninstall(project);
  console.log(
    r.changed
      ? `Removed. ${r.backupKept ? "Original backup kept: " + r.backupKept : ""}`
      : "Nothing to remove.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
