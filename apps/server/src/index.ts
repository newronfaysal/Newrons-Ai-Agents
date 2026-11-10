import { buildApp } from "./app.js";

const h = await buildApp();
await h.app.listen({ host: h.cfg.host, port: h.cfg.port });
console.log(`AI Office server listening on http://${h.cfg.host}:${h.cfg.port}`);
console.log(`Data dir: ${h.cfg.dataDir}`);
if (h.cfg.host !== "127.0.0.1" && h.cfg.host !== "localhost" && h.cfg.host !== "::1") {
  console.warn("WARNING: bound to a non-loopback address. The dashboard is intended for localhost only.");
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void h.close().then(() => process.exit(0)));
