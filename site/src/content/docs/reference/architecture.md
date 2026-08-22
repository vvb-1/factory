---
title: Architecture Specification
description: Deep architectural breakdown of Factory loops and components
---

Factory is structured around three foundational subsystems:

```
┌─────────────────────────────────────────────────────────────┐
│                      Control Plane                          │
│          (GitHub Issues / Linear / Projects v2)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Orchestrator & Dispatch                    │
│      - Ticket Admittance & Owned Paths Graph Matcher        │
│      - Worktree Manager (Ports, DB, Git Workspaces)         │
│      - Verification Gate & Falsifiability Runner            │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Agent Harness Pool                       │
│       (Claude Code, Gemini/AGY, Codex, Cursor, Pi)          │
└──────────────────────────────┬──────────────────────────────┘
                               │ optional requirement
┌──────────────────────────────▼──────────────────────────────┐
│                  Gondolin Sandbox Boundary                 │
│       (workspace mount, egress policy, secret proxy)       │
└─────────────────────────────────────────────────────────────┘
```
