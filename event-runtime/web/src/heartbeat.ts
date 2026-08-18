import type { Worker } from "./types";

/**
 * Mirrors `HEARTBEAT_STALE_MS` in `event-runtime/lib/workers.mjs`. The web app
 * never imports from the runtime's `lib/`, so moving the window there means
 * changing it here too — the number is duplicated on purpose, not by accident.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/** The last third of the window. A worker that checks in every tick never reaches it. */
export const HEARTBEAT_WARN_MS = 30_000;

export type Heartbeat =
  | { kind: "stale"; overdueMs: number }
  | { kind: "live"; remainingMs: number }
  | { kind: "none" };

/**
 * Threshold arithmetic, not a second opinion on health: whether a worker *is*
 * stale stays the server's call (`w.stale`, via `health`), and this only says how
 * much of the 90s window is left or how far past it we are. A cleanly stopped
 * worker stops checking in on purpose, so it has no deadline at all — counting
 * down for it would invent an outage.
 */
export const heartbeatOf = (w: Worker, now: number): Heartbeat => {
  const deadline = Date.parse(w.lastSeen) + HEARTBEAT_STALE_MS;
  // Floored to a second, because `dur` renders the first sub-second of overdue as
  // `0:00` and "stale for no time at all" reads as a broken badge rather than a
  // fresh one. Same floor the countdown below uses, so the flip reads 0:01 next.
  if (w.stale)
    return { kind: "stale", overdueMs: Math.max(1000, now - deadline) };
  if (w.state === "stopped") return { kind: "none" };
  // Whole seconds, rounded up: the last fraction of a second reads 0:01, and only
  // a genuinely spent window reads 0 — which is what `overdue` keys off.
  return {
    kind: "live",
    remainingMs: Math.max(0, Math.ceil((deadline - now) / 1000) * 1000),
  };
};

/** One hue per clock, so the age, the countdown and the meter never disagree. */
export const heartbeatHue = (hb: Heartbeat): string | undefined => {
  if (hb.kind === "stale") return "var(--hue-err)";
  if (hb.kind === "live" && hb.remainingMs <= HEARTBEAT_WARN_MS)
    return "var(--hue-warn)";
  return undefined;
};

/** `m:ss` while seconds decide, coarser once they stop mattering. */
export const dur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
};

/** Whether the live countdown has spent the window but the server has not marked stale yet. */
export const isOverdue = (hb: Heartbeat): boolean =>
  hb.kind === "live" && hb.remainingMs === 0;
