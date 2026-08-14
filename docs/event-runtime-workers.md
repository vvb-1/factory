# Event runtime: workers, placement, and chaining

Status: **stage 1 shipped (OPS-233); stages 2–3 are still design**. Tracking: OPS-221.
Companion to [event-runtime.md](event-runtime.md) §3, §8, §10, §11 — this
note expands the "second process → Postgres → remote workers" line of §10
into something ticket-shaped, without changing any decision made there.
§6 tracks the cut-lines, recording what has shipped (in-process workers,
placement, claim verification, chaining) versus what remains deferred for
remote distribution (Postgres substrate, shared artifact store).

---

## 1. Today, precisely

`serve` is API, planner, scheduler, chain resolver and outbox publisher. It
runs **no worker**: execution lives in one or more `cli.mjs work` processes,
each registering in the worker table with labels and a heartbeat.
`--with-worker` restores the all-in-one for a demo.

Two consequences worth stating because they answer real operator questions:

- **Concurrency is a worker count, and the count is a deployment choice.** Two
  `work` processes execute two runs at once, and the claim is correct under
  contention (`BEGIN IMMEDIATE`, leases, fencing tokens). The reason to keep it
  at one is the unobservable subscription usage window (architecture.md §2.9),
  not a structural limit.
- **A run occupies the worker for its whole duration.** A 10-minute agent
  run means 10 minutes of queue. The lease (spec timeout + 120 s grace) and
  fencing token already make this safe to change — they were built for the
  multi-worker future, and guard nothing today.

## 2. Stage 1 — worker as a process (same machine) — **shipped, OPS-233**

The smallest real step, and a prerequisite for everything after:

- **Substrate: SQLite, for now.** A correction to this note's original plan:
  splitting the process does **not** require Postgres. SQLite in WAL mode
  already supports multiple processes on one machine — what it needed was
  `BEGIN IMMEDIATE` on the claim (the default deferred transaction lets two
  workers read the same QUEUED row before either writes) and `busy_timeout`
  set *before* `journal_mode`, or a second process opening the database
  fails with `SQLITE_BUSY_RECOVERY`. Postgres with `FOR UPDATE SKIP LOCKED`
  is the **remote node** requirement (stage 2), not the multi-process one;
  the claim path is one module so that swap stays an implementation change.
- **`cli.mjs work`** — a standalone process running the loop `runOnce`
  already contains: claim → workspace → adapter → verify → fenced publish.
  `serve` keeps API, planner, approval, outbox, and the reaper, and no longer
  executes (`--with-worker` restores the all-in-one for a quick demo).
- **Worker registry and heartbeats.** Leases prove an *attempt* is held; the
  registry answers which processes are alive, where, and with what labels —
  the difference between "busy on a long run" and "died holding a lease".
  The heartbeat runs on its own timer, never inside the claim loop, because
  that loop blocks for the whole duration of an agent run.
- **Bounded graceful drain.** SIGTERM stops claiming and lets the in-flight
  attempt finish, but only for a grace period (`--drain-timeout`, default
  60s): waiting out a ten-minute run trains operators to SIGKILL, which
  orphans the agent process and leaves a lying registry row. On timeout the
  worker leaves honestly and says what happens next — the lease expires and
  the reaper requeues.
- **Concurrency becomes a worker count**, still deliberately small. Two
  `work` processes are the correctness proof (leases and fencing under real
  contention); raising agent-run parallelism beyond that waits for an answer
  to the usage-window problem, which no code can observe (§3).

Nothing downstream of the claim changes: contracts, verification, the FSM,
and the approval gate are untouched.

## 3. Stage 2 — workers on other nodes

A `work` process on another machine, talking to Postgres over the tailnet.
Workers do **not** talk to the control API — the API stays loopback on the
control node, so distribution adds no network-facing operator surface. The
webhook intake, approval, and web UI do not move.

What actually has to exist first:

- **Shared artifact backend.** Receipts and hashes live in the database, but
  artifact/transcript *bytes* are node-local disk behind `lib/artifacts.mjs`.
  That interface needs a shared backend — Postgres blobs are adequate at
  current volume, an object store later — or `inspect` and the web UI can
  only read artifacts from runs that happened to execute on the control
  node. Workspaces stay node-local and ephemeral; retained-on-failure
  debugging leans on captured transcripts, not remote paths.
