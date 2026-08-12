# Event runtime (watched MVP)

Implementation of [docs/event-runtime.md](../docs/event-runtime.md) — an
isolated, opt-in sidecar that turns authenticated events into bounded,
verified, one-off agent runs. Slice 1: a read-only Linear status report.

**Isolation guarantees (§3):** nothing here touches `shared/`, `build/emit.mjs`,
`orchestrator/`, or any timer. Durable state lives in
`~/.factory/event-runtime/` (override with `FACTORY_EVENT_HOME`). Stopping the
runtime — or deleting its home directory — has no effect on skill invocation,
emit checks, queue scans, or ticket dispatch.

## Run it

```bash
bun event-runtime/cli.mjs serve          # control API (loopback) + planner + one worker, foreground
```

Operator verbs (clients of the control API — they need `serve` running):

```bash
bun event-runtime/cli.mjs status                      # events, proposals, runs, anomalies
bun event-runtime/cli.mjs proposals                   # open proposals with TTL age
bun event-runtime/cli.mjs approve <proposal-id>
bun event-runtime/cli.mjs reject <proposal-id> "<reason>"
bun event-runtime/cli.mjs inject <envelope.json>      # replay CLI — same intake as the webhook
bun event-runtime/cli.mjs cancel <run-id>
bun event-runtime/cli.mjs retry <run-id> [--force]
bun event-runtime/cli.mjs inspect <run-id>            # spec, lifecycle journal, result, receipt
bun event-runtime/cli.mjs update-pins                 # re-pin agent definition content hashes
```

Webhook intake: `POST /events` with HMAC (`x-factory-signature: sha256=<hex>`
over `${x-factory-timestamp}.${raw body}`, secret from `FACTORY_EVENT_SECRET`).
No secret configured → webhooks are refused; the replay CLI still works.

## Web control plane

A second client of the same control API
([docs/event-runtime-webui.md](../docs/event-runtime-webui.md)) — Linear-style
UI over proposals, runs, and the doctor view. Loopback only, no auth by
decision; `serve` must be running.

```bash
cd event-runtime/web && bun install && bun run build   # once, and after UI changes
bun event-runtime/web/serve.mjs                        # http://127.0.0.1:7382 (FACTORY_EVENT_WEB_PORT)
```

Dev loop: `cd event-runtime/web && bunx vite` (proxies /api to the control
API). Keyboard-first: `⌘K` palette, `g o/p/r` to navigate, `j/k` + `Enter` on
lists, `a`/`x` to approve/reject the selected proposal.

## Try the slice

```bash
cat > /tmp/status-report.json <<'EOF'
{
  "schemaVersion": "factory.event/v1",
  "eventId": "manual-001",
  "type": "factory.status-report.requested",
  "source": "replay-cli",
  "subject": "factory",
  "occurredAt": "2026-08-12T10:30:00Z",
  "correlationId": "manual-001",
  "payload": { "repos": ["bj29"] }
}
EOF
bun event-runtime/cli.mjs inject /tmp/status-report.json
bun event-runtime/cli.mjs proposals        # → approve <id>
```

Injecting the same envelope twice is safe: one admission, one proposal, one run
(§5.4). Approval after the proposal TTL re-plans instead of executing a stale
spec (§12).

## Layout

| Path | What |
| :--- | :--- |
| `lib/config.mjs` | paths, port, secrets, policy version |
| `lib/canonical.mjs` `lib/schema.mjs` | canonical JSON + hashes; fail-closed schema validation |
| `lib/db.mjs` | SQLite substrate (§10): events, proposals, runs, attempts, journal, results, outbox |
| `lib/lifecycle.mjs` | closed FSM (§8); every transition journaled |
| `lib/registry.mjs` | agent definitions pinned by content hash (§6) |
| `lib/intake.mjs` | HMAC verification + idempotent admission (§5.1, §14) |
| `lib/planner.mjs` | deterministic plan(event) → NOOP \| HUMAN_NEEDED \| RunSpec (§4, §5.4) |
| `lib/proposals.mjs` | watched approval, TTL, re-plan on expiry (§12) |
| `lib/workspace.mjs` | ephemeral workspaces, path confinement (§7) |
| `lib/worker.mjs` | single worker: lease, execute, verify, publish with fencing (§8) |
| `lib/verify.mjs` | result verification + compact receipts (§9) |
| `lib/adapters/` | adapter registry: `claude` (real), `fake` (tests) (§6) |
| `lib/api.mjs` `cli.mjs` | loopback control API + CLI client (§12–§13) |
| `web/` | web control plane: Vite/React app + `serve.mjs` static/proxy server |
| `agents/` `schemas/` `event-types.json` | registered agents, contracts, event→agent mappings |

## Capabilities are audited, not enforced (§14)

`linear:read` is a validated, recorded declaration — the MVP has no sandbox and
no scoped credentials. Enforcement arrives with the egress proxy / container
provider. Until then the watched approval gate and read-only agent prompts are
the actual containment.
