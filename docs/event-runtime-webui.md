# Event runtime web control plane

Status: **implemented** (OPS-212) at `event-runtime/web/`. Tracking: OPS-209
(this spec), OPS-212 (implementation).

Parent: [event-runtime.md](event-runtime.md) | Roadmap: [event-runtime-webui-roadmap.md](event-runtime-webui-roadmap.md). §12 already decided the shape of
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
  auth" to its actual precondition: auth is required _when approval and cancel
  become network-reachable_. They do not. The web server binds `127.0.0.1`
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
- **Polling, not push.** The control API has no event stream, and the worker
  fleet (OPS-233 onward — several processes may register at once) reports
  itself by heartbeat rather than by push: a worker's `lastSeen` is never
  fresher than its last beat, so the UI is polling something that is already
  polled. TanStack Query polling every 2 s on focused views is honest and
  sufficient at this scale. An SSE endpoint is a deferred follow-up, not a
  dependency.

## 2. Non-goals

- No authentication, sessions, or multi-operator identity (see above).
- No new mutation surface except the loopback janitor verb
  (`POST /repos/:name/janitor`, OPS-301): Dry and Apply, 127.0.0.1, actor
  `operator`, same trust as typing `factory janitor` on the machine. Apply
  never passes `--force`. The Projects-tab buttons (typed confirm, Dry
  before Apply) are a follow-up (OPS-362); this records the API exception.
  Everything else the UI exposes is still approve, reject, cancel, retry,
  replay.
- No database access, no imports from `event-runtime/lib/`.
- No SSE/WebSocket work in the first version.
- No transcript/artifact _content_ viewer. `GET /runs/:id` returns the
  retained workspace _path_; a browser cannot read local paths, and an
  artifact-fetch endpoint is new API surface. Deferred (§8) — the UI shows
  the path and hashes, and `cli.mjs inspect` remains the deep-inspection tool.
- No involvement in the emit pipeline or `shared/`. The control API may
  spawn `factory janitor` for the Projects verb (OPS-301); the web app still
  does not import the orchestrator.

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
ambiguous open proposals, stale leases, unpublished outbox rows, and dead-lettered
events with their `lastError`. A dead-letter row offers **replay** (`POST /replay`
with the stored envelope — which requires the UI to have the envelope body; see §7).

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
JSON therefore sits in a disclosure that defaults open while the proposal is
undecided, so it is in front of the operator without being asked for. Once the
proposal is decided the panel is an audit record rather than something to act
on, and the disclosure defaults closed.

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
  in a disclosure that defaults open (same raw rendering as proposals);
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

### 4.4 Inject — `POST /replay` (templates: OPS-214)

Dev parity with `cli.mjs inject`: a dialog with a JSON textarea for an event
envelope, client-side-validated against the envelope shape before submitting.

**Templates are derived, never hand-maintained (OPS-214).** One chip per
registered event type; the payload skeleton is built from that event's agent
_input schema_ (required fields only; enums seed their first value, numbers
their minimum, `minItems` arrays one element, patterned strings a
recognisable placeholder). A newly registered event type therefore appears
with no UI change, and a template can never propose a payload the runtime
would reject for shape. Ids and `occurredAt` are generated per dialog
opening; the JSON stays fully editable — the template is a starting point,
not a cage. An unregistered `type` warns once (it is admissible, but parks
as `human_needed`) and injects on the second click. The Events view offers
**Trigger again**, which clones an envelope under a _fresh_ identity —
deliberately distinct from Replay, which reuses the delivery id and dedups
to a no-op.
The response distinguishes `admitted` from `duplicate` — a duplicate is a
success ("§5.1 working as designed"), displayed as such, not an error.

## 5. Keyboard and command surface

Linear's feel is keyboard-first; this is a requirement, not garnish.

- `⌘K` — cmdk palette: navigate to any view, jump to a run/proposal by ID,
  and invoke the verbs valid for the current selection.