- **Registry verification at claim, not trust.** Definitions are pinned by
  content hash and the RunSpec records `defHash` (OPS-409). The worker
  resolves prompt and schema files from its checkout and **verifies the spec's
  content hash before executing; mismatch → typed refusal**
  (`agent_definition_mismatch`), preventing version skew between approval and
  execution.
- **Per-node credentials and adapters.** Secrets are worker-injected (§14):
  each node carries its own Linear key / claude auth. A node registers only
  adapters it has passed conformance for — a node without the `claude` CLI
  simply never claims agent runs, only deterministic-command ones.

## 4. Labels and placement

Placement is **claim-side filtering, not a scheduler**. The claim query is
the whole mechanism:

- A worker starts with labels describing what and where it is (`--label k=v`):
  `node=lab`, `arch=arm64`, `adapter=claude`, `can=infra-exec`, registered in
  the worker table via `registerWorker` (`lib/workers.mjs`).
- An agent definition (and therefore its RunSpec, resolved at planning time in
  `lib/planner.mjs`) may declare `placement`: label requirements such as
  `{ node: "lab", can: "infra-exec" }`. No requirement → any worker.
- `claimNext` (`lib/worker.mjs`) claims only runs whose placement its labels satisfy
  (`satisfiesPlacement` in `lib/workers.mjs`). In SQLite today, the worker
  filters candidate runs in JS within `claimNext`; Postgres will evaluate the
  filter inside the same `SKIP LOCKED` query — there is no scheduler process,
  no bin-packing, no second coordinator (§3's rule: two mutation coordinators race).

Slice 2 is the motivating case: `keephq.disk-alert.raised` remediation must
execute *on the affected host*. Labels also encode the quota split cleanly:
`adapter=claude` workers are capped hard; `can=infra-exec` deterministic
executors (closed action registry, no model) can scale per node with zero
usage-window risk.

Unsatisfiable placement must surface, not hang: candidate filtering ensures
unplaced or matching runs are not starved by unsatisfiable queue heads
(OPS-454), and runs whose placement no live worker's labels satisfy surface
as doctor-check anomalies (§13) after a threshold age, naming the missing labels.

## 5. Chaining agents

Shipped as the discovered form (OPS-223): `lib/chain.mjs` plus `edges.json`. The rules
that answer "can agent A trigger agent B":

- **Agents never message or spawn agents.** A finished run's accepted result
  is published as a result event through the outbox. Events are the only
  coupling.
- **Declared chains (workflows).** A workflow node declares `dependsOn`,
  one registered agent or deterministic command, and input mapped from prior
  accepted artifacts. Code selects runnable nodes topologically; a completed
  upstream unlocks downstreams. Slice 2's diagnose → remediate pair is the
  first two-node chain.
- **"Agent A identifies that agent B should work"** — the discovered chain —
  is a *typed recommendation in A's output contract*, not an action A takes:
  A's artifact carries e.g. `recommendedFollowUp: { type: "...", input: … }`
  drawn from a closed set its schema allows. The result event re-enters the
  planner; the planner (registered mapping, never the model) turns it into a
  **new proposal**, which waits for watched approval like any other. A
  hallucinated recommendation therefore costs one rejected proposal, not an
  unauthorized run. Approval of chain steps can relax per event type later
  (the §2 "earned automation" rule), but the default is: every spawned step
  is proposed, visible at `#/proposals`, and approved.

The loop this closes: webhook → agent A → result event → planner → proposal
for agent B → approval → agent B — same intake, same dedup (causation IDs
already exist in the envelope for exactly this provenance), same audit
trail, whether the "requester" was a webhook or another agent's result.

**Decided (operator, 2026-08-12):** the discovered/recommendation flavor is
the direction to build toward, ahead of general declared workflows (slice
2's fixed two-node chain stands as designed). Approval model:
**per-edge earned automation** — each recommendation edge (a specific
`A-recommendation → B` mapping) is watched individually and earns
auto-approval on its own record; mutating edges may simply never earn it.
First use case: **shipped (OPS-223)** — the CI failure doctor: `github.workflow-run.failed` → `ci-doctor@1` verdict → `FLAKE|ENV → ci-rerun@1` / `TICKET → ci-notify@1`, every edge watched; the edge registry (`edges.json`), chain resolver (`lib/chain.mjs`), and closed-template command adapter are the §6 cut-line 6 machinery.

## 5a. Repository access: tier 1 shipped, tier 2 held (OPS-228/OPS-229)

Agents that need a repo split cleanly by whether they *read* code or *build*
it, and only the second half is expensive.

**Tier 1 — read-only pinned checkout (shipped).** A bare mirror per repo under
the runtime home, fetched at plan time; each run gets its own detached
worktree of that mirror at a **SHA resolved at plan time and pinned into the
run's input** (`repoPin`), so the run names the exact tree it read and dedup
distinguishes "same repo, new commit". No dependency install, no ports, no
database — reading code does not need `node_modules`. Repo facts come from
the factory's existing `config/repos.yaml` (`FACTORY_REPOS_ROOT` overrides
the checkout it is read from); the runtime is a reader, never a second
registry. The operator's live checkout is never used: it holds uncommitted
work an agent would read as truth, concurrent runs would race in it, and even
a read-only run wants `git fetch`, which writes to `.git`.

**Tier 2 — full worktree (designed, WM-107; unbuilt).** Branch, install,
ports, per-ticket database. This tier was held while its blocker was
unresolved; the coordination design now exists —
[event-runtime-dispatch.md](event-runtime-dispatch.md) — and the two rules
stand as the rules that design satisfies:

1. **Delegate, never reimplement.** `config/repos.yaml` already declares
   `worktree_up`/`worktree_down`/`verify` per repo; the provider shells out to
   them (dispatch design §5). Git isolates branches, not ports or databases —
   a second worktree implementation inside the runtime would drift and
   eventually collide with a dev server. Delegation covers the repo-owned
   worktree scripts, **not** the harness spawn: the run itself goes through
   the runtime's own `claude` adapter, never by shelling to `run-agent.sh`
   (dispatch design §6).
2. **Coordination first, workspaces second.** Per event-runtime.md §3, before
   an event run may claim a ticket or mutate code, both paths must share one
   claim, capacity, Owned Paths, and approval authority with the ticket
   dispatcher. Two independent mutation coordinators race even with separate
   source trees, and both draw on the same unobservable subscription usage
   window. The dispatch design answers each: the Linear assignee stays the
   only ticket lock, the dispatcher's cap and worker-lease ledger count both
   paths, `orchestrator/owned-paths.mjs` is imported as the one collision
   oracle, and watched proposals gate every mutation — with the deploy-branch
   merge permanently human. Building the provider before those land would
   recreate the race this rule exists to prevent.

## 6. Ticket cut-lines

1. **Postgres substrate** — **deferred (Stage 2)**: port `db.mjs`; same schema;
   `FOR UPDATE SKIP LOCKED` in `claimNext` for remote nodes; SQLite with WAL mode
   and `BEGIN IMMEDIATE` remains the default substrate for local multi-process
   operation, tests, and demos.
2. **`cli.mjs work`** — **shipped (OPS-233)**: worker-as-process; `serve`
   runs no worker by default (`--with-worker` for all-in-one demo/tests);
   two-process lease/fencing contention verified in `lib/workers.test.mjs`.
3. **Artifact store backend** — **deferred (Stage 2)**: shared-bytes
   implementation behind `lib/artifacts.mjs` (Postgres blobs or object store);
   control-node reads for any remote node's artifacts; node-local content-addressed
   disk store (`<home>/artifacts/<sha256>`) remains current.
4. **Labels + placement** — **shipped (OPS-233, OPS-454)**: worker label set
   (`--label k=v`, `registerWorker` in `lib/workers.mjs`), `placement` in agent
   definitions and RunSpec (`lib/planner.mjs`), claim-side filtering via
   `satisfiesPlacement` (`lib/workers.mjs`) in `claimNext` (`lib/worker.mjs`).
   Enforcement semantics are strictly claim-side filtering, not an external scheduler.
5. **Registry verification at claim** — **shipped (OPS-409)**: content-hash check
   on the worker via `verifyDefHash` (`lib/receipts.mjs`), evaluated in
   `lib/worker.mjs` before execution, with typed refusal (`agent_definition_mismatch`
   → `REFUSED`) and receipt attestation on definition drift.
6. **Chaining slice** — **shipped (OPS-223)**: discovered chaining via
   typed recommendations in output contracts (`edges.json`, `lib/chain.mjs`),
   re-entering the planner for watched proposals with per-edge earned automation
   (CI failure doctor: `ci-doctor@1` → `FLAKE|ENV → ci-rerun@1` / `TICKET → ci-notify@1`).

Items 2, 4, 5, and 6 are shipped and verified in the test suite; items 1 and 3
remain the prerequisites for multi-node distribution (Stage 2).
