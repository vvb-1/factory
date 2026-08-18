# janitor-apply — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory janitor --repo {repo} --apply --json
```

Stops tracked daemons for ticket worktrees that have neither a non-terminal
runtime run nor a live worker lease. Non-Done worktrees remain on disk for
debugging. Finished/canceled worktrees are then reclaimed by executing the
repository's `worktree_down` script without `--force`, preserving any checkout
containing uncommitted or unpushed work.
