#!/usr/bin/env bun
/**
 * Reclaim worktrees whose tickets are finished.
 *
 *   bun orchestrator/janitor.mjs --repo bj29           # dry run
 *   bun orchestrator/janitor.mjs --repo bj29 --apply
 *   bun orchestrator/janitor.mjs --repo bj29 --gate    # exit 0 if there is work
 *   bun orchestrator/janitor.mjs --repo bj29 --json    # same survey, machine-readable
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
 *
 * `--json` (OPS-301) is the same survey the human CLI prints, as one object
 * per `--repo` so the loopback control API can spawn this script rather than
 * reimplement Linear + worktree discovery. Stdout is JSON only; the colour
 * log is skipped. `--force` is still not a flag and must never become one.
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const GATE = argv.includes("--gate");
const JSON_OUT = argv.includes("--json");
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

const expand = (p) => p.replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));
if (!repos.length) { console.error("no matching repo in config/repos.yaml"); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const quiet = JSON_OUT || GATE;

// Keep a lightweight per-repo run marker. Unlike worktree discovery this does
// not depend on there being an orphan, so `factory status` can accurately say
// when the janitor was last invoked even when it found nothing.
if (!GATE) {
  try {
    const logDir = path.join(homedir(), ".factory/logs");
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
    for (const repo of repos) appendFileSync(path.join(logDir, `janitor-${repo.name}-${stamp}.log`), `${new Date().toISOString()} ${APPLY ? "apply" : "dry"}\n`);
  } catch { /* observability must never block safe cleanup */ }
}

function emptySurvey(repo) {
  return {
    name: repo.name,
    apply: APPLY,
    missingRoot: false,
    reclaimable: [],
    kept: [],
    named: [],
    unknown: [],
    removed: [],
    refused: [],
    skippedApplyReason: null,
  };
}

async function survey(repo) {
  const result = emptySurvey(repo);
  const root = expand(repo.worktree_root ?? "");
  const repoPath = expand(repo.path);
  if (!root || !existsSync(root)) {
    result.missingRoot = true;
    return result;
  }

  // Only ever consider <TEAM>-<number> directories. Named worktrees (a release
  // branch, a scratch checkout) are somebody's deliberate workspace and are not
  // this tool's business.
  const pattern = new RegExp(`^${repo.team}-\\d+$`);
  const all = readdirSync(root);
  const tickets = all.filter((d) => pattern.test(d));
  result.named = all.filter((d) => !pattern.test(d) && !d.startsWith("."));

  let states = {};
  if (tickets.length) {
    const nums = tickets.map((t) => Number(t.split("-")[1]));
    const q = `query($n:[Float!]){ issues(first:250, filter:{ number:{in:$n}, team:{key:{eq:"${repo.team}"}} }){ nodes{ identifier state{name type} } } }`;
    const nodes = (await gql(q, { n: nums }))?.issues?.nodes ?? [];
    states = Object.fromEntries(nodes.map((n) => [n.identifier, n.state]));
  }

  const finished = tickets.filter((t) => ["completed", "canceled"].includes(states[t]?.type));
  result.kept = tickets
    .filter((t) => states[t] && !["completed", "canceled"].includes(states[t].type))
    .map((t) => ({ id: t, state: states[t].name }));
  result.unknown = tickets.filter((t) => !states[t]);
  result.reclaimable = finished.map((t) => ({ id: t, state: states[t].name }));

  if (!APPLY || !finished.length) return result;

  // `report_only` disables dispatch, not safe cleanup. A repo with its own
  // configured teardown script can be reclaimed; one without it is surveyed
  // only, because removing a worktree by hand leaves its database behind.
  const down = repo.worktree_down;
  if (repo.report_only && !down) {
    result.skippedApplyReason = `report-only: ${repo.name} has no worktree teardown script (PC-15 pending)`;
    return result;
  }

  if (!down || !existsSync(path.join(repoPath, down))) {
    result.skippedApplyReason = `${repo.name} has no worktree_down script (${down}) — refusing to remove by hand`;
    return result;
  }

  for (const t of finished) {
    // No --force, deliberately: the script's refusal on uncommitted or unpushed
    // work is the safety property, not an obstacle to work around.
    const r = spawnSync("/bin/bash", [down, t], { cwd: repoPath, encoding: "utf8" });
    if (r.status === 0) result.removed.push(t);
    else {
      const reason = (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.status}`;
      result.refused.push({ id: t, reason });
    }
  }
  return result;
}

function printHuman(repo, result) {
  if (result.missingRoot) return;
  const n = result.reclaimable.length + result.kept.length + result.unknown.length;
  console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${n} ticket worktree(s) in ${repo.worktree_root}`));
  if (result.kept.length) {
    console.log(c.dim(`  keeping ${result.kept.length} live: ${result.kept.map((t) => `${t.id} (${t.state})`).join(", ")}`));
  }
  if (result.named.length) console.log(c.dim(`  ignoring ${result.named.length} named worktree(s): ${result.named.join(", ")}`));
  if (result.unknown.length) {
    console.log(c.yellow(`  ${result.unknown.length} worktree(s) with no matching ticket — left alone: ${result.unknown.join(", ")}`));
  }
  if (!result.reclaimable.length) {
    console.log(c.green("  nothing to reclaim"));
    return;
  }
  console.log(`  ${c.bold(String(result.reclaimable.length))} reclaimable (ticket finished):`);
  for (const t of result.reclaimable) console.log(`    ${t.id}  ${c.dim(t.state)}`);
  if (!APPLY) {
    console.log(c.dim(`\n  dry run — re-run with --apply to remove them`));
    return;
  }
  if (result.skippedApplyReason) {
    console.log(c.yellow(`\n  ${result.skippedApplyReason}`));
    if (result.skippedApplyReason.startsWith("report-only:")) {
      console.log(c.dim(`  Not removing anything. These need the repo's own worktree-down.sh so the`));
      console.log(c.dim(`  per-ticket database goes with the checkout.`));
    }
    return;
  }
  for (const t of result.removed) console.log(`    ${c.green("removed")} ${t}`);
  for (const t of result.refused) console.log(`    ${c.yellow("kept")}    ${t.id} — ${t.reason}`);
  console.log(`\n  ${result.removed.length} removed, ${result.refused.length} kept (unpushed or uncommitted work).`);
}

const surveys = [];
for (const repo of repos) {
  const result = await survey(repo);
  surveys.push(result);
  if (GATE) continue;
  if (!quiet) printHuman(repo, result);
}

if (GATE) {
  const totalReclaimable = surveys.reduce((n, s) => n + s.reclaimable.length, 0);
  if (totalReclaimable > 0) { console.log(`${totalReclaimable} reclaimable worktree(s)`); process.exit(0); }
  console.log("no worktrees to reclaim");
  process.exit(1);
}

if (JSON_OUT) {
  // One `--repo` is the API's contract (a single selected project). Several
  // names wrap in `{ results }` so a human ` --repo a,b --json` still parses.
  const payload = surveys.length === 1 ? surveys[0] : { apply: APPLY, results: surveys };
  console.log(JSON.stringify(payload));
} else {
  console.log();
}