- `i` — inject event. `?` — keyboard cheatsheet. `c` — copy the selected id.
- `/` — focus the list filter. Esc in the filter clears it, then blurs.
  From Overview or Graph (no filter), `/` opens Events and focuses there.
- `j`/`k` or arrows — move list (and Graph node) selection; `Enter`/`o` —
  open detail panel; `Esc` — close it, then clear the filter.
- `[` / `]` — previous / next status tab (Events, Proposals, Runs). Changing
  tab closes the detail so a deep-linked row cannot yank the tab back.
- `⌘↵` — confirm inject (from the envelope textarea too).
- On a selected proposal: `a` approve (opens the confirm with the spec in
  view), `x` reject (focuses the reason field).
- `g o` / `g e` / `g p` / `g r` / `g t` / `g w` / `g g` — go to Overview /
  Events / Proposals / Runs / Agents / Workers / Graph.
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
  high-contrast variant _computed_, never hand-tuned per theme. Dark is the
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
read-only SQL discipline as `statusView`. The spec originally required
exactly one addition — `GET /events` — and the shipped surface (§10) grew
with the same rule applied each time. Additions to date, all loopback-only
and shared with the CLI:

- **`GET /events`** (`?status=`) — admitted events **with the stored envelope
  body**, plus the latest `proposalId` / `runId` for that origin (null until
  planned). Without the envelope, dead letters lack their body, the doctor
  panel's replay verb cannot work, and an inbox view is impossible; without
  the ids, an event is a dead end.
- **`GET /agents`** — the registered agent definitions and event routing
  (CLI `agents`; the registry-visibility surface, OPS-213).
- **`GET /journal`** (`?since=&limit=`) — the global lifecycle feed behind
  Overview's activity list.
- **`GET /outbox`** (`?limit=`) — emitted result events, the runtime's
  actual output.
- **`POST /events/requeue`** — re-plan a dead-lettered or `human_needed`
  event (CLI `requeue`); audited like every other verb.
- **`GET /repos`** — `config/repos.yaml` as an allow-listed registry (OPS-299).
- **`POST /repos/:name/janitor`** — loopback spawn of `factory janitor`
  `--json` for that one name (OPS-301). Body `{ apply: false | true }`;
  omitted `apply` is Dry. Apply never `--force`. Unknown name 404; Apply on
  a `report_only` repo without `worktree_down` 409. Actor `"operator"`. The
  UI confirm is OPS-362, not this endpoint.
- **`GET /artifacts/:sha256`** — content-addressed artifact/transcript bytes
  (the §8 deferral, since triggered and shipped).
- **`GET /workers`** — the worker registry the CLI `workers` command prints,
  each row carrying a `stale` flag derived from heartbeat age. The same
  projection widened `/status` with `workers.{live, busy, stale}` (live and
  busy both exclude stale) and the doctor with `stalledWorkers` and
  `noWorkers`.

Still explicitly _not_ added: pagination beyond `journal`/`outbox` limits
(volumes are tiny; first endpoint to hurt gets it) and SSE (§8).

## 8. Deferred, with triggers

| Deferred item                                     | Trigger                                                                                             |
| :------------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| Authentication + real actor identity              | Binding the web server or control API beyond loopback — precondition, not retrofit (§1, parent §14) |
| SSE / push updates                                | Polling demonstrably too slow — e.g. watching slice-2 remediation runs live                         |
| ~~Artifact/transcript content endpoint + viewer~~ | **Shipped** — content-addressed artifact store + `GET /artifacts/:sha256` + transcript capture (§7) |
| Pagination on `/runs`, `/events`                  | First list where scrolling actually hurts                                                           |
| Notification channel                              | Unattended stage (parent §12) — watched mode means the operator is watching                         |

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

---

## 10. What shipped beyond the spec

The control API grew past §7's single addition (proposal↔event linkage,
proposal history, `GET /journal`, `GET /outbox`, `POST /events/requeue`,
environment identity on `/health`/`/status`), and the UI now consumes all of
it. Everything below follows §5's keyboard model and §5.1's design language
unchanged.

### 10.1 Events view (`#/events`, `g e`)

