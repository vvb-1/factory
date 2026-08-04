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

/**
 * Commands are repo-agnostic verbs; `{{repo}}` is where the target goes.
 *
 * One supervisor per repo is the unit of parallelism: two terminals, each
 * running the same job set against a different repo, each stoppable on its own.
 * The alternative — a second copy of every job per repo in schedule.yaml — is
 * how a schedule file drifts, because the copies are edited one at a time.
 */
function withVars(cmd, vars) {
  if (typeof cmd !== "string") return cmd;
  let out = cmd;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

export function parseSchedule(text, repo = null, harness = null) {
  const doc = Bun.YAML.parse(text) ?? {};
  const defaults = doc.defaults ?? {};
  const target = repo ?? defaults.repo;
  const agent = harness ?? defaults.harness ?? "claude";
  const vars = { repo: target, harness: agent };
  const jobs = (doc.jobs ?? []).map((j) => ({
    ...j,
    command: withVars(j.command, vars),
    dry_command: withVars(j.dry_command, vars),
    gate_command: withVars(j.gate_command, vars),
  }));
  return { defaults, jobs, repo: target, harness: agent };
}

/** "15m" / "6h" / "90s" -> seconds */
export function toSeconds(every) {
  const m = String(every).match(/^(\d+)([smh])$/);
  if (!m) throw new Error(`bad interval: ${every}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

export function loadSchedule(repo = null, harness = null) {
  return parseSchedule(readFileSync(path.join(ROOT, "config/schedule.yaml"), "utf8"), repo, harness);
}
