import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathViolation, createWorkspace, destroyWorkspace, safeJoin } from "./workspace.mjs";

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "evrt-ws-"));
}

describe("safeJoin", () => {
  const ws = tmpRoot();

  test("accepts nested relative paths", () => {
    expect(safeJoin(ws, "result.json")).toBe(path.join(ws, "result.json"));
    expect(safeJoin(ws, "logs/agent/output.log")).toBe(path.join(ws, "logs", "agent", "output.log"));
  });

  test("rejects absolute paths", () => {
    expect(() => safeJoin(ws, "/etc/passwd")).toThrow(PathViolation);
  });

  test("rejects ../ escapes", () => {
    expect(() => safeJoin(ws, "../outside.txt")).toThrow(PathViolation);
    expect(() => safeJoin(ws, "logs/../../outside.txt")).toThrow(PathViolation);
  });

  test("rejects empty and non-string paths, and the workspace itself", () => {
    expect(() => safeJoin(ws, "")).toThrow(PathViolation);
    expect(() => safeJoin(ws, undefined)).toThrow(PathViolation);
    expect(() => safeJoin(ws, ".")).toThrow(PathViolation);
  });
});

describe("createWorkspace / destroyWorkspace", () => {
  test("creates <runId>-a<attempt> and writes canonical input.json", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({ root, runId: "run_x", attempt: 1, input: { b: 2, a: 1 } });
    expect(dir).toBe(path.join(root, "run_x-a1"));
    expect(readFileSync(path.join(dir, "input.json"), "utf8")).toBe('{"a":1,"b":2}\n');
  });

  test("destroy removes the directory; retain leaves it and returns false", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({ root, runId: "run_y", attempt: 1, input: {} });
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
