# Continuous integration

## Runner topology

Factory CI uses self-hosted runners only. The `shadow` label currently maps to eight runner services (`watt-mind-runner-1` through `watt-mind-runner-8`) on one physical host. The lightweight `smoke-test` runner is on that host too, but it only checks fleet health and host capacity.

Treat runner names as parallel executors, not independent machines. CPU, memory, `/tmp`, and process scheduling are shared across all eight shadow services.

## Verify serialization

Both test jobs acquire `/tmp/factory-verify-host.lock` with `flock` before installing dependencies or running tests. A guardian process holds the descriptor across GitHub Actions steps. The guardian records the job's `Runner.Worker` PID, executable, and process start time and checks that identity every five seconds, both while queued and after acquisition. If the worker disappears (including a crash that prevents `always()` cleanup), the guardian cancels its pending `flock` or exits and releases an acquired lock within about ten seconds. The final `always()` step still terminates the guardian on normal completion.

Before blocking, each acquisition checks the current holder with `lslocks` and `lsof`. It kills only a recognized legacy `tail -f /dev/null` or current Factory guardian that has been adopted by PID 1 and has no live recorded `Runner.Worker`, logging the stale PID and command. The `shadow-runner-health` job independently fails when such an orphan has held the lock for more than ten minutes, so a broken liveness rule becomes an explicit check rather than a host-wide silent queue.

The lock is intentionally host-local rather than a GitHub Actions `concurrency` group. A concurrency group keeps only one pending job and replaces older pending jobs when more runs arrive. The host lock lets every started workflow wait its turn while ensuring that no two Factory test critical sections execute on the shared host at once. Job timeouts include lock wait, so they include generous multi-PR queue headroom.

Do not add more lock lanes unless the `shadow` label is moved to multiple physical hosts and the lock path is scoped per host.

## Lint

`Verify` runs `bun run lint --max-warnings=608` (WM-607) right after installing
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

## Security scans

`.github/workflows/security.yml` runs on `pull_request`, `push` to `develop`/`main`, and `workflow_dispatch`, on `[self-hosted, shadow]` with the same no-`uses:` git-fetch checkout pattern as `ci.yml` (WM-573). Four jobs:

- **Gitleaks** — `gitleaks git --no-banner --redact` over the PR's base..head range (or the last commit on a branch push). Honours a repo-root `.gitleaks.toml` if one is added. Binary resolves from PATH, then `~/.local/bin/gitleaks`, then a GitHub Releases download (not a marketplace action) on first use per runner host.
- **Semgrep** — `uvx semgrep scan --config p/security-audit --error --metrics=off .`, scoped by `.semgrepignore` (generated output, vendor trees, fixtures, lockfiles). `uv`/`uvx` installs from astral.sh if missing on the host.
- **Actionlint** — `actionlint -color .github/workflows/*.yml`. `.github/actionlint.yaml` declares the repo's custom self-hosted runner labels (`shadow`, `smoke-test`) so they don't flag as unknown; real shellcheck findings on `run:` blocks get fixed or suppressed inline with a reason, never blanket-disabled.
- **CodeQL** — gated behind `if: ${{ vars.CODEQL_ENABLED == 'true' }}` and currently a placeholder: this repo is private with no GitHub Advanced Security (`code-scanning/default-setup` returns 403). Flip the `CODEQL_ENABLED` repository variable and replace the placeholder step with `github/codeql-action` init/analyze once GHAS is available (project-conventions.md §3D).

Run the same tools locally before pushing with `factory security` (Gitleaks + Semgrep + Actionlint, plus Ruff/pip-audit when a repo has adopted the Python tier) — see `lib/security-check.sh`. Local and CI use identical tool invocations and config files (`.gitleaks.toml`, `.semgrepignore`) so a clean local run predicts a clean CI run.

## Browser E2E

The Playwright smoke suite exercises the event-runtime web UI against an
isolated fake-adapter runtime seeded by `event-runtime/demo/seed.mjs`. It covers
Overview, Inbox acknowledgement, proposal approval inspection, Runs detail, and
the capability Graph.

Run it locally from the web package (Google Chrome must be installed):

```bash
cd event-runtime/web
bun run test:e2e
```

The helper owns and removes a temporary `FACTORY_EVENT_HOME`. It picks two
free ports per run (so concurrent worktrees never collide or seed each other's
runtime); set `E2E_API_PORT` and `E2E_WEB_PORT` to pin them. It fails fast if
the API, worker, or Vite process dies during startup rather than seeding
whatever else is listening on the port. Set `PLAYWRIGHT_CHANNEL=chromium` to
use Playwright's downloaded Chromium instead of system Chrome. The pinned
`@playwright/test` version lives in `e2e/playwright-version.mjs`, read by both
`test:e2e` and the workflow.

`.github/workflows/e2e.yml` is deliberately opt-in while the suite proves
stable. It runs for a pull request only when that PR has the `run-e2e` label,
and it can always be started manually with `workflow_dispatch`. The workflow
uses the shared verify lock to serialize against every other test job on the
self-hosted runner, installs Playwright's Chromium build (cached in the
runner's `~/.cache/ms-playwright`, keyed on the pinned version), and runs the
same `bun run test:e2e` command.
