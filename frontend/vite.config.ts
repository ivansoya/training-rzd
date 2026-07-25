import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev flow: backend runs in docker compose; the nginx gateway on :8080
      // already routes /api/* to the right microservice (incl. SSE), so the
      // dev server just forwards everything there.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
});
