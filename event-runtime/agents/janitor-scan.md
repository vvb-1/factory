# janitor-scan — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory janitor --repo {repo} --json
```

Surveys the repository's configured worktree root on the worker host, matching
local directories against Linear issue states. For every ticket worktree it
also reports live `.factory/run/*.pid` daemons plus non-terminal runtime runs
and live worker leases. Reports finished/canceled reclaimable checkouts, active
worktrees, and named worktrees without deleting anything.
