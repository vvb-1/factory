#!/usr/bin/env bash
# Run one factory command as a headless Claude Code session, inside a repo.
#
#   runners/run-agent.sh --repo bj29 --command factory-triage --read-only
#   runners/run-agent.sh --repo bj29 --command factory-work --args "CLNT-616"
#   runners/run-agent.sh --repo bj29,legalease --command factory-triage --dry
#
# Headless CLI rather than the Agent SDK on purpose: this is the same agent that
# works interactively, just unattended, so plugins, hooks and MCP config load
# from the repo exactly as they do when you run `claude` yourself.
#
# macOS ships bash 3.2, which errors on "${arr[@]}" under `set -u` and mangles
# embedded JS. So: no arrays here, and envelope parsing lives in report.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="" ; COMMAND="" ; BUDGET="" ; DRY=0 ; ARGS="" ; READONLY=0 ; USE_API=0 ; MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO="$2"; shift 2 ;;
    --command)   COMMAND="$2"; shift 2 ;;
    --budget)    BUDGET="$2"; shift 2 ;;
    --args)      ARGS="$2"; shift 2 ;;
    --dry)       DRY=1; shift ;;
    --read-only) READONLY=1; shift ;;
    --use-api)   USE_API=1; shift ;;
    --model)     MODEL="$2"; shift 2 ;;
    -h|--help)   sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO"    ]] || { echo "--repo is required"    >&2; exit 2; }
[[ -n "$COMMAND" ]] || { echo "--command is required" >&2; exit 2; }

# --repo takes a list. Repos run SEQUENTIALLY: parallelism belongs inside a repo
# (one ticket, one worktree, Owned Paths keeping them apart), not across repos,
# where concurrent sessions contend for one machine and one usage window.
case "$REPO" in
  *,*)
    rc=0
    for r in ${REPO//,/ }; do
      echo
      echo "=============================== $r ==============================="
      sub="$0 --repo $r --command $COMMAND"
      [[ -n "$BUDGET"     ]] && sub="$sub --budget $BUDGET"
      [[ -n "$ARGS"       ]] && sub="$sub --args \"$ARGS\""
      [[ "$DRY"      == 1 ]] && sub="$sub --dry"
      [[ "$READONLY" == 1 ]] && sub="$sub --read-only"
      [[ "$USE_API"  == 1 ]] && sub="$sub --use-api"
      [[ -n "$MODEL"      ]] && sub="$sub --model $MODEL"
      eval "$sub" || rc=$?
    done
    exit $rc
    ;;
esac

# Repo facts and budget come from config/, so the runner has no opinions of its
# own to drift from policy.
REPO_PATH="$(cd "$ROOT" && bun -e '
  const c = Bun.YAML.parse(await Bun.file("config/repos.yaml").text());
  const r = (c.repos ?? []).find((x) => x.name === process.argv[1]);
  if (!r) { console.error("no repo in config/repos.yaml: " + process.argv[1]); process.exit(2); }
  console.log(r.path.replace("~", process.env.HOME));
' "$REPO")"
REPO_TEAM="$(cd "$ROOT" && bun -e '
  const c = Bun.YAML.parse(await Bun.file("config/repos.yaml").text());
  console.log((c.repos ?? []).find((x) => x.name === process.argv[1]).team);
' "$REPO")"
[[ -d "$REPO_PATH" ]] || { echo "repo path does not exist: $REPO_PATH" >&2; exit 2; }

if [[ -z "$BUDGET" ]]; then
  BUDGET="$(cd "$ROOT" && bun -e '
    const p = Bun.YAML.parse(await Bun.file("config/policy.yaml").text());
    console.log(p?.budget?.per_ticket_usd ?? 15);
  ')"
fi

PROMPT="/${COMMAND}${ARGS:+ $ARGS}"

# Left empty, each command's own frontmatter decides its model (triage/audit
# sonnet, merge opus, work sonnet orchestrating opus subagents). --model
# overrides the whole session — the blunt instrument; prefer the frontmatter.
MODEL_ARGS=""
if [[ -n "$MODEL" ]]; then
  MODEL_ARGS="--model $MODEL"
fi

# Read-only stages run in the MAIN checkout — triage needs the code to write
# file pointers but has no business changing it, and that checkout routinely
# holds the human's uncommitted work. Bash stays available (exploration needs
# it), so this raises the bar rather than sealing it.
READONLY_ARGS=""
if [[ "$READONLY" == "1" ]]; then
  READONLY_ARGS="--disallowedTools Edit Write NotebookEdit"
fi

# ANTHROPIC_API_KEY, if set, takes precedence over the claude.ai login: runs get
# billed per token instead of drawing on the subscription, AND claude.ai
# connectors (including the Linear MCP) are disabled. Default to the
# subscription; --use-api opts in deliberately.
ENV_PREFIX="env"
if [[ "$USE_API" == "1" ]]; then
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] || { echo "--use-api given but ANTHROPIC_API_KEY is not set" >&2; exit 2; }
  AUTH_NOTE="ANTHROPIC_API_KEY (billed per token; connectors disabled)"
else
  ENV_PREFIX="env -u ANTHROPIC_API_KEY"
  AUTH_NOTE="subscription"
fi

if [[ "$DRY" == "1" ]]; then
  echo "would run in $REPO_PATH:"
  echo "  claude -p '$PROMPT' --max-budget-usd $BUDGET $MODEL_ARGS $READONLY_ARGS"
  echo "  auth: $AUTH_NOTE"
  exit 0
fi

command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 127; }

LOG_DIR="$HOME/.factory/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${REPO}-${COMMAND}-$(date +%Y%m%d-%H%M%S).jsonl"

echo "→ $REPO ($REPO_TEAM)  $PROMPT"
echo "  cwd:    $REPO_PATH"
echo "  auth:   $AUTH_NOTE   cap ~\$$BUDGET notional"

# Stages read the repo to write file pointers and verification commands, so a
# stale checkout produces specs against code that moved. Fetch and REPORT —
# never pull: the main checkout routinely holds uncommitted work, and rebasing
# under someone is worse than a slightly stale spec.
(
  cd "$REPO_PATH"
  git fetch --quiet 2>/dev/null || true
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  BEHIND="$(git rev-list --count "HEAD..@{upstream}" 2>/dev/null || echo 0)"
  DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "  branch: $BRANCH  behind: $BEHIND  uncommitted: $DIRTY"
  [[ "$BEHIND" != "0" ]] && echo "  ! $BEHIND commit(s) behind — specs may reference moved code"
  [[ "$DIRTY"  != "0" ]] && echo "  ! $DIRTY uncommitted file(s) — not pulling, they would be clobbered"
  true
)
echo

# A session launched from inside a Claude Code session inherits these and the
# child exits 1 with no useful message.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

# stream-json, not json: `json` buffers everything until the end, so a watched
# run shows a blank terminal for minutes and then a wall of text. report.mjs
# renders each step live and still parses the final envelope for the exit code.
set +e
(
  cd "$REPO_PATH"
  $ENV_PREFIX claude -p "$PROMPT" \
    --output-format stream-json --verbose \
    --max-budget-usd "$BUDGET" \
    --fallback-model sonnet \
    $MODEL_ARGS $READONLY_ARGS
) 2>&1 | (cd "$ROOT" && bun runners/report.mjs --log "$LOG")
STATUS=${PIPESTATUS[1]}
set -e

exit "$STATUS"
