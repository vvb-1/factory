/**
 * Single-worker execution with leases and fencing (docs/event-runtime.md §8).
 *
 * Delivery is at-least-once, never assumed exactly-once: a claim takes a
 * lease with a monotonic fencing token, an expired lease re-queues the run,
 * and only the attempt holding the run's highest token may publish a terminal
 * result. Storing an accepted result and its derived completion event is one
 * transaction via the outbox — an invalid or refused output emits no
 * completion event at all (§15 exit criterion). An operator cancelling a run
 * mid-flight surfaces here as IllegalTransition; the worker stops quietly,
 * publishing nothing.
 */
import { storeCollected } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot } from "./config.mjs";
import { nextCounter, tx, txImmediate } from "./db.mjs";
import { getAgent } from "./registry.mjs";
import { IllegalTransition, transition } from "./lifecycle.mjs";
import { closeOpenProposalForRun } from "./proposals.mjs";
import { traceRecorder } from "./trace.mjs";
import { ContractViolation, verifyResult } from "./verify.mjs";
import { satisfiesPlacement } from "./workers.mjs";
import { createWorkspace, destroyWorkspace } from "./workspace.mjs";

/**
 * Runtime-injected artifacts: adapters that capture the agent's output write
 * it here (workspace-relative); the verifier includes it when present. The
 * agent does not have to declare its own transcript.
 */
const RUNTIME_ARTIFACTS = [{ kind: "transcript", path: ".transcript.json" }];

/** Grace added to the spec timeout before a lease is considered abandoned. */
const LEASE_GRACE_SECONDS = 120;

function iso(now) {
  return new Date(now).toISOString();
}

function finishAttempt(db, runId, attempt, terminalState, reasonCode, now) {
  db.query(
    `UPDATE attempts SET terminal_state = ?, reason_code = ?, finished_at = ?
     WHERE run_id = ? AND attempt = ?`,
  ).run(terminalState, reasonCode, iso(now), runId, attempt);
}

