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
        // Живая связь — ответ, который молчит секундами. Таймауты прокси
        // на такой ответ — это обрыв каждые пятнадцать секунд и
        // «http proxy error: ECONNRESET» в терминале.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
