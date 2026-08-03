# Friction log

Things that repeatedly cost the factory time, and what was done about them.

**This list should shrink.** An entry is not a note to remember — it is an open defect in the harness. When it is fixed, the entry stays with status `fixed` so nobody re-discovers it and re-proposes the same thing.

**Rejections are recorded too**, with the reason. A log of only open items invites the same suggestion every month.

Evidence comes from `bun orchestrator/friction.mjs`, which reads the JSONL transcripts every run writes to `~/.factory/logs/`. Curation happens in `/factory-retro`.

## How to add an entry

Only two things qualify: a failure shape seen in **more than one run**, or a cost paid **per ticket that could be paid once**. One-offs don't belong here — a rule everyone must read forever is a real cost, and it should buy more than one saved minute.

Prefer removing the need over documenting the workaround. An env var or a script default beats a rule an agent has to remember.

---

## Open

### F-1 · zsh glob-expands unquoted `--include=*.ts`

**Seen:** 2 occurrences, `bj29-factory-work-20260803-230342`
**Symptom:** `(eval):1: no matches found: --include=*.ts` — the agent's `grep -rn "..." app/src --include=*.ts` dies before grep runs.

zsh expands `*.ts` against the *current directory* and errors when nothing matches, unlike bash which passes the literal through. Every agent doing a scoped grep hits it.

**Fix options, in order of preference:**
1. Set `NO_NOMATCH` for agent shells so unmatched globs pass through literally (removes the need entirely).
2. Or a line in `shared/floor.md`: quote glob arguments — `--include='*.ts'`.

Option 1 is preferred because it cannot be forgotten. Option 2 is a rule; rules decay.

### F-2 · `gh pr merge --delete-branch` fails while the worktree exists

**Seen:** 1 occurrence — recorded early because the cause is structural, not incidental.
**Symptom:** `failed to delete local branch fix/CLNT-611-blog-banner-image: cannot delete branch ... checked out at <worktree>`

Git refuses to delete a branch that is checked out in a worktree. The merge stage deletes the branch before tearing the worktree down, so it will fail every single time a ticket is merged from a worktree.

**Fix:** merge stage should run `worktree-down.sh <TICKET>` *before* `--delete-branch`, or drop `--delete-branch` and let the janitor handle both. Belongs in `shared/commands/factory-merge.md`.

### F-3 · Non-canonical Linear labels are attempted

**Seen:** 1 occurrence (`type:chore`)
**Symptom:** `Could not resolve label(s): "type:chore"`

`type:*` has eight canonical values (`bug feature ui-ux security performance maintenance docs a11y`) and `chore` is not one of them. The agent had no list in front of it.

**Fix:** put the canonical `type:*` and `area:*` values in `shared/floor.md`, where every harness sees them, rather than only in `linear.md` which an agent may not have loaded.

### F-8 · Agents `sleep` to wait for CI instead of watching it

**Seen:** `sleep 150; gh pr checks 166`, `sleep 180; echo done`, `sleep 60; echo done` across multiple runs.

A fixed sleep is a guess: too long wastes wall clock in a process holding a concurrency slot, too short means a re-poll. `gh pr checks <PR> --watch --fail-fast` returns the moment checks settle and exits non-zero on the first failure.

**Fix:** rule added to `shared/floor.md` (§Waiting). Verified `--watch`, `--fail-fast` and `-i` exist in gh 2.97.

**Status:** fixed in the floor — watch whether agents actually adopt it. If sleeps persist in transcripts, the next step is a wrapper script they have to call, since a default beats a rule.

### F-9 · Fixed sleeps waiting for dev servers to boot

**Seen:** `wasp start ... & sleep 60; tail log`, `astro dev & sleep 12; cat log`, `sleep 75; tail`.

Same shape as F-8 but for local processes, and the guess is worse: boot time varies with whether the worktree was warm-cloned or compiled from scratch.

**Fix:** bounded readiness poll (`for i in $(seq 60); do curl -sf ... && break; sleep 2; done`) documented alongside F-8. A repo-level `bin/wait-for-dev.sh` would be the stronger fix — a default rather than a rule — if this keeps recurring.

---

## Fixed

### F-4 · Stale warm cache made every worktree pay a full compile — `fixed`

Template 99 commits behind turned worktree setup into ~3 min each; three tickets meant ~9 minutes before any code was written. Now `tick.mjs` checks staleness after claiming and refreshes once when it pays (2+ tickets, ≥15 commits behind). See [architecture §2.6](architecture.md).

### F-5 · `ANTHROPIC_API_KEY` silently billed the API and disabled connectors — `fixed`

Runs were billed per token instead of drawing on the subscription, and claude.ai connectors — including the Linear MCP — were disabled without anyone noticing. `run-agent.sh` and `tick.mjs` now unset it for the child; `--use-api` opts in deliberately.

### F-6 · Unknown slash commands reported success — `fixed`

`subtype:"success"` with `num_turns:0` and `result:"Unknown command"` was treated as ok. Success detection now requires turns > 0 and no unknown-command reply, and names the fix. The underlying cause — commands never installed into the repo — is handled by `bun build/emit.mjs --link-repos`.

### F-7 · `Owned Paths` in fenced code blocks parsed as empty — `fixed`

A correctly specced ticket was undispatchable because the parser only read bullet lists. It now accepts bullets, fenced blocks and indented code. This one is worth remembering as a *shape*: a strict parser silently turning good input into no input looks like an upstream failure, not a parser bug.

---

## Rejected

### R-1 · Per-ticket `claude` processes should run on separate machines

Considered during the cloud/local split. Rejected for now: the binding constraint is the subscription usage window, which is per-account and does not improve by spreading across machines. Revisit only if wall-clock CPU contention — not tokens — becomes the limit.

### R-2 · Automatically pull the main checkout before triage

Rejected. The main checkout routinely holds uncommitted human work; rebasing under someone to save a slightly stale spec is a far worse trade. The runner fetches and reports `behind`/`uncommitted` instead, and leaves the decision to a human.
