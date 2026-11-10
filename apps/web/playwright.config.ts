import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const PORT = 4411;
const DATA = path.join(os.tmpdir(), "ai-office-e2e-data");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      // Use a system Chrome when PLAYWRIGHT_CHROME is set (e.g. when `playwright install` is unavailable); software WebGL keeps the canvas working headless.
      executablePath: process.env.PLAYWRIGHT_CHROME || undefined,
      args: [
        "--no-sandbox",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--use-gl=angle",
      ],
    },
  },
  webServer: {
    command: `node -e "require('fs').rmSync(process.env.AI_OFFICE_DATA_DIR,{recursive:true,force:true})" && pnpm --filter @ai-office/web build && pnpm --filter @ai-office/server start`,
    cwd: "../..",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { AI_OFFICE_PORT: String(PORT), AI_OFFICE_DATA_DIR: DATA, AI_OFFICE_ALLOWED_ORIGINS: "" },
  },
});
