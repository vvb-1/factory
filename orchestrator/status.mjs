#!/usr/bin/env bun
/**
 * At-a-glance status for the configured repository containing cwd.
 *
 *   factory status
 *   factory status --repo legalease
 *   factory status --json
 *
 * Read-only: refreshes remote refs, reads the live factory queue, and, when
 * configured, fetches the public deployment metadata endpoint.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";
import { loadQueueConfig, fetchQueueSummaries } from "../lib/queue-summary.mjs";
import { recommendNext } from "../lib/next-recommend.mjs";
import { formatAge, deployedRevision, deploymentState, metadataUrl } from "../lib/repo-status.mjs";
import { latestReaperRunMs } from "./reaper.mjs";

const argv = process.argv.slice(2);
const val = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const JSON_OUT = argv.includes("--json");
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const expand = (p) => p?.replace(/^~/, homedir());
const sh = (args, cwd) => {
  const result = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
};

function configuredRepo() {
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  const explicit = val("--repo");
  if (explicit) return (cfg.repos ?? []).find((r) => r.name === explicit) ?? null;
  const cwd = process.cwd();
  const byPath = (cfg.repos ?? []).find((r) => {
    const roots = [r.path, r.worktree_root].map(expand).filter(Boolean);
    return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  });
  if (byPath) return byPath;

  // The factory itself has no worktree_root, and users may create a worktree
  // outside the configured location. The configured GitHub slug remains a
  // stable identity in both cases.
  const remote = sh(["git", "config", "--get", "remote.origin.url"], cwd).out
    .replace(/^git@github\.com:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return (cfg.repos ?? []).find((r) => r.github === remote) ?? null;
}

// Resolve before doing network work so an unmapped cwd fails with an actionable message.
const repoConfig = configuredRepo();
if (!repoConfig) {
  console.error("no configured repository for cwd — pass --repo <name>");
  process.exit(2);
}
const configuredPath = expand(repoConfig.path);
// Worktrees are valid entry points; use the checkout containing cwd for branch
// and cleanliness, but retain the configured root for callers outside a repo.
const repoPath = sh(["git", "rev-parse", "--show-toplevel"], process.cwd()).out || configuredPath;
if (!existsSync(repoPath)) {
  console.error(`configured path does not exist: ${repoPath}`);
  process.exit(2);
}

const deployBranch = repoConfig.deploy_branch ?? (repoConfig.base === "main" ? "main" : "master");
const baseBranch = repoConfig.base;
const metadataBranch = repoConfig.deployment?.branch ?? deployBranch;
const fetchResult = sh(["git", "fetch", "--quiet", "origin", ...new Set([baseBranch, deployBranch, metadataBranch])], repoPath);
const branch = sh(["git", "branch", "--show-current"], repoPath).out || "(detached)";
const head = sh(["git", "rev-parse", "HEAD"], repoPath).out || null;
const dirty = sh(["git", "status", "--porcelain"], repoPath).out.split("\n").filter(Boolean);

function remoteRef(name) {
  const sha = sh(["git", "rev-parse", `origin/${name}`], repoPath).out || null;
  const aheadBehind = head && sha ? sh(["git", "rev-list", "--left-right", "--count", `HEAD...origin/${name}`], repoPath).out.split(/\s+/).map(Number) : [];
  return { branch: name, sha, checkoutAhead: aheadBehind[0] ?? null, checkoutBehind: aheadBehind[1] ?? null };
}
const base = remoteRef(baseBranch);
const deploy = remoteRef(deployBranch);
const metadataRef = metadataBranch === deployBranch ? deploy : metadataBranch === baseBranch ? base : remoteRef(metadataBranch);

let deployment = { configured: false, state: "not configured" };
if (repoConfig.deployment?.url) {
  const url = metadataUrl(repoConfig.deployment.url);
  deployment = { configured: true, url, branch: metadataBranch, state: "unknown" };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!response.ok) {
      deployment.error = `HTTP ${response.status}`;
    } else {
      const payload = await response.json();
      const revision = deployedRevision(payload, repoConfig.deployment.revision_field);
      deployment.payload = payload;
      deployment.revision = revision?.value ?? null;
      deployment.revisionField = revision?.field ?? null;
      const contains = revision?.value && metadataRef.sha
        ? sh(["git", "merge-base", "--is-ancestor", revision.value, `origin/${metadataBranch}`], repoPath).ok
        : null;
      Object.assign(deployment, deploymentState({ deployed: revision?.value, remoteSha: metadataRef.sha, localContains: contains }));
    }
  } catch (error) { deployment.error = error.message; }
}

function latestJanitorRunMs(repo) {
  const dir = path.join(homedir(), ".factory/logs");
  let latest = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!new RegExp(`^janitor-${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}-\\d{6}\\.log$`).test(name)) continue;
      const at = statSync(path.join(dir, name)).mtimeMs;
      if (latest === null || at > latest) latest = at;
    }
  } catch { /* no logs yet */ }
  return latest;
}

