# Event runtime web control plane

Status: **specified; not implemented**. Tracking: OPS-209 (this spec).
Implementation is a separate ticket, filed after this document is reviewed.

Parent: [event-runtime.md](event-runtime.md). §12 already decided the shape of
this app: the TUI/CLI is one client of the control API, and a web app is a
**second client of identical endpoints** — never a reader of the database.
This document specifies that second client: stack, decisions, view-to-endpoint
mapping, and exit criteria. Nothing here changes the runtime's contracts.

---

## 1. Decisions

Made by the operator, recorded here so nobody relitigates them mid-build:

- **Stack: Vite + React + Tailwind + shadcn/ui + cmdk.** The target aesthetic
  is Linear's: dense dark lists, a side detail panel, keyboard-first
  navigation, a ⌘K command palette. shadcn/ui (Radix + Tailwind) and `cmdk`
  are the shortest honest path to that look; TanStack Query handles fetching
  and polling.
- **No authentication.** This narrows §14's "the web-app step requires real
  auth" to its actual precondition: auth is required *when approval and cancel
  become network-reachable*. They do not. The web server binds `127.0.0.1`
  only, exactly like the control API (`API_HOST` in `lib/config.mjs`), so the
  trust surface is unchanged: local user access. The actor recorded on verbs
  stays `"operator"`, same as the CLI. If this surface is ever bound beyond
  loopback — Tailscale, LAN, anything — that is the moment §14's auth
  requirement applies, as a precondition of that change, not a retrofit after
  it.
- **TypeScript, confined to `event-runtime/web/`.** The repo's plain-`.mjs`
  convention continues to govern all runtime code. The web app is leaf UI code
  with its own toolchain, never imported by the runtime; shadcn/ui generates
  TSX, and fighting that in plain JS costs more than the exception.
- **Polling, not push.** The control API has no event stream and one worker.
  TanStack Query polling every 2 s on focused views is honest and sufficient
  at this scale. An SSE endpoint is a deferred follow-up, not a dependency.

## 2. Non-goals

- No authentication, sessions, or multi-operator identity (see above).
- No new mutation surface: the UI exposes exactly the verbs the API has —
  approve, reject, cancel, retry, replay. Nothing else.
- No database access, no imports from `event-runtime/lib/`.
- No SSE/WebSocket work in the first version.
- No transcript/artifact *content* viewer. `GET /runs/:id` returns the
  retained workspace *path*; a browser cannot read local paths, and an
  artifact-fetch endpoint is new API surface. Deferred (§8) — the UI shows
  the path and hashes, and `cli.mjs inspect` remains the deep-inspection tool.
- No involvement in the emit pipeline, `shared/`, or the orchestrator (§3 of
  the parent doc applies unchanged).

---

## 3. Architecture

```text
browser (localhost)
   │
   ▼
web server — Bun, 127.0.0.1:7382 (FACTORY_EVENT_WEB_PORT)
   ├── serves static bundle from event-runtime/web/dist/
   └── proxies /api/* → control API 127.0.0.1:7381
                              │
                              ▼
                    existing lib/api.mjs — unchanged trust model
```

- `event-runtime/web/serve.mjs` — ~30 lines of `Bun.serve`: static files plus
  an `/api/*` proxy that strips the prefix and forwards to
  `127.0.0.1:${FACTORY_EVENT_PORT}`. A separate process, started explicitly
  (`bun event-runtime/web/serve.mjs`); stopping it affects nothing else.
  The proxy exists so the browser has one origin — it adds no headers, no
  rewriting, no logic.
- `event-runtime/web/src/` — the Vite + React app.
- `event-runtime/web/dist/` — build output, gitignored. `bunx vite build`
  produces it; `serve.mjs` refuses to start without it (with a message naming
  the build command) rather than serving a stale or empty directory.
- Dev loop needs no `serve.mjs`: `bunx vite` with a dev-server proxy entry for
  `/api` pointing at 7381.

The runtime remains startable, stoppable, and fully operable without the web
app. The CLI loses nothing.

## 4. Views

Four views, all thin projections of existing endpoints. Layout is Linear's
three-zone shape: a narrow left nav rail, a dense list, and a right-side
detail panel (shadcn `Sheet`) that opens without leaving the list.

### 4.1 Overview — `GET /status`, `GET /health`

The landing view. Stat tiles for event counts by status (`admitted`,
`planned`, `noop`, `human_needed`, `dead_lettered`), open/expired proposal
counts, and runs by FSM state. Below them, the **doctor panel** — the §13
anomalies rendered as a list, empty state included: expired open proposals,
stale leases, unpublished outbox rows, and dead-lettered events with their
`lastError`. A dead-letter row offers **replay** (`POST /replay` with the
stored envelope — which requires the UI to have the envelope body; see §7).

