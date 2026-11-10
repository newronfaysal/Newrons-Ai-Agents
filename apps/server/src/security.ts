import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

export interface Tokens {
  /** Secret shared with the local Claude Code hook script. Stored in the data dir. */
  hookToken: string;
  /** Per-process token handed to the same-origin web UI. Not persisted. */
  uiToken: string;
}

export function loadOrCreateHookToken(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "hook-token");
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export function makeTokens(dataDir: string): Tokens {
  return { hookToken: loadOrCreateHookToken(dataDir), uiToken: crypto.randomBytes(24).toString("hex") };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function allowedHosts(cfg: Config): Set<string> {
  return new Set(cfg.allowedOrigins.map((o) => new URL(o).host));
}

/** Blocks DNS-rebinding style requests: Host must be one of ours; Origin (if sent) must be allowlisted. */
export function originGuard(cfg: Config) {
  const hosts = allowedHosts(cfg);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host ?? "";
    if (!hosts.has(host)) return reply.code(403).send({ error: "forbidden_host" });
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin))
      return reply.code(403).send({ error: "forbidden_origin" });
  };
}

export type AuthKind = "ui" | "hook";

export function requireAuth(tokens: Tokens, allow: AuthKind[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ui = req.headers["x-ai-office-ui"];
    const hook = req.headers["x-ai-office-token"];
    if (allow.includes("ui") && typeof ui === "string" && safeEqual(ui, tokens.uiToken)) return;
    if (allow.includes("hook") && typeof hook === "string" && safeEqual(hook, tokens.hookToken)) return;
    return reply.code(401).send({ error: "unauthorized" });
  };
}
