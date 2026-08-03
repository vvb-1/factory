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

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const GATE = argv.includes("--gate");
// Below this, a refresh costs more than the compile it saves.
const THRESHOLD = Number(val("--threshold") ?? 15);

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repo = (cfg.repos ?? []).find((r) => r.name === val("--repo"));
if (!repo) { console.error("--repo required"); process.exit(2); }

const repoPath = expand(repo.path);
const warmDir = path.join(expand(repo.worktree_root ?? ""), ".warm");
const sh = (cmd, cwd) => spawnSync("/bin/bash", ["-lc", cmd], { cwd, encoding: "utf8" });

if (!existsSync(warmDir)) {
  console.log(`${repo.name}: no warm cache at ${warmDir}`);
  if (GATE) process.exit(repo.worktree_warm ? 0 : 1);
}

const warmHead = existsSync(warmDir) ? sh("git rev-parse HEAD", warmDir).stdout.trim() : null;
sh("git fetch --quiet", repoPath);
const behind = warmHead
  ? Number(sh(`git rev-list --count ${warmHead}..origin/${repo.base}`, repoPath).stdout.trim() || 0)
  : Infinity;
const age = warmHead ? sh(`git log -1 --format=%ar ${warmHead}`, repoPath).stdout.trim() : "n/a";

if (GATE) {
  if (behind >= THRESHOLD) { console.log(`${repo.name}: warm cache ${behind} commits behind — refresh`); process.exit(0); }
  console.log(`${repo.name}: warm cache ${behind} commits behind — fresh enough`);
  process.exit(1);
}

console.log(`\n${repo.name} warm cache`);
console.log(`  path:   ${repo.worktree_root}/.warm`);
console.log(`  head:   ${warmHead?.slice(0, 8) ?? "-"}  (${age})`);
console.log(`  behind: ${behind === Infinity ? "n/a" : behind} commit(s) on origin/${repo.base}`);
console.log(behind >= THRESHOLD
  ? `  → stale: every new worktree pays a full compile instead of cloning a usable cache`
  : `  → fresh enough (threshold ${THRESHOLD})`);

if (!APPLY) { console.log(`\n  re-run with --apply to refresh\n`); process.exit(0); }

if (!repo.worktree_warm) { console.error(`\n  ${repo.name} has no worktree_warm script in repos.yaml`); process.exit(2); }

console.log(`\n  running ${repo.worktree_warm} — this compiles once so that N worktrees don't...\n`);
const r = spawnSync("/bin/bash", [repo.worktree_warm], { cwd: repoPath, stdio: "inherit" });
process.exit(r.status ?? 1);
