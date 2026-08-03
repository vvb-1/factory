/**
 * config/schedule.yaml -> job objects.
 *
 * Shared by deploy/gen.mjs (launchd, unattended) and orchestrator/run.mjs
 * (foreground, watched) so the two execution modes can never disagree about
 * what the jobs are.
 *
 * Uses Bun.YAML rather than a hand-rolled parser. The hand-rolled one was the
 * most fragile code in this repo — it silently mis-parsed anything outside the
 * exact subset it was written for, and a scheduler that misreads its own
 * schedule fails in the least debuggable way available.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (typeof Bun === "undefined") {
  throw new Error(
    "factory runs on bun (Bun.YAML). Use `bun <script>` instead of `node <script>`.\n" +
    "Install: brew install oven-sh/bun/bun"
  );
}

export function parseSchedule(text) {
  const doc = Bun.YAML.parse(text) ?? {};
  return { defaults: doc.defaults ?? {}, jobs: doc.jobs ?? [] };
}

/** "15m" / "6h" / "90s" -> seconds */
export function toSeconds(every) {
  const m = String(every).match(/^(\d+)([smh])$/);
  if (!m) throw new Error(`bad interval: ${every}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

export function loadSchedule() {
  return parseSchedule(readFileSync(path.join(ROOT, "config/schedule.yaml"), "utf8"));
}
