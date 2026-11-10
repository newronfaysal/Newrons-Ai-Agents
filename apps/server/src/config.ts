import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  retentionDays: number;
  allowedOrigins: string[];
  staleAfterMs: number;
  webDistDir: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.AI_OFFICE_PORT ?? 4317);
  const extra = (env.AI_OFFICE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    host: env.AI_OFFICE_HOST ?? "127.0.0.1",
    port,
    dataDir: path.resolve(env.AI_OFFICE_DATA_DIR ?? path.join(here, "../../../data")),
    retentionDays: Number(env.AI_OFFICE_RETENTION_DAYS ?? 30),
    allowedOrigins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      ...extra,
    ],
    staleAfterMs: 120_000,
    webDistDir: path.resolve(here, "../../web/dist"),
  };
}
