# Event Runtime Web Control Plane — UX Improvement Proposals & UI Architecture Spec

Tracking: **OPS-355** | Parent specs: [event-runtime-webui.md](event-runtime-webui.md), [event-runtime-webui-roadmap.md](event-runtime-webui-roadmap.md)

This document captures usability evaluations, workflow bottlenecks, design proposals, implementation details, and long-term UI roadmap items for the **Factory Event Runtime Web Control Plane** (`event-runtime/web/`).

---

## 1. Executive UX Evaluation

The Web Control Plane provides a dense, keyboard-driven interface adhering to Linear's design language, OKLCH perceptual color tokens, and strict concurrency honesty (refusing optimistic state updates).

### 1.1 Architectural & UX Strengths

- **Safety Invariants as First-Class UI**: The interface strictly renders raw immutable `RunSpec` payloads before approval, live countdowns guard against TTL expiration, and expired approvals halt on re-planning to display a line diff ([`SpecDiff.tsx`](../event-runtime/web/src/components/SpecDiff.tsx)) rather than auto-approving.
- **Keyboard Velocity**: Complete single-key navigation (`j`/`k`, `a` approve, `x` reject/cancel, `q` requeue, `i` inject, `/` filter) coupled with chord transitions (`g o/e/p/r/f/t/w/g`) and `⌘K` command palette.
- **Hash Single-Source-of-Truth**: Deep linkable routes (`#/runs/:id`, `#/events/:source/:eventId`, `#/graph/:nodeId`, `#/workers/:id`, `#/projects/:name`) allow seamless handoff between team members, CLI output, and browser tabs.
- **Auditable Failure Modes**: 404/409 concurrency race conditions and unreachable API backends produce explicit inline notices with recovery actions rather than disappearing toasts.
- **Context Filtering**: Top-level repository and in-flight tabs ([`ContextTabs.tsx`](../event-runtime/web/src/components/ContextTabs.tsx)) scope lists without containerizing agent instances.

---

