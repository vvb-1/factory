#!/usr/bin/env bun
/**
 * Is this machine ready to run the loop for a repo?
 *
 *   bun orchestrator/doctor.mjs              # every configured repo
 *   bun orchestrator/doctor.mjs --repo bj29
 *
 * The factory does NOT clone target repos. The main checkout is yours — you
 * work in it, it holds your uncommitted changes, and cloning a private repo
 * needs your credentials. Factory owns the control plane; you own the
 * checkouts. What it owes you is a clear answer to "why isn't this repo
 * working", which is this.
 *
 * Read-only. Every failure names the fix.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let failures = 0;
const check = (ok, label, detail, fix) => {
  if (ok === "warn") {
    console.log(`  ${c.yellow("!")} ${label}${detail ? c.dim("  " + detail) : ""}`);
    if (fix) console.log(`      ${c.dim(fix)}`);
    return;
  }
  console.log(`  ${ok ? c.green("✓") : c.red("✗")} ${label}${detail ? c.dim("  " + detail) : ""}`);
  if (!ok) {
    failures++;
    if (fix) console.log(`      ${c.bold("fix:")} ${fix}`);
  }
};

const sh = (cmd, cwd) => spawnSync("/bin/bash", ["-lc", cmd], { cwd, encoding: "utf8" });

// ------------------------------------------------------------------ machine ---
console.log(c.bold("\nmachine"));
for (const [bin, fix] of [
  ["bun", "brew install oven-sh/bun/bun"],
  ["claude", "install Claude Code, then `claude setup-token` for unattended runs"],
  ["git", "xcode-select --install"],
  ["gh", "brew install gh && gh auth login"],
]) {
  const r = sh(`command -v ${bin}`);
  check(r.status === 0, bin, r.stdout.trim(), fix);
}

const key = process.env.LINEAR_API_KEY || (existsSync(expand("~/Develop/hdkiller/.env")) &&
  /LINEAR_API_KEY/.test(readFileSync(expand("~/Develop/hdkiller/.env"), "utf8")));
check(Boolean(key), "LINEAR_API_KEY", key ? "found" : "", "add it to ~/Develop/hdkiller/.env or the environment");

// Disk: worktrees are the bulk of what this machine holds, and a bootstrap that
// fails halfway leaves a half-provisioned database behind.
const df = sh("df -h ~ | tail -1 | awk '{print $5\" used, \"$4\" free\"}'");
const pct = Number((df.stdout.match(/(\d+)%/) || [])[1] || 0);
check(pct < 90 ? true : "warn", "disk", df.stdout.trim(),
  pct >= 90 ? "run `bun orchestrator/janitor.mjs --repo <name> --apply` to reclaim finished worktrees" : null);

if (!repos.length) {
  console.error(c.red(`\nno matching repo in config/repos.yaml`));
  process.exit(2);
}

// -------------------------------------------------------------------- repos ---
for (const repo of repos) {
  console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}`));
  const p = expand(repo.path);

  const cloned = existsSync(p) && existsSync(path.join(p, ".git"));
  check(cloned, "checkout exists", p,
    `git clone git@github.com:${repo.github}.git ${repo.path}   ${c.dim("(you clone it, not the factory)")}`);
  if (!cloned) continue;

  const remote = sh("git remote get-url origin", p).stdout.trim();
  check(remote.includes(repo.github), "remote matches repos.yaml", remote,
    `expected ${repo.github} — fix repos.yaml or the remote`);

  const hasBase = sh(`git rev-parse --verify origin/${repo.base}`, p).status === 0;
  check(hasBase, `base branch origin/${repo.base}`, "", "git fetch origin");

  // Worktree tooling is PC-15 — the precondition for dispatching concurrent
  // agents. Without it a repo's safe concurrency is one agent, whatever the
  // dispatcher thinks.
  for (const [k, label] of [["worktree_up", "worktree-up script"], ["worktree_down", "worktree-down script"]]) {
    const s = repo[k];
    const full = s ? path.join(p, s) : null;
    const ok = Boolean(full && existsSync(full));
    const exec = ok && (statSync(full).mode & 0o111) !== 0;
    check(ok && exec, `${label}`, s ?? "not configured",
      !ok ? `this repo has no ${k} — dispatch is unsafe here (PC-15); see CW-363 / CLNT-609 for the pattern`
          : `chmod +x ${s}`);
  }

  const wtRoot = expand(repo.worktree_root ?? "");
  check(Boolean(wtRoot) && existsSync(wtRoot) ? true : "warn", "worktree root", repo.worktree_root ?? "not set",
    "created on first worktree-up; nothing to do if the repo is new");

  const dirty = sh("git status --porcelain | wc -l", p).stdout.trim();
  check(dirty === "0" ? true : "warn", "main checkout clean", `${dirty} uncommitted file(s)`,
    dirty === "0" ? null : "fine for triage (read-only), but specs are written against what's on disk");

  // Does the Linear project actually resolve? A typo here fails at dispatch
  // time, after a worktree and a database already exist.
  try {
    const q = `query($t:String!,$p:String!){ issues(first:1, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}} }){ nodes{ identifier } } }`;
    const nodes = (await gql(q, { t: repo.team, p: repo.project }))?.issues?.nodes ?? [];
    check(true, "Linear team/project resolves", `${repo.team} / ${repo.project}${nodes[0] ? ` (e.g. ${nodes[0].identifier})` : " (no open issues)"}`);
  } catch (e) {
    check(false, "Linear team/project resolves", String(e.message).slice(0, 60),
      "check team key and project name against linear.md §1–2 (CW projects carry a 'Coach Watts - ' prefix)");
  }

  check(Boolean(repo.verify), "verification command", repo.verify ?? "",
    "set `verify:` in repos.yaml — agents must never open a PR without clean output");
  check(Boolean(repo.smoke_workflow) ? true : "warn", "post-deploy smoke check", repo.smoke_workflow ?? "none",
    repo.smoke_workflow ? null : "without one, Done means merged rather than running");
}

console.log();
if (failures) {
  console.log(c.red(`${failures} problem(s) — the loop will fail on these before it does anything useful.\n`));
  process.exit(1);
}
console.log(c.green("ready.\n"));