The event inbox is a first-class view, not just the Overview table it started
as. Status filter tabs (all / admitted / planned / noop / human_needed /
dead_lettered) over `GET /events?status=`, with counts from `/status` and a
client-side type/source/id filter. j/k selection, `#/events/:source/:eventId`
deep links, and a detail panel with identity KV rows, collapsed envelope
payload, and jumps to the latest proposal and run. Status is a badge (same
primitive as runs), not hue-only text; `human_needed` and `dead_lettered`
rows carry a status wash that yields to the selection ring. **Requeue** (`q`,
button, and ⌘K — `r` is off-limits as the `g r` navigation suffix) calls
`POST /events/requeue` for dead_lettered/human_needed events only — it
re-plans the already-admitted event and, once a new open proposal appears,
jumps to it the way Approve jumps to the queued run. **Replay through intake**
is behind a confirm: it re-injects the envelope (dedup demo), it does not
re-plan. `404`/`409` render inline per §6. Empty copy distinguishes loading,
unreachable API, and a genuinely empty inbox.

### 10.2 Proposals: origin + decision history

Each proposal shows its originating event (`eventId`/`eventSource` from the
API; the event type resolved from the shared events cache) as a jump to the
Events inbox, the agent ref as a jump to Agents, and the run id as a jump to
Runs. An **Open / History** tab pair: History is backed by
`GET /proposals?status=all` and is strictly read-only — decided proposals
with `status`, `decided_by`, `decided_at`, and the immutable spec, no verbs
ever offered on a decided row. Status and decision are badges (same primitive
as events/runs); expired and stale-run rows carry a status wash that yields
to the selection ring. Client-side filter, tab counts, Copy id, and
`#/proposals/:id` deep links (open tab first, then history). The TTL
countdown behaves as §4.2 specified.

### 10.3 Runs: enriched list + evidence