function latestJournalHash(db, runId) {
  return db
    .query(`SELECT record_hash FROM lifecycle_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId)?.record_hash ?? null;
}

/** The admitted event this run was planned from, via its proposal (may be absent). */
function originatingEvent(db, runId) {
  return db
    .query(
      `SELECT e.type, e.correlation_id, e.causation_id
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.run_id = ?
       LIMIT 1`,
    )
    .get(runId) ?? null;
}

/**
 * Claim the oldest QUEUED run: bump the attempt counter, take a lease with a
 * fresh fencing token, and move it to LEASED — all in one transaction.
 *
 * @returns {{ runId: string, attempt: number, fencingToken: number, spec: object } | null}
 */
export function claimNext(db, { owner, now = Date.now(), policyVersion = "unknown", labels = {}, adapters = null } = {}) {
  // BEGIN IMMEDIATE, not the default deferred transaction: two workers must
  // not both read the same QUEUED row before either writes (OPS-233).
  return txImmediate(db, () => {
    // Oldest-first, but skip runs this worker may not take — placement
    // requirements (§4) and adapters it does not have. Filtering in JS keeps
    // the rule in one predicate; Postgres can push it into SQL later.
    const candidates = db
      .query(
        `SELECT run_id, spec_json, attempts FROM runs
         WHERE state = 'QUEUED' ORDER BY created_at, run_id LIMIT 50`,
      )
      .all();
    let row = null;
    let spec = null;
    for (const candidate of candidates) {
      const candidateSpec = JSON.parse(candidate.spec_json);
      if (!satisfiesPlacement(labels, candidateSpec.placement)) continue;
      if (adapters && !adapters.includes(candidateSpec.adapter)) continue;
      row = candidate;
      spec = candidateSpec;
      break;
    }
    if (!row) return null;
    const attempt = row.attempts + 1;
    const fencingToken = nextCounter(db, "fencing");
    const leaseExpiresAt = iso(now + (spec.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000);

    db.query(`UPDATE runs SET attempts = ?, updated_at = ? WHERE run_id = ?`)
      .run(attempt, iso(now), row.run_id);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.run_id, attempt, fencingToken, owner, leaseExpiresAt);
    transition(db, {
      runId: row.run_id, to: "LEASED", expectFrom: "QUEUED",
      actor: owner, reason: "claimed", attempt, policyVersion, now,
    });

    return { runId: row.run_id, attempt, fencingToken, spec };
  });
}

/** Active executions by runId for cooperative cancellation. */
const ACTIVE_EXECUTIONS = new Map();

/**
 * Execute one claimed attempt to a terminal state. Returns a summary
 * { runId, attempt, terminalState, reasonCode, receipt? }, or
 * { cancelled: true } when an operator moved the run under us, or
 * { fenced: true } when a newer attempt owns the run at publish time.
 */
export async function executeClaimed(db, registry, adapters, claim, {
  workspacesRoot, artifactStore = artifactsRoot(), now = Date.now(), policyVersion = "unknown",
} = {}) {
  const { runId, attempt, fencingToken, spec } = claim;
  const owner = db
    .query(`SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`)
    .get(runId, attempt)?.lease_owner ?? "worker";
  const retain = spec.workspace?.retainOnFailure === true;
  let workspaceDir = null;
  let checkoutPath = null;
  const repoName = spec.input?.repoPin?.repo ?? spec.input?.repo ?? null;

  const abortController = new AbortController();
  ACTIVE_EXECUTIONS.set(runId, {
    abort: (reason) => abortController.abort(reason),
    controller: abortController,
    runId,
    attempt,
  });
  let cancelPoll = setInterval(() => {
    try {
      const state = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
      if (state === "CANCELLED" && !abortController.signal.aborted) {
        abortController.abort("db_cancelled");
      }
    } catch {
      // ignore
    }
  }, 250);
  cancelPoll?.unref?.();

  /** Terminal failure-shaped write: transition + attempts row, one tx. */
  const failTerminal = (to, journalReason, reasonCode, { requeue = false } = {}) =>
    tx(db, () => {
      transition(db, {
        runId, to, expectFrom: "RUNNING",
        actor: owner, reason: journalReason, attempt, policyVersion, now,
      });
      finishAttempt(db, runId, attempt, to, reasonCode, now);
      if (requeue && attempt < spec.maxAttempts) {
        transition(db, {
          runId, to: "QUEUED", expectFrom: "FAILED",
          actor: owner, reason: "retry", attempt, policyVersion, now,
        });
      }
    });

  try {
    tx(db, () => {
      transition(db, {
        runId, to: "RUNNING", expectFrom: "LEASED",
        actor: owner, reason: "started", attempt, policyVersion, now,
      });
      db.query(`UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`)
        .run(iso(now), runId, attempt);
    });

    const created = createWorkspace({
      root: workspacesRoot, runId, attempt, input: spec.input, workspace: spec.workspace,
      artifactStore,
    });
    workspaceDir = created.dir;
    checkoutPath = created.checkout?.path ?? null;
    db.query(`UPDATE attempts SET workspace_path = ? WHERE run_id = ? AND attempt = ?`)
      .run(workspaceDir, runId, attempt);

    const adapter = adapters[spec.adapter];
    if (!adapter) {
      failTerminal("FAILED", "unknown_adapter", "unknown_adapter");
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      return { runId, attempt, terminalState: "FAILED", reasonCode: "unknown_adapter" };
    }
    const def = getAgent(registry, spec.agent);

    // Live trace (factory.trace/v1): the recorder is already defensive, but
    // wrap it anyway — an adapter streaming trace events mid-run must never
    // be able to turn a recording problem into a failed attempt.
    // Real wall-clock per event — NOT the claim-time `now`. Trace timestamps
    // are the one place frozen time defeats the feature: "what is the agent
    // doing right now" needs to say when each step actually happened.
    const recorder = traceRecorder(db, { runId, attempt });
    const onTrace = (kind, payload) => {
      try {
        recorder(kind, payload);
      } catch {
        // swallow: trace is observability, not correctness
      }
    };

    let outcome;
    try {
      outcome = await adapter.execute({
        spec, def, workspaceDir, timeoutMs: spec.timeoutSeconds * 1000, env: {}, onTrace,
        abortSignal: abortController.signal, signal: abortController.signal,
      });
    } finally {
      clearInterval(cancelPoll);
      ACTIVE_EXECUTIONS.delete(runId);
    }

    if (abortController.signal.aborted) {
      if (workspaceDir) destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      try {
        finishAttempt(db, runId, attempt, "CANCELLED", "cancelled", now);
      } catch {
        // ignore
      }
      return { cancelled: true };
    }

    const { exitCode, timedOut } = outcome ?? {};

    if (timedOut) {
      failTerminal("TIMED_OUT", "timeout", "timeout");
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      return { runId, attempt, terminalState: "TIMED_OUT", reasonCode: "timeout" };
    }
    if (exitCode !== 0) {
      const reasonCode = `agent_exit_${exitCode}`;
      failTerminal("FAILED", reasonCode, reasonCode, { requeue: true });
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    transition(db, {
      runId, to: "VERIFYING", expectFrom: "RUNNING",
      actor: owner, reason: "exit_0", attempt, policyVersion, now,
    });

    let verified;
    try {
      verified = verifyResult({ spec, def, registry, workspaceDir, attempt, extraArtifacts: RUNTIME_ARTIFACTS });
    } catch (err) {
      if (!(err instanceof ContractViolation)) throw err;
      // Invalid output is a typed contract failure and emits no completion
      // event (§15) — no results row, no outbox row.
      tx(db, () => {
        transition(db, {
          runId, to: "FAILED", expectFrom: "VERIFYING",
          actor: owner, reason: `contract_violation: ${err.violations.join(", ")}`,
          attempt, policyVersion, now,
        });
        finishAttempt(db, runId, attempt, "FAILED", "contract_violation", now);
        if (attempt < spec.maxAttempts) {
          transition(db, {
            runId, to: "QUEUED", expectFrom: "FAILED",
            actor: owner, reason: "retry", attempt, policyVersion, now,
          });
        }
      });
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      return { runId, attempt, terminalState: "FAILED", reasonCode: "contract_violation" };
    }

    if (verified.kind === "refused") {
      // Refusal is not failure (§5.3): store the typed result, publish no
      // completion event, clean the workspace normally.
      tx(db, () => {
        transition(db, {
          runId, to: "REFUSED", expectFrom: "VERIFYING",
          actor: owner, reason: verified.reasonCode, attempt, policyVersion, now,
        });
        const receipt = {
          runId, runSpecHash: hashJson(spec), artifactHash: null, evidenceSetHash: null,
          journalHead: latestJournalHash(db, runId), verificationStatus: "passed",
        };
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId, attempt, canonicalJson(verified.result), "none", null,
          canonicalJson(verified.result.verification), canonicalJson(receipt), iso(now),
        );
        finishAttempt(db, runId, attempt, "REFUSED", verified.reasonCode, now);
      });
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { runId, attempt, terminalState: "REFUSED", reasonCode: verified.reasonCode };
    }

    // Copy verified artifact files into the durable content-addressed store
    // (§7) BEFORE the workspace dies and before the row referencing them
    // commits. Orphans from a failed commit are harmless; dead links are not.
    verified.result.artifacts = storeCollected({ entries: verified.result.artifacts, storeRoot: artifactStore });

    // Completed: fencing check, result, receipt, outbox event, and the
    // COMPLETED transition are one transaction.
    const published = tx(db, () => {
      const maxToken = db
        .query(`SELECT MAX(fencing_token) AS m FROM attempts WHERE run_id = ?`)
        .get(runId).m;
      if (fencingToken !== maxToken) return { fenced: true };

      const receipt = { ...verified.receipt, journalHead: latestJournalHash(db, runId) };
      const { result } = verified;
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId, attempt, canonicalJson(result), result.artifactHash, result.evidenceSetHash,
        canonicalJson(result.verification), canonicalJson(receipt), iso(now),
      );

      const origin = originatingEvent(db, runId);
      const envelope = {
        schemaVersion: "factory.event/v1",
        eventId: `event-runtime:${runId}:${attempt}`,
        type: origin ? origin.type.replace(/\.requested$/, ".completed") : "factory.run.completed",
        source: "event-runtime",
        subject: spec.agent,
        occurredAt: iso(now),
        correlationId: origin?.correlation_id ?? null,
        causationId: origin?.causation_id ?? null,
        payload: { runId, attempt, artifactHash: result.artifactHash, outputContract: spec.outputContract },
      };
      db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`)
        .run(canonicalJson(envelope), iso(now));

      transition(db, {
        runId, to: "COMPLETED", expectFrom: "VERIFYING",
        actor: owner, reason: "ok", attempt, policyVersion, now,
      });
      finishAttempt(db, runId, attempt, "COMPLETED", "ok", now);
      return { receipt };
    });

    if (published.fenced) {
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { fenced: true };
    }
    destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
    return { runId, attempt, terminalState: "COMPLETED", reasonCode: "ok", receipt: published.receipt };
  } catch (err) {
    if (err instanceof IllegalTransition) {
      // Operator moved the run under us (cancel) — stop quietly, publish nothing.
      if (workspaceDir) destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { cancelled: true };
    }
    const reasonCode = "adapter_error";
    const journalReason = `adapter_error: ${err?.message ?? String(err)}`;
    try {
      failTerminal("FAILED", journalReason, reasonCode, { requeue: true });
    } catch {
      // if failTerminal could not transition, continue
    }
    if (workspaceDir) {
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
    }
    return { runId, attempt, terminalState: "FAILED", reasonCode, error: err?.message };
  }
}

