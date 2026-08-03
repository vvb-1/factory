# factory

The control layer of the Watt Mind agent factory: shared commands, agents, and skills distributed to every repo as a Claude Code plugin, plus the scheduler and dispatcher that run the standing loops.

**Linear is the control plane, GitHub is the source of truth, CI is the reward signal.** Nothing merges because an agent said it was done — it merges because the tests passed and a reviewer (agent or human) approved.

## Layout

```
.claude-plugin/marketplace.json   catalog — the entry point for target repos
plugins/core/                     the plugin every repo enables
  .claude-plugin/plugin.json      manifest ONLY — skills/commands/agents are siblings
  commands/                       /work /merge /triage /audit
  agents/                         ux-critic
  skills/                         ticket-spec
orchestrator/                     dispatch logic (owned-paths collision, tick)
config/schedule.yaml              ONE source of truth for cadences
config/policy.yaml                budgets, concurrency, escalation
deploy/gen.mjs                    schedule.yaml -> launchd plists
deploy/launchd/                   generated, committed, never hand-edited
evals/                            prompt regression tests
```

## Using it from a product repo

```json
// <repo>/.claude/settings.json
{
  "extraKnownMarketplaces": {
    "factory": { "source": { "source": "github", "repo": "watt-mind/factory" } }
  },
  "enabledPlugins": ["core@factory"]
}
```

> [!IMPORTANT]
> **The plugin is a convenience layer, not the safety floor.** It reaches Claude Code only — Gemini reads `GEMINI.md`, Cursor reads `.cursor/rules/`, Codex reads `AGENTS.md`, and none of them can load a plugin. A cloud sandbox without GitHub auth for this private repo gets nothing either, and fails closed without knowing it.
>
> So the non-negotiables (queue rule, claim protocol, `Owned Paths`, worktree mandate, verification gate, `Done` definition, escalation list) stay committed in each repo's **`AGENTS.md`**, which every harness reads and which travels with the checkout. This plugin carries the Claude-specific ergonomics on top.

## Commands

| Command | Does |
| :--- | :--- |
| `/work` | Claims agent-ready tickets, dispatches them rolling (not batched), lands the PRs |
| `/merge` | Reviews open PRs, fixes what's mechanical, merges what qualifies |
| `/triage` | Turns `Triage` tickets into `ai:agent-ready` ones |
| `/audit` | Grades a repo against project-conventions `PC-01`..`PC-20`, files the gaps |

## Scheduling

`config/schedule.yaml` is the only place cadences are defined.

```bash
node deploy/gen.mjs             # render plists, show what changed
node deploy/gen.mjs --install   # copy to ~/Library/LaunchAgents and load
```

Never hand-edit a generated plist — the next regeneration silently reverts it.

Only `linear-reaper` is enabled today. `spec-synth`, `dispatch`, and `merge-babysitter` ship disabled with the reason recorded inline: dispatch needs `PC-15` (worktree isolation) in its target repos, and spec-synth needs eval coverage before it's trusted to write specs unattended.

## Why `Owned Paths` and not keyword matching

`orchestrator/owned-paths.mjs` decides whether two tickets can run at once by intersecting their `Owned Paths` globs. Every `ai:agent-ready` ticket already carries that section, so the machine-readable answer exists — guessing from title keywords both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary but no files) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files but no words).

Where the glob algebra is ambiguous it errs toward *collision*: a false positive serializes two tickets, a false negative puts two agents in one file. Tests: `node --test orchestrator/owned-paths.test.mjs`.

## What stays out of git

Secrets (injected via launchd env or `op run`), worktrees, agent session logs, and the dispatcher's state — all under `~/.factory/`.

## Related

- `~/Develop/hdkiller/docs/orgs/linear.md` — the execution protocol (SoT)
- `~/Develop/hdkiller/docs/guides/project-conventions.md` — the quality baseline and `PC-*` audit
- `~/Develop/hdkiller/docs/servers/workstations/hdkiller-macbook-pro.md` — the host these jobs run on