The list gains adapter, latest `reasonCode`, attempts as `n/maxAttempts`,
the origin `eventId` (a jump to the Events inbox), and the agent ref (a jump
to Agents). Failed and timed-out rows carry an error wash, refused a warning
wash; selection wins. Client-side filter (selecting a visible row keeps it;
it clears only when a deep-linked or jumped-to run is hidden by the filter,
or the status tab switches to All to surface that run), tab counts from
`/status`, Copy id, and a detail panel that opens while the run payload is
still loading. The
detail panel additionally renders the result's declared `evidence`
(collapsible pretty JSON, per §4.3's result block) and the origin event; `x`
cancels the selected run from the list, matching the proposals-view verb
convention. `#/runs/:id` deep-links to the runs view with that run selected.

### 10.4 Overview: dashboard

Stat tiles stay, and each is a jump (event status → that Events tab, open
proposals → Proposals, run state → that Runs tab). Added: (a) the **doctor panel** now links each anomaly to
its view (expired proposal → that proposal, stale leases → runs,
dead-lettered → that event's row on the Events dead_lettered tab, unpublished
outbox → scroll to the outbox feed) and offers requeue
directly on dead-letter rows — toast, poll for the new open proposal, jump to
`#/proposals/:id` (or an honest toast if none appears, same 8s budget as Events);
(b) a **live activity feed** off `GET /journal`
— first fetch seeds the latest entries, then each poll passes
`since=<last head>` and prepends only what is new, capped at 50 shown, each
entry rendered as `run · FROM → TO by actor (reason)` with a relative
timestamp, a state badge, and a jump-to-run link; empty copy distinguishes
loading, unreachable API, and a genuinely empty journal; (c) a compact **outbox feed** of the latest
result events from `GET /outbox`, unpublished rows flagged in the warning
tone, envelope behind a disclosure. Tiles, doctor, and outbox never say
"none" while the control API request is still pending.

### 10.5 Artifacts in run detail

`GET /runs/:id` result `artifacts` entries are durable
(`{kind, uri, sha256, sizeBytes}`, content-addressed store; real claude runs
include a runtime-captured `transcript` automatically). The run detail's
**Artifacts** section lists each with kind, human-readable size, short hash
(full hash on hover), and an **Open** link to `/api/artifacts/<sha256>` in a
new tab — the serve proxy forwards to the control API, which streams
`text/plain` for texty content and `octet-stream` otherwise. This partially
lifts §2's "no artifact content viewer" non-goal: the trigger in §8 ("first
time opening the transcript matters from the browser") fired, and the viewer
is the browser itself, not new UI. Empty state shown when a result has no
stored artifacts.

### 10.6 Agents view (`#/agents`, `g t`)

`GET /agents` exposes the registry, fully readable, so the operator can
deep-dive what "factory-status-report@1" actually is before approving a spec
that names it. List: ref, output contract, mutating flag (error tone when
true), capabilities summary, timeout, attempts; client-side filter and
`#/agents/:ref` deep links. Detail panel, stacked
sections: **Definition** (workspace, capabilities, limits), **Prompt** (the
full markdown text in a monospace block — readable, no new dependencies —
with Copy prompt),
**Schemas** (input/output, pretty JSON behind disclosures), **Pins** (file →
hash table, captioned: content-hash pins that fail the registry closed on
drift — versions are bumped and re-pinned, never edited in place), and
**Event routing** (which event types select this agent, with adapter,
idempotency scope, and proposal TTL). The shared envelope contracts
(`factory.event/v1`, `factory.agent-result/v1`) render once at the list
level, not per agent. Strictly read-only — the registry has no mutation
surface. ⌘K jumps to an agent ref the same way it jumps to a run or event.

Chord choice: `g t` ("what is **t**his agent?"). `o/e/p/r` were taken, and
`g a` is unusable — chord suffixes share the keydown with single-key list
verbs, and `a` is approve on the proposals view (same class of collision
that moved requeue to `q` in §10.1).

Cross-links: the agent ref in the run detail and in the proposal detail is a
link that opens the Agents view with that agent selected.

### 10.7 Environment chip

The nav rail header carries a permanent chip naming the runtime environment
from `/health`'s `env` object: `env.name`, with the serve-wide adapter
override appended when set ("dev · fake"). **live** wears the warning tone —
approvals there trigger real agent runs; every other environment is
informational. The title attribute carries `env.home` and the
`policyVersion`. When `/health` fails the chip shows **disconnected** in the
error tone, doubling as the API-down indicator alongside §4.1's connection
dot.

### 10.8 Operator chrome (OPS-230)

Follow-up to the Events-as-a-node pass (OPS-226). Same design language (§5.1);
no new API.

- **Shareable hashes.** Selection lives in the hash: `#/runs/:id`,
  `#/events/:source/:eventId`, `#/events?type=`, `#/proposals/:id`,
  `#/agents/:ref`, `#/graph/:nodeId`. Jumps write the full path; refresh
  restores the row. Nav-rail clicks still go to the view root. Overview
  status tiles remain ephemeral (tab/filter, not a URL) except Graph's
  event-type jump, which is `#/events?type=`.
- **Health banner.** When `/health` has failed (not while first pending), a
  status banner sits above every view: the factory is unreachable, lists may
  show cache, verbs stay disabled. **Retry** refetches `/health`. The nav
  chip still says `disconnected`; click it to copy `env.home`.
- **Graph on the same rails.** Selected event-type → Events filtered by type
  (`#/events?type=`); selected agent → Agents. Copy id, `j`/`k` walk nodes,
  Esc closes the panel, honest empty when `/agents` is down. `#/graph/:nodeId`.
- **Inject confirm.** Inject and Trigger again require confirm before
  `POST /replay`. Template chips are a radiogroup (arrow keys). Copy keeps
  Requeue (re-plan) / Replay (same id through intake) / Trigger again (fresh
  id) / Inject (blank or template) distinct.
- **Overview.** Expired-proposals tile lands on the Open tab with the expired
  chip on. Quiet Graph and Inject jumps in the header. Doctor Requeue jumps to
  the new open proposal like Events.
- **⌘K** includes decided proposals (`GET /proposals?status=all`). Dialogs
  expose `role=dialog` `aria-modal`. Runs state tabs scroll on one row
  (LEASED and VERIFYING included — the Overview stale-lease jump lands there).
- **Copy link** on every detail panel copies the shareable hash (`c` copies
  the id). Inject `i` admits then jumps to the event. `?` lists the keys.
  Empty Events inbox offers Inject as a button. Outbox types jump to the
  origin event when the envelope carries source+eventId. Trigger again
  selects a "this envelope" chip. `/` focuses the filter — from Overview or
  Graph it opens Events first. The empty filter shows a `/` hint. Dialog Tab
  cycles stay inside the dialog and focus returns to the opener on close.
  `[` / `]` cycle status tabs. Graph `j`/`k` pans the selected node into
  view; **Show on canvas** does the same from the panel. List title/tabs/filter
  stay pinned while the table scrolls. Detail Copy/Close stays pinned while
  the spec scrolls. `[` / `]` also scrolls the selected Runs tab into view.
  ⌘K splits This item / Go / Commands.
  Relative timestamps show the ISO instant on hover (lists, detail KV, run
  lifecycle clock, attempt start/finish). Click a string KV value to copy it. Doctor anomalies copy. A filtered
  empty list reminds that Esc clears. Selection wash is denser so j/k is
  obvious. Click a toast to dismiss it. The document title follows the hash
  (`factory · Runs · run_id`).

### 10.9 Workers view (`#/workers`, `g w`) — OPS-265, OPS-266, OPS-267, OPS-268

The fleet became plural (OPS-233), so §1's single-worker claim stopped being
true and the registry needed a view. Workers answers one question: **who could
claim the next run, and who only looks like they could.** A worker whose
heartbeat has gone stale still reports `busy` and still holds its run; that gap
is the reason the view exists.

- **Health is four disjoint tokens** — `idle`, `busy`, `stopped`, `stale` —
  rendered with the same `StateBadge` primitive as events, proposals, and runs.
  A stale heartbeat outranks whatever the row claims (`stale` beats a reported
  `busy`), and the row keeps the last self-report beside the badge as
  "reported busy" rather than discarding it. Staleness is heartbeat age past
  `HEARTBEAT_STALE_MS` (90 s, `lib/workers.mjs`); a cleanly stopped worker is
  never marked stale, which is what keeps the four disjoint. Stale rows carry
  the error wash, cleanly stopped rows dim; selection wins over both, per
  §5.1.
- **List** over `GET /workers`, polled at §6's 2 s: worker id, host, pid,
  state, placement labels, adapters, current run, last seen (relative, ISO on
  hover, error-toned when stale). One client-side filter spans id, host, pid,
  health, labels, adapters, and current run. Empty copy distinguishes loading,
  an unreachable API, and a genuinely empty registry — the last names the
  command that fixes it (`bun event-runtime/cli.mjs work`).
- **Detail panel**, stacked sections: a stale banner that says the process is
  gone whatever it last reported (and, when it still holds a run, that the run
  is reclaimed when its lease expires); **Process** (`workerId`, `host`,
  `pid`, `state`, `currentRun`, `startedAt`, `lastSeen`, and `stoppedAt` when
  present); **Adapters**, with an honest empty line when a worker claims
  nothing; and **Labels** as pretty JSON, captioned as what a run's placement
  constraints are matched against. Strictly read-only — the registry has no
  mutation surface, and the UI adds none.
- **Runs stay the run router.** `currentRun` is a jump to `#/runs/:id` from
  both the row and the panel; the fleet is a way in, not a second place runs
  live.
- **Hashes and keys.** `#/workers` and `#/workers/:id` per §10.8: selecting a
  worker writes the hash, refresh restores the row, a nav-rail click returns
  to the view root. `g w` navigates (`w` is no view's single-key list verb, so
  unlike `g a` in §10.6 the natural chord was free); `j`/`k` move, `o` opens
  the current run, `c` copies the worker id, `Esc` closes the panel then
  clears the filter, and the panel's **Copy link** copies the shareable hash.
  ⌘K lists workers in their own group (id, host, and the same
  stale-outranks-reported health) and jumps to one.
- **Nav badge.** The Workers rail entry is the one badge whose meaning flips:
  with stale workers it shows the stale count in the warning tone plus the
  word "stale", otherwise the busy count in the accent tone. The word is
  there because tone alone does not survive the high-contrast theme. Counts
  come from `/status`'s `workers` block.

The two AC items of the parent pass that shipped separately are **now on this
tree**, so the fields §7 already returned are all read by a view:

- **Overview tiles and worker anomalies (OPS-267).** The Overview stat grid
  gains `workers · live` / `busy` / `stale` from `/status`, each hued only when
  non-zero (ok, info, warn) and each a jump to `#/workers`. The Overview doctor
  panel gains a row per `stalledWorkers` entry — naming the worker, the run it
  still holds, and the heartbeat age, with a jump to both ends of that gap —
  and a row for `noWorkers` that counts the queued runs waiting on a
  registration. Anomaly rows carry a link list rather than one link, because a
  stalled worker legitimately has two destinations.
- **`lease_owner` jumps (OPS-268).** A run's attempts now render their lease
  owner, and both it and a lifecycle row's actor become a jump to
  `#/workers/:id` when the string is a worker id (`worker_<pid>_<rand>`,
  `lib/ids.mjs`). Every other actor the runtime records is a bare word
  (`operator`, `planner`, `reaper`, or the `worker` fallback for an attempt
  whose owner was lost) and stays inert text, since none of them addresses a
  row in the fleet; a missing owner reads `unclaimed`.

### 10.10 Live trace in run detail (OPS-295)

`GET /runs/:id/trace` (factory.trace/v1, `lib/trace.mjs`) answers the
question the lifecycle journal cannot: _what is the agent saying and which
tools is it calling, right now._ The run detail gains a **Trace** section
between Lifecycle and Attempts, rendering the stream chronologically:

- `assistant_text` as plain text blocks; `tool_use` as a compact "🔧 name"
  row with the input JSON behind a disclosure; `tool_result` collapsed by
  default (this is the bulky, least-read kind), error-toned when `isError`;
  `usage` as a muted summary line (turns · duration · cost, token detail
  behind a disclosure); `lifecycle` notes muted — except `trace_truncated`,
  which renders visibly in the warning tone as "trace truncated — N events
  dropped past the cap". Payloads the recorder clipped in place
  (`{truncated, preview, originalBytes}`) say so and show the preview.
- **Live behavior.** While the run is `LEASED`/`RUNNING`/`VERIFYING` the
  section polls every ~1.5 s with `since=<last received seq>` (the §10.4
  journal-feed pattern) and appends; a live badge shows, and the scroll pins
  to the newest entry. Polling stops on any other state, with one final
  catch-up read on the live→terminal transition so the tail written between
  the last poll and the terminal flip is not lost. Terminal runs fetch once
  on open — historical traces are browsable, not just live ones. The cursor
  is the last _received_ seq, never the server `head` (which would skip rows
  whenever a read filled a whole 500-row page); full pages loop until caught
  up, bounded by the recorder's 2000-row cap.
- **Multi-attempt runs** get an "Attempt #n" divider whenever the attempt
  number changes (entries are seq-ascending, so attempts are contiguous);
  single-attempt traces carry no labels.
- **Empty states** distinguish loading, an unreachable API, a live run that
  has not emitted yet, and the honest terminal case: "No trace — this
  adapter does not stream events" (fake runs seeded before this feature and
  command-adapter runs have none).

