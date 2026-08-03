#!/usr/bin/env bun
/**
 * Mechanical escalation check: does a PR touch this repo's `escalate_paths`?
 *
 *   bun orchestrator/escalate.mjs --repo bj29 --pr 123
 *
 * Exit 0  — no escalate path touched; the merge stage's normal judgment applies
 * Exit 2  — a listed surface is in the diff; NEVER auto-merge, hand to a human
 * Exit 1+ — couldn't answer (gh failed, unknown repo); treat as escalate
 *
 * This turns the `escalate_paths` lists in config/repos.yaml from documentation
 * into a gate. It is deliberately one-directional: a match here forces
 * escalation, but a clean exit never overrides the global judgment list in
 * policy.yaml (auth, payments, secrets…) — path matching can't see whether a
 * diff CHANGES security-relevant behavior, only where it lives.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { globsOverlap } from "./owned-paths.mjs";
import { ROOT } from "../lib/schedule.mjs";

/** Which changed files hit which escalate globs? Pure, for tests. */
export function matchEscalations(files, globs) {
  const hits = [];
  for (const f of files) {
    const matched = globs.filter((g) => globsOverlap(f, g));
    if (matched.length) hits.push({ file: f, globs: matched });
  }
  return hits;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  const repo = (cfg.repos ?? []).find((r) => r.name === val("--repo"));
  const pr = val("--pr");
  if (!repo || !pr) { console.error(`usage: bun orchestrator/escalate.mjs --repo <name> --pr <number>`); process.exit(3); }

  const globs = repo.escalate_paths ?? [];
  if (!globs.length) { console.log(`${repo.name}: no escalate_paths configured — nothing to check mechanically`); process.exit(0); }

  const repoPath = String(repo.path).replace(/^~/, homedir());
  const diff = spawnSync("gh", ["pr", "diff", pr, "--name-only"], { cwd: repoPath, encoding: "utf8" });
  if (diff.status !== 0) {
    console.error(`gh pr diff failed: ${(diff.stderr || "").trim()}`);
    console.error(`cannot see the diff => treat as ESCALATE, not as clean`);
    process.exit(3);
  }

  const files = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const hits = matchEscalations(files, globs);
  if (hits.length) {
    console.log(`ESCALATE — PR #${pr} touches ${hits.length} protected file(s) in ${repo.name}:`);
    for (const h of hits) console.log(`  ${h.file}  (${h.globs.join(", ")})`);
    process.exit(2);
  }
  console.log(`PR #${pr}: none of ${files.length} changed file(s) hit escalate_paths — mechanical check clean (judgment list still applies)`);
  process.exit(0);
}
