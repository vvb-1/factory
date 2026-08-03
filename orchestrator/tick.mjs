#!/usr/bin/env bun
/**
 * Dispatch: one OS process per ticket.
 *
 *   bun orchestrator/tick.mjs --repo bj29                 # dry — what it would start
 *   bun orchestrator/tick.mjs --repo bj29 --apply
 *   bun orchestrator/tick.mjs --repo bj29 --apply --max 1
 *   bun orchestrator/tick.mjs --repo bj29 --apply --ticket CLNT-611
 *
 * Previously one `claude -p` session claimed several tickets and worked them
 * through subagents. That shares a process, a context window and a budget
 * across tickets: one crash takes all of them, one runaway starves its
 * siblings, and everything interleaves into a single untraceable stream.
 *
 * Here the dispatcher owns claiming, worktrees and slots, and each ticket gets
 * its own process, log, budget and session id. A stuck ticket can be killed
 * alone; a failed one can be resumed alone.
 *
 * Claiming happens BEFORE the worktree is built: worktree-up.sh takes minutes,
 * and a ticket left unclaimed that long is a ticket another agent may take.
 */
import { readFileSync, mkdirSync, createWriteStream, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, pathsCollide } from "./owned-paths.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const MAX = Number(val("--max") ?? 0) || null;
const ONE = val("--ticket");
const repoName = val("--repo");

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repo = (cfg.repos ?? []).find((r) => r.name === repoName);
if (!repo) { console.error(`--repo required; known: ${(cfg.repos ?? []).map((r) => r.name).join(", ")}`); process.exit(2); }
if (repo.report_only) { console.error(`${repo.name} is report_only — no worktree tooling, dispatch is unsafe here`); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const clock = () => new Date().toTimeString().slice(0, 8);
const repoPath = expand(repo.path);

// ------------------------------------------------------------------ queue ---
const Q = `query($t:String!,$p:String!){ issues(first:250, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}},
    state:{ type:{ nin:["completed","canceled"] } } }){
  nodes{ id identifier title description state{name} assignee{id} labels(first:20){nodes{name}} priority } } }`;

const nodes = (await gql(Q, { t: repo.team, p: repo.project }))?.issues?.nodes ?? [];
const labelsOf = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
const inProgress = nodes.filter((i) => i.state?.name === "In Progress");
const ready = nodes
  .filter((i) => i.state?.name === "Todo" && labelsOf(i).includes("ai:agent-ready") && !i.assignee)
  .sort((a, b) => (a.priority || 99) - (b.priority || 99));

const cap = repo.max_in_flight ?? 3;
let slots = Math.max(0, cap - inProgress.length);
if (MAX) slots = Math.min(slots, MAX);

console.log(c.bold(`\n${repo.name}`) + c.dim(`  cap ${cap} · ${inProgress.length} running · ${slots} slot(s) · ${ready.length} ready`));

// Owned Paths of everything already running — a candidate must clear all of it.
const busy = inProgress.flatMap((i) => parseOwnedPaths(i.description ?? ""));
const picked = [];
for (const t of ready) {
  if (picked.length >= slots) break;
  if (ONE && t.identifier !== ONE) continue;
  const own = parseOwnedPaths(t.description ?? "");
  if (!own.length) { console.log(c.yellow(`  skip ${t.identifier} — no parseable Owned Paths (not dispatchable)`)); continue; }
  if (pathsCollide(own, busy)) { console.log(c.dim(`  skip ${t.identifier} — Owned Paths collide with running work`)); continue; }
  picked.push({ ...t, own });
  busy.push(...own);
}

if (!picked.length) { console.log(c.dim("  nothing to start.\n")); process.exit(0); }

console.log(c.bold(`\nwould start ${picked.length}:`));
for (const t of picked) console.log(`  ${c.green(t.identifier)}  ${t.title.slice(0, 60)}\n    ${c.dim(t.own.join(", "))}`);

if (!APPLY) { console.log(c.dim("\ndry run — re-run with --apply\n")); process.exit(0); }

// ------------------------------------------------------------------ claim ---
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

const LOG_DIR = path.join(homedir(), ".factory/logs");
mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const results = [];
async function runTicket(t) {
  if (!(await claim(t))) { console.log(c.yellow(`  ${t.identifier} claim lost to another agent — skipping`)); return; }
  console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} claimed`);

  // Worktree via the repo's OWN script: deterministic ports, per-ticket
  // database, verified migration state. Never hand-rolled.
  const up = spawnSync("/bin/bash", [repo.worktree_up, t.identifier], { cwd: repoPath, encoding: "utf8" });
  if (up.status !== 0) {
    console.log(c.red(`  ${t.identifier} worktree-up failed: ${(up.stderr || up.stdout || "").trim().split("\n").pop()}`));
    results.push({ id: t.identifier, ok: false, why: "worktree-up failed" });
    return;
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
    const onData = (d) => {
      out.write(d);
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "assistant") {
          for (const p of e.message?.content ?? []) {
            if (p.type === "tool_use") console.log(`${c.dim(clock())} ${tag} ${p.name} ${c.dim(String(p.input?.command ?? p.input?.file_path ?? p.input?.description ?? "").replace(/\s+/g, " ").slice(0, 70))}`);
          }
        }
        if (e.type === "result" || "num_turns" in e) {
          const ok = e.subtype === "success" && !e.is_error && (e.num_turns ?? 0) > 0;
          console.log(`${c.dim(clock())} ${tag} ${ok ? c.green("done") : c.red("FAILED")} ${c.dim(`${e.num_turns ?? 0} turns ~$${(e.total_cost_usd ?? 0).toFixed(2)}`)}`);
          results.push({ id: t.identifier, ok, log });
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => out.write(d));
    child.on("close", () => { out.end(); resolve(); });
  });
}

console.log(c.bold(`\nstarting ${picked.length} ticket process(es) — one per ticket, logs in ~/.factory/logs/\n`));
await Promise.all(picked.map(runTicket));

console.log(c.bold("\nsummary"));
for (const r of results) console.log(`  ${r.ok ? c.green("ok  ") : c.red("FAIL")} ${r.id}${r.log ? c.dim("  " + r.log.replace(homedir(), "~")) : ""}${r.why ? c.dim("  " + r.why) : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(c.dim(`\n${results.length - failed} ok, ${failed} failed. Merging is a separate stage.\n`));
process.exit(failed ? 1 : 0);