const { repos, defaultCap } = loadQueueConfig([repoConfig.name]);
let queue = null, next = null, queueError = null;
try {
  queue = (await fetchQueueSummaries(repos, defaultCap))[0] ?? null;
  if (queue) next = recommendNext(queue);
} catch (error) { queueError = error.message; }

const output = {
  repo: repoConfig.name, path: repoPath, configuredPath, github: repoConfig.github, reportOnly: !!repoConfig.report_only,
  checkout: { branch, head, dirtyFiles: dirty.length }, fetch: fetchResult.ok ? null : fetchResult.err,
  branches: { base, deploy }, deployment,
  maintenance: { reaperLastRun: latestReaperRunMs(), janitorLastRun: latestJanitorRunMs(repoConfig.name) },
  factory: queue ? { queue, next } : { error: queueError },
};
if (JSON_OUT) { console.log(JSON.stringify(output, null, 2)); process.exit(0); }

console.log(c.bold(`\nfactory status — ${repoConfig.name}`));
console.log(c.dim(`${repoPath}${repoConfig.report_only ? "  · report-only" : ""}`));
console.log(`\nCheckout   ${branch}  ${(head ?? "unknown").slice(0, 12)}  ${dirty.length ? c.yellow(`${dirty.length} changed file(s)`) : c.green("clean")}`);
for (const [label, ref] of [["Base", base], ["Deploy", deploy]]) {
  const delta = ref.checkoutAhead == null ? "unavailable" : `checkout +${ref.checkoutAhead}/-${ref.checkoutBehind}`;
  console.log(`${label.padEnd(10)} origin/${ref.branch}  ${(ref.sha ?? "unavailable").slice(0, 12)}  ${c.dim(delta)}`);
}
console.log(`\nDeployment ${deployment.configured ? deployment.url : c.dim("not configured")}`);
if (deployment.configured) {
  console.log(c.dim(`  comparing with origin/${deployment.branch}`));
  if (deployment.revision) console.log(`  ${deployment.revisionField}  ${deployment.revision.slice(0, 12)}`);
  const color = deployment.state === "current" ? c.green : ["stale", "diverged", "different"].includes(deployment.state) ? c.yellow : c.red;
  console.log(`  ${color(deployment.state)} — ${deployment.message ?? deployment.error ?? "could not fetch endpoint"}`);
}
console.log(`\nMaintenance  reaper ${formatAge(output.maintenance.reaperLastRun)}  ·  janitor ${formatAge(output.maintenance.janitorLastRun)}`);
console.log(c.bold("\nFactory now:"));
if (queue) {
  console.log(`  Triage ${queue.triageState} · Todo ${queue.todoNotReady} · Ready ${queue.ready} · In progress ${queue.inProgress} · Review ${queue.inReview} · Blocked ${queue.blocked}`);
  const command = next.command ? `${next.command}${next.args ? ` ${next.args}` : ""}` : "(wait)";
  console.log(`  Next ${c.green(command)} — ${next.reason}`);

  const action = next.command?.replace(/^factory-/, "");
  const explanations = {
    triage: "clarify and prepare the oldest tickets so agents can safely take them",
    work: "claim up to three ready tickets and implement them in isolated worktrees",
    merge: "review mergeable pull requests, verify their checks, then land eligible changes",
    reconcile: "repair claims whose agent/worktree is no longer live",
    digest: "show the questions currently waiting for a human answer",
    unblock: "re-check held tickets for new evidence that removes their block",
    sweep: "retire obsolete or duplicate tickets while the main pipeline is idle",
  };
  const waitExplanation = {
    capacity: "Workers are already at capacity; let an active ticket finish before dispatching another.",
    "path collision": "Ready tickets overlap paths with active work; wait rather than create a conflicting worktree.",
    report_only: "This repository is intentionally report-only until its safe worktree lifecycle exists.",
    idle: "No ticket needs action right now; re-run after a branch, deploy, or ticket changes.",
  };
  console.log(c.bold("\nSuggested action:"));
  if (action && explanations[action]) {
    console.log(`  ${c.green(`factory ${action}${next.args ? ` ${next.args}` : ""}`)} — ${explanations[action]}.`);
  } else if (next.command === "tick") {
    console.log(`  ${c.green("factory tick --repo " + repoConfig.name + " --apply")} — run one orchestrated dispatch/merge pass.`);
  } else {
    console.log(`  ${c.dim(waitExplanation[next.constraint] ?? "No safe factory command is applicable yet; re-run after the state changes.")}`);
  }
  console.log(c.dim("  `factory status --json` is available for scripts; this view is the human-facing hub."));
} else console.log(c.red(`  queue unavailable — ${queueError ?? "unknown error"}`));
console.log();
