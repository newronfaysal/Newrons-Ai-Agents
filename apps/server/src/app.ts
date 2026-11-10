import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fstatic from "@fastify/static";
import { ZodError } from "zod";
import type { WsMessage } from "@ai-office/shared";
import { loadConfig, type Config } from "./config.js";
import { backupDb, openAndMigrate, pruneEvents, type DB } from "./db.js";
import { DemoRunner } from "./demo.js";
import { Ingestor } from "./ingest.js";
import { registerApi } from "./routes/api.js";
import { registerLive } from "./routes/live.js";
import { registerIntegration } from "./integration.js";
import { registerRouting } from "./routes/routing.js";
import { makeTokens, originGuard, type Tokens } from "./security.js";
import { drainSpool } from "./spool.js";

export interface AppHandle {
  app: FastifyInstance;
  db: DB;
  cfg: Config;
  tokens: Tokens;
  ingestor: Ingestor;
  demo: DemoRunner;
  close(): Promise<void>;
}

export async function buildApp(
  overrides: Partial<Config> & { dbFile?: string; captureCommandText?: boolean } = {},
): Promise<AppHandle> {
  const cfg: Config = { ...loadConfig(), ...overrides };
  const db = openAndMigrate(overrides.dbFile ?? path.join(cfg.dataDir, "ai-office.db"));
  const tokens = makeTokens(cfg.dataDir);
  const ingestor = new Ingestor(db, {
    staleAfterMs: cfg.staleAfterMs,
    captureCommandText: overrides.captureCommandText ?? process.env.AI_OFFICE_CAPTURE_COMMANDS === "on",
  });
  ingestor.restore();

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  // Tolerate bodyless POST/DELETE that still carry a JSON content-type; malformed JSON is still a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("invalid_json") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  await app.register(cors, {
    origin: cfg.allowedOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "x-ai-office-ui", "x-ai-office-token", "x-requested-with"],
  });
  await app.register(websocket);
  app.addHook("onRequest", originGuard(cfg));

  const clients = new Set<{ send(data: string): void; readyState: number }>();
  const send = (msg: WsMessage) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(data);
  };
  ingestor.setBroadcast(send);
  const demo = new DemoRunner(ingestor, () => {
    send({ type: "hello", serverTime: new Date().toISOString(), mode: { demo: demo.running } });
    send({ type: "agents", agents: ingestor.registry.snapshot() }); // so removed demo avatars disappear immediately
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        error: "validation",
        issues: err.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? "internal_error" : (e.message ?? "error") });
  });

  registerLive(app, cfg, ingestor, tokens, demo, clients);
  registerApi(app, db, ingestor, tokens, () => send({ type: "tasks-changed" }));
  registerIntegration(app, cfg, db);
  registerRouting(app, db, ingestor.router, tokens);

  await app.register(async (inst) => {
    inst.get("/ws", { websocket: true }, (socket) => {
      clients.add(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          serverTime: new Date().toISOString(),
          mode: { demo: demo.running },
        } satisfies WsMessage),
      );
      socket.send(
        JSON.stringify({ type: "agents", agents: ingestor.registry.snapshot() } satisfies WsMessage),
      );
      socket.send(
        JSON.stringify({
          type: "departments",
          departments: ingestor.router.departmentStates(),
        } satisfies WsMessage),
      );
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
    });
  });

  if (cfg.webDistDir && fs.existsSync(path.join(cfg.webDistDir, "index.html"))) {
    await app.register(fstatic, { root: cfg.webDistDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "not_found" })
        : reply.sendFile("index.html"),
    );
  }

  // Housekeeping: freshness transitions, spool drain, ping, retention, daily backup.
  let lastHash = "";
  const timers = [
    setInterval(() => {
      const snap = ingestor.registry.snapshot();
      const h = JSON.stringify(snap.map((a) => [a.agentId, a.freshness, a.activity]));
      if (h !== lastHash) {
        lastHash = h;
        send({ type: "agents", agents: snap });
      }
      try {
        // inactivity timeouts + department state decay (results linger, silent work becomes "waiting")
        if (ingestor.router.tick()) send({ type: "agents", agents: ingestor.registry.snapshot() });
      } catch {
        /* keep serving */
      }
      send({ type: "ping", t: Date.now() });
    }, 10_000),
    setInterval(() => {
      try {
        drainSpool(cfg.dataDir, ingestor);
      } catch {
        /* keep serving */
      }
    }, 15_000),
    setInterval(() => {
      try {
        pruneEvents(db, cfg.retentionDays);
        ingestor.router.pruneLog(cfg.retentionDays);
        backupDb(db, cfg.dataDir);
      } catch {
        /* keep serving */
      }
    }, 24 * 3600_000),
  ];
  for (const t of timers) t.unref();
  try {
    drainSpool(cfg.dataDir, ingestor);
    pruneEvents(db, cfg.retentionDays);
  } catch {
    /* ignore */
  }

  return {
    app,
    db,
    cfg,
    tokens,
    ingestor,
    demo,
    async close() {
      timers.forEach(clearInterval);
      demo.stop(false);
      await app.close();
      db.close();
    },
  };
}
