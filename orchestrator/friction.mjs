#!/usr/bin/env bun
/**
 * What is wasting the factory's time?
 *
 *   bun orchestrator/friction.mjs                 # all captured runs
 *   bun orchestrator/friction.mjs --since 2d
 *   bun orchestrator/friction.mjs --run bj29-factory-work-20260803-230342
 *
 * Every run writes a full JSONL transcript to ~/.factory/logs/. That is a
 * record of what agents actually did, so friction can be MEASURED rather than
 * remembered — an agent that had to fight a cookie banner will not reliably
 * write that down, but its transcript shows the same click three runs running.
 *
 * This finds the repeatable kind:
 *   - tool calls that errored, grouped by what the error actually was
 *   - identical commands run more than once in a session (retry loops)
 *   - commands that dominate wall clock (installs, compiles, sleeps)
 *   - runs that ended without producing anything
 *
 * It proposes nothing on its own. `/factory-retro` reads this, decides what is
 * worth fixing, and files it — because the judgement of "is this worth a
 * change" is not a job for a histogram.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const LOGS = path.join(homedir(), ".factory/logs");
const JSON_OUT = argv.includes("--json");

if (!existsSync(LOGS)) { console.error(`no transcripts at ${LOGS}`); process.exit(1); }

const sinceArg = val("--since");
const sinceMs = sinceArg
  ? Date.now() - Number(sinceArg.replace(/[^\d]/g, "")) * (sinceArg.endsWith("h") ? 3600e3 : 86400e3)
  : 0;
const onlyRun = val("--run");

const files = readdirSync(LOGS)
  .filter((f) => f.endsWith(".jsonl"))
  .filter((f) => !onlyRun || f.startsWith(onlyRun))
  .map((f) => ({ f, p: path.join(LOGS, f), t: statSync(path.join(LOGS, f)).mtimeMs }))
  .filter((x) => x.t >= sinceMs)
  .sort((a, b) => a.t - b.t);

if (!files.length) { console.error("no transcripts match"); process.exit(1); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
};
const oneLine = (s, n = 90) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const errors = new Map();     // signature -> {count, tool, sample, runs:Set}
const repeats = new Map();    // command -> {count, runs:Set}
const toolUse = new Map();    // tool -> count
const runs = [];

for (const { f, p } of files) {
  const run = { file: f, tools: 0, errors: 0, turns: 0, cost: 0, ok: null, commands: new Map() };
  const pending = new Map(); // tool_use_id -> {name, brief}

  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }

    if (e.type === "assistant") {
      for (const part of e.message?.content ?? []) {
        if (part.type !== "tool_use") continue;
        run.tools++;
        toolUse.set(part.name, (toolUse.get(part.name) ?? 0) + 1);
        const brief = oneLine(part.input?.command ?? part.input?.file_path ?? part.input?.pattern ?? "", 120);
        pending.set(part.id, { name: part.name, brief });
        if (part.name === "Bash" && brief) run.commands.set(brief, (run.commands.get(brief) ?? 0) + 1);
      }
    }

    if (e.type === "user") {
      for (const part of e.message?.content ?? []) {
        if (part.type !== "tool_result" || !part.is_error) continue;
        run.errors++;
        const src = pending.get(part.tool_use_id) ?? { name: "?", brief: "" };
        const body = typeof part.content === "string" ? part.content : (part.content ?? []).map((x) => x.text ?? "").join(" ");
        // Group by the shape of the failure, not the exact string — paths and
        // ids differ per run and would fragment the count into singletons.
        const sig = oneLine(body, 70)
          .replace(/\/[\w./-]+/g, "<path>")
          .replace(/\b[0-9a-f]{7,}\b/g, "<sha>")
          .replace(/\d+/g, "N");
        const k = `${src.name}|${sig}`;
        const hit = errors.get(k) ?? { count: 0, tool: src.name, sample: oneLine(body, 110), cmd: src.brief, runs: new Set() };
        hit.count++; hit.runs.add(f);
        errors.set(k, hit);
      }
    }

    if (e.type === "result" || "num_turns" in e) {
      run.turns = e.num_turns ?? 0;
      run.cost = e.total_cost_usd ?? 0;
      run.ok = e.subtype === "success" && !e.is_error && (e.num_turns ?? 0) > 0;
      run.durationMs = e.duration_ms ?? 0;
    }
  }

  for (const [cmd, n] of run.commands) {
    if (n < 2) continue;
    const hit = repeats.get(cmd) ?? { count: 0, runs: new Set() };
    hit.count += n; hit.runs.add(f);
    repeats.set(cmd, hit);
  }
  runs.push(run);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    runs: runs.map((r) => ({ file: r.file, ok: r.ok, turns: r.turns, cost: r.cost, tools: r.tools, errors: r.errors })),
    errors: [...errors.values()].map((e) => ({ tool: e.tool, count: e.count, sample: e.sample, runs: e.runs.size })),
    repeats: [...repeats.entries()].map(([cmd, v]) => ({ cmd, count: v.count, runs: v.runs.size })),
  }, null, 2));
  process.exit(0);
}

console.log(c.bold(`\nfriction across ${files.length} run(s)\n`));
for (const r of runs) {
  const status = r.ok === null ? c.yellow("no result") : r.ok ? c.green("ok") : c.red("FAILED");
  console.log(`  ${status.padEnd(18)} ${r.file.replace(/\.jsonl$/, "")}`);
  console.log(c.dim(`     ${r.turns} turns · ${r.tools} tool calls · ${r.errors} errors · ~$${r.cost.toFixed(2)} · ${(r.durationMs / 60000).toFixed(1)}min`));
}

const sortedErrors = [...errors.values()].sort((a, b) => b.count - a.count);
if (sortedErrors.length) {
  console.log(c.bold(`\nrecurring failures`) + c.dim("  (grouped by failure shape, paths and ids normalised)\n"));
  for (const e of sortedErrors.slice(0, 12)) {
    const flag = e.runs.size > 1 ? c.red(`×${e.count} in ${e.runs.size} runs`) : c.yellow(`×${e.count}`);
    console.log(`  ${flag}  ${c.bold(e.tool)}`);
    if (e.cmd) console.log(c.dim(`     cmd: ${e.cmd}`));
    console.log(c.dim(`     err: ${e.sample}`));
  }
  console.log(c.dim(`\n  Failures spanning MORE THAN ONE run are the ones worth fixing —`));
  console.log(c.dim(`  a one-off is a ticket's problem, a repeat is the harness's.`));
}

const sortedRepeats = [...repeats.entries()].filter(([, v]) => v.count > 2).sort((a, b) => b[1].count - a[1].count);
if (sortedRepeats.length) {
  console.log(c.bold(`\nrepeated commands`) + c.dim("  (same command re-run inside a session — a retry loop or a missing shortcut)\n"));
  for (const [cmd, v] of sortedRepeats.slice(0, 10)) {
    console.log(`  ${c.yellow(`×${v.count}`)}  ${oneLine(cmd, 100)}`);
  }
}

const topTools = [...toolUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(c.bold(`\ntool usage\n`));
console.log("  " + topTools.map(([n, k]) => `${n}×${k}`).join("  "));

console.log(c.dim(`\nNext: /factory-retro turns the repeats above into changes, or records why not.\n`));
