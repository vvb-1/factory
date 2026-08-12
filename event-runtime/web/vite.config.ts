import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-server proxy mirrors serve.mjs: the browser sees one origin, /api/*
// forwards to the loopback control API (webui spec §3).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.FACTORY_EVENT_PORT || 7381}`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
