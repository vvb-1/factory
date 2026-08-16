# merge-fix — bounded mechanical correction on an existing PR

`input.json` is one SHA-pinned mechanical finding. `./repo` is the repo-owned
isolated worktree for the ticket. This is not a general implementation run.

1. Read the ticket and all comments. Re-read the PR head/base and required
   checks. Refuse if head SHA, base SHA, ticket, branch, finding hash, or PR
   identity moved; stale evidence requires a fresh independent scan.
2. Confirm the finding is mechanical, round is 1 or 2, the change is wholly
   within the supplied Owned Paths and the ticket's live Owned Paths, and no
   security/product/policy judgment is involved. Otherwise move the ticket to
   Blocked, notify when policy requires, and output BLOCKED without editing.
3. Move the ticket from In Review to In Progress. Check out the existing PR
   head branch at the pinned SHA. Make only the smallest correction, add or
   update a falsifiable regression test, and run the ticket's exact
   Verification Command. Never weaken or skip it.
4. Commit with the ticket ID, push the same head branch, and add a PR comment
   exactly `factory-merge-fix round=<round> finding=<findingHash> old=<oldSha>
new=<newSha>`. Do not merge, approve, mark Done, or delete anything.
5. Return UPDATED with the new 40-hex head SHA. Completion chains to a wholly
   new merge-scan run. You are forbidden to declare your own update mergeable.

If the branch cannot be reconstructed safely, verification fails, a path is
out of scope, or any evidence is uncertain, preserve the worktree/branch,
block the ticket with one answerable reason, and return BLOCKED.

## Result contract

Write `result.json` as a completed `factory.agent-result/v1` result whose
`artifact` conforms to `factory.merge-fix-result/v1`. Both artifacts must
contain exactly these properties, in this order: `outcome`, `repo`, `ticket`,
`pr`, `headSha`, `round`, `summary`. Do not add diagnostic properties; put the
reason or change description in `summary`.

Copy `repo`, `ticket`, `pr`, and `round` from `input.json`. Substitute the real
values for the representative values below.

### UPDATED artifact

Use the new commit SHA that was successfully pushed as `headSha`:

```json
{
  "outcome": "UPDATED",
  "repo": "factory",
  "ticket": "WM-500",
  "pr": 42,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "round": 1,
  "summary": "Applied the mechanical correction, verified it, and pushed the updated head."
}
```

### BLOCKED artifact

Use the pinned `input.json` `headSha` as the required `headSha`, including when
the live PR head moved. Describe the observed mismatch or other blocking reason
only in `summary`:

```json
{
  "outcome": "BLOCKED",
  "repo": "factory",
  "ticket": "WM-500",
  "pr": 42,
  "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "round": 1,
  "summary": "Blocked because the live PR head no longer matches the pinned input head."
}
```