Nothing global changes: no nav entry, no chord — the trace lives inside the
run detail only, and the shared `Disclosure` label widened from `string` to
`ReactNode` to allow the error-toned tool-result summary.

### 10.11 Full-page run view (`#/run/:id`) — OPS-354

Operator verdict after living with §10.10: the panel is right for triage and
wrong for _reading_ — a trace deserves a page. `#/run/:id` is that page.

- **Route.** A distinct first segment, not a mode on `#/runs/:id`. Under
  §10.8's rules, same-view hash writes replace history and cross-view writes
  push — so `runs → run` pushes by construction: browser Back lands on
  `#/runs/:id` with the panel selection intact (the selection _is_ the
  hash), and the explicit **← Runs** control navigates to `#/runs/:id`
  directly, which also works for a pasted `#/run/:id` link with no history
  behind it. A bare `#/run` renders the Runs list. The Runs rail entry stays
  highlighted while a full run view is open.
- **Getting in and out.** From the Runs list: `Enter`/`o` on the selection
  (§5's "open detail" verb graduates — selection alone already opens the
  panel, so _open_ now means the full page). From the panel: an **Expand**
  button, clicking the run id in the panel title, the ⌘K context action, and
  the panel trace's "open full view" tail link. Out: browser Back, **←
  Runs**, or `Esc`. `x` cancel and `c` copy work on the page, same as the
  panel.
