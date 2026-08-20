import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRESHOLD,
  evaluateWarmCache,
  parseBehindCount,
  parseWarmHead,
  runWarm,
} from "./warm.mjs";

const HEAD = "a".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function evaluate(overrides = {}) {
  return evaluateWarmCache({
    warmDirExists: true,
    warmHeadResult: ok(`${HEAD}\n`),
    fetchResult: ok(),
    revListResult: ok("0\n"),
    threshold: DEFAULT_THRESHOLD,
    ...overrides,
  });
}

describe("warm cache staleness gate", () => {
  test("a successful count below the threshold is fresh and exits 1 under --gate", () => {
    expect(evaluate({ revListResult: ok("14\n") })).toEqual({
      warmHead: HEAD,
      behind: 14,
      stale: false,
      gateExitCode: 1,
    });
  });

  test("a successful count at the threshold is stale and exits 0 under --gate", () => {
    expect(evaluate({ revListResult: ok("15\n") })).toEqual({
      warmHead: HEAD,
      behind: 15,
      stale: true,
      gateExitCode: 0,
    });
  });

  test.each([
    [
      "non-zero rev-list status",
      { status: 128, stdout: "", stderr: "fatal: bad revision" },
    ],
    ["empty rev-list output", ok("  \n")],
    ["unparseable rev-list output", ok("not-a-number\n")],
    [
      "rev-list error output",
      { status: 0, stdout: "2\n", stderr: "warning: unverified" },
    ],
  ])("%s fails closed and exits 0 under --gate", (_name, revListResult) => {
    const result = evaluate({ revListResult });
    expect(result.behind).toBe(Infinity);
    expect(result.stale).toBe(true);
    expect(result.gateExitCode).toBe(0);
  });

  test("a failed fetch makes the behind count unknown", () => {
    expect(parseBehindCount({ status: 1 }, ok("0\n"))).toBe(Infinity);
  });

  test("an unsafe numeric count fails closed", () => {
    expect(parseBehindCount(ok(), ok("999999999999999999999\n"))).toBe(
      Infinity,
    );
  });
});

describe("warm CLI behavior", () => {
  const cfg = {
    repos: [
      {
        name: "example",
        path: "/repo",
        worktree_root: "/warm-root",
        base: "develop",
        worktree_warm: "/warm.sh",
      },
    ],
  };

  function run({
    args = ["--gate"],
    warmDirExists = true,
    head = ok(`${HEAD}\n`),
    fetch = ok(),
    revList = ok("0\n"),
  } = {}) {
    const output = [];
    const shell = (command) => {
      if (command === "git rev-parse HEAD") return head;
      if (command === "git fetch --quiet") return fetch;
      if (command.startsWith("git rev-list --count")) return revList;
      if (command.startsWith("git log -1")) return ok("one minute ago\n");
      throw new Error(`unexpected command: ${command}`);
    };
    const exitCode = runWarm({
      argv: ["--repo", "example", ...args],
      cfg,
      exists: () => warmDirExists,
      shell,
      log: (line) => output.push(line),
      error: (line) => output.push(line),
    });
    return { exitCode, output: output.join("\n") };
  }

  test("--gate exits 1 and reports fresh when a valid count is below the threshold", () => {
    const result = run({ revList: ok("14\n") });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("14 commits behind — fresh enough");
  });

  test("--gate exits 0 and requests refresh when a valid count reaches the threshold", () => {
    const result = run({ revList: ok("15\n") });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("15 commits behind — refresh");
  });

  test("--gate reports stale and unknown when rev-list fails", () => {
    const result = run({
      revList: { status: 128, stdout: "", stderr: "fatal: bad revision" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stale — behind-count unknown — refresh");
  });

  test("non-gate output reports n/a and stale when rev-list fails", () => {
    const result = run({
      args: [],
      revList: { status: 128, stdout: "", stderr: "fatal" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("behind: n/a commit(s)");
    expect(result.output).toContain("→ stale:");
  });

  test("a missing warm directory requests refresh under --gate", () => {
    const result = run({ warmDirExists: false });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "no warm cache at /warm-root/.warm — stale",
    );
  });

  test("an invalid warm HEAD is stale with an unknown count", () => {
    const result = run({ head: ok("invalid\n") });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stale — behind-count unknown — refresh");
  });
});

describe("warm cache location and HEAD validation", () => {
  test("a missing warm directory is stale", () => {
    const result = evaluate({
      warmDirExists: false,
      warmHeadResult: null,
      revListResult: null,
    });
    expect(result).toMatchObject({
      warmHead: null,
      behind: Infinity,
      stale: true,
      gateExitCode: 0,
    });
  });

  test.each([
    ["rev-parse failure", { status: 128, stdout: "", stderr: "fatal" }],
    ["empty HEAD", ok("\n")],
    ["malformed HEAD", ok("not-an-object-id\n")],
  ])("an invalid warm HEAD (%s) is stale", (_name, warmHeadResult) => {
    const result = evaluate({ warmHeadResult, revListResult: null });
    expect(result).toMatchObject({
      warmHead: null,
      behind: Infinity,
      stale: true,
      gateExitCode: 0,
    });
  });

  test("SHA-1 and SHA-256 object IDs are accepted", () => {
    expect(parseWarmHead(ok(`${HEAD}\n`))).toBe(HEAD);
    expect(parseWarmHead(ok(`${"b".repeat(64)}\n`))).toBe("b".repeat(64));
  });
});
