/**
 * Closed run lifecycle (docs/event-runtime.md §8).
 *
 * Every state change goes through transition(), which enforces the legal-move
 * table and appends an audited record to the journal in the same transaction
 * that updates the run row. Illegal transitions are rejected, never repaired.
 */
import { hashJson } from "./canonical.mjs";
import { tx } from "./db.mjs";

export const STATES = [
  "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING",
  "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];

/** Terminal for the run. FAILED may still be re-queued while attempts remain. */
export const TERMINAL_STATES = new Set(["COMPLETED", "REFUSED", "TIMED_OUT", "CANCELLED"]);

const LEGAL = {
  PROPOSED: ["APPROVED", "CANCELLED"],
  APPROVED: ["QUEUED", "CANCELLED"],
  QUEUED: ["LEASED", "CANCELLED"],
  LEASED: ["RUNNING", "QUEUED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "TIMED_OUT", "QUEUED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "REFUSED", "FAILED"],
  FAILED: ["QUEUED"],
  COMPLETED: [],
  REFUSED: [],
  TIMED_OUT: [],
  CANCELLED: [],
};

export class IllegalTransition extends Error {
  constructor(runId, from, to) {
    super(`illegal transition ${from ?? "(none)"} → ${to} for ${runId}`);
    this.name = "IllegalTransition";
    this.runId = runId;
    this.from = from;
    this.to = to;
  }
}

function appendJournal(db, record) {
  const record_hash = hashJson(record);
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId, record.from, record.to, record.actor, record.reason ?? null,
    record.attempt ?? null, record.correlationId ?? null, record.causationId ?? null,
    record.policyVersion ?? null, record.at, record_hash,
  );
}

/**
 * Create a run in PROPOSED with its immutable spec. The idempotency key's
 * UNIQUE constraint is the §5.4 guarantee — a duplicate plan throws here and
 * the caller resolves to the existing run.
 */
export function createRun(db, { runId, idempotencyKey, spec, specJson, specHash, actor, correlationId, causationId, policyVersion, now = Date.now() }) {
  const at = new Date(now).toISOString();
  return tx(db, () => {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PROPOSED', 0, ?, ?)`,
    ).run(runId, idempotencyKey, specJson, specHash, at, at);
    appendJournal(db, {
      runId, from: null, to: "PROPOSED", actor,
      reason: "planned", correlationId, causationId, policyVersion, at,
    });
    return { runId, state: "PROPOSED" };
  });
}

/**
 * Move a run to `to`, enforcing legality against its current state. Pass
 * `expectFrom` when the caller must not race another mover (worker vs
 * operator): the transition then only applies if the state is still that one.
 */
export function transition(db, { runId, to, expectFrom, actor, reason, attempt, correlationId, causationId, policyVersion, now = Date.now() }) {
  const at = new Date(now).toISOString();
  return tx(db, () => {
    const run = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new IllegalTransition(runId, undefined, to);
    const from = run.state;
    if (expectFrom && from !== expectFrom) throw new IllegalTransition(runId, from, to);
    if (!(LEGAL[from] ?? []).includes(to)) throw new IllegalTransition(runId, from, to);
    db.query(`UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?`).run(to, at, runId);
    appendJournal(db, { runId, from, to, actor, reason, attempt, correlationId, causationId, policyVersion, at });
    return { runId, from, to };
  });
}

export function runState(db, runId) {
  return db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
}

export function lifecycleOf(db, runId) {
  return db.query(`SELECT * FROM lifecycle_events WHERE run_id = ? ORDER BY seq`).all(runId);
}
