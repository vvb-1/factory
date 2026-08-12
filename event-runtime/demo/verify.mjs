#!/usr/bin/env bun
/**
 * E2E smoke over a seeded demo runtime (OPS-217): assert, via the control
 * API only, that every state seed.mjs promises actually exists. Exit 0 =
 * fixture is intact and an e2e client (browser test, UX critique, styling
 * session) can rely on it.
 *
 *   bun event-runtime/demo/verify.mjs [--port 7381]
 */
import { apiClient } from "../lib/client.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const port = Number(i === -1 ? (process.env.FACTORY_EVENT_PORT ?? 7381) : args[i + 1]);
const client = apiClient({ port });

const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const health = await client.health().catch(() => null);
if (!health) {
  console.error(`verify: no control API on 127.0.0.1:${port}`);
  process.exit(1);
}

const { runs } = await client.runs();
const byState = (state) => runs.filter((r) => r.state === state).length;
// RUNNING decays to TIMED_OUT after the hang run's 600s timeout — both are
// the same seeded row, so accept either.
check("1 run RUNNING or TIMED_OUT (hang)", byState("RUNNING") + byState("TIMED_OUT") >= 1);
check("≥1 run COMPLETED", byState("COMPLETED") >= 1);
check("≥1 run REFUSED", byState("REFUSED") >= 1);
check("≥2 runs FAILED (crash + contract violation)", byState("FAILED") >= 2);
check("≥1 run CANCELLED (rejected proposal)", byState("CANCELLED") >= 1);
check("≥1 run PROPOSED (open proposal)", byState("PROPOSED") >= 1);

const { proposals } = await client.proposals();
check("1 open `run` proposal", proposals.filter((p) => p.decision === "run").length === 1);
check("1 open `human_needed` proposal", proposals.filter((p) => p.decision === "human_needed").length === 1);

const completed = runs.find((r) => r.state === "COMPLETED");
if (completed) {
  const view = await client.run(completed.runId);
  check("completed run has result + receipt + lifecycle", Boolean(view.result && view.receipt && view.lifecycle.length >= 6));
  check("completed run receipt verification passed", view.receipt?.verificationStatus === "passed");
}

const events = await client.events();
check("≥8 admitted events", events.events.length >= 8);

if (failures.length) {
  console.error(`\nverify: ${failures.length} check(s) failed — reseed with: bun event-runtime/demo/seed.mjs --port ${port}`);
  process.exit(1);
}
console.log("\nverify: seeded demo fixture intact");
