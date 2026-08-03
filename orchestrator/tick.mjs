#!/usr/bin/env bun
/**
 * Dispatch: one OS process per ticket, rolling.
 *
 *   bun orchestrator/tick.mjs --repo bj29                 # dry — what it would start
 *   bun orchestrator/tick.mjs --repo bj29 --apply
 *   bun orchestrator/tick.mjs --repo bj29 --apply --max 2
 *   bun orchestrator/tick.mjs --repo bj29 --apply --ticket CLNT-611
 *   bun orchestrator/tick.mjs --repo bj29 --apply --no-refill   # start a batch, don't refill
 *
 * Each ticket gets its own process, log file, budget and session id, so a stuck
 * ticket can be killed alone and a failed one resumed alone.
 *
 * ROLLING, NOT BATCHED. When a ticket finishes, its slot is refilled
 * immediately from the queue — the run does not wait for the slowest ticket
 * before starting anything else. Batching is the dominant throughput loss in
 * practice: one 40-minute ticket idles two agents for 40 minutes.
 *
 * The queue is re-read on every refill, so tickets that became agent-ready
 * *during* the run (triage promoting one, or an agent filing follow-up work)
 * get picked up without waiting for the next supervisor tick.
 */
import { readFileSync, mkdirSync, createWriteStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, pathsCollide } from "./owned-paths.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const REFILL = !argv.includes("--no-refill");
const MAX = Number(val("--max") ?? 0) || Infinity;
const ONE = val("--ticket");

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repo = (cfg.repos ?? []).find((r) => r.name === val("--repo"));
if (!repo) { console.error(`--repo required; known: ${(cfg.repos ?? []).map((r) => r.name).join(", ")}`); process.exit(2); }
if (repo.report_only) { console.error(`${repo.name} is report_only — no worktree tooling, dispatch is unsafe here`); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const clock = () => new Date().toTimeString().slice(0, 8);
const repoPath = expand(repo.path);
const cap = repo.max_in_flight ?? 3;

const Q = `query($t:String!,$p:String!){ issues(first:250, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}},
    state:{ type:{ nin:["completed","canceled"] } } }){
  nodes{ id identifier title description state{name} assignee{id} labels(first:20){nodes{name}} priority } } }`;

/** Current queue straight from Linear — never cached, because it changes under us. */
async function fetchState() {
  const nodes = (await gql(Q, { t: repo.team, p: repo.project }))?.issues?.nodes ?? [];
  const has = (i, n) => (i.labels?.nodes ?? []).some((l) => l.name === n);
  return {
    inProgress: nodes.filter((i) => i.state?.name === "In Progress"),
    ready: nodes
      .filter((i) => i.state?.name === "Todo" && has(i, "ai:agent-ready") && !i.assignee)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99)),
  };
}

/**
 * What can start right now, given what is running right now.
 * Owned Paths overlap is checked at THIS moment, not from a plan computed
 * earlier — under rolling dispatch the in-flight set changes continuously.
 */
function selectable(state, excludeIds, limit) {
  const busy = state.inProgress.flatMap((i) => parseOwnedPaths(i.description ?? ""));
  const out = [];
  for (const t of state.ready) {
    if (out.length >= limit) break;
    if (excludeIds.has(t.identifier)) continue;
    if (ONE && t.identifier !== ONE) continue;
    const own = parseOwnedPaths(t.description ?? "");
    if (!own.length) continue;
    if (pathsCollide(own, busy)) continue;
    out.push({ ...t, own });
    busy.push(...own);
  }
  return out;
}

// ------------------------------------------------------------------- dry ----
const first = await fetchState();
const freeNow = Math.max(0, cap - first.inProgress.length);
console.log(c.bold(`\n${repo.name}`) + c.dim(`  cap ${cap} · ${first.inProgress.length} running · ${freeNow} slot(s) · ${first.ready.length} ready`));