- **The `g o` collision, fixed for the class.** `o` is also the Overview
  chord suffix, and the chord listener and a view's key listener ride the
  same keydown — with listener order flipping on remount, so neither side
  can reliably win a race. `goSequence.ts` now exports a time-based
  `goPrefix` armed-timestamp (set on `g`, never cleared synchronously —
  clearing in one listener would blind the other); `useListKeys` stands down
  entirely while it is armed. This also retroactively fixes §10.9's `o`
  (open current run) double-firing on `g o` in Workers.
- **Layout.** Full-bleed two-column under a pinned header (back, state
  badge, run id, agent · adapter · attempts, copy verbs): MAIN is the trace
  at a readable measure (`max-w`-bounded, taller scroll viewport); SIDEBAR
  is the panel's blocks unchanged — verbs with the existing 409 handling,
  spec summary with the agent link, lifecycle, attempts, result + evidence,
  artifacts (open links), receipt. The sidebar stacks below the trace on
  narrow viewports. Origin event still comes from the runs-list join
  (`GET /runs/:id` does not return it); the list query's cache is shared.
- **Trace enhancements, width-earned and modest.** Kind filter chips —
  text / tool calls / tool results / usage · lifecycle (the last two share a
  chip) — filter client-side over the cached entries; polling is untouched
  and hidden-not-shown state means new kinds stay visible by default. The
  poller is the same `useTraceFeed` as §10.10, not a fork: `RunTrace` grew a
  `variant` prop (`panel` | `full`), and both surfaces share one query
  cache, so panel and page never poll the same run twice.
