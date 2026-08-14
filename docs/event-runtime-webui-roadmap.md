# Event Runtime Web Control Plane — UI/UX Roadmap & Primitives Spec

Parent specs: [event-runtime.md](event-runtime.md), [event-runtime-webui.md](event-runtime-webui.md)

This document specifies the UX/UI product feature roadmap, Linear-inspired design primitives, view modes, display options, and interaction models for the **Factory Event Control Plane**.

---

## 1. Core UI/UX Primitives (Linear-Grade Paradigm)

### 1.1 View Display Primitives
* **High-Density List View**: Primary view for high-volume inspection. Sticky headers (`sticky top-0 z-10 bg-(--surface-0)`), tabular monospaced metrics, and single-key keyboard selection (`j`/`k`).
* **Kanban Board View**: Column-based layout for `Runs` and `Proposals` grouped into state columns (`PROPOSED` → `APPROVED` → `QUEUED` → `RUNNING` → `VERIFYING` → `COMPLETED`/`FAILED`).
* **Timeline / Gantt View**: Chronological Gantt breakdown showing queue wait times, worker lease durations, and parallel attempt execution.
* **Detail Inspection Modes**: Master-detail side-by-side split, slide-over sheet drawer, and full-screen focus inspector.

### 1.2 Grouping & Aggregation Primitives
Operators can dynamically group any view by:
* **Group by Status**: Group runs into state buckets (Running, Failed, Completed).
* **Group by Agent**: Cluster proposals and runs by target agent (`factory-status-report`, `factory-triage`).
* **Group by Intake Source**: Group by origin (`replay-cli`, `webhook:linear`, `webhook:github`).
* **Group by Adapter**: Separate rows/columns by `claude` (real) vs `fake` (test/demo).
* **Group by Date/Time**: Bucket into `Today`, `Yesterday`, `This Week`.

### 1.3 Filter Engine & Saved Views
* **Structured Query Bar**: Dropdown chips for multi-attribute queries (e.g. `status:failed agent:factory-status-report adapter:claude created:>1h`).
* **Context tabs (OPS-356)**: All / In flight / a factory-repo *filter* above the inverted-L. Not a container for agents; unscoped work stays in All. Pin-a-run document tabs are OPS-357.
* **Saved Views (Bookmarks)**: Custom view tabs saved in top bar or sidebar bookmarks:
  * *"Failed Runs Today"* (`status:failed created:>24h`)
  * *"Pending Approvals"* (`status:open decision:run`)
  * *"Dead-Lettered Webhooks"* (`status:dead_lettered`)

### 1.4 Multi-Select & Bulk Action Primitives
* **Selection Controls**: Table checkboxes, `Shift + Click` range selection, and `⌘A` select all visible rows.
* **Floating Bulk Action Bar**: Bottom action bar appearing when items are selected (`[ Approve Selected (3) ]`, `[ Reject Selected (3) ]`, `[ Bulk Requeue ]`, `[ Bulk Cancel ]`).

### 1.5 Display Preferences Popover ("Display" Menu)
* **Density Controls**: `Compact` (28px row height) vs `Comfortable` (36px row height).
* **Column Visibility Toggles**: Custom show/hide toggles for optional metadata (Workspace Path, Spec Hash, Idempotency Key, Durations).
* **Order & Sorting**: Ascending/descending sorting by `Created At`, `Updated At`, `Duration`, `Attempts`, `TTL`.

### 1.6 Micro-Interaction Primitives
* **Contextual Right-Click Menus**: Custom right-click menu on table rows (`Approve`, `Reject`, `Requeue`, `Copy ID`, `Copy Spec Hash`).
* **Breadcrumb Navigation**: Path breadcrumbs in top header (`Factory / Runs / run_48acf867 / Attempt #1`).
* **Copy-to-Clipboard & Toasts**: Top-right copy buttons on all code/JSON blocks with non-intrusive bottom-right toast feedback.

---

## 2. Module Feature Roadmap

### 2.1 Executive Dashboard & Operations Center (`/overview`)
* Real-time stat grid (events, proposals, runs, and `workers.{live,busy,stale}` from `GET /status` — shipped OPS-267, each tile a jump to `/workers` (§2.7)).
* Doctor anomaly resolution panel (dead letters, stale leases, prompt hash drift, stalled workers still holding a run, no live worker for queued runs).
* Append-only live activity journal (`GET /journal?since=<seq>`).
* Published outbox result stream (`factory.agent-result/v1`).

### 2.2 Watched Approval Engine (`/proposals`)
* Live TTL countdown timers (`m:ss`).
* Immutable `RunSpec` JSON inspector & capability risk badges (`filesystem:write`, `network:egress`).
* Line-by-line red/green spec diff (`SpecDiff.tsx`) when approving expired re-planned proposals.
* Decision audit history (`/proposals?status=all`).

### 2.3 Run Diagnostics & Execution Timeline (`/runs`)
* Lifecycle FSM state filtering tabs.
* Timestamped vertical lifecycle timeline (`seq`, `from` → `to`, `actor`, `reason_code`).
* Attempt metrics & workspace path inspector.
* Cryptographic receipts and declared evidence retention (`evidence` payload).
* Guarded operator verbs (Cancel run with reason, Retry / Force-Retry past attempt budgets).

### 2.4 Event Intake & Replay Engine (`/events`)
* Status-filtered event inbox (`admitted`, `planned`, `noop`, `human_needed`, `dead_lettered`).
* Envelope raw JSON inspector.
* Planning failure error formatting (`planFailures` counter + `lastPlanError`).
* Requeue (`q`) and Replay verbs (HMAC deduplication testing).

### 2.5 Agent Registry & Sandbox (`/agents`)
* Definition cards & output contract types.
* Monospace prompt viewer & content-hash pin audit table (`promptFile` → `sha256`).
* JSON schema visualizers (input/output).
* Event routing matrix.

### 2.6 Artifact & Transcript Viewer (`/artifacts`)
* Content-addressed file browser (`/api/artifacts/:sha256`).
* In-browser transcript viewer (`transcript.jsonl`).

### 2.7 Worker Fleet & Placement (`/workers`) — shipped
* Registry list from `GET /workers`: host, pid, health, placement labels, adapters, current run, heartbeat age.
* Heartbeat as the lie detector: `stale` outranks the worker's own `busy`/`idle` report (90 s window), and the nav badge flips from the busy count to the stale count.
* Detail inspector: process identity, declared adapters, placement labels; jump to the held run (`#/runs/:id`).
* Shipped since: Overview worker tiles and doctor stalled/no-worker anomalies (OPS-267), and `lease_owner` → worker jumps from a run's attempts and lifecycle actors (OPS-268).