if (!APPLY) {
  const picked = selectable(first, new Set(), Math.min(freeNow, MAX));
  const skipped = first.ready.filter((t) => !parseOwnedPaths(t.description ?? "").length);
  for (const t of skipped) console.log(c.yellow(`  skip ${t.identifier} — no parseable Owned Paths`));
  if (!picked.length) { console.log(c.dim("  nothing to start.\n")); process.exit(0); }
  console.log(c.bold(`\nwould start ${picked.length} now${REFILL ? ", then refill slots as they free" : ""}:`));
  for (const t of picked) console.log(`  ${c.green(t.identifier)}  ${t.title.slice(0, 60)}\n    ${c.dim(t.own.join(", "))}`);
  console.log(c.dim("\ndry run — re-run with --apply\n"));
  process.exit(0);
}

// ----------------------------------------------------------------- claim ----
const me = (await gql(`query{ viewer{ id name } }`))?.viewer;
const states = (await gql(`query($t:String!){ team(id:$t){ states(first:50){ nodes{ id name } } } }`, { t: repo.team }))?.team?.states?.nodes ?? [];
const inProgressId = states.find((s) => s.name.toLowerCase() === "in progress")?.id;
const allLabels = (await gql(`query{ issueLabels(first:250){ nodes{ id name } } }`))?.issueLabels?.nodes ?? [];
const labelId = (n) => allLabels.find((l) => l.name === n)?.id;
if (!inProgressId) { console.error("no 'In Progress' state on team " + repo.team); process.exit(1); }

async function claim(t) {
  const keep = (t.labels?.nodes ?? []).map((l) => allLabels.find((x) => x.name === l.name)?.id).filter(Boolean);
  const want = [...new Set([...keep, labelId("ai:in-progress"), labelId("agent:claude-code")].filter(Boolean))];
  await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
    { id: t.id, in: { stateId: inProgressId, assigneeId: me.id, labelIds: want } });
  // Linear has no compare-and-swap; this read-back IS the concurrency control.
  const back = (await gql(`query($id:String!){ issue(id:$id){ assignee{id} } }`, { id: t.id }))?.issue;
  return back?.assignee?.id === me.id;
}

// ------------------------------------------------------------------ warm ----
let warmChecked = false;
/**
 * Warming costs one compile; skipping it costs N. So it only pays from two
 * tickets up, and only once per run — after claiming (minutes here cannot lose
 * a claimed ticket) and before any worktree-up (nothing should clone a template
 * being rewritten underneath it).
 */
function warmIfWorthIt(count) {
  if (warmChecked || argv.includes("--no-warm") || !repo.worktree_warm) return;
  warmChecked = true;
  if (count < 2) { console.log(c.dim(`  (single ticket — not warming; same compile either way)`)); return; }

  const gate = spawnSync("/bin/bash", ["-lc", `bun orchestrator/warm.mjs --repo ${repo.name} --gate`], { cwd: ROOT, encoding: "utf8" });
  if (gate.status !== 0) { console.log(c.dim(`  warm cache fresh — ${gate.stdout.trim()}`)); return; }
  console.log(c.yellow(`\n  ${gate.stdout.trim()}`));
  console.log(c.dim(`  Compiling once so ${count} worktrees don't.\n`));
  const r = spawnSync("/bin/bash", ["-lc", `bun orchestrator/warm.mjs --repo ${repo.name} --apply`], { cwd: ROOT, stdio: "inherit" });
  console.log(r.status === 0 ? c.green(`\n  warm cache refreshed.\n`) : c.yellow(`\n  warm refresh failed — continuing; worktrees will be slower.\n`));
}

// ------------------------------------------------------------------- run ----
const LOG_DIR = path.join(homedir(), ".factory/logs");
mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const results = [];

