#!/usr/bin/env bun
/**
 * Seed a fake-adapter event runtime with one of everything (OPS-217, OPS-422).
 *
 * Drives real state through the real surfaces — intake, planner, watched
 * approval, worker, verifier — with rich fixture coverage across agents,
 * workspace types, recommendation chains, artifacts, and lifecycle edges.
 * Requires `serve --adapter-override fake` running on the target port; refuses
 * to seed a runtime whose adapter is real (approving would spawn real agents).
 *
 * Scenarios & terminal states produced:
 *
 *   COMPLETED   status-report (repos:["ok"])             result + receipt + evidence
 *   COMPLETED   status-report (repos:["with-artifact"])   declared report.txt + transcript
 *   COMPLETED   status-report (repos:["trace-flood"])     >100 live trace events
 *   REFUSED     status-report (repos:["refuse"])          typed refusal (needs_human)
 *   FAILED      status-report (repos:["crash"])           attempt: 2 (multi-attempt retry)
 *   FAILED      status-report (repos:["invalid-artifact"]) output-contract violation
 *   CANCELLED   rejected proposal                         closed via reject verb
 *   CANCELLED   operator cancelled                        cancelled via cancel verb
 *
 *   CI Chain (3 hops with causationId & artifacts workspace):
 *     COMPLETED ci-log-capture@1                          captured ci-log artifact
 *     COMPLETED ci-doctor@2                               artifacts workspace, verdict FLAKE
 *     COMPLETED ci-rerun@1                                command adapter follow-up
 *
 *   Triage Chain (repository workspace with repoPin):
 *     COMPLETED triage-scan@1                             repository workspace, pinned sha
 *
 *   Open proposals:
 *     - open approvable (`run`)
 *     - open human_needed (empty repos fails schema minItems)
 *     - open TTL-expired proposal
 *     - open triage-apply@1 from chain
 *
 *   Admitted & anomaly events:
 *     - dead-lettered event (lastPlanError present)
 *     - duplicate delivery suppression
 *
 *   RUNNING     repos:["hang"] (approved LAST — single worker holds until 600s timeout)
 *
 *   bun event-runtime/demo/seed.mjs [--port 7381] [--prefix demo]
 */
import { apiClient } from "../lib/client.mjs";
import { openDb } from "../lib/db.mjs";
import { dbPath, runtimeHome } from "../lib/config.mjs";

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
 * Real project names for the tags, from the serve process's GET /repos — the
 * same list the UI's project tabs offer. Optional by design: a missing or
 * unreadable registry (HTTP 500) must still seed a full demo set, so it
 * costs the tags, not the run.
 */
async function projectNames() {
  try {
    const { repos: registry } = await client.repos();
    return (registry ?? []).map((row) => row.name).filter(Boolean);
  } catch (err) {
    log(`no repo registry (${err.message}) — seeding without project tags`);
    return [];
  }
}

/** repos[0] must stay the fake adapter's mode — the project name only trails it. */
const tag = (mode, project) => (project ? [mode, project] : [mode]);

