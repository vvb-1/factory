# Setup

## 1. Authenticate the CLI for unattended runs

```bash
claude setup-token
```

Do this **before** loading any launchd job. A launchd process inherits no interactive session, so without a long-lived token the job fails on auth in a way that looks like a hang rather than an error.

## 2. Render and load the schedule

```bash
node deploy/gen.mjs             # review what it would write
node deploy/gen.mjs --install   # copy to ~/Library/LaunchAgents and load
```

```bash
launchctl list | grep wattmind
tail -20 ~/Library/Logs/linear-reaper.log
launchctl kickstart -k gui/$(id -u)/com.wattmind.linear-reaper
```

> [!NOTE]
> `com.wattmind.linear-reaper` was installed by hand on 2026-08-03 and is functionally identical to the generated one. `--install` adopts it (bootout + bootstrap). The only difference is the generated plist writes stdout to `linear-reaper.out.log`, keeping it clear of the wrapper's own `linear-reaper.log`.

## 3. Enable a product repo

```json
// <repo>/.claude/settings.json
{
  "extraKnownMarketplaces": {
    "factory": { "source": { "source": "github", "repo": "watt-mind/factory" } }
  },
  "enabledPlugins": ["core@factory"]
}
```

This is a **private** repo, so any machine loading the plugin needs GitHub auth — including ephemeral cloud VMs. A sandbox without it fails closed and starts with no floor, which is why the non-negotiables also live in each repo's `AGENTS.md`.

## 4. Verify

```bash
node --test orchestrator/owned-paths.test.mjs
node deploy/gen.mjs
```

## Known gaps

These are deliberate — the scaffold ships honest about what isn't built.

| Gap | Why it's not done |
| :--- | :--- |
| `orchestrator/tick.mjs` | Dispatch stays disabled until `PC-15` (worktree isolation) lands in the repos it would dispatch to — see CW-363, CLNT-609. Dispatching into repos with no port/database isolation is how two agents share one dev database. |
| `runners/` | The shared worktree library is deliberately deferred: BJ29 is the only implementation today. Extract after CW-363 and CLNT-609 land, when the real variation across Wasp/Prisma/Postgres, pnpm/Nuxt/Prisma and Django/SQLite is visible. Rule of three. |
| `evals/run.mjs` | Cases are written first on purpose — they specify what the skill is for. |
| `config/repos.yaml` | Not created. Ports and test commands would be invented today; they come from the worktree scripts once those exist. |
| Per-agent Linear identity | Every agent currently claims as the human, so the assignee lock can't detect a lost race (OPS-40). The dispatcher is the natural place to inject a per-agent key — build it in rather than retrofitting. |

## Flags worth knowing

Verified against Claude Code **2.1.220**: `--max-budget-usd`, `--allowedTools`, `--fallback-model`, `--output-format`, `--session-id`, `--resume`, and `setup-token` all exist. **`--max-turns` does not** appear in this version's help — the budget cap is the real bound; a turn cap will silently fail to apply.

Use `--output-format json` (not `stream-json`) for unattended runs: stream is for showing a human live progress, while the JSON envelope carries `session_id`, `total_cost_usd`, `num_turns`, and `subtype` — which is how budget accounting gets its input.

Branch on zero vs non-zero exit and read the structured output for the reason. A model refusal does not show up in the exit code at all; `subtype === "success"` is the truth.

Headless billing changed around mid-June 2026, past the reliable knowledge of the models that wrote this file — check current docs before sizing `budget.per_ticket_usd`.
