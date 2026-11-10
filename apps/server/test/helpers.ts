import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type AppHandle } from "../src/app.js";

export const FIXTURES = path.resolve(__dirname, "../../../fixtures/hooks");
export const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

export async function makeApp(
  opts: { dbFile?: string; dataDir?: string; captureCommandText?: boolean } = {},
): Promise<AppHandle & { dataDir: string }> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "aio-"));
  const h = await buildApp({
    dataDir,
    dbFile: opts.dbFile ?? ":memory:",
    captureCommandText: opts.captureCommandText,
  });
  return Object.assign(h, { dataDir });
}

export const ui = (h: AppHandle) => ({
  "x-ai-office-ui": h.tokens.uiToken,
  "content-type": "application/json",
  host: `127.0.0.1:${h.cfg.port}`,
});
export const hook = (h: AppHandle) => ({
  "x-ai-office-token": h.tokens.hookToken,
  "content-type": "application/json",
  host: `127.0.0.1:${h.cfg.port}`,
});
export const plain = (h: AppHandle) => ({ host: `127.0.0.1:${h.cfg.port}` });

import net from "node:net";
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function makeListening(opts: { dbFile?: string; dataDir?: string } = {}) {
  const port = await freePort();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "aio-"));
  const h = await buildApp({
    dataDir,
    dbFile: opts.dbFile ?? ":memory:",
    port,
    allowedOrigins: [`http://127.0.0.1:${port}`],
  });
  await h.app.listen({ host: "127.0.0.1", port });
  return Object.assign(h, { dataDir, port });
}
