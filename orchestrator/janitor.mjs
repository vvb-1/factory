#!/usr/bin/env bun
/**
 * Reclaim worktrees whose tickets are finished.
 *
 *   bun orchestrator/janitor.mjs --repo bj29           # dry run
 *   bun orchestrator/janitor.mjs --repo bj29 --apply
 *   bun orchestrator/janitor.mjs --repo bj29 --gate    # exit 0 if there is work
 *
 * Every worktree holds a checkout and (here) a per-ticket database. The merge
 * stage is supposed to tear its own down, but a crashed run, a merge done by
 * hand, or a ticket closed in Linear all leave one behind — and nothing
 * notices, because an orphaned worktree looks exactly like an active one.
 *
 * When this was written bj29 had 21 ticket worktrees, 20 of them for Done
 * tickets, on a disk at 89%. That is the failure mode: silent accumulation.
 *
 * SAFETY: this calls the repo's own worktree-down.sh WITHOUT --force, so a
 * worktree with uncommitted changes or unpushed commits refuses to be removed.
 * Losing an agent's unpushed work would be far worse than the disk it holds.
 * Never add --force here; if a worktree won't go, that is a finding to look at.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const GATE = argv.includes("--gate");
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

const expand = (p) => p.replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));
if (!repos.length) { console.error("no matching repo in config/repos.yaml"); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
};

let totalReclaimable = 0;

for (const repo of repos) {
  const root = expand(repo.worktree_root ?? "");
  const repoPath = expand(repo.path);
  if (!root || !existsSync(root)) continue;

  // Only ever consider <TEAM>-<number> directories. Named worktrees (a release
  // branch, a scratch checkout) are somebody's deliberate workspace and are not
  // this tool's business.
  const pattern = new RegExp(`^${repo.team}-\\d+$`);
  const all = readdirSync(root);
  const tickets = all.filter((d) => pattern.test(d));
  const named = all.filter((d) => !pattern.test(d) && !d.startsWith("."));

  if (!GATE) console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${tickets.length} ticket worktree(s) in ${repo.worktree_root}`));

  let states = {};
  if (tickets.length) {
    const nums = tickets.map((t) => Number(t.split("-")[1]));
    const q = `query($n:[Float!]){ issues(first:250, filter:{ number:{in:$n}, team:{key:{eq:"${repo.team}"}} }){ nodes{ identifier state{name type} } } }`;
    const nodes = (await gql(q, { n: nums }))?.issues?.nodes ?? [];
    states = Object.fromEntries(nodes.map((n) => [n.identifier, n.state]));
  }

  const finished = tickets.filter((t) => ["completed", "canceled"].includes(states[t]?.type));
  const live = tickets.filter((t) => states[t] && !["completed", "canceled"].includes(states[t].type));
  const unknown = tickets.filter((t) => !states[t]);
  totalReclaimable += finished.length;

  if (GATE) continue;

  if (live.length) console.log(c.dim(`  keeping ${live.length} live: ${live.map((t) => `${t} (${states[t].name})`).join(", ")}`));
  if (named.length) console.log(c.dim(`  ignoring ${named.length} named worktree(s): ${named.join(", ")}`));
  if (unknown.length) console.log(c.yellow(`  ${unknown.length} worktree(s) with no matching ticket — left alone: ${unknown.join(", ")}`));

  if (!finished.length) { console.log(c.green("  nothing to reclaim")); continue; }

  console.log(`  ${c.bold(String(finished.length))} reclaimable (ticket finished):`);
  for (const t of finished) console.log(`    ${t}  ${c.dim(states[t].name)}`);

  if (!APPLY) {
    console.log(c.dim(`\n  dry run — re-run with --apply to remove them`));
    continue;
  }

  // report_only repos are surveyed, never modified. Removing a worktree without
  // the repo's own down script leaves its database behind — that is how a
  // Postgres fills up with dev databases nobody can attribute.
  if (repo.report_only) {
    console.log(c.yellow(`\n  report-only: ${repo.name} has no worktree teardown script (PC-15 pending).`));
    console.log(c.dim(`  Not removing anything. These need the repo's own worktree-down.sh so the`));
    console.log(c.dim(`  per-ticket database goes with the checkout.`));
    continue;
  }

  const down = repo.worktree_down;
  if (!down || !existsSync(path.join(repoPath, down))) {
    console.log(c.red(`  ! ${repo.name} has no worktree_down script (${down}) — refusing to remove by hand`));
    continue;
  }

  let removed = 0, refused = 0;
  for (const t of finished) {
    // No --force, deliberately: the script's refusal on uncommitted or unpushed
    // work is the safety property, not an obstacle to work around.
    const r = spawnSync("/bin/bash", [down, t], { cwd: repoPath, encoding: "utf8" });
    if (r.status === 0) { removed++; console.log(`    ${c.green("removed")} ${t}`); }
    else {
      refused++;
      const msg = (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.status}`;
      console.log(`    ${c.yellow("kept")}    ${t} — ${msg}`);
    }
  }
  console.log(`\n  ${removed} removed, ${refused} kept (unpushed or uncommitted work).`);
}

if (GATE) {
  if (totalReclaimable > 0) { console.log(`${totalReclaimable} reclaimable worktree(s)`); process.exit(0); }
  console.log("no worktrees to reclaim");
  process.exit(1);
}
console.log();
