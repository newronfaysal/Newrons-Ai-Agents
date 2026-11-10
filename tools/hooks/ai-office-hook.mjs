#!/usr/bin/env node
// AI Office observability hook for Claude Code.
//
// Contract:
//  * NEVER blocks or alters Claude: always exits 0, prints nothing to stdout, no decisions.
//  * Forwards ONLY a whitelist of fields. Tool output and transcripts are never sent.
//  * Prompt text is sent ONLY to the local AI Office server so the Task Router can classify it in memory;
//    the server never stores it. Set AI_OFFICE_FORWARD_PROMPT=off to send only its length.
//  * If the dashboard is not running, payloads are buffered to <dataDir>/spool and replayed later (deduplicated).
//    Prompt text is stripped before anything is written to the spool.
//  * Zero dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.AI_OFFICE_DATA_DIR || path.join(here, "../../data"));
const port = Number(process.env.AI_OFFICE_PORT || 4317);
const host = process.env.AI_OFFICE_HOST || "127.0.0.1";
const TIMEOUT_MS = 1200;
const MAX_STDIN = 2 * 1024 * 1024;
const MAX_PROMPT = 4000;

const cut = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

export function buildPayload(input, now = new Date(), env = process.env) {
  const ti = input && typeof input.tool_input === "object" && input.tool_input ? input.tool_input : {};
  const ts = now.toISOString();
  const p = {
    hook_event_name: cut(input.hook_event_name, 40),
    session_id: cut(input.session_id, 128),
    cwd: cut(input.cwd, 400),
    agent_id: cut(input.agent_id, 100),
    agent_type: cut(input.agent_type, 60),
    tool_name: cut(input.tool_name, 80),
    tool_use_id: cut(input.tool_use_id, 100),
    // Only the few fields needed to label activity. Everything else in tool_input is dropped.
    tool_input: { file_path: cut(ti.file_path ?? ti.path, 400), command: cut(ti.command, 300) },
    task_id: cut(input.task_id, 100),
    task_subject: cut(input.task_subject, 150),
    notification_type: cut(input.notification_type, 60),
    message: cut(input.message, 200),
    error: cut(typeof input.error === "string" ? input.error : undefined, 200),
    is_interrupt: typeof input.is_interrupt === "boolean" ? input.is_interrupt : undefined,
    duration_ms: typeof input.duration_ms === "number" ? input.duration_ms : undefined,
    source: cut(input.source, 30),
    reason: cut(input.reason, 60),
    model: cut(input.model, 80),
    permission_mode: cut(input.permission_mode, 30),
    prompt_length: typeof input.prompt === "string" ? input.prompt.length : undefined,
    // Prompt text: to the local server only, for in-memory routing. Never spooled, never stored.
    prompt_text:
      input.hook_event_name === "UserPromptSubmit" &&
      typeof input.prompt === "string" &&
      String(env.AI_OFFICE_FORWARD_PROMPT || "on").toLowerCase() !== "off"
        ? input.prompt.slice(0, MAX_PROMPT)
        : undefined,
    ts,
  };
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
  p.eventId = "h_" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
  return JSON.parse(JSON.stringify(p)); // drop undefined
}

/** Payload as written to disk: never contains prompt text. */
export function forSpool(payload) {
  const { prompt_text: _dropped, ...rest } = payload;
  return rest;
}

export function spool(payload, dir = dataDir) {
  try {
    const d = path.join(dir, "spool");
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(
      d,
      `${new Date()
        .toISOString()
        .slice(0, 13)
        .replace(/[^0-9]/g, "")}-${process.pid}.jsonl`,
    );
    fs.appendFileSync(f, JSON.stringify(forSpool(payload)) + "\n");
  } catch {
    /* nothing more we can safely do */
  }
}

async function post(payload) {
  const token = fs.readFileSync(path.join(dataDir, "hook-token"), "utf8").trim();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/api/hooks/claude`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-office-token": token },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(String(res.status));
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_STDIN) break;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== "object") return;
  const payload = buildPayload(input);
  try {
    await post(payload);
  } catch {
    spool(payload);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
