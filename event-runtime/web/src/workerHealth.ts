import type { Worker, WorkerState } from "./types";

export type WorkerHealth = WorkerState | "stale";

/** Four mutually exclusive tokens; `stale` is the loudest because it is a lie detector. */
export const WORKER_HUES: Record<WorkerHealth, string> = {
  idle: "var(--hue-ok)",
  busy: "var(--hue-warn)",
  stopped: "var(--hue-idle)",
  stale: "var(--hue-err)",
};

/**
 * A stale heartbeat outranks whatever the row claims: a stale busy worker is
 * gone, not busy. `listWorkers` never marks a cleanly stopped worker stale, so
 * these four are disjoint.
 */
export const health = (w: Worker): WorkerHealth => (w.stale ? "stale" : w.state);
