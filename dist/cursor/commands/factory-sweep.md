Find tickets in this project's backlog that no longer need to exist, and retire them — never delete them. "Retire" means moving to Linear's `Canceled` or `Duplicate` state with a comment citing the evidence. Those states already exist for exactly this (`linear.md` §4) and keep the ticket recoverable; an actual delete does not, so **never call a delete/archive mutation, only a state transition.**

Resolve the team/project from the repo via `~/Develop/hdkiller/docs/orgs/linear.md` §1–2, or from `$ARGUMENTS` if a project name is given. Use the Linear MCP; on failure retry once then fall back to `linear_common` GraphQL per the global rule.

## Scope

Target open tickets **not currently live**: `Backlog`, `Triage`, and `Todo` (including `ai:agent-ready` ones — the queue is exactly where an overtaken ticket keeps wasting a future dispatch slot if it isn't caught here). Interpret `$ARGUMENTS` as specific issue IDs or a max count; default up to 20, oldest-updated first — a ticket nobody has touched in months is the one most likely to have been overtaken by events, though age alone is never the verdict (see below).

**Skip, always:** anything `In Progress`, `In Review`, or carrying `ai:blocked` — those are live claims or holds owned by other stages, not this one's to touch.

## Claim what you are examining

Same protocol as triage/unblock: before judging an issue, set `assignee` to yourself and add `ai:in-progress` + `agent:<your-harness>`; remove it when you finish that issue, whether you acted or left it alone. One at a time, not a batch up front.

## Decide, per ticket

Obsolete means one of these, each requiring **evidence you can cite**, not a hunch:

- **Duplicate** — another ticket (open or `Done`) already covers the same requirement. Cite the other issue's ID.
- **Already shipped** — read the actual codebase (or the linked PR) and confirm the acceptance criteria are already met. Cite the file/PR/commit that proves it.
- **Overtaken by events** — the feature, flow, or integration it references no longer exists (removed in the codebase, product decision recorded in `docs/product-decisions.md`, project archived/ended). Cite what you found.
- **Superseded** — a later, more specific ticket replaced this one's scope. Cite the superseding ticket.

**Age, low priority, and "nobody's gotten to it" are never evidence on their own.** A ticket that's sat in `Backlog` for six months untouched can still be exactly the right thing to build next quarter — that's a prioritization question, not an obsolescence one, and this sweep has no opinion on priority. If you can't point at a concrete reason the *work itself* no longer needs doing, leave it alone.

**Obvious cases — act directly:** an exact duplicate of a `Done` ticket, or acceptance criteria you can point to as already met in the current code, are safe to retire without asking first. Comment with the evidence and the state you're moving it to (`Duplicate` links the surviving ticket; `Canceled` for shipped/overtaken), then transition it.

**Everything else — flag, don't act.** If the ticket looks stale but you can't produce hard evidence (the description hints the project may have paused, an integration might be deprecated but you're not certain, it smells overtaken but nothing confirms it), do not change its state. List it in the report as `needs human call` with your reasoning, and let a person decide. A wrongly canceled ticket that was actually still wanted costs more than a slower sweep.

## Don't

Don't touch `ai:agent-ready` tickets' specification quality — that's triage's job, not this one's. Don't cancel anything with an open PR against it, even a stale-looking one — check first. Don't batch-cancel without per-ticket evidence just because several tickets share a pattern (e.g. "these five are all about the old onboarding flow") — cite each one's own evidence, even if it's the same underlying fact.

## Report

One batch table at the end: issue, verdict (`retired — duplicate of <ID>` / `retired — shipped, see <evidence>` / `retired — overtaken, see <evidence>` / `needs human call, see <reasoning>` / `left alone`), and the evidence or reasoning for each. Total retired vs. flagged vs. left alone. If anything is flagged for a human call, that's the section I read first.
