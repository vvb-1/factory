# evals

Prompt changes are the only part of this system with no regression test. Without these, a skill silently degrades and you find out weeks later when the merge rate has quietly halved.

**Treat a prompt edit like a code change.** CI runs the frozen cases below against any changed skill; if a skill's pass rate drops, the PR fails.

## Structure

```
cases/<skill>/<case-name>/
  input.md      the ticket / diff / PR the skill receives
  expect.md     what a correct response must contain, and must not
```

`expect.md` is graded, not diffed — the wording will vary. State observable properties ("names a Verification Command that runs", "does not promote"), never exact phrasing.

## Choosing cases

The valuable cases are the ones where the skill is **tempted to do the wrong thing**: a ticket that looks specifiable but hides a product decision, a diff that looks cosmetic but changes an authorization check, a PR whose CI is green but whose test asserts nothing. A case the skill passes trivially teaches nothing and costs a run.

Freeze a case once it's written. A case edited to match new behavior is no longer a regression test.

## Running

    node evals/run.mjs                 # all
    node evals/run.mjs --skill ticket-spec

Not yet implemented — the runner is the next piece. Cases are written first deliberately: they're the specification of what the skill is for, and writing them has already surfaced disagreements about what "agent-ready" means.