- **Panel trace is now tail-only** (last 20 entries) with a "showing last 20
  of N — open full view" line: triage reads the newest activity, reading the
  whole thing is what the page is for.

### 10.12 Operator context tabs (OPS-356)

Linear-style strip **above** the inverted-L. A tab is a filter context, not a
project container and not a second nav rail. Decisions: [product-decisions.md](product-decisions.md).

- **All** — default, never closable. Today's UI. Unscoped work lives here.
- **In flight** — Runs in `LEASED` or `RUNNING`, every repo. Not a fake
  project. Selecting it lands on `#/runs`.
- **A factory repo** — opened with `+` from `GET /repos`. Filters Events /
  Proposals / Runs to rows whose `repos: string[]` (from spec input /
  envelope payload: `repoPin.repo`, `repo`, `repos[]`) includes that name.
  Empty `repos` only appear under All. Closing the tab returns to All.
- **Agents / Workers / Graph / Inject** stay global. When a repo tab is
  active they caption that they are not scoped to it.
- **Hash.** View + selection stay in the path (`#/runs/:id`). Optional
  `?project=` (`inflight` reserved) restores the active filter on refresh.
  The open-repo set is `sessionStorage`. A pasted `#/runs/:id` without
  `?project=` opens All. `g e` / j/k / Esc stay inside the context; `[` / `]`
  still cycle status tabs.
- Pinning a run as a document tab on this strip is OPS-357, not this
  section. The Projects _view_ (OPS-300) is a separate registry list.
