# Continuous integration

## Runner topology

Factory CI uses self-hosted runners only. The `shadow` label currently maps to eight runner services (`watt-mind-runner-1` through `watt-mind-runner-8`) on one physical host. The lightweight `smoke-test` runner is on that host too, but it only checks fleet health and host capacity.

Treat runner names as parallel executors, not independent machines. CPU, memory, `/tmp`, and process scheduling are shared across all eight shadow services.

## Verify serialization

Both test jobs acquire `/tmp/factory-verify-host.lock` with `flock` before installing dependencies or running tests. A guardian process holds the descriptor across GitHub Actions steps; the final `always()` step releases it, and runner process cleanup releases it after cancellation or failure.

The lock is intentionally host-local rather than a GitHub Actions `concurrency` group. A concurrency group keeps only one pending job and replaces older pending jobs when more runs arrive. The host lock lets every started workflow wait its turn while ensuring that no two Factory test critical sections execute on the shared host at once. Job timeouts include lock wait, so they include generous multi-PR queue headroom.

Do not add more lock lanes unless the `shadow` label is moved to multiple physical hosts and the lock path is scoped per host.

## Lint

`Verify` runs `bun run lint --max-warnings=605` (WM-607) right after installing
`event-runtime/web` deps and before the prettier check. `eslint.config.mjs` at
repo root covers `**/*.{mjs,js,jsx}` with `@eslint/js` recommended, and
`event-runtime/web/**/*.{ts,tsx}` with `typescript-eslint` recommended plus
`eslint-plugin-react-hooks`. `no-unused-vars` (and its TS equivalent) is a
`warn`, so the `--max-warnings` count is a ratchet: it pins the warning total
at its value when this landed so the count can only shrink, never grow
silently. If a change needs to raise it, do so deliberately in the same PR
that adds the warnings, with a one-line reason. Two rules are downgraded from
the recommended sets' default `error` to `warn` in `eslint.config.mjs` because
each had 30+ pre-existing violations that are one intentional, low-risk
pattern rather than isolated mistakes (see the inline comments there for
specifics): `@typescript-eslint/no-explicit-any` (untyped API/test data) and
a cluster of `eslint-plugin-react-hooks` v7 "React Compiler readiness" rules
(`set-state-in-effect`, `refs`, `purity`, `preserve-manual-memoization`,
`error-boundaries`, `immutability`) that the codebase predates. No other rule
is disabled or downgraded globally to reach green.

## Test split and timeout

CI splits tests into separately rerunnable jobs:

- **Fast unit tests:** `event-runtime/lib`
- **Verify:** every other test, including CLI, daemon, web, demo, orchestration, and process-spawning integration suites

Both invoke Bun with `--timeout 20000 --max-concurrency=4`. The 20-second default allows for scheduling delays on a busy self-hosted machine instead of failing unrelated tests at Bun's 5-second default. Tests that encode genuine liveness bounds continue to declare explicit, narrower timeouts; the CLI default does not replace those assertions.

## Operational validation

After changing the workflow:

1. Require all checks on the PR itself to pass:

   ```bash
   gh pr checks <PR> --watch --fail-fast
   ```

2. After merge, inspect develop runs and confirm five consecutive green runs, including a period when at least three PR workflows were queued concurrently:

   ```bash
   gh run list --workflow CI --branch develop --limit 5
   gh run list --workflow CI --event pull_request --limit 20
   ```

3. For each relevant run, inspect step timestamps with `gh run view <RUN_ID>` and confirm the interval from `Acquire host verify lock` completing through `Release host verify lock` does not overlap that interval in either test job from another Factory workflow run.

A failed or cancelled test job breaks the streak. Record the five develop run URLs in the validating ticket or merge handoff.