/**
 * Re-queue LEASED/RUNNING/VERIFYING runs whose current attempt's lease expired.
 * The stale attempt keeps its (now lower) fencing token, so a late publish from
 * it is fenced out. Respects maxAttempts and dead-letters beyond it.
 */
export function reapExpiredLeases(db, { now = Date.now(), policyVersion = "unknown" } = {}) {
  return tx(db, () => {
    const rows = db
      .query(
        `SELECT r.run_id, r.attempts, r.spec_json, r.state FROM runs r
         JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
         WHERE r.state IN ('LEASED', 'RUNNING', 'VERIFYING') AND a.lease_expires_at < ?`,
      )
      .all(iso(now));
    for (const row of rows) {
      const spec = JSON.parse(row.spec_json);
      if (row.attempts < spec.maxAttempts) {
        if (row.state === "VERIFYING") {
          transition(db, {
            runId: row.run_id, to: "FAILED",
            actor: "reaper", reason: "lease_expired", attempt: row.attempts, policyVersion, now,
          });
          transition(db, {
            runId: row.run_id, to: "QUEUED",
            actor: "reaper", reason: "retry", attempt: row.attempts, policyVersion, now,
          });
        } else {
          transition(db, {
            runId: row.run_id, to: "QUEUED",
            actor: "reaper", reason: "lease_expired", attempt: row.attempts, policyVersion, now,
          });
        }
      } else {
        if (row.state === "LEASED") {
          transition(db, {
            runId: row.run_id, to: "RUNNING",
            actor: "reaper", reason: "lease_expired_attempts_exhausted", attempt: row.attempts, policyVersion, now,
          });
        }
        transition(db, {
          runId: row.run_id, to: "FAILED",
          actor: "reaper", reason: "lease_expired_attempts_exhausted", attempt: row.attempts, policyVersion, now,
        });
        finishAttempt(db, row.run_id, row.attempts, "FAILED", "lease_expired", now);
      }
    }
    return rows.length;
  });
}

