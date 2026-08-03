#!/usr/bin/env bun
/**
 * Where is the loop right now?
 *
 *   bun orchestrator/queue.mjs              # every configured repo
 *   bun orchestrator/queue.mjs --repo bj29
 *
 * Read-only. This is the `dry_command` for all three agent stages, so "what
 * would this job do" never means "spawn an agent and find out" — it means look
 * at the queue the job would draw from.
 *
 * It also answers the question that actually governs throughput: is the factory
 * about to idle? A deep Triage pile with an empty agent-ready queue means the
 * constraint is specification, not execution, and dispatching harder won't help.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, pathsCollide } from "./owned-paths.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = val("--repo");

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only || r.name === only);

if (!repos.length) {
  console.error(only ? `no repo named "${only}" in config/repos.yaml` : "no repos configured");
  process.exit(2);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title description priority
        state { name type }
        assignee { name }
        labels(first: 20) { nodes { name } }
      }
    }
  }`;

for (const repo of repos) {
  console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}  ->  ${repo.base}`));

  const nodes = (await gql(QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];
  const labels = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
  const state = (i) => i.state?.name ?? "?";

  const triage = nodes.filter((i) => state(i) === "Triage");
  const ready = nodes.filter((i) => state(i) === "Todo" && labels(i).includes("ai:agent-ready") && !i.assignee);
  const notReady = nodes.filter((i) => state(i) === "Todo" && !labels(i).includes("ai:agent-ready"));
  const inProgress = nodes.filter((i) => state(i) === "In Progress");
  const inReview = nodes.filter((i) => state(i) === "In Review");
  const blocked = nodes.filter((i) => state(i) === "Blocked");

  const line = (label, n, color = (s) => s) =>
    console.log(`  ${label.padEnd(22)} ${color(String(n).padStart(3))}`);

  line("Triage (unspecified)", triage.length, triage.length > 20 ? c.yellow : (s) => s);
  line("Todo, not ready", notReady.length);
  line("READY to dispatch", ready.length, ready.length ? c.green : c.red);
  line("In Progress", inProgress.length);
  line("In Review", inReview.length, inReview.length ? c.cyan : (s) => s);
  line("Blocked", blocked.length, blocked.length ? c.red : (s) => s);

  // What dispatch would actually pick up, honouring Owned Paths against what is
  // already running. Sorted the way §7 sorts: priority asc, then created asc.
  const inFlightPaths = inProgress.flatMap((i) => parseOwnedPaths(i.description ?? ""));
  const sorted = [...ready].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const free = [];
  const busyPaths = [...inFlightPaths];
  for (const t of sorted) {
    const own = parseOwnedPaths(t.description ?? "");
    if (!own.length) continue;                       // no Owned Paths => not dispatchable
    if (pathsCollide(own, busyPaths)) continue;      // would collide with running work
    free.push(t);
    busyPaths.push(...own);                          // later tickets must clear this one too
    if (free.length >= (repo.max_in_flight ?? 3) - inProgress.length) break;
  }

  if (free.length) {
    console.log(c.dim(`\n  dispatch would start (cap ${repo.max_in_flight}, ${inProgress.length} running):`));
    for (const t of free) console.log(`    ${c.green(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  } else if (ready.length) {
    console.log(c.dim(`\n  nothing startable — all ready tickets collide with running work or lack Owned Paths`));
  } else {
    console.log(c.dim(`\n  queue empty — the constraint is specification, not dispatch.`));
    console.log(c.dim(`  ${triage.length} ticket(s) in Triage. Run the triage stage.`));
  }

  if (inReview.length) {
    console.log(c.dim(`\n  awaiting review/merge:`));
    for (const t of inReview) console.log(`    ${c.cyan(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  }
  if (blocked.length) {
    console.log(c.red(`\n  BLOCKED — needs a human:`));
    for (const t of blocked) console.log(`    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}`);
  }
}
console.log();
