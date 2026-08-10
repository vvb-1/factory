#!/usr/bin/env bun
/**
 * What should the factory do next?
 *
 *   bun orchestrator/next.mjs --repo bj29
 *   bun orchestrator/next.mjs --repo bj29 --json
 *   bun orchestrator/next.mjs --repo bj29 --apply [--harness pi] [--orchestrated]
 *
 * Read-only by default. Uses the same queue snapshot as queue.mjs; the LLM
 * command `/factory-next` wraps this script rather than re-deriving gates.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQueueSummaries, loadQueueConfig } from "../lib/queue-summary.mjs";
import { recommendNext } from "../lib/next-recommend.mjs";
import { budgetExhausted } from "../lib/spend.mjs";
import { appendEvent } from "../lib/factory-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);
const JSON_OUT = argv.includes("--json");
const APPLY = argv.includes("--apply");
const ORCHESTRATED = argv.includes("--orchestrated");
const INCLUDE_SWEEP = argv.includes("--include-sweep");
const HARNESS = val("--harness") || "claude";

const { repos, policy, defaultCap } = loadQueueConfig(only);
if (!repos.length) {
  console.error(only.length ? `no repo named "${only.join(",")}" in config/repos.yaml` : "no repos configured");
  process.exit(2);
}

const spent = budgetExhausted(policy);
const summaries = await fetchQueueSummaries(repos, defaultCap);
const plans = summaries.map((s) => ({
  ...recommendNext(s, { orchestrated: ORCHESTRATED, includeSweep: INCLUDE_SWEEP }),
  queue: s,
}));

function slashCommand(plan) {
  if (!plan.command || plan.command === "tick" || plan.command === "reconcile" || plan.command === "digest") return null;
  const args = plan.args ? ` ${plan.args}` : "";
  return `/factory-${plan.command.replace(/^factory-/, "")}${args}`;
}

function formatPlan(plan) {
  const slash = plan.slash ?? slashCommand(plan);
  return {
    repo: plan.repo,
    stage: plan.stage,
    constraint: plan.constraint,
    command: plan.command,
    args: plan.args,
    slash,
    exec: plan.exec ?? null,
    reason: plan.reason,
    alternates: (plan.alternates ?? []).map((a) => ({
      stage: a.stage,
      slash: a.slash ?? slashCommand(a),
      exec: a.exec ?? null,
      reason: a.reason,
    })),
  };
}

const output = {
  budgetBlocked: spent,
  orchestrated: ORCHESTRATED,
  plans: plans.map(formatPlan),
};

for (const plan of output.plans) {
  if (!plan.repo) continue;
  try {
    appendEvent({
      type: "recommend",
      repo: plan.repo,
      harness: HARNESS,
      command: plan.command ?? undefined,
      args: plan.args || undefined,
      exec: plan.exec ?? undefined,
      slash: plan.slash ?? undefined,
      reason: plan.reason,
      constraint: plan.constraint ?? undefined,
    });
  } catch { /* journal must not block routing */ }
}

if (JSON_OUT) {
  console.log(JSON.stringify(output, null, 2));
  if (APPLY) await runApply(output);
  process.exit(0);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

console.log(c.bold("\nfactory next\n"));
if (spent) console.log(c.red(`  budget: ${spent} — no new agent stages today`));

for (const plan of output.plans) {
  console.log(c.bold(`\n${plan.repo}`));
  if (plan.constraint) console.log(`  constraint   ${plan.constraint}`);
  if (plan.command) {
    const label = plan.slash ?? plan.exec ?? `${plan.command} ${plan.args}`.trim();
    console.log(`  recommend    ${c.green(label)}`);
    console.log(c.dim(`  because      ${plan.reason}`));
  } else {
    console.log(`  recommend    ${c.yellow("(wait)")}`);
    console.log(c.dim(`  because      ${plan.reason}`));
  }
  for (const alt of plan.alternates) {
    const label = alt.slash ?? alt.exec ?? "";
    if (label) console.log(c.dim(`  also         ${label} — ${alt.reason}`));
  }
}

console.log(c.dim("\nRun one stage: add --apply (interactive: run the slash command; headless: --orchestrated --apply)\n"));

if (APPLY) await runApply(output);

async function runApply(out) {
  if (out.budgetBlocked) {
    console.error(`cannot --apply: ${out.budgetBlocked}`);
    process.exit(1);
  }
  const target = out.plans.find((p) => p.command) ?? out.plans[0];
  if (!target?.command) {
    console.log("nothing to apply — loop idle");
    return;
  }
  try {
    appendEvent({
      type: "start",
      repo: target.repo,
      harness: HARNESS,
      command: target.command,
      args: target.args || undefined,
      exec: target.exec ?? undefined,
      slash: target.slash ?? undefined,
      runId: process.env.FACTORY_RUN_ID,
    });
  } catch { /* journal must not block execution */ }
  if (target.exec) {
    console.log(`\n> ${target.exec}\n`);
    const p = Bun.spawn(["bash", "-lc", target.exec], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    process.exit(await p.exited);
  }
  const readOnly = target.command === "factory-triage" || target.command === "factory-unblock" || target.command === "factory-sweep";
  const cmd = [
    "bash", path.join(ROOT, "runners/run-agent.sh"),
    "--repo", target.repo,
    "--command", target.command,
    "--harness", HARNESS,
  ];
  if (readOnly) cmd.push("--read-only");
  if (target.args) cmd.push("--args", target.args);
  console.log(`\n> ${cmd.join(" ")}\n`);
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  process.exit(await p.exited);
}
