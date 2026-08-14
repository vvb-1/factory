import { describe, expect, test } from "bun:test";
import type { Worker } from "./types";
import {
  dur,
  heartbeatHue,
  heartbeatOf,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_WARN_MS,
  isOverdue,
} from "./heartbeat";

const baseWorker = (overrides: Partial<Worker> = {}): Worker => ({
  workerId: "wkr_test",
  host: "lab",
  pid: 1,
  labels: {},
  adapters: [],
  state: "idle",
  currentRun: null,
  lastSeen: "2026-01-01T00:00:00.000Z",
  stale: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  stoppedAt: null,
  ...overrides,
});

describe("heartbeatOf", () => {
  const lastSeen = "2026-01-01T00:00:00.000Z";
  const deadline = Date.parse(lastSeen) + HEARTBEAT_STALE_MS;

  test("a cleanly stopped worker has no countdown", () => {
    const w = baseWorker({ state: "stopped", lastSeen });
    expect(heartbeatOf(w, deadline)).toEqual({ kind: "none" });
  });

  test("stale outranks stopped: a stale row still shows overdue time", () => {
    const w = baseWorker({ state: "stopped", stale: true, lastSeen });
    expect(heartbeatOf(w, deadline + 5000)).toEqual({ kind: "stale", overdueMs: 5000 });
  });

  test("live worker halfway through the window", () => {
    const w = baseWorker({ state: "busy", lastSeen });
    const now = deadline - 45_000;
    expect(heartbeatOf(w, now)).toEqual({ kind: "live", remainingMs: 45_000 });
  });

  test("ceil rounds sub-second remainder up to the next whole second", () => {
    const w = baseWorker({ lastSeen });
    expect(heartbeatOf(w, deadline - 1)).toEqual({ kind: "live", remainingMs: 1000 });
    expect(heartbeatOf(w, deadline - 999)).toEqual({ kind: "live", remainingMs: 1000 });
  });

  test("at the 90s boundary remainingMs is zero (overdue, not stale yet)", () => {
    const w = baseWorker({ lastSeen });
    expect(heartbeatOf(w, deadline)).toEqual({ kind: "live", remainingMs: 0 });
    expect(heartbeatOf(w, deadline + 10_000)).toEqual({ kind: "live", remainingMs: 0 });
  });

  test("stale overdueMs floors to at least one second", () => {
    const w = baseWorker({ stale: true, lastSeen });
    expect(heartbeatOf(w, deadline + 1)).toEqual({ kind: "stale", overdueMs: 1000 });
    expect(heartbeatOf(w, deadline + 2500)).toEqual({ kind: "stale", overdueMs: 2500 });
  });
});

describe("isOverdue", () => {
  test("only a spent live window reads overdue", () => {
    expect(isOverdue({ kind: "live", remainingMs: 0 })).toBe(true);
    expect(isOverdue({ kind: "live", remainingMs: 1000 })).toBe(false);
    expect(isOverdue({ kind: "stale", overdueMs: 5000 })).toBe(false);
    expect(isOverdue({ kind: "none" })).toBe(false);
  });
});

describe("heartbeatHue", () => {
  test("stale is always error", () => {
    expect(heartbeatHue({ kind: "stale", overdueMs: 1000 })).toBe("var(--hue-err)");
  });

  test("live inside the warn band is warn", () => {
    expect(heartbeatHue({ kind: "live", remainingMs: HEARTBEAT_WARN_MS })).toBe("var(--hue-warn)");
    expect(heartbeatHue({ kind: "live", remainingMs: 1000 })).toBe("var(--hue-warn)");
    expect(heartbeatHue({ kind: "live", remainingMs: 0 })).toBe("var(--hue-warn)");
  });

  test("live outside the warn band has no accent", () => {
    expect(heartbeatHue({ kind: "live", remainingMs: HEARTBEAT_WARN_MS + 1000 })).toBeUndefined();
    expect(heartbeatHue({ kind: "none" })).toBeUndefined();
  });
});

describe("dur", () => {
  test("formats sub-hour durations as m:ss", () => {
    expect(dur(0)).toBe("0:00");
    expect(dur(1000)).toBe("0:01");
    expect(dur(65_000)).toBe("1:05");
    expect(dur(3599_000)).toBe("59:59");
  });

  test("formats hour-scale durations", () => {
    expect(dur(3600_000)).toBe("1h00m");
    expect(dur(3661_000)).toBe("1h01m");
  });

  test("formats day-scale durations", () => {
    expect(dur(86_400_000)).toBe("1d0h");
    expect(dur(90_000_000)).toBe("1d1h");
  });
});