`GET /health` drives a connection indicator in the nav rail: green with the
reported `policyVersion`, red "runtime unreachable" when polling fails. Every
view keeps working read-only from cache when the runtime is down; verbs
disable.

### 4.2 Proposals — `GET /proposals`

The centerpiece (§12: watched approval). A dense table of open proposals:
agent, decision, TTL as a **live countdown** (computed from `created_at` +
`ttl_seconds`), and an `expired` badge once past TTL. Row click opens the
detail panel showing **the full immutable `RunSpec`, rendered raw** — agent
and version, input, `inputHash`, capabilities, timeout, attempts,
`idempotencyKey`, workspace type — plus the planner's reason. §12 is explicit
that the operator approves a specific spec, not a summary of one; the spec
JSON is therefore always visible, not behind a disclosure.

Verbs:

- **Approve** — `POST /proposals/:id/approve`. On `{approved: true, runId}`,
  navigate to the run. On `{approved: false, replanned: true, proposal}` — the
  TTL-expiry re-plan path — the UI must **stop and present the new proposal**,
  visually diffed against the one the operator just approved. It never
  auto-approves the replacement; that would silently execute intent the
  operator did not read, the exact thing §12's TTL exists to prevent.
- **Reject** — `POST /proposals/:id/reject` with `{reason}`. The UI requires
  a non-empty reason even though the API tolerates its absence: rejections
  are audit records, and "(no reason)" is a useless one.

Both verbs surface `404` (unknown proposal) and `409` (already decided) as
inline errors and refetch — a second browser tab or the CLI may have acted
first.

### 4.3 Runs — `GET /runs`, `GET /runs/:id`

List with FSM state filter tabs (the `?state=` parameter): run ID, state
badge, agent, attempts, created/updated. State badges use one fixed color
map for the closed §8 lifecycle — proposal-to-terminal — so a state is
recognizable at a glance across every view.

The detail panel shows the five blocks `GET /runs/:id` returns:

- **run** — state, attempts, `idempotencyKey`, `specHash`, and the full spec
  (same raw rendering as proposals);
- **lifecycle** — the journal as a vertical timeline: state → state, actor,
  reason code, attempt, timestamp. This is the audit trail; it is the point
  of the page;
- **attempts** — per-attempt rows with lease expiry and workspace path;
- **result** — terminal state, reason code, the artifact JSON, and declared
  evidence when present;
- **receipt** — the compact §9 receipt: hashes and verification status.

Verbs: **cancel** (`POST /runs/:id/cancel`, confirm dialog, optional reason)
and **retry** (`POST /runs/:id/retry`). Retry past `maxAttempts` requires the
`{force: true}` body; the UI exposes force-retry only behind an explicit
confirmation that states it overrides the attempt budget and is recorded.
`409` (`IllegalTransition`, `attempts_exhausted`) renders as an inline
explanation, not a toast that evaporates.

### 4.4 Inject — `POST /replay`

Dev parity with `cli.mjs inject`: a dialog with a JSON textarea for an event
envelope, client-side-validated against the envelope shape before submitting.
The response distinguishes `admitted` from `duplicate` — a duplicate is a
success ("§5.1 working as designed"), displayed as such, not an error.

## 5. Keyboard and command surface

Linear's feel is keyboard-first; this is a requirement, not garnish.

- `⌘K` — cmdk palette: navigate to any view, jump to a run/proposal by ID,
  and invoke the verbs valid for the current selection.
- `j`/`k` or arrows — move list selection; `Enter`/`o` — open detail panel;
  `Esc` — close it.
- On a selected proposal: `a` approve (opens the confirm with the spec in
  view), `x` reject (focuses the reason field).
- `g o` / `g p` / `g r` — go to Overview / Proposals / Runs.
- Every verb the palette offers checks current state first — it never shows
  "approve" on a decided proposal or "cancel" on a terminal run.

### 5.1 Design language

