/**
 * Opaque identifiers. Identity that must be deterministic (payload hashes,
 * idempotency keys) never comes from here — these are only for rows that need
 * a unique, unguessable handle.
 */
import { randomUUID } from "node:crypto";

export function newRunId() {
  return `run_${randomUUID()}`;
}

export function newProposalId() {
  return `prop_${randomUUID()}`;
}

export function newWorkerId() {
  return `worker_${process.pid}_${randomUUID().slice(0, 8)}`;
}
