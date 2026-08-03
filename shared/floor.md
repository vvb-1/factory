<!-- FACTORY:FLOOR:BEGIN -->
<!-- Generated from watt-mind/factory shared/floor.md. Do not edit here — edit
     the source and re-run `node build/emit.mjs`, or your change is lost on the
     next sync. -->

## Agent operating floor

Non-negotiable for every agent in this repo, in any harness. Full protocol: `~/Develop/hdkiller/docs/orgs/linear.md`. If that path doesn't exist where you're running (a cloud sandbox, someone else's machine), this block is the whole contract — follow it as written and don't infer the rest.

**Work comes from Linear, and only when it's ready.** A ticket is dispatchable only if it is `Todo` + `ai:agent-ready` + unassigned. `Triage` and `Backlog` are not queues to pull from. If you're asked to do meaningful, trackable work with no ticket, create one first.

**Claim before you code.** Set assignee to yourself, state `In Progress`, add `ai:in-progress`, then **re-read the ticket** — if the assignee isn't you, another agent won the race; take the next one. This read-back is the entire concurrency control.

**One ticket, one worktree.** Never share a checkout between concurrent tickets. **If the repo ships a worktree script (`bin/worktree-up.sh` or equivalent), it is mandatory** — git isolates branches, not ports or databases, and a migration against a shared dev database destroys another agent's work silently.

**Stay inside `Owned Paths`.** That glob set is what makes parallel work safe; the dispatcher refuses to run two tickets whose sets intersect. Work discovered outside it becomes a new `Triage` issue — it never expands the current ticket.

**Heartbeat** at each phase change (claimed → implemented → verified → PR open) and at least every 20 minutes, saying what changed. After 45 minutes of silence the ticket is reclaimed.

**Verification is a gate, not a formality.** Run the ticket's exact Verification Command. Never advance state, open a PR, or report success on failing output. Never weaken a test or skip a check to get green — if the test is wrong, that's a finding to report, not to edit around.

**`Done` means merged and running:** PR merged, base-branch CI green after the merge, and the post-deploy smoke check green where the repo has one.

### Never auto-merge

Regardless of CI or review outcome, these come back to a human with findings: **auth/authz, payments or money movement, credential and secret handling, destructive DB migrations, production infra config, and `CLNT` security behavior.**

The test is whether the diff **changes security-relevant behavior**, not whether a file sits near security code — read as file-adjacency this list swallows every PR in an app where auth is everywhere, and that trains everyone to rubber-stamp it. When it's genuinely ambiguous, escalate: a false escalation costs one message, a wrong merge costs a client incident.

`master`/`main` always goes through a human. Merging into `develop` on an `hdkiller`/`watt-mind` repo is pre-authorized once CI is genuinely green **and you have read the diff** — green CI alone is never the bar.

### Stop and ask

Move the ticket to `Blocked`, say specifically what you need in one answerable question, and notify. Never leave a stalled ticket sitting in `In Progress`.

Before blocking on product intent, check whether it's already written down — the repo's `docs/product-decisions.md`, `docs/`, or the Linear project Overview. If you resolve a decision that wasn't recorded, record it.

### Secrets

Never print, echo, commit, or paste an API key, token, or `.env` file — not into a transcript, a PR, a Linear comment, or a log. Scripts read credentials themselves. If a secret appears in a diff, that's an escalation, not a cleanup.
<!-- FACTORY:FLOOR:END -->
