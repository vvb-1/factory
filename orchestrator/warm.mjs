#!/usr/bin/env bun
/**
 * Keep the worktree warm cache fresh.
 *
 *   bun orchestrator/warm.mjs --repo bj29            # how stale is it?
 *   bun orchestrator/warm.mjs --repo bj29 --gate     # exit 0 if it needs refreshing
 *   bun orchestrator/warm.mjs --repo bj29 --apply    # refresh it
 *
 * Worktree creation clones node_modules and the build cache from a warm
 * template (APFS clonefile — effectively free). When the template is current,
 * a new worktree is seconds. When it is stale, the clone is worthless: the
 * compile has to redo everything, and every ticket pays it.
 *
 * Observed: a template 99 commits behind turned worktree setup into ~3 minutes
 * per ticket. With three tickets in flight that is ~9 minutes of wall clock
 * before any agent writes a line of code, and it competes for the same cores.
 *
 * Refreshing is the highest-leverage thing to do before a dispatch batch.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";

// Below this, a refresh costs more than the compile it saves.
export const DEFAULT_THRESHOLD = 15;

/** Return a valid object ID, or null when the warm checkout cannot identify HEAD. */
export function parseWarmHead(result) {
  const head = result?.status === 0 ? String(result.stdout ?? "").trim() : "";
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head) ? head : null;
}

/**
 * Parse a rev-list result, failing closed when freshness could not be verified.
 * A fetch error also makes the count unknowable, even if a cached origin ref
 * happens to let rev-list succeed.
 */
export function parseBehindCount(fetchResult, revListResult) {
  const stdout = String(revListResult?.stdout ?? "").trim();
  const stderr = String(revListResult?.stderr ?? "").trim();
  if (fetchResult?.status !== 0 || revListResult?.status !== 0 || stderr || !/^\d+$/.test(stdout)) {
    return Infinity;
  }

  const behind = Number(stdout);
  return Number.isSafeInteger(behind) ? behind : Infinity;
}

/** Exported staleness and gate decision logic for unit tests and other callers. */
export function evaluateWarmCache({
  warmDirExists,
  warmHeadResult,
  fetchResult,
  revListResult,
  threshold = DEFAULT_THRESHOLD,
}) {
  const warmHead = warmDirExists ? parseWarmHead(warmHeadResult) : null;
  const behind = warmHead ? parseBehindCount(fetchResult, revListResult) : Infinity;
  const stale = !Number.isFinite(behind) || behind >= threshold;
  return { warmHead, behind, stale, gateExitCode: stale ? 0 : 1 };
}

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const sh = (cmd, cwd) => spawnSync("/bin/bash", ["-lc", cmd], { cwd, encoding: "utf8" });

export function runWarm({
  argv,
  cfg,
  exists = existsSync,
  shell = sh,
  applyShell = (script, cwd) => spawnSync("/bin/bash", [script], { cwd, stdio: "inherit" }),
  log = console.log,
  error = console.error,
}) {
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
  const apply = argv.includes("--apply");
  const gate = argv.includes("--gate");
  const threshold = Number(val("--threshold") ?? DEFAULT_THRESHOLD);

  const repo = (cfg.repos ?? []).find((r) => r.name === val("--repo"));
  if (!repo) { error("--repo required"); return 2; }

  const repoPath = expand(repo.path);
  const warmDir = path.join(expand(repo.worktree_root ?? ""), ".warm");
  const warmDirExists = exists(warmDir);
  if (!warmDirExists) {
    log(`${repo.name}: no warm cache at ${warmDir} — stale`);
    if (gate) return repo.worktree_warm ? 0 : 1;
  }

  const warmHeadResult = warmDirExists ? shell("git rev-parse HEAD", warmDir) : null;
  const warmHead = parseWarmHead(warmHeadResult);
  const fetchResult = shell("git fetch --quiet", repoPath);
  const revListResult = warmHead
    ? shell(`git rev-list --count ${warmHead}..origin/${repo.base}`, repoPath)
    : null;
  const freshness = evaluateWarmCache({
    warmDirExists,
    warmHeadResult,
    fetchResult,
    revListResult,
    threshold,
  });
  const behind = freshness.behind;
  const age = warmHead ? shell(`git log -1 --format=%ar ${warmHead}`, repoPath).stdout.trim() : "n/a";

  if (gate) {
    if (freshness.stale) {
      const detail = Number.isFinite(behind) ? `${behind} commits behind` : "stale — behind-count unknown";
      log(`${repo.name}: warm cache ${detail} — refresh`);
      return freshness.gateExitCode;
    }
    log(`${repo.name}: warm cache ${behind} commits behind — fresh enough`);
    return freshness.gateExitCode;
  }

  log(`\n${repo.name} warm cache`);
  log(`  path:   ${repo.worktree_root}/.warm`);
  log(`  head:   ${warmHead?.slice(0, 8) ?? "-"}  (${age})`);
  log(`  behind: ${Number.isFinite(behind) ? behind : "n/a"} commit(s) on origin/${repo.base}`);
  log(freshness.stale
    ? `  → stale: every new worktree pays a full compile instead of cloning a usable cache`
    : `  → fresh enough (threshold ${threshold})`);

  if (!apply) { log(`\n  re-run with --apply to refresh\n`); return 0; }

  if (!repo.worktree_warm) { error(`\n  ${repo.name} has no worktree_warm script in repos.yaml`); return 2; }

  log(`\n  running ${repo.worktree_warm} — this compiles once so that N worktrees don't...\n`);
  const result = applyShell(repo.worktree_warm, repoPath);
  return result.status ?? 1;
}

if (import.meta.main) {
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  process.exit(runWarm({ argv: process.argv.slice(2), cfg }));
}
