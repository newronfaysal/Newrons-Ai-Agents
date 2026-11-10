import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DemoRunner } from "../demo.js";
import type { Ingestor } from "../ingest.js";
import type { HookPayload } from "../normalize.js";
import { requireAuth, type Tokens } from "../security.js";

export function registerLive(
  app: FastifyInstance,
  cfg: Config,
  ingestor: Ingestor,
  tokens: Tokens,
  demo: DemoRunner,
  clients: Set<{ send(data: string): void; readyState: number }>,
) {
  // The UI fetches its token here. Host + Origin are verified by the global guard, and a custom header forces a CORS preflight.
  app.get("/api/bootstrap", async (req, reply) => {
    if (req.headers["x-requested-with"] !== "ai-office")
      return reply.code(400).send({ error: "missing_header" });
    return { uiToken: tokens.uiToken, version: "0.1.0", demo: demo.running, wsPath: "/ws" };
  });

  app.get("/api/health", async () => ({
    ok: true,
    time: new Date().toISOString(),
    demo: demo.running,
    clients: clients.size,
    integrations: { observability: "hooks", managedExecution: "disabled" },
  }));

  const hookAuth = requireAuth(tokens, ["hook"]);
  const eventAuth = requireAuth(tokens, ["ui", "hook"]);

  // Claude Code hook script -> server. Always cheap and idempotent.
  app.post("/api/hooks/claude", { preHandler: hookAuth, bodyLimit: 64 * 1024 }, async (req, reply) => {
    const body = z.object({}).passthrough().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const r = ingestor.ingestHook(body.data as HookPayload);
    return reply.code(r.status === "ignored" ? 200 : 202).send(r);
  });

  // Manual / orchestrated / demo events. Observed events may only arrive via the hook endpoint.
  app.post("/api/events", { preHandler: eventAuth, bodyLimit: 32 * 1024 }, async (req, reply) => {
    const b = req.body as { sourceType?: string } | null;
    if (b && b.sourceType === "observed")
      return reply.code(400).send({ error: "observed_events_only_via_hook" });
    if (b && b.sourceType === "demo")
      return reply.code(400).send({ error: "demo_events_only_from_demo_runner" });
    try {
      const r = ingestor.ingestEvent(req.body);
      return reply.code(r.status === "duplicate" ? 200 : 202).send(r);
    } catch (e) {
      if (e instanceof z.ZodError)
        return reply.code(400).send({
          error: "invalid_event",
          issues: e.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      throw e;
    }
  });

  app.post("/api/demo/start", { preHandler: requireAuth(tokens, ["ui"]) }, async (req) => {
    const b = z.object({ speed: z.number().min(0.5).max(20).default(1) }).parse(req.body ?? {});
    demo.start(b.speed);
    return { demo: true };
  });
  app.post("/api/demo/stop", { preHandler: requireAuth(tokens, ["ui"]) }, async () => {
    demo.stop();
    return { demo: false };
  });
}