/** Claim and execute one run, or null when nothing is QUEUED. */
export async function runOnce(db, registry, adapters, opts = {}) {
  const claim = claimNext(db, opts);
  if (!claim) return null;
  return executeClaimed(db, registry, adapters, claim, opts);
}

/**
 * Operator cancel (§13): cancels runs in pre-terminal states.
 * For VERIFYING, transitions to FAILED with reason operator_cancel.
 * A still-open proposal for the run is closed in the same transaction.
 */
export function cancelRun(db, runId, { actor, reason = "operator_cancel", now = Date.now(), policyVersion } = {}) {
  return tx(db, () => {
    const run = db.query(`SELECT state, attempts FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING") {
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now });
      finishAttempt(db, runId, run.attempts, "FAILED", "cancelled", now);
    } else {
      result = transition(db, { runId, to: "CANCELLED", actor, reason, policyVersion, now });
      if (run.state === "RUNNING" || run.state === "LEASED") {
        finishAttempt(db, runId, run.attempts, "CANCELLED", "cancelled", now);
      }
    }
    const proposalClose = closeOpenProposalForRun(db, runId, { actor, now });
    const active = ACTIVE_EXECUTIONS.get(runId);
    if (active) {
      active.abort(reason);
    }
    return { ...result, proposalClose };
  });
}

/**
 * Force-fail a stranded or non-terminal run with a journaled transition.
 */
export function forceFailRun(db, runId, { actor = "operator", reason = "operator_force_fail", now = Date.now(), policyVersion = "unknown" } = {}) {
  return tx(db, () => {
    const run = db.query(`SELECT state, attempts FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING" || run.state === "RUNNING") {
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, now);
    } else if (run.state === "LEASED") {
      transition(db, { runId, to: "RUNNING", actor, reason: "force_fail_start", attempt: run.attempts, policyVersion, now });
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, now);
    } else if (run.state === "QUEUED" || run.state === "APPROVED" || run.state === "PROPOSED") {
      result = transition(db, { runId, to: "CANCELLED", actor, reason, policyVersion, now });
    } else {
      throw new Error(`cannot force-fail run in terminal state ${run.state}`);
    }
    closeOpenProposalForRun(db, runId, { actor, now });
    return result;
  });
}

/**
 * Operator retry (§13): FAILED → QUEUED, or recovery from VERIFYING. Retrying past maxAttempts requires
 * the explicit force override, which is recorded in the journal reason.
 */
export function retryRun(db, runId, { actor, force = false, now = Date.now(), policyVersion } = {}) {
  const row = db.query(`SELECT state, spec_json, attempts FROM runs WHERE run_id = ?`).get(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json);
  if (!force && row.attempts >= spec.maxAttempts) throw new Error("attempts_exhausted");
  if (row.state === "VERIFYING") {
    return tx(db, () => {
      transition(db, { runId, to: "FAILED", actor, reason: "operator_retry_verifying", policyVersion, now });
      finishAttempt(db, runId, row.attempts, "FAILED", "operator_retry", now);
      return transition(db, {
        runId, to: "QUEUED", actor,
        reason: force ? "operator_retry_forced" : "operator_retry", policyVersion, now,
      });
    });
  }
  return transition(db, {
    runId, to: "QUEUED", actor,
    reason: force ? "operator_retry_forced" : "operator_retry", policyVersion, now,
  });
}
