---
description: Find open Linear issues for this repo and triage them toward agent-ready
argument-hint: [optional: issue IDs, "all" for workspace-wide, or a max count]
model: opus
---

Triage the open Linear issues for the repository I'm currently in: turn raw `Triage` tickets into fully specified, agent-dispatchable ones where possible.

Resolve the team from the repo via the mapping in `~/Develop/hdkiller/docs/orgs/linear.md` §1. Use the Linear MCP; on failure retry once then fall back to `linear_common` GraphQL per the global rule. Interpret $ARGUMENTS as specific issue IDs, a max count, or "all" (workspace-wide); default is this repo's team, up to 10 issues.

For each issue in `Triage` state (plus any `Todo` issue missing the `ai:agent-ready` label):

1. **Sanity check** — is it a duplicate of an existing issue, already fixed in the codebase or git history, or obsolete? If so, say which and mark it (duplicate → link + cancel, fixed → comment with evidence + close). Confirm with me before canceling anything non-obvious.
2. **Specify** — investigate the codebase enough to write the full §5 AI-ready template: `Problem & Context`, observable `Acceptance Criteria`, `Source File Pointers` (verify the files actually exist), `Owned Paths` (tight globs — these gate concurrent dispatch), and a `Verification Command` that actually runs in this repo. For non-code work, the evidence line replaces the verification command.
3. **Route** — correct project, canonical `type:*` + `area:*` labels, evidence-based priority. Read the issue's current state before writing — the GitHub integration may have moved it already.
4. **Promote or hold** — if all five sections are now solid, update the description, add `ai:agent-ready`, move to `Todo`. If something genuinely needs a human decision (unclear product intent, missing credentials, ambiguous scope), leave it in `Triage` and comment exactly what's missing, phrased as questions I can answer.

**Before holding on product intent, look for the answer.** Check the repo's product-decisions doc (`docs/product-decisions.md` where it exists), `docs/`, the Linear project Overview, and prior tickets in the same area — most "unclear intent" holds are questions already answered somewhere, and every avoidable hold costs a round-trip through the slowest part of the pipeline. Hold only when the decision genuinely hasn't been made yet.

When you do resolve intent from those sources, cite where in the ticket so the next agent doesn't re-litigate it. When I answer a held question, the answer belongs in the product-decisions doc, not just in the ticket comment.

Batch the questions: one notification at the end of the run listing everything held and what each needs, rather than a ping per ticket.

Do **not** start implementing anything — triage only. Never promote a ticket you couldn't verify against the actual codebase.

Finish with a summary table: issue, action taken (promoted / held / duplicate / closed), and what's blocking each held one.