## 2. Core Friction Points & Usability Gaps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             UX FRICTION MATRIX                              │
├─────────────────────────┬─────────────────────────┬─────────────────────────┤
│ 1. Information Density  │ 2. Triage & Decisions   │ 3. Deep Observability   │
│ • Stat tile overload    │ • Linear repetitive loop│ • Monolithic trace feed │
│ • Table column squeeze  │ • Multi-tab loss of ctx │ • Plain text artifacts  │
│ • Monospace visual fatigue│ • Monochromatic payloads│ • Static graph canvas │
│ • Lack of split control │ • Unstructured search   │ • Missing timing waterfall│
└─────────────────────────┴─────────────────────────┴─────────────────────────┘
```

1. **Overview Glanceability & Stage Flow**: 18+ stat cards previously rendered in an undifferentiated flat grid in [`Overview.tsx`](../event-runtime/web/src/views/Overview.tsx). Structured stage pipelines (Intake $\rightarrow$ Watched Gate $\rightarrow$ Execution Fleet) dramatically improve operational triage.
2. **Master-Detail Table Squeeze**: Opening the slide-over detail pane (440px–520px) heavily truncates 6–8 column tables in `Runs`, `Events`, `Projects`, and `Workers`, cutting off key identifiers, error strings, and hostnames without responsive column shedding or pane resizing.
3. **Trace Stream Navigation & Execution Timings**: In [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx), multi-turn agent execution streams can produce 500+ items. Operators need granular filtering, search within trace, turn timing waterfalls, and cost accumulators.
4. **Artifact & Diff Inspection**: Reports, code patches, and logs render in raw text blocks rather than rich interactive markdown and side-by-side syntax-highlighted diff viewers with collapsible hunks.
5. **Multi-Run Workbench Ergonomics**: Operators troubleshooting concurrent runs or reviewing multiple proposals lose their place when clicking rows, requiring a document/run tab pinning strip.
6. **Proposal Blast Radius Assessment**: Approving high-stakes proposals requires mentally calculating risks (mutating flags, network egress, timeout, attempts) instead of an instant safety assessment badge card.
7. **Lineage Visibility**: Tracing an event from its initial webhook ingestion through planning, approval, execution attempts, and final outbox publication currently requires manual navigation between 4 different views.

---

## 3. Syntax-Highlighted JSON Architecture

High-performance, zero-dependency tokenized JSON rendering across all detail panes and trace disclosures.

### 3.1 Design Goals for JSON Highlighting

1. **Zero External Bundle Bloat**: Avoid multi-megabyte highlighter dependencies (e.g. heavy TextMate WASM grammars).
2. **OKLCH Token Harmony**: Token colors derive from the active theme variables (`var(--accent)`, `var(--hue-ok)`, `var(--hue-info)`, `var(--hue-warn)`, `var(--hue-err)`) across Dark, Light, and High-Contrast modes.
3. **Copy-Paste Fidelity**: Copying text from the rendered JSON yields clean, unpolluted JSON text.
4. **Sub-millisecond Tokenization**: Fast rendering even with 500+ line payloads.

### 3.2 Implemented Architecture (`highlight.ts` & `JsonBlock.tsx`) — [Shipped in OPS-355]

Every JSON payload in the UI already renders through this tokenizer — there is no plain `<pre>` JSON left to replace. Covered by [`highlight.test.ts`](../event-runtime/web/src/highlight.test.ts).

- **Shipped**: Zero-dependency regex tokenizer in [`highlight.ts`](../event-runtime/web/src/highlight.ts) and [`JsonBlock`](../event-runtime/web/src/components/ui.tsx) categorizing:
  - Object keys: `TOKEN_CLASSES.key` (`text-(--text) font-medium`)
  - String values: `TOKEN_CLASSES.string` (`text-[color:var(--hue-ok)]`)
  - Numbers: `TOKEN_CLASSES.number` (`text-[color:var(--hue-info)]`)
  - Booleans: `TOKEN_CLASSES.boolean` (`text-[color:var(--hue-warn)] font-semibold`)
  - Nulls: `TOKEN_CLASSES.null` (`text-[color:var(--hue-err)] font-semibold`)
  - Syntax punctuation: `TOKEN_CLASSES.punctuation` (`text-(--text-faint)`)

### 3.3 Not Built (Tier 2)

- **Collapsible JSON tree**: fold/unfold of objects and arrays, subtree copy, and click-to-copy JSONPath. `JsonBlock` is a flat highlighted block today. No ticket filed — raise one before starting.

---

## 4. Prioritized UX Improvement Proposals

**Read this before implementing anything below.** Much of it is already on `develop`; a proposal without a status marker is genuinely unbuilt.

**Already on `develop` — do not rebuild:**

- Syntax-highlighted `JsonBlock` — [`highlight.ts`](../event-runtime/web/src/highlight.ts), [`ui.tsx`](../event-runtime/web/src/components/ui.tsx) — **OPS-355**
- Operator context tabs (All / repo / In flight) — [`ContextTabs.tsx`](../event-runtime/web/src/components/ContextTabs.tsx) — **OPS-356**
- Trace filter chips, expand/collapse all, `Copy CLI` inspect — [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx), [`Runs.tsx`](../event-runtime/web/src/views/Runs.tsx) — **OPS-358**
- Proposal Spec Highlights safety card — [`Proposals.tsx`](../event-runtime/web/src/views/Proposals.tsx) — **OPS-359**
- Overview stage pipeline & promoted doctor deck — [`Overview.tsx`](../event-runtime/web/src/views/Overview.tsx) — **OPS-360**
- Inject `Format JSON` action, validity indicator, required-field lint — [`InjectDialog.tsx`](../event-runtime/web/src/components/InjectDialog.tsx) — **OPS-361**
- Inject two-column template sidebar with instant search — [`InjectDialog.tsx`](../event-runtime/web/src/components/InjectDialog.tsx) — **OPS-363**

**Filed, not built:** Proposal 4 faceted search (**OPS-382**), Proposal 6 graph phase 2 (**OPS-227**), Proposal 7 pinned run tabs (**OPS-357**, on hold).

Everything else below is unbuilt and unfiled — file a Linear issue before implementing it rather than widening an unrelated ticket.

### Proposal 1: Overview Triage Cockpit (Pipeline Hierarchy) — [Shipped in OPS-360]

**Goal**: Transform [`Overview.tsx`](../event-runtime/web/src/views/Overview.tsx) from a flat stat grid into an operational triage pipeline.

- **Grouped Stages**:
  1. **Intake & Triage**: `admitted` $\rightarrow$ `planned` $\rightarrow$ `noop` $\rightarrow$ `human_needed` $\rightarrow$ `dead_lettered`.
  2. **Watched Approval Gate**: `open proposals` (flagged with countdowns $<5\text{m}$) $\rightarrow$ `expired`.
  3. **Execution Fleet & Capacity**: `active runs` (`QUEUED`, `LEASED`, `RUNNING`, `VERIFYING`) vs `terminal runs` (`COMPLETED`, `FAILED`, `REFUSED`, `TIMED_OUT`, `CANCELLED`) plus `live`/`busy`/`stale` worker counters.
- **Promoted Doctor Deck**: Pinned anomaly box at the top when active issues exist, with single-click triage actions (`Requeue all dead letters`, `Jump to stale leases`, `Jump to stalled workers`).

---

### Proposal 2: Watched Approval "Spec Highlights & Blast Radius" Card — [Card shipped in OPS-359]

**Goal**: Accelerate safe proposal review in [`Proposals.tsx`](../event-runtime/web/src/views/Proposals.tsx).

- **Summary Safety Card** — _shipped_ as the `Spec Highlights — safety check` section above the raw RunSpec disclosure:
  - **Action Target**: agent and adapter, workspace type, and placement (pinned repository / host).
  - **Mutation Risk**: `read-only` (green badge) vs. an amber capability-count badge listing the declared capabilities.
  - **Resource Envelope**: timeout budget ($s$) and declared attempts ceiling.
  - _Not built, unfiled_: per-endpoint egress list (`api.github.com`, `linear.app`) and token ceiling. `RunSpec` carries neither — egress would have to be joined in from the agent registry (`capabilities.services` on `GET /agents`), and a token ceiling does not exist in the runtime at all.
- **One-Click Rejection Canned Feedback** — _not built, unfiled_ — quick buttons to prefill the mandatory rejection reason (`"Scope too wide"`, `"Wrong target branch"`, `"Needs dry-run confirmation"`, `"Token limit excessive"`). The reject flow ships today as a free-text required reason.
- **Historical Comparison** — _not built, unfiled_ — one-click "Compare with last successful run of this agent" diff view.

---

### Proposal 3: Run Trace Controls & CLI Integration — [Shipped in OPS-358]

**Goal**: Make long multi-turn agent traces scannable in [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx).

- **Stream Filter Chips**:
  - `[All]` (full stream)
  - `[Tools Only]` (tool names, inputs, and outputs)
  - `[Reasoning]` (`assistant_text` only)
  - `[Errors]` (failed tool executions and runtime error notes)
  - `[Cost & Tokens]` (`usage` metrics)
- **Bulk Expansion**: `Expand all tool outputs` / `Collapse all` toggle (`e`).
- **CLI Bridge**: One-click `Copy CLI Inspect` button: `bun event-runtime/cli.mjs inspect <runId>`.

---

### Proposal 4: Faceted Search & Filter Tags — [Not built; tracked in OPS-382]

**Goal**: Elevate list search across `Runs`, `Events`, `Projects`, and `Proposals`. `FilterInput` is plain substring matching today.

- **Structured Query Syntax**: Support key-value filters in [`FilterInput`](../event-runtime/web/src/components/ui.tsx):
  - `agent:ci-doctor`
  - `state:failed`
  - `source:keephq`
  - `is:stale`
  - `adapter:claude`
- **Dismissible Tag Bar**: Active filter criteria render as visual tag chips above tables with one-click removal and keyboard clearing (`Esc`).

---

### Proposal 5: Inject & Replay Editor Upgrade — [Shipped in OPS-361/OPS-363]

**Goal**: Prevent envelope syntax errors and streamline event trigger injection in [`InjectDialog.tsx`](../event-runtime/web/src/components/InjectDialog.tsx).

- **Two-Column Sidebar Layout**: Left sidebar with instant template search and keyboard radio navigation; right side houses envelope editor.
- **Format JSON Action**: Dedicated format button and shortcut (`⌘⇧F` / `⌥⇧F`) to beautify pasted envelopes.
- **Pre-submission Schema Linting**: Client-side validation checking required fields (`schemaVersion`, `eventId`, `type`, `source`, `occurredAt`), a live valid/invalid JSON indicator, and an explicit acknowledgement step for unregistered event types.
- **Not pursued**: a CodeMirror editor or a generated form/JSON dual mode. The textarea plus `Format JSON`, the validity dot, and the required-field lint cover the failure this proposal was about (envelope syntax errors); an editor dependency is bundle weight for no operator gain. Re-open only with a concrete case the current editor cannot handle.

---

### Proposal 6: Topology Canvas Live State (Graph Phase 2) — [Not built; tracked in OPS-227]

**Goal**: Evolve [`Graph.tsx`](../event-runtime/web/src/views/Graph.tsx) into a live runtime health map.

- **Active Load Indicators**: Badges on `eventType` and `agent` nodes showing live admitted events and active worker runs.
- **Failure Heatmap**: Edge color intensity based on recent error or `human_needed` rates.
- **Canvas-Triggered Injection**: Click an event node on canvas $\rightarrow$ quick action to open `InjectDialog` pre-seeded with that event's template.
- **Sub-graph Isolation**: One-click filtering to isolate specific event-agent-followup pipelines.

---

### Proposal 7: Pinned Document & Run Multi-Tab Workbench — [Not built; OPS-357 on hold]

**Goal**: Allow operators to maintain multiple open inspection tabs (runs, proposals, events) across view switches. The context strip itself ships (All / repo / In flight, OPS-356); only the pinned run/proposal tabs on its right-hand side are outstanding.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [ All ] [ In flight ] [ watt-mind/factory ] │ [ 📌 run_48ac ✕ ] [ 📌 prop_8f12 ✕ ] │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Top Bar Pinning**: Clicking a "Pin Tab" button or middle-clicking a row adds a persistent document tab to the top context strip.
- **Side-by-Side Comparison**: Split-view mode allowing an operator to compare two pinned runs (e.g. Attempt #1 vs Attempt #2, or Run A vs Run B) side-by-side.
- **Fast Tab Switching**: Keyboard chords `⌘1`–`⌘9` / `⌥1`–`⌥9` for instant switching between active workbench tabs.

---

### Proposal 8: Trace Execution Waterfall, Live Auto-Scroll & In-Stream Search — [Not built, unfiled]

**Goal**: Provide deep runtime observability for long agent execution sessions in [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRACE WATERFALL & COST ACCUMULATOR                                          │
│ Turn 1: 4.2s (Reasoning: 1.1s │ tool:read_file: 12ms │ tool:git_diff: 85ms)  │
│ Turn 2: 26.4s (Reasoning: 2.1s │ tool:run_command [npm test]: 24.1s)        │
│ Total: 30.6s · 18,420 tokens ($0.0552) · 2 turns                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Execution Timing Waterfall**: Visual breakdown displaying elapsed milliseconds/seconds per tool invocation and LLM reasoning turn.
- **Live Stream Auto-Scroll with Pause Lock**: Sticky auto-scroll to the latest event during active runs (`LEASED`, `RUNNING`, `VERIFYING`), with a floating `"↓ New trace events below"` indicator when manually scrolled up.
- **In-Trace Text Search**: Dedicated search input (`⌘F` inside trace) with term highlighting and next/prev match jumping.
- **Token Burn Sparkline**: Cumulative prompt/completion token usage progression graph across turns.

---

### Proposal 9: Rich Artifact, Diff & Test Log Inspector

**Goal**: Elevate secondary artifact inspection from raw plain-text into readable operational documents.

- **Interactive Markdown Renderer**: Automatic rendered preview for markdown reports (`report`, `summary.md`, `verdict.md`) with toggle to raw source.
- **Side-by-Side Unified Patch Viewer**: For code patch artifacts (`diff`), display git diffs with green/red syntax highlighting, line numbers, and collapsible unchanged file hunks.
- **Structured Test Log Formatter**: Detect ANSI escape codes and stack traces in build/test logs, providing one-click "Jump to first failure line".
- **Evidence JSONPath Querying**: For large structured evidence payloads (`result.evidence`), offer interactive subtree folding and click-to-copy JSONPath.

---

### Proposal 10: Master-Detail Adaptive Density & Resizable Split Pane — [Not built, unfiled]

**Goal**: Eliminate table column squashing when the detail panel is opened in `Runs`, `Events`, `Workers`, and `Projects`.

- **Responsive Column Shedding**: Gracefully hide low-priority columns (`Spec Hash`, `Idempotency Key`, `Workspace Path`, `Created At`) when the detail pane is opened, restoring them when closed.
- **Draggable Split Pane**: Allow operators to drag the border between the list and detail pane (min 380px, max 800px) with double-click reset and localStorage persistence.
- **Maximized Inspector ("Focus Mode")**: Single-key action (`m`) to toggle the detail panel between split-screen and full-width focus mode across all views.

---

### Proposal 11: End-to-End Event-to-Outbox Lineage Trail

**Goal**: Provide a clear end-to-end visual breadcrumb trail across the event lifecycle.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LINEAGE: Webhook (#gh_8f) ➔ Event (admitted) ➔ Proposal (approved) ➔        │
│          Run (attempt #1 ➔ attempt #2 [COMPLETED]) ➔ Outbox (published)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Lineage Header Bar**: Rendered in both Event detail and Run detail views, showing clickable upstream and downstream stages:
  - Ingest Source $\rightarrow$ Event ID $\rightarrow$ Proposal ID $\rightarrow$ Run ID $\rightarrow$ Outbox Publication.
- **One-Click Causality Navigation**: Instantly navigate from a failed Run back to the triggering Event or forward to resulting Outbox messages.

---

### Proposal 12: Batch Intake & Dead-Letter Triage Workspace

**Goal**: Provide high-velocity batch operations in [`Events.tsx`](../event-runtime/web/src/views/Events.tsx).

- **Multi-Row Selection**: Support `Shift + Click` range selection and `⌘A` visible selection in event and run lists.
- **Floating Bulk Action Bar**:
  - `[ Requeue Selected (N) ]`
  - `[ Mark as Handled (N) ]`
  - `[ Export Envelopes JSON ]`
- **Dead-Letter Root Cause Clustering**: Group dead-lettered webhooks by error pattern (e.g. `"Payload missing required issue.number"`, `"Unrecognized HMAC signature"`) for batch resolution.

---

### Proposal 13: Worker Fleet Capacity Gauges & Stale Recovery Wizard

**Goal**: Provide operational clarity and guided recovery for worker fleets in [`Workers.tsx`](../event-runtime/web/src/views/Workers.tsx).

- **Fleet Utilization Gauges**: Top-level capacity bar showing Total Registered Workers, Busy Capacity, Idle Slots, and Stale Heartbeats.
- **Heartbeat Stability Bar**: Visual decay bar showing elapsed time since last heartbeat against the 90-second stale ceiling.
- **Stale Lease Eviction Wizard**: When a worker becomes stale while holding active runs:
  - Guided modal showing held run IDs, attempt counts, and remaining lease time.
  - Safe confirmation button to trigger immediate lease reaping and run requeuing.
- **CLI Bridge Helper**: One-click copy for worker process diagnosis: `factory workers inspect <workerId>`.

---

### Proposal 14: Deep URL Hash State Serialization & Saved Views

**Goal**: Enable exact state sharing and workflow bookmarking.

- **Full State URL Encoding**: Serialize active tabs, filters, sorting, and open panels into the URL hash:
  `#/runs?state=FAILED&agent=ci-doctor&sort=duration&drawer=run_8f12`
