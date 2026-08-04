import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeWorkerLease, renewWorkerLease, releaseWorkerLease, liveWorkerLeases } from "./worker-leases.mjs";

test("a lease occupies capacity only while its worker is alive and heartbeating", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-lease-"));
  writeWorkerLease({ repo: "legalease", ticket: "CLNT-1", owner: "run-a", pid: 42, dir, now: 1_000 });
  expect(liveWorkerLeases("legalease", { dir, now: 2_000, pidAlive: (pid) => pid === 42 })).toHaveLength(1);
  expect(liveWorkerLeases("legalease", { dir, now: 2_000, pidAlive: () => false })).toEqual([]);
  expect(liveWorkerLeases("legalease", { dir, now: 100_001, pidAlive: () => true })).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("only the owner can refresh or release a lease", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-lease-"));
  writeWorkerLease({ repo: "legalease", ticket: "CLNT-2", owner: "run-a", pid: process.pid, dir, now: 1_000 });
  expect(renewWorkerLease({ repo: "legalease", ticket: "CLNT-2", owner: "run-b", dir, now: 2_000 })).toBe(false);
  expect(releaseWorkerLease({ repo: "legalease", ticket: "CLNT-2", owner: "run-b", dir })).toBe(false);
  expect(releaseWorkerLease({ repo: "legalease", ticket: "CLNT-2", owner: "run-a", dir })).toBe(true);
  expect(liveWorkerLeases("legalease", { dir })).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
