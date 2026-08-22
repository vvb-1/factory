---
title: Worktrees & Isolation
description: Complete process, port, and database isolation per ticket
---

Git branches isolate code changes, but they do **not** isolate ports, databases, or daemon state. If two agents run tests against a shared development database or dev server port, they silently corrupt each other's work.

Factory mandates **one ticket, one worktree**.

## Worktree Lifecycle

Each dispatchable repository declares `worktree_up`, `worktree_down`, and `worktree_root` in `config/repos.yaml`:

```bash
bin/worktree-up.sh <TICKET-ID>      # spins up isolated environment
bin/worktree-down.sh <TICKET-ID>    # tears down and cleans up
```

```mermaid
flowchart TD
    A[Ticket Dispatched: WM-101] --> B[worktree-up.sh WM-101]
    B --> C[Create .worktrees/WM-101]
    B --> D[Assign Unique Dynamic Port: e.g. 52101]
    B --> E[Provision Isolated SQLite / Postgres DB]
    B --> F[Set Local Runtime Environment]
    F --> G[Run Agent Implementation]
    G --> H[Run Independent Verification]
    H --> I[worktree-down.sh WM-101]
    I --> J[Remove clean worktree or retain evidence]
```

## Safety Rules

:::caution[No Git Stash in Worktrees]
The `git stash` stack is repository-global, not isolated per worktree (`.git/refs/stash`). Running `git stash`, `git stash pop`, or `git rebase --autostash` can mix changes between concurrent sessions and cause data loss. Use a temporary commit or a namespaced patch file instead.
:::
