# Factory architecture

What the factory is, how a ticket moves through it, and **why each choice was made** — including the ones that were wrong first. The README says how to run it; this says why it is shaped this way.

Read this before changing the dispatcher, the claim protocol, or anything touching worktrees.

---

## 1. The model

```
        ┌──────────── Linear: the control plane ────────────┐
        │  Triage → Todo+agent-ready → In Progress → In Review → Done
        └───────────────────────────────────────────────────┘
             ▲            ▲                ▲            ▲
          triage      dispatch          merge        janitor
        (sonnet)   (1 proc/ticket)     (opus)      (worktrees)
                          │
                    reaper (crashed claims)
```

- **Linear holds state.** Not the filesystem, not a queue file. Two agents cannot disagree about who owns a ticket if there is one authority.
- **GitHub holds truth.** The PR is the artifact; the branch is the work.
- **CI is the reward signal.** Nothing merges because an agent said it was done.
- **The factory holds no state of its own.** `tick.mjs` re-reads Linear on every decision. Restarting it loses nothing.

---

## 2. Decisions and their reasons

### 2.1 One OS process per ticket — not subagents

**Chose:** `tick.mjs` spawns one `claude -p` per ticket.
**Over:** one session claiming several tickets and working them through subagents.

Subagents share a process, a context window and a budget. One crash takes every ticket with it, one runaway starves its siblings, and three tickets interleave into a single untraceable stream. Per-process gives each ticket its own log, budget, session id, and failure domain: a stuck ticket can be killed alone, a failed one resumed alone.

**Cost:** the dispatcher must own claiming, slots and worktrees itself, in code, rather than instructing an agent to do it in prose. That is a feature — it is the part that must be deterministic.

### 2.2 Rolling, never batched

When a ticket finishes, its slot refills immediately. `Promise.all` on a batch was the first implementation and it was wrong: one 40-minute ticket idles two agents for 40 minutes, and batching is the dominant throughput loss in practice.

The queue is re-read on **every** refill, so a ticket that became agent-ready *during* the run — triage promoting one, or a finishing agent filing follow-up work — is picked up without waiting for the next supervisor tick.

### 2.3 `Owned Paths` is the concurrency key

Two tickets may run together only if their `Owned Paths` glob sets are disjoint. Every `ai:agent-ready` ticket carries that section, so the machine-readable answer already exists.

**Rejected:** inferring collisions from ticket titles. It both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary, touch nothing in common) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files, share no words).

Where the glob algebra is ambiguous, `globsOverlap` errs toward **collision**: a false positive serializes two tickets, a false negative puts two agents in one file.

> **This bit us.** The parser originally read only bullet lists. A correctly specced CLNT-616 wrote its paths in a fenced code block, so it parsed as empty, and dispatch refused it as undispatchable — which looked like a triage failure and wasn't. It now accepts bullets, fenced blocks and indented code, mixed with prose. If `READY` is high but nothing is startable, suspect this first.

### 2.4 Claim before building the worktree

Order is **claim → warm → worktree → spawn**.

`worktree-up.sh` takes minutes, and a warm refresh takes minutes more. A ticket left unclaimed for that long is one another agent may take. Holding a claim for a few minutes is harmless — the reaper's threshold is 45.

The Linear read-back after claiming is the only concurrency control that exists; Linear has no compare-and-swap.

### 2.5 Worktrees are industrialized, never hand-rolled

Git isolates branches. It does not isolate **ports** or **databases** — and `migrate-dev` against a shared dev database destroys another agent's work silently, cross-agent. Each repo owns `worktree-{up,down,warm}.sh` meeting `W-1`…`W-12` in [project-conventions §3E](file:///Users/hdkiller/Develop/hdkiller/docs/guides/project-conventions.md).

A repo without those scripts has a safe concurrency of **one agent**, whatever the dispatcher believes. Such repos are marked `report_only: true` in `config/repos.yaml`: the janitor can see their orphans, dispatch refuses them.

### 2.6 The warm cache, and why it is automatic

Worktree creation clones `node_modules` and the build cache from a template (APFS clonefile — effectively free). Current template: seconds. **Stale template: the clone is worthless and every ticket pays a full compile.**

Measured on bj29 with the template 99 commits behind: ~3 minutes per worktree, ~9 minutes of wall clock for three tickets, competing for the same cores, before any agent wrote a line of code.

So `tick.mjs` decides, because the arithmetic is mechanical — warming costs one compile, skipping costs N:

| | |
| :--- | :--- |
| 2+ tickets, ≥15 commits behind | refresh once, then build |
| 1 ticket | skip — a wash, and the ticket would rather start now |
| fresh | skip |

Warming happens **before any `worktree-up`**, so nothing clones a template being rewritten underneath it. (`worktree-up.sh` would detect the mismatch and rebuild from empty, so that race is a slowness bug rather than corruption — but slowness is what we are removing.)

### 2.7 Foreground first — nothing is scheduled