- **Saved View Bookmarks**: Top navigation dropdown for instant operational queries:
  - _"My Blocked Proposals"_ (`#/proposals?tab=open&decision=human_needed`)
  - _"Active In-Flight CI Runs"_ (`#/runs?state=RUNNING&agent=ci-doctor`)
  - _"Today's Dead Letters"_ (`#/events?status=dead_lettered`)

---

### Proposal 15: Vim-Grade Power Navigation, Audio Chimes & High-Contrast Compliance

**Goal**: Maximize ergonomics for power users and ensure full accessibility.

- **Vim Navigation Extensions**: `gg` (jump to top of list), `G` (jump to bottom of list), `Ctrl+d` / `Ctrl+u` (half-page scroll).
- **Configurable Audio/Visual Chimes**: Subtle, non-intrusive notification sounds or visual pulse when:
  - A proposal arrives with $< 2\text{m}$ TTL.
  - A running agent completes or fails.
  - A worker heartbeat lapses into `stale`.
- **Contrast & Colorblind Compliance**: Complete AAA contrast verification across all OKLCH state hues (`--hue-ok`, `--hue-warn`, `--hue-err`, `--hue-verify`, `--hue-info`) ensuring every badge is distinguishable in grayscale.

---

## 5. Comprehensive Delivery Roadmap & Sequencing

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DELIVERY SEQUENCING                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 1 — Ergonomics & Highlighting                          [SHIPPED]  │
│ • Zero-dependency syntax-highlighted JsonBlock (highlight.ts)     OPS-355   │
│ • Run Trace filter pills & Collapse/Expand all                    OPS-358   │
│ • CLI inspect command copy helper in Run Detail                   OPS-358   │
│ • Overview 3-stage pipeline layout (Intake ➔ Gate ➔ Fleet)        OPS-360   │
│ • InjectDialog 2-column sidebar & JSON formatting tools       OPS-361/363   │
│ • Operator context tabs (All / repo / In flight)                  OPS-356   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 2 — Triage Velocity & Proposal Blast Radius             [PARTIAL] │
│ • Proposal Spec Highlights & Blast Radius safety card             OPS-359   │
│ • Rejection canned feedback templates                             unfiled   │
│ • Responsive column shedding on detail panel open                 unfiled   │
│ • In-trace text search (⌘F) and live auto-scroll lock             unfiled   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 3 — Deep Observability & Multi-Run Workbench                      │
│ • Multi-run pinned document tab strip                    OPS-357 (on hold)  │
│ • Side-by-side run comparison workbench                           unfiled   │
│ • Trace execution timing waterfall & token burn accumulator       unfiled   │
│ • Rich Markdown & syntax-highlighted git diff artifact inspector  unfiled   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 4 — Fleet Telemetry & Topology Canvas Phase 2                     │
│ • Graph live runtime telemetry overlay & load heatmaps            OPS-227   │
│ • Faceted search syntax (agent:, state:, source:)                 OPS-382   │
│ • Worker fleet capacity gauges & stale lease recovery wizard      unfiled   │
│ • End-to-end event-to-outbox lineage trail breadcrumbs            unfiled   │
│ • Saved view bookmarks & deep hash state                          unfiled   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 5 — Batch Operations & Power Ergonomics                           │
│ • Multi-row selection & bulk triage action bar                    unfiled   │
│ • Dead-letter root cause pattern clustering                       unfiled   │
│ • Vim-grade navigation chords (gg, G, Ctrl+d/u)                   unfiled   │
│ • Full deep URL hash serialization for all view filter states     unfiled   │
└─────────────────────────────────────────────────────────────────────────────┘
```

`unfiled` means exactly that: no Linear issue exists, so file one (correct team, `type:*` + `area:*`, evidence-based priority) before starting rather than folding it into whatever ticket is open.
