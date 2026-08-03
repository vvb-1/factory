/**
 * node --test orchestrator/owned-paths.test.mjs
 *
 * Collision detection is the one piece of the dispatcher that causes silent
 * data loss when wrong — two agents editing one file — so it gets real tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOwnedPaths, globsOverlap, pathsCollide, nextDispatchable } from "./owned-paths.mjs";

test("parses the Owned Paths section of a real ticket", () => {
  const desc = `## Problem & Context

Something is broken.

## Owned Paths

- \`app/services/api.ts\`
- \`app/services/__tests__/*\`

## Verification Command

    npm test`;
  assert.deepEqual(parseOwnedPaths(desc), ["app/services/api.ts", "app/services/__tests__/*"]);
});

test("missing section yields no paths (caller treats as not-dispatchable)", () => {
  assert.deepEqual(parseOwnedPaths("## Problem\n\nno paths here"), []);
});

test("identical and nested globs overlap", () => {
  assert.ok(globsOverlap("app/api.ts", "app/api.ts"));
  assert.ok(globsOverlap("app/**", "app/services/api.ts"));
  assert.ok(globsOverlap("bin/worktree-*.sh", "bin/worktree-up.sh"));
  assert.ok(globsOverlap("AGENTS.md", "AGENTS.md"));
});

test("disjoint directories do not overlap", () => {
  assert.ok(!globsOverlap("app/services/**", "docs/**"));
  assert.ok(!globsOverlap("bin/worktree-*.sh", "AGENTS.md"));
  assert.ok(!globsOverlap(".github/workflows/*", "app/src/main.ts"));
});

test("the case keyword matching gets wrong", () => {
  // Same vocabulary, unrelated files: must NOT collide.
  assert.ok(!pathsCollide(["app/ui/LoginButton.tsx"], ["server/auth/middleware.ts"]));
  // Different vocabulary, same files: MUST collide.
  assert.ok(pathsCollide(["app/pages/onboarding/**"], ["app/pages/onboarding/step2.tsx"]));
});

test("CW-363 and CLNT-609 are concurrent-safe (different repos, same globs)", () => {
  // Both own bin/worktree-*.sh and AGENTS.md, but in different repos. The
  // dispatcher scopes collision checks per repo; within one repo they'd block.
  const a = ["bin/worktree-*.sh", "AGENTS.md"];
  const b = ["bin/worktree-*.sh", "AGENTS.md"];
  assert.ok(pathsCollide(a, b), "same repo: must serialize");
});

test("nextDispatchable skips collisions and tickets without Owned Paths", () => {
  const inFlight = [{ id: "A", ownedPaths: ["app/services/**"] }];
  const candidates = [
    { id: "B", ownedPaths: ["app/services/api.ts"] }, // collides
    { id: "C", ownedPaths: [] },                       // not agent-ready
    { id: "D", ownedPaths: ["docs/**"] },              // free
  ];
  assert.equal(nextDispatchable(candidates, inFlight)?.id, "D");
});

test("nothing dispatchable returns undefined rather than throwing", () => {
  assert.equal(nextDispatchable([], []), undefined);
});