function runTicket(t) {
  const up = spawnSync("/bin/bash", [repo.worktree_up, t.identifier], { cwd: repoPath, encoding: "utf8" });
  if (up.status !== 0) {
    const why = (up.stderr || up.stdout || "").trim().split("\n").pop();
    console.log(c.red(`  ${t.identifier} worktree-up failed: ${why}`));
    results.push({ id: t.identifier, ok: false, why: "worktree-up failed" });
    return Promise.resolve();
  }
  const wt = path.join(expand(repo.worktree_root), t.identifier);
  console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} worktree ready ${c.dim(wt)}`);

  const log = path.join(LOG_DIR, `${repo.name}-${t.identifier}-${stamp}.jsonl`);
  const out = createWriteStream(log);
  const budget = String(cfg.budget?.per_ticket_usd ?? 15);

  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc",
      `env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p ` +
      `"/factory-ticket ${t.identifier}" --output-format stream-json --verbose ` +
      `--max-budget-usd ${budget} --fallback-model sonnet`],
      { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    const tag = c.cyan(`[${t.identifier}]`);
    child.stdout.on("data", (d) => {
      out.write(d);
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "assistant") {
          for (const p of e.message?.content ?? []) {
            if (p.type === "tool_use") {
              const d = String(p.input?.command ?? p.input?.file_path ?? p.input?.description ?? "").replace(/\s+/g, " ").slice(0, 66);
              console.log(`${c.dim(clock())} ${tag} ${p.name} ${c.dim(d)}`);
            }
          }
        }
        if (e.type === "result" || "num_turns" in e) {
          const ok = e.subtype === "success" && !e.is_error && (e.num_turns ?? 0) > 0;
          console.log(`${c.dim(clock())} ${tag} ${ok ? c.green("done") : c.red("FAILED")} ${c.dim(`${e.num_turns ?? 0} turns ~$${(e.total_cost_usd ?? 0).toFixed(2)}`)}`);
          results.push({ id: t.identifier, ok, log });
        }
      }
    });
    child.stderr.on("data", (d) => out.write(d));
    child.on("close", () => { out.end(); resolve(); });
  });
}

// --------------------------------------------------------- rolling loop -----
const running = new Map();   // identifier -> promise
const seen = new Set();      // everything we have claimed this run
let startedCount = 0;

async function fill() {
  if (startedCount >= MAX) return;
  const state = await fetchState();
  const free = Math.min(cap - state.inProgress.length, MAX - startedCount);
  if (free <= 0) return;

  const picked = selectable(state, seen, free);
  if (!picked.length) return;

  const claimed = [];
  for (const t of picked) {
    if (await claim(t)) { claimed.push(t); seen.add(t.identifier); console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} claimed`); }
    else console.log(c.yellow(`  ${t.identifier} claim lost to another agent`));
  }
  if (!claimed.length) return;

  warmIfWorthIt(claimed.length);

  for (const t of claimed) {
    startedCount++;
    const p = runTicket(t).finally(() => running.delete(t.identifier));
    running.set(t.identifier, p);
  }
}

await fill();
if (!running.size) { console.log(c.dim("\n  nothing started.\n")); process.exit(0); }

while (running.size) {
  await Promise.race(running.values());
  // A slot just freed. Re-read the queue — triage may have promoted something,
  // or a finishing agent may have filed follow-up work, while we were busy.
  if (REFILL && startedCount < MAX) {
    const before = running.size;
    await fill();
    if (running.size > before) console.log(c.dim(`  ${clock()} refilled — ${running.size} in flight`));
  }
}

console.log(c.bold("\nsummary"));
for (const r of results) console.log(`  ${r.ok ? c.green("ok  ") : c.red("FAIL")} ${r.id}${r.log ? c.dim("  " + r.log.replace(homedir(), "~")) : ""}${r.why ? c.dim("  " + r.why) : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(c.dim(`\n${results.length - failed} ok, ${failed} failed, ${startedCount} started. Merging is a separate stage.\n`));
process.exit(failed ? 1 : 0);
