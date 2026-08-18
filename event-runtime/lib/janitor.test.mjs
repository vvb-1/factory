import { describe, expect, test } from "bun:test";
import {
  janitorArgv,
  JANITOR_MAX_BUFFER,
  JANITOR_TIMEOUT_MS,
  spawnFactoryJanitor,
} from "./janitor.mjs";

describe("janitor", () => {
  test("janitorArgv never includes --force and adds --apply only when asked (OPS-301, OPS-364)", () => {
    const dry = janitorArgv("bj29");
    expect(dry).toContain("--json");
    expect(dry).toContain("bj29");
    expect(dry).not.toContain("--force");
    expect(dry).not.toContain("--apply");
    const apply = janitorArgv("bj29", { apply: true });
    expect(apply).toContain("--apply");
    expect(apply).not.toContain("--force");
    expect(apply.filter((a) => a === "--apply")).toHaveLength(1);
  });

  test("spawnFactoryJanitor is an async function (OPS-364)", () => {
    expect(typeof spawnFactoryJanitor).toBe("function");
    const promise = spawnFactoryJanitor("nonexistent-repo-test-12345");
    expect(promise instanceof Promise).toBe(true);
    return promise.catch((err) => {
      expect(err.status).toBe(404);
    });
  });

  test("spawnFactoryJanitor times out with 504 status", async () => {
    // Calling with timeoutMs = 1 against something that takes longer will time out
    const promise = spawnFactoryJanitor("bj29", { timeoutMs: 1 });
    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err.status).toBe(504);
      expect(err.message).toContain("janitor timed out");
    }
  });
});