Grounded in what Linear published about its own 2024 redesign
([how-we-redesigned-the-linear-ui](https://linear.app/now/how-we-redesigned-the-linear-ui),
[a-design-reset](https://linear.app/now/a-design-reset)) — adopted here as
constraints, not vibes:

- **Three theme tokens, OKLCH, derived shades.** Linear replaced ~98
  hand-picked variables per theme with three — base, accent, contrast — and
  generates every surface, border, and text shade from them in a perceptually
  uniform color space. We do the same: three `oklch()` tokens as CSS
  variables (Tailwind v4 is OKLCH-native), with light, dark, and a
  high-contrast variant *computed*, never hand-tuned per theme. Dark is the
  default; the others come for free by construction, which is the whole
  point.
- **Neutral chrome, meaningful color.** Keep chroma out of the chrome: nav
  rail, headers, borders, and row hover states are near-zero-chroma grays
  derived from the base token. Hue appears only where it carries meaning —
  the FSM state badges, the connection dot, and destructive confirmations.
  If a screenshot in grayscale loses information, color was doing structure's
  job.
- **Typography: Inter, Inter Display.** Inter at 13–14 px for body and table
  text, tight row height; Inter Display for the few headings and stat-tile
  numerals. Nothing else.
- **The inverted-L is the whole chrome.** Nav rail plus view header form an
  inverted L around the content, and Linear's redesign spent most of its
  effort on pixel-level alignment inside it — icons, labels, and counts on
  one consistent grid. Every one of our four views uses the identical
  skeleton (header → dense list → right detail panel), so hierarchy and
  density never reset between views.
- **Stress-test before ship.** Linear validated against three axes —
  environment, appearance, hierarchy — rather than a formal method. The
  implementation ticket's hallmark critique pass adopts the same axes:
  window sizes and platforms; all three generated themes; and whether run
  state reads at a glance from two meters. The reset post's one transferable
  lesson is that piecemeal polish reads as disjointed because user journeys
  are unpredictable — hence tokens and the shared view skeleton are defined
  once, first, and everything renders through them.

The target is "quiet tool you live in", not "dashboard demo".

## 6. Liveness and concurrency honesty

- TanStack Query, `refetchInterval` 2 s on the focused view, paused on hidden
  tabs, single retry with backoff when the runtime is unreachable.
- Verbs invalidate affected queries on success rather than waiting for the
  next poll.
- The UI never assumes it is the only operator. The CLI, a webhook, or
  another tab can change state between poll and click; every verb therefore
  treats `404`/`409` as normal outcomes with a refetch, never as bugs. No
  optimistic updates for lifecycle transitions — a control plane that shows
  states the runtime has not confirmed is lying about the one thing it is
  for. 2 s of latency is fine; wrong state is not.

## 7. Control API additions

The web UI is a client, so anything it needs that the API lacks becomes API
surface first, UI second — implemented in `lib/api.mjs` with the same
read-only SQL discipline as `statusView`. Exactly one addition is needed:

- **`GET /events`** — list admitted events: `(source, eventId)`, type,
  subject, status, `occurredAt`/`receivedAt`, `correlationId`, plan error if
  any, **and the stored envelope body**. Optional `?status=` filter. Without
  it the UI sees only `/status` counts, dead letters lack their envelope (so
  the doctor panel's replay verb cannot work), and an "inbox" view is
  impossible. Read-only, loopback-only, and useful to the CLI as well.

Everything else the four views need already exists. Explicitly *not* added
now: pagination (volumes are tiny; first endpoint to hurt gets it), SSE, and
artifact-content endpoints (§8).

## 8. Deferred, with triggers

| Deferred item | Trigger |
| :--- | :--- |
| Authentication + real actor identity | Binding the web server or control API beyond loopback — precondition, not retrofit (§1, parent §14) |
| SSE / push updates | Polling demonstrably too slow — e.g. watching slice-2 remediation runs live |
| Artifact/transcript content endpoint + viewer | First time "open the transcript" matters from the browser; until then `cli.mjs inspect` |
| Pagination on `/runs`, `/events` | First list where scrolling actually hurts |
| Notification channel | Unattended stage (parent §12) — watched mode means the operator is watching |

## 9. Exit criteria

- Every §13 operator verb is available: status, proposals, approve, reject,
  cancel, retry, inspect-level detail (spec, lifecycle, result, receipt),
  replay/inject — each observably equivalent to its CLI counterpart, and each
  recorded by the runtime identically (actor `"operator"`).
- Approving an expired proposal surfaces the re-planned spec with a diff and
  requires a second explicit approval; it is impossible to approve a spec the
  UI has not displayed.
- Duplicate injection shows one admission (`duplicate: true`), one proposal,
  one run — the UI demonstrates §5.4 rather than obscuring it.
- Web server and app bind loopback only; stopping them affects nothing;
  `serve.mjs` imports nothing from `lib/`.
- A `409` from any verb (raced by the CLI) produces a correct, explained UI
  state, verified by acting from the CLI while the UI is open.
- Existing factory tests, emit checks, and `event-runtime` tests remain
  untouched and green; `GET /events` arrives with tests matching the other
  read endpoints' coverage in `cli.test.mjs`.
