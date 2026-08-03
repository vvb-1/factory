# factory

Runs on **bun**. The control layer of the Watt Mind agent factory: shared commands, agents, and skills distributed to every repo as a Claude Code plugin, plus the scheduler and dispatcher that run the standing loops.

**Linear is the control plane, GitHub is the source of truth, CI is the reward signal.** Nothing merges because an agent said it was done — it merges because the tests passed and a reviewer (agent or human) approved.

## Layout

**`shared/` is the source of truth. Everything in `plugins/` and `dist/` is generated — never edit it.**

```
shared/                           harness-neutral content, the only place to edit
  floor.md                        the non-negotiables (goes into every AGENTS.md)
  commands/                       factory-work, factory-merge, factory-triage, factory-audit
  skills/                         ticket-spec (SKILL.md — a format all harnesses share)
  agents/                         ux-critic (Claude-only: needs its Task tool)
build/emit.mjs                    shared/ -> per-harness packaging; --check guards drift
plugins/core/                     GENERATED — the Claude Code plugin
dist/{codex,gemini,cursor}/       GENERATED — the other harnesses
dist/AGENTS.floor.md              GENERATED — paste/sync into each repo's AGENTS.md
orchestrator/                     dispatch logic (owned-paths collision, tick)
config/schedule.yaml              ONE source of truth for cadences
config/policy.yaml                budgets, concurrency, escalation
deploy/gen.mjs                    schedule.yaml -> launchd plists
evals/                            prompt regression tests
```

## Multi-harness

The **content** is portable; only the **packaging** isn't. `SKILL.md` is a format Claude, Codex, and Gemini all consume, and command bodies are just markdown.

| Harness | Context | Skills | Commands |
| :--- | :--- | :--- | :--- |
| Claude Code | `CLAUDE.md` → `AGENTS.md` | plugin `skills/` | plugin `commands/` |
| Codex | `AGENTS.md` (native) | `~/.codex/skills/` | `~/.codex/prompts/` |
| Gemini CLI | `GEMINI.md` → `AGENTS.md` | `~/.gemini/skills/` | — |
| Antigravity | shares `~/.gemini/` | via Gemini | — |
| Cursor | `.cursor/rules/` | — | `~/.cursor/commands/` |

```bash
bun build/emit.mjs           # regenerate everything
bun build/emit.mjs --check   # CI: fail if the tree drifted from shared/
bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
```

`--link` symlinks rather than copies, so a `git pull` updates every harness at once and there is no copy to go stale. It refuses to overwrite a real file.

> [!IMPORTANT]
> **The plugin is a convenience layer, not the safety floor.** It reaches Claude Code only, and a cloud sandbox without GitHub auth for this private repo gets nothing — failing closed without knowing it.
>
> So the non-negotiables live in `shared/floor.md` and are committed into each repo's **`AGENTS.md`**, which every harness reads and which travels with the checkout.

**Why `--check` is the important half.** The failure this repo exists to prevent is a rule living in one harness's file and nowhere else — coach-wattz carries "NEVER `prisma db push`" only in `GEMINI.md`, invisible to Claude. Four generated copies are only safer than four hand-written ones if CI proves they still match their source. If the check fails, move the rule into `shared/`; never edit the generated file.

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

## Commands

Prefixed `factory-` so they're identifiable as ours and never collide with a repo-local or built-in command of the same name.

| Command | Does |
| :--- | :--- |
| `/factory-work` | Claims agent-ready tickets, dispatches them rolling (not batched), lands the PRs |
| `/factory-merge` | Reviews open PRs, fixes what's mechanical, merges what qualifies |
| `/factory-triage` | Turns `Triage` tickets into `ai:agent-ready` ones |
| `/factory-audit` | Grades a repo against project-conventions `PC-01`..`PC-20`, files the gaps |

## Scheduling — nothing is scheduled

**Standing policy: the factory runs in the foreground, watched.** No launchd job acts on Linear, git, or CI without someone looking at it. Every job in `config/schedule.yaml` is `enabled: false`, and `deploy/launchd/` is empty.

That's deliberate at this maturity: no skill has eval coverage yet, the dispatcher isn't built, per-agent identity doesn't exist (OPS-40) so autonomous actions can't be attributed, and the reaper already demonstrated that one wrong predicate reaches 31 tickets. Foreground-first is how each loop earns the right to run unattended.

The cost is real and worth naming: **without the reaper, a crashed agent holds its ticket until a human notices.** Acceptable while every run is watched; the first thing to re-enable when that stops being true.

### The supervisor — a scheduler you watch

`orchestrator/run.mjs` runs the same jobs in the foreground: it prints every command before running it, streams output live, and dies with Ctrl-C. When it isn't running, nothing is running.

```bash
bun orchestrator/run.mjs --list                          # what exists
bun orchestrator/run.mjs --only linear-reaper --once     # dry run, one pass
bun orchestrator/run.mjs --only linear-reaper --apply    # for real, on its cadence
bun orchestrator/run.mjs --all --apply
```

Three properties, in order of how much they matter:

1. **Dry by default.** A job declares `dry_command` next to `command`; without `--apply` you get the dry one. The reaper's first real run would have unassigned 31 tickets, so *what would this do* is the default question.
2. **Explicit selection.** Always `--only` or `--all`. There is no "run whatever is enabled" mode — `enabled:` means *may be installed as an unattended timer*, which is a different decision from *run it now*.
3. **No overlap.** A job still running when its next tick arrives is skipped, not stacked. Two reapers racing is precisely the failure the reaper exists to clean up.

`config/schedule.yaml` stays the single source of truth for cadences — the supervisor and the launchd generator read it through the same `lib/schedule.mjs`, so the watched and unattended modes can't disagree about what the jobs are. When a loop does earn promotion it's one flag and a regeneration, not a plist someone writes by hand at 1am.

```bash
bun deploy/gen.mjs             # render enabled jobs (currently: none)
bun deploy/gen.mjs --install   # copy to ~/Library/LaunchAgents and load
```

Never hand-edit a generated plist — the next regeneration silently reverts it.

## Why `Owned Paths` and not keyword matching

`orchestrator/owned-paths.mjs` decides whether two tickets can run at once by intersecting their `Owned Paths` globs. Every `ai:agent-ready` ticket already carries that section, so the machine-readable answer exists — guessing from title keywords both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary but no files) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files but no words).

Where the glob algebra is ambiguous it errs toward *collision*: a false positive serializes two tickets, a false negative puts two agents in one file. Tests: `bun test`.

## What stays out of git

Secrets (injected via launchd env or `op run`), worktrees, agent session logs, and the dispatcher's state — all under `~/.factory/`.

## Related

- `~/Develop/hdkiller/docs/orgs/linear.md` — the execution protocol (SoT)
- `~/Develop/hdkiller/docs/guides/project-conventions.md` — the quality baseline and `PC-*` audit
- `~/Develop/hdkiller/docs/servers/workstations/hdkiller-macbook-pro.md` — the host these jobs run on