function envelope(id, repos, type = "factory.status-report.requested") {
  return {
    schemaVersion: "factory.event/v1",
    eventId: `${prefix}-${id}`,
    type,
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

async function openProposalFor(eventId, { agent } = {}) {
  return until(`proposal for ${agent ?? eventId}`, async () => {
    const { proposals } = await client.proposals();
    return proposals.find((p) => {
      if (p.status !== "open") return false;
      if (agent) return p.spec?.agent === agent || p.agent === agent;
      return (
        p.spec?.idempotencyKey?.includes(eventId) ||
        p.reason?.includes(eventId) ||
        p.eventId?.includes(eventId) ||
        (p.spec?.input && JSON.stringify(p.spec.input).includes(eventId))
      );
    });
  });
}

/** human_needed proposals carry no spec — match via their admitted event. */
async function humanNeededProposal(eventId) {
  return until(`human_needed proposal${eventId ? ` for ${eventId}` : ""}`, async () => {
    const { proposals } = await client.proposals();
    return proposals.find(
      (p) =>
        p.status === "open" &&
        p.decision === "human_needed" &&
        (!eventId || p.eventId?.includes(eventId) || p.reason?.includes(eventId)),
    );
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

const [projectA, projectB = projectA] = await projectNames();
const primaryProject = projectA || "factory";
log(projectA ? `project tags: ${[...new Set([projectA, projectB])].join(", ")}` : "project tags: none (fallback: factory)");

// 1. Quick terminals for status-report (ephemeral workspace)
const terminals = [
  { id: "completed", repos: tag("ok", projectA), wanted: "COMPLETED" },
  { id: "with-artifact", repos: tag("with-artifact", projectA), wanted: "COMPLETED" },
  { id: "trace-flood", repos: ["trace-flood"], wanted: "COMPLETED" },
  { id: "refused", repos: ["refuse"], wanted: "REFUSED" },
  { id: "failed-crash", repos: ["crash"], wanted: "FAILED" },
  { id: "failed-contract", repos: ["invalid-artifact"], wanted: "FAILED" },
];
for (const t of terminals) {
  await client.replay(envelope(t.id, t.repos));
  const proposal = await openProposalFor(`${prefix}-${t.id}`);
  await client.approve(proposal.id);
  await runTerminal(proposal.runId, t.wanted);
  log(`${proposal.runId} → ${t.wanted} (${t.id})`);
}

// 2. Multi-attempt run: retry the failed-crash run (attempt: 2)
const failedCrashProposal = await until("failed-crash run for retry", async () => {
  const { runs } = await client.runs("FAILED");
  return runs.find((r) => r.reasonCode === "agent_exit_1");
});
if (failedCrashProposal) {
  log(`retrying ${failedCrashProposal.runId} with force=true to create attempt 2`);
  await client.retry(failedCrashProposal.runId, { force: true });
  await runTerminal(failedCrashProposal.runId, "FAILED");
  log(`${failedCrashProposal.runId} → FAILED (attempt 2 completed)`);
}

// 3. CANCELLED via proposal rejection
await client.replay(envelope("rejected", tag("ok", projectB)));
const rejected = await openProposalFor(`${prefix}-rejected`);
await client.reject(rejected.id, "demo: rejected on purpose");
await runTerminal(rejected.runId, "CANCELLED");
log(`${rejected.runId} → CANCELLED (proposal rejected)`);

// 4. CANCELLED via operator cancel
await client.replay(envelope("cancel-op", tag("ok", projectA)));
const toCancel = await openProposalFor(`${prefix}-cancel-op`);
await client.cancel(toCancel.runId, "demo: operator cancelled");
await runTerminal(toCancel.runId, "CANCELLED");
log(`${toCancel.runId} → CANCELLED (operator cancelled)`);

// 5. CI Failure Chain scenario: github.workflow-run.failed → ci-log-capture → ci-doctor → ci-rerun
const ciRunId = 12345;
const ciEventId = `${prefix}-ci-failed`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: ciEventId,
  type: "github.workflow-run.failed",
  source: "github",
  subject: "ci",
  occurredAt: new Date().toISOString(),
  correlationId: ciEventId,
  payload: { repo: `wm/${primaryProject}`, runId: ciRunId },
});
const ciCaptureProposal = await openProposalFor(ciEventId, { agent: "ci-log-capture@1" });
await client.approve(ciCaptureProposal.id);
await runTerminal(ciCaptureProposal.runId, "COMPLETED");
log(`${ciCaptureProposal.runId} → COMPLETED (ci-log-capture@1, emitted ci-log artifact)`);

// Hop 2: ci-doctor@2 (artifacts workspace type with $.artifactHash.ci-log)
const ciDoctorProposal = await openProposalFor(ciEventId, { agent: "ci-doctor@2" });
await client.approve(ciDoctorProposal.id);
await runTerminal(ciDoctorProposal.runId, "COMPLETED");
log(`${ciDoctorProposal.runId} → COMPLETED (ci-doctor@2, verdict FLAKE, artifacts workspace)`);

// Hop 3: ci-rerun@1 (command adapter follow-up with causationId)
const ciRerunProposal = await openProposalFor(ciEventId, { agent: "ci-rerun@1" });
await client.approve(ciRerunProposal.id);
await runTerminal(ciRerunProposal.runId, "COMPLETED");
log(`${ciRerunProposal.runId} → COMPLETED (ci-rerun@1, command adapter)`);

// 6. Triage scan scenario: factory.triage.requested (repository workspace type with repoPin)
const triageEventId = `${prefix}-triage`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: triageEventId,
  type: "factory.triage.requested",
  source: "operator",
  subject: primaryProject,
  occurredAt: new Date().toISOString(),
  correlationId: triageEventId,
  payload: { repo: primaryProject },
});
const triageScanProposal = await openProposalFor(triageEventId, { agent: "triage-scan@1" });
await client.approve(triageScanProposal.id);
await runTerminal(triageScanProposal.runId, "COMPLETED");
log(`${triageScanProposal.runId} → COMPLETED (triage-scan@1, repository workspace)`);

// Follow-up triage-apply proposal from chain
const triageApplyProposal = await openProposalFor(triageEventId, { agent: "triage-apply@1" });
log(`${triageApplyProposal.id} left open (triage-apply@1 chain recommendation)`);

// 7. Duplicate delivery suppression
const dupOutcome = await client.replay(envelope("completed", tag("ok", projectA)));
log(`duplicate admission test: duplicate=${dupOutcome.duplicate}`);

// 8. Open proposals: approvable (`run`), human_needed, and TTL-expired
await client.replay(envelope("open", tag("ok", projectA)));
const open = await openProposalFor(`${prefix}-open`);
log(`${open.id} left open (approvable → instant COMPLETED)`);

await client.replay(envelope("human-needed", []));
const human = await humanNeededProposal(`${prefix}-human-needed`);
log(`${human.id} left open (human_needed: ${human.reason})`);

// TTL-expired proposal
await client.replay(envelope("expired", tag("ok", projectA)));
const expiredProposal = await openProposalFor(`${prefix}-expired`);

// 9. Database state for anomaly fixtures (dead-lettered event & expired proposal timestamp)
const home = health.env?.home || runtimeHome();
try {
  const db = openDb(dbPath(home));
  // Set expired proposal created_at to 2 hours ago
  db.query("UPDATE proposals SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(expiredProposal.id);
  log(`${expiredProposal.id} timestamp updated to 2h ago (TTL-expired proposal anomaly)`);

  // Insert a dead-lettered event directly into events table
  const deadEventId = `${prefix}-dead-letter`;
  const deadEnvelope = envelope("dead-letter", tag("ok", projectA));
  const nowStr = new Date().toISOString();
  db.query(
    `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, causation_id, envelope_json, payload_hash, status, plan_failures, last_plan_error, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dead_lettered', 3, 'simulated planning failure: poison payload', ?)
     ON CONFLICT(source, event_id) DO UPDATE SET
       status = 'dead_lettered', plan_failures = 3, last_plan_error = 'simulated planning failure: poison payload'`,
  ).run(
    deadEnvelope.source, deadEventId, deadEnvelope.type, deadEnvelope.subject,
    deadEnvelope.occurredAt, nowStr, deadEnvelope.correlationId, null,
    JSON.stringify(deadEnvelope), "none", nowStr,
  );
  db.close();
  log(`${deadEventId} inserted as dead_lettered (dead-letter anomaly)`);
} catch (err) {
  log(`warning: could not write direct db anomalies (${err.message})`);
}

// 10. RUNNING, last: occupies worker until 600s timeout
await client.replay(envelope("running", tag("hang", projectB)));
const hang = await openProposalFor(`${prefix}-running`);
await client.approve(hang.id);
await until(`run ${hang.runId} → RUNNING`, async () => {
  const view = await client.run(hang.runId);
  return view.run.state === "RUNNING" ? view : null;
});
log(`${hang.runId} → RUNNING (hang mode; TIMED_OUT after 600s timeout)`);

log("done — seeded comprehensive fixture across all agents & states:");
const { runs } = await client.runs();
for (const r of runs) log(`  ${r.runId}  ${r.state}  agent:${r.agent}  repos:[${(r.repos ?? []).join(", ")}]`);
const { proposals } = await client.proposals();
for (const p of proposals) log(`  ${p.id}  ${p.decision} (open)  agent:${p.agent ?? p.spec?.agent}  expired:${p.expired}`);
