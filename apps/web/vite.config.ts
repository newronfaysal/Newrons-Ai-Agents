import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const API = process.env.AI_OFFICE_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Same-origin in dev: the proxy keeps Host/Origin allowlisted on the server and avoids CORS entirely.
    proxy: {
      "/api": { target: API, changeOrigin: false, headers: { origin: "http://127.0.0.1:5173" } },
      "/ws": { target: API.replace("http", "ws"), ws: true, headers: { origin: "http://127.0.0.1:5173" } },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
