/**
 * Lease reaper for the event runtime (docs/event-runtime.md §8; OPS-416).
 *
 * Sweeps LEASED, RUNNING, and VERIFYING attempts whose lease has expired.
 * Recovers stranded attempts by re-queuing (if attempts < maxAttempts)
 * or dead-lettering to FAILED (if maxAttempts exhausted).
 */
export { reapExpiredLeases } from "./worker.mjs";