Every job in `config/schedule.yaml` is `enabled: false` and `deploy/launchd/` is empty. The factory runs under `orchestrator/run.mjs`, watched, and when it is not running nothing is running.

This is a maturity judgement, not a permanent design: no skill has eval coverage, agents have no per-agent Linear identity ([OPS-40](https://linear.app/watt-mind/issue/OPS-40)), and the reaper demonstrated on its first run that one wrong predicate reaches 31 tickets. Each loop earns its timer by being watched first.

**The cost, stated rather than hidden:** without the reaper on a timer, a crashed agent holds its ticket until a human notices.

### 2.8 Gates: poll often, act rarely

Every stage has a `gate_command` — one cheap Linear query, exit 0 for work and 1 for idle. Polling costs a read; spawning an agent costs a bite of the usage window. That is what lets cadences be 5 minutes instead of hours, which is what makes the loop feel continuous.

The dispatch gate matters most: an agent that wakes to find the cap full has burned a run to learn nothing.

### 2.9 Auth is the subscription; "budget" is not money

`run-agent.sh` and `tick.mjs` unset `ANTHROPIC_API_KEY` for the child. With it set, runs bill the API per token instead of drawing on the subscription, **and** claude.ai connectors — including the Linear MCP — are silently disabled.

`--max-budget-usd` still works: `costUSD` is reported on subscription auth (a trivial one-turn run is ~$0.14 notional, mostly cache creation). Read it as a **runaway guard in notional units**, not a wallet.

The real constraint is the **usage window**, which nothing here can observe. Per-tick ticket caps (`--args`, `--max`) are the knob that bounds how much of a window one tick consumes. Hitting a limit means smaller caps, not a smaller budget number.

### 2.10 Models: opus only where it changes the outcome

| Stage | Model | Why |
| :--- | :--- | :--- |
| triage | sonnet | structured extraction guided by a detailed skill |
| ticket (implementation) | **opus** | the code is the product |
| merge | **opus** | review catches what tests don't; last gate before `develop` auto-deploys |
| audit | sonnet | mechanical checklist |
| ux-critic | sonnet | exercises the app and reports |

Triage is the live judgement call: a bad spec burns a full dispatch run, which argues for opus; `evals/` is the cheaper place to catch spec quality dropping. Currently sonnet — revisit if specs degrade.

### 2.11 Content is harness-neutral; packaging is generated

`shared/` is the only place to edit. `build/emit.mjs` produces the Claude plugin, `~/.codex/skills`, `~/.gemini/skills`, `~/.cursor/commands`, and the `AGENTS.md` floor block.

`--check` is the half that matters: it fails CI when a generated file drifts from `shared/`. The failure this prevents is real — coach-wattz carries "NEVER `prisma db push`" only in `GEMINI.md`, invisible to Claude Code. Four generated copies beat four hand-written ones **only** if CI proves they still match their source.

The plugin is a convenience layer, not the safety floor. It reaches Claude Code only, and a cloud sandbox without GitHub auth for this private repo gets nothing — failing closed without knowing it. So the non-negotiables live in `shared/floor.md` and are committed into each repo's `AGENTS.md`, the one channel every harness reads.

---

## 3. Failure modes this design accepts

| Failure | Why it is tolerated | Mitigation |
| :--- | :--- | :--- |
| Crashed agent holds a ticket | Reaper is not on a timer (§2.7) | Run it by hand; re-enable when runs are unattended |
| Agents indistinguishable from the human in Linear | Shared API key | OPS-40 — the dispatcher is the natural place to inject per-agent keys |
| Orphaned worktrees | Merge stage sometimes skipped | `janitor.mjs`, hourly gate |
| Stale spec against moved code | Runner fetches but never pulls — the main checkout holds uncommitted human work | Warns with commits-behind; rebasing under someone is worse |
| Triage can still write to the repo | `Bash` must stay available for exploration | Edit/Write/NotebookEdit disabled; dispatch works in worktrees instead |

---

## 4. What is deliberately not built

- **`config/repos.yaml` for unwired repos** — coach-wattz, legalease and cashsaas are `report_only` until `CW-363`/`CLNT-609` land their worktree scripts. Inventing ports for tooling that does not exist is how two agents share a database.
- **A shared worktree library** — bj29 is one implementation. Extract after the third, when the real variation across Wasp/Prisma/Postgres, pnpm/Nuxt/Prisma and Django/SQLite is visible.
- **`evals/run.mjs`** — cases are written first on purpose; they specify what a skill is for.
- **Cross-repo parallelism** — `--repo a,b` runs sequentially. Concurrent sessions across repos contend for one machine and one usage window.

---

## 5. Related

- [`README.md`](../README.md) — how to run it
- [`SETUP.md`](../SETUP.md) — first-time setup and known gaps
- [linear.md](file:///Users/hdkiller/Develop/hdkiller/docs/orgs/linear.md) — the execution protocol (source of truth)
- [project-conventions.md](file:///Users/hdkiller/Develop/hdkiller/docs/guides/project-conventions.md) — quality baseline, `PC-*` audit, `W-*` worktree spec
