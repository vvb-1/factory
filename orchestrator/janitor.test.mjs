/**
 * bun test orchestrator/janitor.test.mjs
 *
 * WM-17. On legalease, PR #261 was auto-closed by GitHub when a merge run
 * deleted `feat/CLNT-520` during PR #253's post-merge cleanup: a second agent
 * was still shipping from that branch, and its work survived only as a dangling
 * commit. The branch looked disposable to every guard the janitor had, because
 * the work was committed AND pushed — the uncommitted/unpushed refusal in
 * worktree-down.sh cannot see an open PR.
 *
 * These pin the opposite of WM-16. WM-16 is cleanup that gets skipped (stale
 * worktrees accumulate); this is cleanup that runs too eagerly (it removes what
 * someone is still using). A fix for either that ignores the other swings the
 * failure back the other way, so the holds below are deliberate keeps, not
 * misses: they release themselves as soon as the holding PR closes.
 */
import { test, expect, describe } from "bun:test";
import { parseWorktreeBranches, openPrHold, listOpenPrs, ticketBranches, reclaim } from "./janitor.mjs";

/** A spawnSync stand-in that records every call and never touches the disk. */
function recorder(handler = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  run.calls = calls;
  return run;
}

describe("parseWorktreeBranches", () => {
  test("maps each worktree path to its checked-out branch", () => {
    const porcelain = [
      "worktree /Users/x/Develop/legalease",
      "HEAD aaaa",
      "branch refs/heads/develop",
      "",
      "worktree /Users/x/Develop/.worktrees/legalease/CLNT-520",
      "HEAD bbbb",
      "branch refs/heads/feat/CLNT-520",
      "",
    ].join("\n");
    expect(parseWorktreeBranches(porcelain)).toEqual({
      "/Users/x/Develop/legalease": "develop",
      "/Users/x/Develop/.worktrees/legalease/CLNT-520": "feat/CLNT-520",
    });
  });

  test("a detached worktree has no branch and simply does not appear", () => {
    const porcelain = ["worktree /Users/x/wt/CLNT-1", "HEAD cccc", "detached", ""].join("\n");
    expect(parseWorktreeBranches(porcelain)).toEqual({});
  });

  test("empty or garbage input yields no branches rather than throwing", () => {
    expect(parseWorktreeBranches("")).toEqual({});
    expect(parseWorktreeBranches(null)).toEqual({});
  });
});

describe("openPrHold", () => {
  const openPrs = [
    { number: 261, headRefName: "feat/CLNT-520" },
    { number: 262, headRefName: "fix/CLNT-777-other" },
  ];

  test("a branch that is still an open PR's head is held, naming the PR", () => {
    const hold = openPrHold("feat/CLNT-520", openPrs);
    expect(hold).toContain("#261");
    expect(hold).toContain("feat/CLNT-520");
  });

  test("a branch no open PR points at is free", () => {
    expect(openPrHold("feat/CLNT-999", openPrs)).toBeNull();
  });

  test("a merged PR's branch is free — `gh pr list --state open` no longer lists it", () => {
    // PR #253 (merged) had head feat/CLNT-520 too; what holds the branch is
    // #261 still being open, not #253 having existed.
    expect(openPrHold("feat/CLNT-520", [])).toBeNull();
  });

  test("several open PRs on one branch are all named", () => {
    const hold = openPrHold("feat/CLNT-520", [...openPrs, { number: 264, headRefName: "feat/CLNT-520" }]);
    expect(hold).toContain("#261");
    expect(hold).toContain("#264");
  });

  test("an unknown branch (detached worktree) is not a hold", () => {
    expect(openPrHold(undefined, openPrs)).toBeNull();
  });
});

describe("listOpenPrs", () => {
  test("returns the parsed PR list", () => {
    const run = recorder(() => ({ status: 0, stdout: JSON.stringify([{ number: 261, headRefName: "feat/CLNT-520" }]) }));
    expect(listOpenPrs("/repo", run)).toEqual([{ number: 261, headRefName: "feat/CLNT-520" }]);
    expect(run.calls[0].args).toContain("--state");
    expect(run.calls[0].args).toContain("open");
  });

  test("a failed or unparseable `gh` is null, not an empty list", () => {
    // The distinction is the whole point: empty means "no open PR", null means
    // "could not tell", and only the first one licenses a teardown.
    expect(listOpenPrs("/repo", recorder(() => ({ status: 1, stderr: "gh: not authenticated" })))).toBeNull();
    expect(listOpenPrs("/repo", recorder(() => ({ status: 0, stdout: "not json" })))).toBeNull();
  });
});

describe("ticketBranches", () => {
  test("keys the branch by ticket for worktrees under the root", () => {
    const porcelain = [
      "worktree /wt/legalease/CLNT-520",
      "branch refs/heads/feat/CLNT-520",
      "",
      "worktree /wt/legalease/CLNT-600",
      "branch refs/heads/fix/CLNT-600-thing",
      "",
    ].join("\n");
    const run = recorder(() => ({ status: 0, stdout: porcelain }));
    expect(ticketBranches("/repo", "/wt/legalease", ["CLNT-520", "CLNT-600", "CLNT-700"], run)).toEqual({
      "CLNT-520": "feat/CLNT-520",
      "CLNT-600": "fix/CLNT-600-thing",
    });
  });
});

describe("reclaim (WM-17 regression: branch A merged while a second PR still heads it)", () => {
  const scenario = {
    repoPath: "/Users/x/Develop/legalease",
    down: "bin/worktree-down.sh",
    branches: { "CLNT-520": "feat/CLNT-520", "CLNT-600": "fix/CLNT-600-thing" },
    // PR #253 merged (gone from the open list); PR #261 is another agent's,
    // still open, still pointing at the very branch cleanup is about to remove.
    openPrs: [{ number: 261, headRefName: "feat/CLNT-520" }],
  };

  test("the held worktree is never handed to worktree-down.sh", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520"], { ...scenario, run });
    expect(out.removed).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(out.held.map((h) => h.id)).toEqual(["CLNT-520"]);
    expect(out.held[0].reason).toContain("#261");
  });

  test("the hold is per branch — an unrelated finished ticket is still reclaimed", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520", "CLNT-600"], { ...scenario, run });
    expect(out.removed).toEqual(["CLNT-600"]);
    expect(out.held.map((h) => h.id)).toEqual(["CLNT-520"]);
    expect(run.calls.map((call) => call.args[1])).toEqual(["CLNT-600"]);
  });

  test("once PR #261 closes, the same worktree is reclaimed", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520"], { ...scenario, openPrs: [], run });
    expect(out.removed).toEqual(["CLNT-520"]);
    expect(out.held).toEqual([]);
  });

  test("worktree-down.sh's own refusal (unpushed work) is still reported, not overridden", () => {
    const run = recorder(() => ({ status: 1, stderr: "CLNT-600 has uncommitted changes — commit/stash them\n" }));
    const out = reclaim(["CLNT-600"], { ...scenario, run });
    expect(out.removed).toEqual([]);
    expect(out.refused).toEqual([{ id: "CLNT-600", reason: "CLNT-600 has uncommitted changes — commit/stash them" }]);
  });

  test("teardown is never invoked with --force", () => {
    const run = recorder();
    reclaim(["CLNT-600"], { ...scenario, run });
    expect(run.calls[0].args).not.toContain("--force");
  });
});
