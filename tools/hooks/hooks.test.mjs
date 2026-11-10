import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addHooks, removeHooks, status, install, uninstall, HOOK_EVENTS } from "./install.mjs";
import { buildPayload, forSpool } from "./ai-office-hook.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "ai-office-hook.mjs");
const fx = (n) => fs.readFileSync(path.resolve(here, "../../fixtures/hooks", n + ".json"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aio-hk-"));

describe("buildPayload (privacy whitelist)", () => {
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "s",
    prompt: "my secret business plan",
    transcript_path: "C:\\x\\t.jsonl",
    tool_input: { file_path: "a.txt", content: "FILE BODY", new_string: "SECRET" },
    tool_response: { stdout: "OUTPUT" },
    last_assistant_message: "reply",
  };
  it("never forwards tool output, transcripts or unknown tool_input fields", () => {
    const p = buildPayload(input);
    const s = JSON.stringify(p);
    for (const leak of ["t.jsonl", "FILE BODY", "SECRET", "OUTPUT", "reply"]) expect(s).not.toContain(leak);
    expect(p.prompt_length).toBe("my secret business plan".length);
    expect(p.eventId).toMatch(/^h_[0-9a-f]{32}$/);
  });
  it("forwards prompt text for local routing only, and never writes it to the spool", () => {
    const p = buildPayload(input);
    expect(p.prompt_text).toBe("my secret business plan");
    expect(JSON.stringify(forSpool(p))).not.toContain("secret business plan");
    expect(buildPayload({ ...input, hook_event_name: "PreToolUse" }).prompt_text).toBeUndefined();
  });
  it("can turn prompt forwarding off", () => {
    const p = buildPayload(input, new Date(), { AI_OFFICE_FORWARD_PROMPT: "off" });
    expect(p.prompt_text).toBeUndefined();
    expect(p.prompt_length).toBe("my secret business plan".length);
  });
});

describe("hook script behaviour", () => {
  const run = (stdin, env = {}) =>
    spawnSync(process.execPath, [script], {
      input: stdin,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10000,
    });

  it("exits 0 with empty stdout when the dashboard is down, and buffers to the spool", () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, "hook-token"), "t".repeat(40));
    const r = run(fx("pretool-read"), { AI_OFFICE_DATA_DIR: dataDir, AI_OFFICE_PORT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const files = fs.readdirSync(path.join(dataDir, "spool"));
    expect(files).toHaveLength(1);
    const line = JSON.parse(fs.readFileSync(path.join(dataDir, "spool", files[0]), "utf8").trim());
    expect(line.tool_name).toBe("Read");
  });
  it("never writes prompt text to the spool when the dashboard is down", () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, "hook-token"), "t".repeat(40));
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      prompt: "zebra-confidential plan",
    });
    const r = run(stdin, { AI_OFFICE_DATA_DIR: dataDir, AI_OFFICE_PORT: "1" });
    expect(r.status).toBe(0);
    const dir = path.join(dataDir, "spool");
    const body = fs
      .readdirSync(dir)
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("");
    expect(body).toContain("UserPromptSubmit");
    expect(body).not.toContain("zebra-confidential");
  });
  it("exits 0 even on garbage stdin and writes nothing", () => {
    const dataDir = tmp();
    const r = run("not json at all", { AI_OFFICE_DATA_DIR: dataDir, AI_OFFICE_PORT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(path.join(dataDir, "spool"))).toBe(false);
  });
  it("posts the sanitized payload with the token to a running server", async () => {
    const dataDir = tmp();
    const token = "secret-token-".padEnd(40, "x");
    fs.writeFileSync(path.join(dataDir, "hook-token"), token);
    let got;
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        got = { headers: req.headers, body: JSON.parse(b), url: req.url };
        res.writeHead(202).end("{}");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, AI_OFFICE_DATA_DIR: dataDir, AI_OFFICE_PORT: String(port) },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (c) => resolve({ c, out }));
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-abc",
          cwd: "C:\\p",
          prompt: "x".repeat(42),
          transcript_path: "C:\\t.jsonl",
        }),
      );
    });
    server.close();
    expect(code).toEqual({ c: 0, out: "" });
    expect(got.url).toBe("/api/hooks/claude");
    expect(got.headers["x-ai-office-token"]).toBe(token);
    expect(got.body.hook_event_name).toBe("UserPromptSubmit");
    expect(got.body.prompt).toBeUndefined();
    expect(got.body.prompt_text).toBe("x".repeat(42)); // local server only, for routing
    expect(got.body.prompt_length).toBe(42);
    expect(JSON.stringify(got.body)).not.toContain("t.jsonl");
    expect(fs.existsSync(path.join(dataDir, "spool"))).toBe(false); // delivered, so nothing buffered
  });
});

describe("installer (pure)", () => {
  const existing = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] },
  };
  it("adds async non-blocking hooks for all supported events and preserves user hooks", () => {
    const next = addHooks(existing, 'node "/x/ai-office-hook.mjs"');
    expect(status(next).installed).toBe(true);
    expect(next.permissions).toEqual(existing.permissions);
    expect(next.hooks.PreToolUse).toHaveLength(2);
    expect(next.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    const ours = next.hooks.PostToolUse[0].hooks[0];
    expect(ours.async).toBe(true);
    expect(ours.timeout).toBeLessThanOrEqual(5);
  });
  it("is idempotent", () => {
    const once = addHooks(existing);
    expect(addHooks(once)).toEqual(once);
  });
  it("round-trips: remove(add(x)) deep-equals x", () => {
    expect(removeHooks(addHooks(existing))).toEqual(existing);
    expect(removeHooks(addHooks({}))).toEqual({});
  });
});

describe("installer (filesystem, project-local)", () => {
  it("backs up, installs, and fully restores an existing settings file", () => {
    const proj = tmp();
    const dir = path.join(proj, ".claude");
    fs.mkdirSync(dir);
    const file = path.join(dir, "settings.local.json");
    const original = JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2) + "\n";
    fs.writeFileSync(file, original);
    const dry = install(proj, { dryRun: true });
    expect(dry.written).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    const r = install(proj);
    expect(r.written).toBe(true);
    expect(fs.readFileSync(r.backup, "utf8")).toBe(original);
    expect(status(JSON.parse(fs.readFileSync(file, "utf8"))).installed).toBe(true);
    expect(install(proj).changed).toBe(false);
    uninstall(proj);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(original));
    expect(fs.existsSync(path.join(dir, "ai-office-hooks.manifest.json"))).toBe(false);
  });
  it("removes the settings file entirely when it did not exist before", () => {
    const proj = tmp();
    install(proj);
    expect(fs.existsSync(path.join(proj, ".claude", "settings.local.json"))).toBe(true);
    uninstall(proj);
    expect(fs.existsSync(path.join(proj, ".claude", "settings.local.json"))).toBe(false);
  });
  it("refuses to touch invalid JSON", () => {
    const proj = tmp();
    fs.mkdirSync(path.join(proj, ".claude"));
    fs.writeFileSync(path.join(proj, ".claude", "settings.local.json"), "{ nope");
    expect(() => install(proj)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(proj, ".claude", "settings.local.json"), "utf8")).toBe("{ nope");
  });
  it("CLI install without consent changes nothing", () => {
    const proj = tmp();
    const r = spawnSync(process.execPath, [path.join(here, "install.mjs"), "install", "--project", proj], {
      encoding: "utf8",
      input: "",
    });
    expect(r.stdout).toMatch(/Cancelled/);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
  });
  it("registers exactly the documented event set", () => {
    expect(HOOK_EVENTS).toHaveLength(14);
  });
});
