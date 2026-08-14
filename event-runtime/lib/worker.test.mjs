import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot } from "./config.mjs";
import { openDb } from "./db.mjs";
import { createRun, lifecycleOf, runState, transition, IllegalTransition } from "./lifecycle.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  cancelRun, claimNext, executeClaimed, reapExpiredLeases, retryRun, runOnce,
} from "./worker.mjs";

const registry = loadRegistry();
const adapters = { fake };
const T0 = Date.parse("2026-08-12T10:00:00Z");

let seq = 0;
function makeSpec(overrides = {}) {
  const runId = overrides.runId ?? `run_worker_${++seq}_${Math.random().toString(36).slice(2)}`;
  const input = overrides.input ?? { repos: ["ok"] };
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds: 5,
    maxAttempts: 1,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

function queueRun(db, spec, now = T0) {
  createRun(db, {
    runId: spec.runId, idempotencyKey: spec.idempotencyKey,
    spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
    actor: "test", policyVersion: "test", now,
  });
  transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now });
  transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now });
  return spec;
}

/** Link the run to an admitted event via a proposal, like the planner would. */
function linkEvent(db, runId, { type = "factory.status-report.requested", correlationId = "corr-1" } = {}) {
  const at = new Date(T0).toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("test", `evt-${runId}`, type, "factory", at, at, correlationId, null, "{}", "sha256:x", at);
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, 'RUN_SPEC', ?, 1800)`,
  ).run(`prop-${runId}`, "test", `evt-${runId}`, runId, at);
}

function freshRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "evrt-worker-"));
}

function opts(extra = {}) {
  return { owner: "w1", workspacesRoot: freshRoot(), now: T0, policyVersion: "test", ...extra };
}

describe("worker", () => {
  test("happy path: COMPLETED, results row, receipt, one completion outbox event, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    expect(runState(db, spec.runId)).toBe("COMPLETED");

    const result = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(result).toBeTruthy();
    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.verificationStatus).toBe("passed");
    expect(receipt.journalHead).toMatch(/^sha256:/);
    expect(receipt.runSpecHash).toBe(hashJson(spec));
    expect(receipt.artifactHash).toBe(result.artifact_hash);
    expect(summary.receipt).toEqual(receipt);

    const outbox = db.query(`SELECT * FROM outbox`).all();
    expect(outbox).toHaveLength(1);
    const envelope = JSON.parse(outbox[0].event_json);
    expect(envelope.type).toBe("factory.status-report.completed");
    expect(envelope.eventId).toBe(`event-runtime:${spec.runId}:1`);
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.payload).toEqual({
      runId: spec.runId, attempt: 1,
      artifactHash: result.artifact_hash, outputContract: spec.outputContract,
    });

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("COMPLETED");
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("refuse: REFUSED, results row stored, no outbox row, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("needs_human");
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(db.query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`).get(spec.runId).n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(0);
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);

    const resultRow = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    const parsedResult = JSON.parse(resultRow.result_json);
    expect(parsedResult.artifacts).toHaveLength(1);
    expect(parsedResult.artifacts[0].kind).toBe("transcript");
    expect(parsedResult.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedResult.artifacts[0].uri).toMatch(/^file:\/\//);
    const storePath = path.join(o.artifactStore ?? artifactsRoot(), parsedResult.artifacts[0].sha256);
    expect(existsSync(storePath)).toBe(true);
    expect(pinRunArtifact(db, spec.runId)).toEqual({
      runId: spec.runId,
      transcript: parsedResult.artifacts[0].sha256,
      state: "REFUSED",
      agent: spec.agent,
    });
  });

  test("invalid-artifact: FAILED/contract_violation, no outbox row, workspace retained", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["invalid-artifact"] } }));
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM results`).get().n).toBe(0);
    // retainOnFailure: true in the real def → workspace kept for inspection
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(true);
    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.reason_code).toBe("contract_violation");
  });

  test("escape: artifact outside the workspace is a contract violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["escape"] } }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(0);
  });

  test("no-result: FAILED/contract_violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["no-result"] } }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(runState(db, spec.runId)).toBe("FAILED");
  });

  test("hang: TIMED_OUT with a tiny timeout", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["hang"] }, timeoutSeconds: 0.05 }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("TIMED_OUT");
    expect(summary.reasonCode).toBe("timeout");
    expect(runState(db, spec.runId)).toBe("TIMED_OUT");
  });

  test("crash with maxAttempts 2: FAILED then auto re-QUEUED; second claim has higher fencing token", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] }, maxAttempts: 2 }));
    const o = opts();

    const claim1 = claimNext(db, o);
    expect(claim1.attempt).toBe(1);
    const summary = await executeClaimed(db, registry, adapters, claim1, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("agent_exit_1");
    expect(runState(db, spec.runId)).toBe("QUEUED");

    const claim2 = claimNext(db, o);
    expect(claim2.runId).toBe(spec.runId);
    expect(claim2.attempt).toBe(2);
    expect(claim2.fencingToken).toBeGreaterThan(claim1.fencingToken);
  });

  test("crash with maxAttempts 1: stays FAILED, no auto retry", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] } }));
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
  });

  test("fencing: a stale claim can never publish over a newer attempt", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    linkEvent(db, spec.runId);
    const o = opts();

    // Claim but never execute — the worker "died".
    const stale = claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Lease expires → reaper re-queues.
    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");

    // Fresh claim executes to completion.
    const o2 = { ...o, now: afterExpiry };
    const fresh = claimNext(db, o2);
    expect(fresh.attempt).toBe(2);
    expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);
    const done = await executeClaimed(db, registry, adapters, fresh, o2);
    expect(done.terminalState).toBe("COMPLETED");

    // The zombie wakes up and tries to run its stale claim.
    const zombie = await executeClaimed(db, registry, adapters, stale, o2);
    expect(zombie.fenced === true || zombie.cancelled === true).toBe(true);

    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(db.query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`).get(spec.runId).n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(1);
    const terminals = lifecycleOf(db, spec.runId).filter((e) => e.to_state === "COMPLETED");
    expect(terminals).toHaveLength(1);
  });

  test("restart survival: results, receipt, and journal readable from a reopened file db", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-db-"));
    const file = path.join(dir, "runtime.db");
    const db = openDb(file);
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    db.close();

    const reopened = openDb(file);
    expect(runState(reopened, spec.runId)).toBe("COMPLETED");
    const result = reopened.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(JSON.parse(result.result_json).terminalState).toBe("completed");
    expect(JSON.parse(result.receipt_json).verificationStatus).toBe("passed");
    const journal = lifecycleOf(reopened, spec.runId);
    expect(journal.map((e) => e.to_state)).toEqual([
      "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED",
    ]);
    expect(reopened.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(1);
    reopened.close();
  });

  test("executeClaimed on a cancelled run stops quietly and publishes nothing", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const o = opts();
    const claim = claimNext(db, o);
    cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    const summary = await executeClaimed(db, registry, adapters, claim, o);
    expect(summary).toEqual({ cancelled: true });
    expect(runState(db, spec.runId)).toBe("CANCELLED");
    expect(db.query(`SELECT COUNT(*) AS n FROM results`).get().n).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(0);
  });

  test("unknown adapter fails terminal", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "nope" }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");
    expect(runState(db, spec.runId)).toBe("FAILED");
  });

  test("cancelRun on a QUEUED run → CANCELLED; on a terminal run → IllegalTransition", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(runState(db, spec.runId)).toBe("CANCELLED");
    expect(() => cancelRun(db, spec.runId, { actor: "operator" })).toThrow(IllegalTransition);
  });

  test("cancelRun on a PROPOSED run closes its unique open proposal", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    createRun(db, {
      runId: spec.runId, idempotencyKey: spec.idempotencyKey,
      spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
      actor: "test", policyVersion: "test", now: T0,
    });
    linkEvent(db, spec.runId);
    const outcome = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(runState(db, spec.runId)).toBe("CANCELLED");
    expect(outcome.proposalClose).toEqual({ closed: true, id: `prop-${spec.runId}` });
    const proposal = db.query(`SELECT * FROM proposals WHERE run_id = ?`).get(spec.runId);
    expect(proposal.status).toBe("rejected");
    expect(proposal.reason).toBe("run_cancelled");
    expect(proposal.decided_by).toBe("operator");
    expect(proposal.decided_at).toBe(new Date(T0).toISOString());
  });

  test("cancelRun with no open proposal still cancels", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    createRun(db, {
      runId: spec.runId, idempotencyKey: spec.idempotencyKey,
      spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
      actor: "test", policyVersion: "test", now: T0,
    });
    const outcome = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(runState(db, spec.runId)).toBe("CANCELLED");
    expect(outcome.proposalClose).toEqual({ closed: false });
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(0);
  });

  test("cancelRun with two open proposals for the run closes neither", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    createRun(db, {
      runId: spec.runId, idempotencyKey: spec.idempotencyKey,
      spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
      actor: "test", policyVersion: "test", now: T0,
    });
    linkEvent(db, spec.runId);
    const at = new Date(T0).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'RUN_SPEC', ?, 1800)`,
    ).run(`prop-${spec.runId}-extra`, "test", `evt-${spec.runId}`, spec.runId, at);
    const outcome = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(runState(db, spec.runId)).toBe("CANCELLED");
    expect(outcome.proposalClose).toEqual({ closed: false, ambiguous: true, count: 2 });
    const open = db.query(`SELECT COUNT(*) AS n FROM proposals WHERE run_id = ? AND status = 'open'`).get(spec.runId);
    expect(open.n).toBe(2);
  });

  test("retryRun: exhausted attempts throw without force, re-queue with force", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] } }));
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");

    expect(() => retryRun(db, spec.runId, { actor: "operator", policyVersion: "test" }))
      .toThrow("attempts_exhausted");
    expect(runState(db, spec.runId)).toBe("FAILED");

    retryRun(db, spec.runId, { actor: "operator", force: true, policyVersion: "test", now: T0 });
    expect(runState(db, spec.runId)).toBe("QUEUED");
  });

  test("adapter exception: FAILED/adapter_error, workspace destroyed, not wedged in RUNNING (OPS-405)", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated adapter explosion");
      },
    };
    const throwingAdapters = { throwing: throwingAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "throwing", maxAttempts: 1, workspace: { type: "ephemeral", retainOnFailure: false } }));
    const o = opts();

    const summary = await runOnce(db, registry, throwingAdapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("adapter_error");
    expect(attempt.finished_at).toBeTruthy();
  });

  test("adapter exception with retries: auto re-QUEUED, workspace cleaned (OPS-405)", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated adapter explosion");
      },
    };
    const throwingAdapters = { throwing: throwingAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "throwing", maxAttempts: 2, workspace: { type: "ephemeral", retainOnFailure: false } }));
    const o = opts();

    const summary = await runOnce(db, registry, throwingAdapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("reapExpiredLeases dead-letters when maxAttempts is reached (OPS-405)", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 1 }));
    const o = opts();
    const claim = claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("FAILED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("lease_expired");
    // Does not re-queue again
    expect(reapExpiredLeases(db, { now: afterExpiry + 1000, policyVersion: "test" })).toBe(0);
    expect(claimNext(db, opts())).toBeNull();
  });

  test("cancelRun on a RUNNING attempt aborts adapter immediately and records attempt (OPS-417)", async () => {
    const db = openDb(":memory:");
    let aborted = false;
    const longRunningAdapter = {
      execute: ({ abortSignal }) => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ exitCode: 0, timedOut: false }), 5000);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            resolve({ exitCode: null, timedOut: false });
          });
        });
      },
    };
    const customAdapters = { long: longRunningAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "long", timeoutSeconds: 30 }));
    const o = opts();

    const claim = claimNext(db, o);
    const execPromise = executeClaimed(db, registry, customAdapters, claim, o);

    // Cancel while RUNNING
    expect(runState(db, spec.runId)).toBe("RUNNING");
    cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });

    const summary = await execPromise;
    expect(summary.cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect(runState(db, spec.runId)).toBe("CANCELLED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("CANCELLED");
    expect(attempt.reason_code).toBe("cancelled");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("runOnce returns null when nothing is QUEUED", async () => {
    const db = openDb(":memory:");
    expect(await runOnce(db, registry, adapters, opts())).toBeNull();
  });

  test("accurate attempt timestamps: started_at < finished_at with clock function (OPS-430)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    let t = T0;
    const clock = () => (t += 1000);
    const o = opts({ now: clock });

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(Date.parse(attempt.started_at)).toBeLessThan(Date.parse(attempt.finished_at));

    const journal = lifecycleOf(db, spec.runId);
    const leased = journal.find((e) => e.to_state === "LEASED");
    const running = journal.find((e) => e.to_state === "RUNNING");
    const verifying = journal.find((e) => e.to_state === "VERIFYING");
    const completed = journal.find((e) => e.to_state === "COMPLETED");

    expect(Date.parse(leased.at)).toBeLessThan(Date.parse(running.at));
    expect(Date.parse(running.at)).toBeLessThan(Date.parse(verifying.at));
    expect(Date.parse(verifying.at)).toBeLessThan(Date.parse(completed.at));
    expect(attempt.started_at).toBe(running.at);
    expect(attempt.finished_at).toBe(completed.at);
  });
});

