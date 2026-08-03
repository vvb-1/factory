#!/usr/bin/env bash
# Run one factory command as a headless Claude Code session, inside a repo.
#
#   runners/run-agent.sh --repo bj29 --command factory-triage
#   runners/run-agent.sh --repo bj29 --command factory-work --budget 8
#   runners/run-agent.sh --repo bj29 --command factory-merge --dry
#
# Headless CLI rather than the Agent SDK on purpose: this is the same agent that
# works interactively, just unattended, so plugins, hooks and MCP config load
# from the repo exactly as they do when you run `claude` yourself. The SDK is for
# embedding a loop inside your own program, which this isn't.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="" ; COMMAND="" ; BUDGET="" ; DRY=0 ; ARGS="" ; READONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="$2"; shift 2 ;;
    --command) COMMAND="$2"; shift 2 ;;
    --budget)  BUDGET="$2"; shift 2 ;;
    --args)    ARGS="$2"; shift 2 ;;
    --dry)     DRY=1; shift ;;
    --read-only) READONLY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO"    ]] || { echo "--repo is required"    >&2; exit 2; }
[[ -n "$COMMAND" ]] || { echo "--command is required" >&2; exit 2; }

# --repo takes a list: `--repo bj29,legalease`. The command is a repo-agnostic
# verb, so targeting more repos is an argument rather than another copy of the
# job. Repos run SEQUENTIALLY here on purpose — parallelism belongs inside a
# repo (one ticket, one worktree, Owned Paths keeping them apart), not across
# repos, where N concurrent sessions would contend for the same machine, the
# same Linear rate budget and the same daily spend cap.
if [[ "$REPO" == *,* ]]; then
  rc=0
  for r in ${REPO//,/ }; do
    echo
    echo "=============================== $r ==============================="
    "$0" --repo "$r" --command "$COMMAND" ${BUDGET:+--budget "$BUDGET"} ${ARGS:+--args "$ARGS"} \
      $([[ "$DRY" == "1" ]] && echo --dry) $([[ "$READONLY" == "1" ]] && echo --read-only) || rc=$?
  done
  exit $rc
fi

# Repo facts and budget come from config/, so the runner has no opinions of its
# own to drift from policy.
read -r REPO_PATH REPO_TEAM < <(
  bun -e '
    const c = Bun.YAML.parse(await Bun.file("config/repos.yaml").text());
    const r = (c.repos ?? []).find((x) => x.name === process.argv[1]);
    if (!r) { console.error("no repo \"" + process.argv[1] + "\" in config/repos.yaml"); process.exit(2); }
    console.log(r.path.replace("~", process.env.HOME) + " " + r.team);
  ' "$REPO"
)
[[ -d "$REPO_PATH" ]] || { echo "repo path does not exist: $REPO_PATH" >&2; exit 2; }

if [[ -z "$BUDGET" ]]; then
  BUDGET="$(bun -e '
    const p = Bun.YAML.parse(await Bun.file("config/policy.yaml").text());
    console.log(p?.budget?.per_ticket_usd ?? 5);
  ')"
fi

PROMPT="/${COMMAND}${ARGS:+ $ARGS}"

# Read-only stages run in the MAIN checkout, not a worktree — triage needs the
# code to write file pointers but has no business changing it, and that checkout
# routinely holds the human's uncommitted work. Blocking the edit tools keeps a
# helpful-but-wrong agent from "fixing" something into their WIP.
# Honest limitation: Bash is still available (exploration needs it), so this
# raises the bar rather than sealing it. Dispatch, which does need to write,
# works inside its own worktree instead.
READONLY_FLAGS=()
if [[ "$READONLY" == "1" ]]; then
  READONLY_FLAGS=(--disallowedTools Edit Write NotebookEdit)
fi

if [[ "$DRY" == "1" ]]; then
  echo "would run in $REPO_PATH:"
  echo "  claude -p '$PROMPT' --output-format json --max-budget-usd $BUDGET ${READONLY_FLAGS[*]}"
  [[ "$READONLY" == "1" ]] && echo "  (read-only: repo edit tools disabled)"
  exit 0
fi

command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 127; }

echo "→ $REPO ($REPO_TEAM)  $PROMPT  budget \$$BUDGET"
echo "  cwd: $REPO_PATH"

# Stages read the repo to write Source File Pointers, Owned Paths and
# verification commands, so a stale checkout produces specs against code that
# moved. Fetch and REPORT — never pull. The main checkout routinely holds
# someone's uncommitted work, and silently rebasing it under them would be a
# far worse failure than a slightly stale spec.
(
  cd "$REPO_PATH"
  git fetch --quiet 2>/dev/null || true
  BASE="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  BEHIND="$(git rev-list --count "HEAD..@{upstream}" 2>/dev/null || echo 0)"
  DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "  branch: $BASE  behind: $BEHIND  uncommitted: $DIRTY"
  [[ "$BEHIND" != "0" ]] && echo "  ! checkout is $BEHIND commit(s) behind — specs may reference moved code"
  [[ "$DIRTY"  != "0" ]] && echo "  ! $DIRTY uncommitted file(s) — not pulling, they would be clobbered"
) || true

# A session launched from inside a Claude Code session inherits these and the
# child exits 1 with no useful message. Clearing them makes the runner safe to
# invoke from anywhere, including an interactive session.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
set +e
(
  cd "$REPO_PATH"
  # `json` (not stream-json): the envelope carries session_id, total_cost_usd,
  # num_turns and subtype, which is the only way this script learns what the run
  # actually did and cost. stream-json is for showing a human live progress.
  claude -p "$PROMPT" \
    --output-format json \
    --max-budget-usd "$BUDGET" \
    --fallback-model sonnet \
    "${READONLY_FLAGS[@]}"
) >"$OUT" 2>&1
STATUS=$?
set -e

# Don't branch on the specific exit code — the full table for -p outcomes isn't
# published, and a model refusal doesn't show up in it at all. Treat status as a
# hint and subtype as the truth.
bun -e '
  const raw = await Bun.file(process.argv[1]).text();
  const status = Number(process.argv[2]);
  let env;
  try { env = JSON.parse(raw); } catch {
    console.error("non-JSON output from claude (exit " + status + "):");
    console.error(raw.slice(0, 2000));
    process.exit(status || 1);
  }
  const ok = env.subtype === "success";
  if (env.result) console.log("\n" + env.result);
  console.log(
    "\n  " + (ok ? "ok" : "FAILED: " + (env.subtype ?? "unknown")) +
    "   $" + (env.total_cost_usd ?? 0).toFixed?.(3) +
    "   " + (env.num_turns ?? "?") + " turns" +
    (env.session_id ? "   session " + env.session_id : "")
  );
  process.exit(ok ? 0 : 1);
' "$OUT" "$STATUS"
