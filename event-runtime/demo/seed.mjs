#!/usr/bin/env bun
/**
 * Seed a fake-adapter event runtime with one of everything (OPS-217).
 *
 * Drives real state through the real surfaces — intake, planner, watched
 * approval, worker, verifier — never the database. Requires `serve
 * --adapter-override fake` running on the target port; refuses to seed a
 * runtime whose adapter is real (approving would spawn real agents).
 *
 * Terminal states produced, via the fake adapter's input modes
 * (lib/adapters/fake.mjs — behavior selects on payload.repos[0]):
 *
 *   COMPLETED   repos:["ok"]               result + receipt + evidence
 *   REFUSED     repos:["refuse"]           typed refusal (needs_human)
 *   FAILED      repos:["crash"]            nonzero exit
 *   FAILED      repos:["invalid-artifact"] output-contract violation
 *   CANCELLED   rejected proposal
 *   RUNNING     repos:["hang"]             approved LAST — the single worker
 *                                          sits on it until the spec timeout
 *                                          (600s), then TIMED_OUT
 *
 * Plus two open proposals: one approvable (`run`) and one `human_needed`
 * (empty repos fails the input schema's minItems).
 *
 * Some fixtures carry a second repo — a real config/repos.yaml name appended
 * after the mode (`["ok", "bj29"]`). The web UI's project tabs filter on
 * `repos[]`, so without it every tab on a freshly seeded runtime reads empty
 * (OPS-366). Only appended, never substituted: repos[0] stays the mode.
 *
 *   bun event-runtime/demo/seed.mjs [--port 7381] [--prefix demo]
 */
import { apiClient } from "../lib/client.mjs";
import { loadRepos } from "../lib/repos.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const port = Number(flag("--port") ?? process.env.FACTORY_EVENT_PORT ?? 7381);
const prefix = flag("--prefix") ?? "demo";
const client = apiClient({ port });

const log = (line) => console.log(`seed: ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real repos.yaml names for the project tags. Optional by design: a checkout
 * without config/repos.yaml (or with no entries) must still seed a full demo
 * set, so a missing registry costs the tags, not the run.
 */
function projectNames() {
  try {
    return [...loadRepos().keys()];
  } catch (err) {
    log(`no repo registry (${err.message}) — seeding without project tags`);
    return [];
  }
}

const [projectA, projectB = projectA] = projectNames();

/** repos[0] must stay the fake adapter's mode — the project name only trails it. */
const tag = (mode, project) => (project ? [mode, project] : [mode]);

function envelope(id, repos) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: `${prefix}-${id}`,
    type: "factory.status-report.requested",
    source: "demo-seed",
    subject: "factory",
    occurredAt: new Date().toISOString(),
    correlationId: `${prefix}-${id}`,
    payload: { repos },
  };
}

/** Poll until `fn` returns truthy, or die loudly — a seed must not half-run. */
async function until(what, fn, { timeoutMs = 30_000, everyMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openProposalFor(eventId) {
  return until(`proposal for ${eventId}`, async () => {
    const { proposals } = await client.proposals();
    return proposals.find(
      (p) => p.status === "open" && (p.spec?.idempotencyKey?.includes(eventId) || p.reason?.includes(eventId)),
    );
  });
}

/** human_needed proposals carry no spec — match via their admitted event. */
async function humanNeededProposal() {
  return until("human_needed proposal", async () => {
    const { proposals } = await client.proposals();
    return proposals.find((p) => p.status === "open" && p.decision === "human_needed");
  });
}

async function runTerminal(runId, wanted) {
  return until(`run ${runId} → ${wanted}`, async () => {
    const view = await client.run(runId);
    if (view.run.state === wanted) return view;
    const TERMINAL = ["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"];
    if (TERMINAL.includes(view.run.state)) {
      throw new Error(`run ${runId} terminated ${view.run.state}, expected ${wanted}`);
    }
    return null;
  });
}

// --------------------------------------------------------------------------

const health = await client.health().catch(() => null);
if (!health) {
  console.error(`seed: no control API on 127.0.0.1:${port} — start it with:
  FACTORY_EVENT_PORT=${port} bun event-runtime/cli.mjs serve --adapter-override fake`);
  process.exit(1);
}

// Guard: never seed a real-adapter runtime. The adapter lands in each spec at
// planning time, so probe with a throwaway event and inspect its proposal.
const probeId = `${prefix}-adapter-probe`;
await client.replay(envelope("adapter-probe", ["ok"]));
const probe = await openProposalFor(probeId);
if (probe.spec?.adapter !== "fake") {
  await client.reject(probe.id, "seed aborted: runtime is not in fake-adapter mode");
  console.error(
    `seed: refusing — this runtime plans with adapter "${probe.spec?.adapter}", not "fake". ` +
      `Restart it with --adapter-override fake.`,
  );
  process.exit(1);
}
await client.reject(probe.id, "adapter probe — not part of the demo set");

log(projectA ? `project tags: ${[...new Set([projectA, projectB])].join(", ")}` : "project tags: none");

// Quick terminals first: the single worker handles them one per tick. The
// hang run is approved last so it never blocks the rest of the seed.
// Only some fixtures get a project tag: a tab that matches every row proves
// nothing about filtering.
const terminals = [
  { id: "completed", repos: tag("ok", projectA), wanted: "COMPLETED" },
  { id: "refused", repos: ["refuse"], wanted: "REFUSED" },
  { id: "failed-crash", repos: ["crash"], wanted: "FAILED" },
  { id: "failed-contract", repos: ["invalid-artifact"], wanted: "FAILED" },
];
for (const t of terminals) {
  await client.replay(envelope(t.id, t.repos));
  const proposal = await openProposalFor(`${prefix}-${t.id}`);
  await client.approve(proposal.id);
  await runTerminal(proposal.runId, t.wanted);
  log(`${proposal.runId} → ${t.wanted}`);
}

// CANCELLED via the reject verb.
await client.replay(envelope("rejected", tag("ok", projectB)));
const rejected = await openProposalFor(`${prefix}-rejected`);
await client.reject(rejected.id, "demo: rejected on purpose");
await runTerminal(rejected.runId, "CANCELLED");
log(`${rejected.runId} → CANCELLED (proposal rejected)`);

// Two open proposals: one approvable, one human_needed (empty repos).
await client.replay(envelope("open", tag("ok", projectA)));
const open = await openProposalFor(`${prefix}-open`);
log(`${open.id} left open (approvable → instant COMPLETED)`);
await client.replay(envelope("human-needed", []));
const human = await humanNeededProposal();
log(`${human.id} left open (human_needed: ${human.reason})`);

// RUNNING, last: occupies the single worker until the 600s spec timeout.
await client.replay(envelope("running", tag("hang", projectB)));
const hang = await openProposalFor(`${prefix}-running`);
await client.approve(hang.id);
await until(`run ${hang.runId} → RUNNING`, async () => {
  const view = await client.run(hang.runId);
  return view.run.state === "RUNNING" ? view : null;
});
log(`${hang.runId} → RUNNING (hang mode; TIMED_OUT after the 600s timeout — or cancel it from the UI)`);

log("done — one of everything:");
const { runs } = await client.runs();
for (const r of runs) log(`  ${r.runId}  ${r.state}  repos:[${(r.repos ?? []).join(", ")}]`);
const { proposals } = await client.proposals();
for (const p of proposals) log(`  ${p.id}  ${p.decision} (open)  repos:[${(p.repos ?? []).join(", ")}]`);
