import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Quack monitor REST + SSE both live on the same port (default 3333).
// All `/api/*` and `/v1/*` calls and the `/api/events/stream` SSE feed
// proxy through the dev server to the running monitor.
const QUACK_MONITOR = process.env.QUACK_MONITOR_URL ?? "http://localhost:3333";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: QUACK_MONITOR,
        changeOrigin: true,
      },
      "/v1": {
        target: QUACK_MONITOR,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
