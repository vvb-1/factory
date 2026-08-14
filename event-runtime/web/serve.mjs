#!/usr/bin/env bun
/**
 * Web control plane server (docs/event-runtime-webui.md §3).
 *
 * Static bundle + /api/* proxy to the loopback control API, so the browser
 * has one origin. Deliberately imports nothing from ../lib/ — it is a client
 * of the runtime, not part of it (spec §9). Loopback only: no auth by
 * decision (spec §1); binding beyond 127.0.0.1 is the moment auth becomes a
 * precondition, so no --host flag exists here.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.FACTORY_EVENT_WEB_PORT || 7382);
const API_PORT = Number(process.env.FACTORY_EVENT_PORT || 7381);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error(
    `no build at ${DIST} — build it first:\n  cd event-runtime/web && bun install && bun run build`,
  );
  process.exit(1);
}

Bun.serve({
  hostname: HOST,
  port: WEB_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const target = `http://127.0.0.1:${API_PORT}${url.pathname.slice(4) || "/"}${url.search}`;
      // Pass-through, nothing added: the proxy exists only for same-origin.
      return fetch(target, { method: req.method, headers: req.headers, body: req.body });
    }

    // Static, confined to dist/ — reject traversal rather than resolving it.
    const resolved = path.normalize(path.join(DIST, url.pathname));
    if (!resolved.startsWith(DIST)) return new Response("not found", { status: 404 });
    const file = Bun.file(resolved === DIST ? path.join(DIST, "index.html") : resolved);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(path.join(DIST, "index.html")));
  },
});

console.log(`web control plane on http://${HOST}:${WEB_PORT} → API 127.0.0.1:${API_PORT}`);
