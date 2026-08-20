import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createChildTracker, createShutdownController } from "./run.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function shutdownHarness(childTracker, overrides = {}) {
  const exits = [];
  const logs = [];
  let timersCleared = 0;
  const shutdown = createShutdownController({
    childTracker,
    clearTimers: () => {
      timersCleared++;
    },
    getCounts: () => ({ completed: 2, failed: 0 }),
    getRunningNames: () => ["dispatch"],
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
    ...overrides,
  });
  return {
    shutdown,
    exits,
    logs,
    get timersCleared() {
      return timersCleared;
    },
  };
}

test("active child processes are tracked and removed when they close", async () => {
  const tracker = createChildTracker();
  const first = fakeChild();
  const second = fakeChild();

  expect(tracker.track(first)).toBe(first);
  tracker.track(second);
  expect(tracker.size).toBe(2);
  expect(tracker.active.has(first)).toBe(true);

  first.emit("close", 0);
  expect(tracker.size).toBe(1);
  expect(tracker.active.has(first)).toBe(false);

  second.emit("close", 0);
  expect(tracker.size).toBe(0);
  expect(await tracker.waitForEmpty(20)).toBe(true);
});

test("shutdown forwards SIGTERM and waits for active children to settle", async () => {
  const tracker = createChildTracker();
  const child = fakeChild();
  tracker.track(child);
  const harness = shutdownHarness(tracker);
  let settled = false;

  const pending = harness.shutdown("SIGINT").then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();

  expect(harness.timersCleared).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(settled).toBe(false);
  expect(harness.exits).toEqual([]);

  child.emit("close", 0);
  const result = await pending;
  expect(result).toEqual({ forced: false, drained: true });
  expect(harness.exits).toEqual([0]);
});

test("shutdown stops waiting at its deadline", async () => {
  const tracker = createChildTracker();
  tracker.track(fakeChild());
  const harness = shutdownHarness(tracker, { timeoutMs: 10 });

  const result = await harness.shutdown("SIGTERM");

  expect(result).toEqual({ forced: false, drained: false });
  expect(harness.exits).toEqual([0]);
  expect(harness.logs.some((line) => line.includes("deadline reached"))).toBe(
    true,
  );
});

test("a second interrupt exits immediately with code 130", async () => {
  let terminateCalls = 0;
  const childTracker = {
    size: 1,
    terminateAll: () => {
      terminateCalls++;
    },
    waitForEmpty: () => new Promise(() => {}),
  };
  const harness = shutdownHarness(childTracker);

  void harness.shutdown("SIGINT");
  const result = await harness.shutdown("SIGTERM");

  expect(terminateCalls).toBe(1);
  expect(harness.timersCleared).toBe(1);
  expect(result).toEqual({ forced: true, drained: false });
  expect(harness.exits).toEqual([130]);
});
