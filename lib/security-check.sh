#!/usr/bin/env bash
# Local security harness (OPS-165, OPS-178) — invoked as `factory security`.
#
# Runs Gitleaks, Semgrep, and Actionlint against a repo before pushing, plus
# Ruff (bandit-equivalent `S` rules) and pip-audit when the repo has adopted
# the Python tier (a `ruff.toml` at its root — see hdkiller
# docs/guides/code-security.md §4 tier 2b). Fast local complement to the CI
# security scan.
#
# Usage:
#   factory security [options] [path]
#
# Options:
#   --history        Gitleaks scans full git history instead of tracked changes (slow)
#   --skip-semgrep   Skip the Semgrep scan (the slowest tool)
#   -h, --help       Show this help
#
# Gitleaks runs git-aware (tracked changes only, via `gitleaks git --pre-commit
# --staged`), never a raw filesystem walk — `gitleaks dir` ignores .gitignore
# entirely and will happily crawl a stray .venv/node_modules/data dump for
# minutes. New untracked files are NOT covered by the default scan; `git add`
# them (or scan `--history`) if you need them checked.
#
# Runs from any git repo/worktree; [path] defaults to the repo containing $PWD.
#
# Per-repo tuning comes from config/repos.yaml `security:` blocks — the factory
# dispatcher resolves the repo and exports SEMGREP_ARGS / GITLEAKS_ARGS /
# PYTHON_VERSION before exec'ing this script (tools/security-env.mjs). A
# repo-root `.gitleaks.toml` is picked up by gitleaks automatically and is the
# right home for allowlists, because CI and the pre-commit hook need it too.
# PYTHON_VERSION pins the interpreter pip-audit resolves dependencies with —
# without it, a pip-based repo whose deps require a newer Python than uvx's
# own default can fail resolution entirely (this bit us on first rollout).
set -uo pipefail

HISTORY=0
SKIP_SEMGREP=0
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --history) HISTORY=1 ;;
    --skip-semgrep) SKIP_SEMGREP=1 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

if [ -n "$TARGET" ]; then
  ROOT=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)
else
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
fi
if [ -z "${ROOT:-}" ]; then
  echo "error: not inside a git repository (or path is not one)" >&2
  exit 2
fi

BOLD=$(tput bold 2>/dev/null || true); RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true); RED=$(tput setaf 1 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)

echo "${BOLD}factory security${RESET} → $ROOT"
[ -n "${SEMGREP_ARGS:-}${GITLEAKS_ARGS:-}" ] && echo "  (repo config from config/repos.yaml)"

RESULTS=()
FAILED=0

run_tool() {
  local name="$1"; shift
  if ! command -v "$1" >/dev/null 2>&1; then
    echo; echo "${YELLOW}● $name: SKIPPED (not installed — brew install $1)${RESET}"
    RESULTS+=("${YELLOW}SKIP${RESET}  $name (not installed)")
    return
  fi
  echo; echo "${BOLD}● $name${RESET}"
  local start=$SECONDS
  if "$@"; then
    RESULTS+=("${GREEN}PASS${RESET}  $name ($((SECONDS - start))s)")
  else
    RESULTS+=("${RED}FAIL${RESET}  $name ($((SECONDS - start))s)")
    FAILED=1
  fi
}

# 1. Gitleaks — git-aware, never a raw filesystem walk (`gitleaks dir` ignores
# .gitignore and can crawl a .venv/node_modules for minutes — see --help above).
# Default: tracked changes (staged + unstaged) via git diff. --history: full log.
# shellcheck disable=SC2086
if [ "$HISTORY" = 1 ]; then
  run_tool "gitleaks (git history)" gitleaks git "$ROOT" --no-banner --redact ${GITLEAKS_ARGS:-}
else
  run_tool "gitleaks (tracked changes)" gitleaks git "$ROOT" --pre-commit --staged --no-banner --redact ${GITLEAKS_ARGS:-}
fi

# 2. Semgrep — SAST, security ruleset only (respects .gitignore)
if [ "$SKIP_SEMGREP" = 1 ]; then
  RESULTS+=("${YELLOW}SKIP${RESET}  semgrep (--skip-semgrep)")
else
  # shellcheck disable=SC2086
  run_tool "semgrep (p/security-audit)" semgrep scan --config p/security-audit \
    --metrics=off --quiet --error ${SEMGREP_ARGS:-} "$ROOT"
fi

# 3. Actionlint — only when the repo has GitHub workflows
if [ -d "$ROOT/.github/workflows" ]; then
  cd "$ROOT" && run_tool "actionlint" actionlint -color
else
  RESULTS+=("${YELLOW}SKIP${RESET}  actionlint (no .github/workflows)")
fi

# 4. Ruff (bandit-equivalent S rules) — only when the repo has adopted the
# Python tier (a ruff.toml at its root, copied from factory-ci-templates).
if [ -f "$ROOT/ruff.toml" ]; then
  run_tool "ruff (security)" uvx ruff check --config "$ROOT/ruff.toml" "$ROOT"
else
  RESULTS+=("${YELLOW}SKIP${RESET}  ruff (no ruff.toml)")
fi

# 5. pip-audit — dependency vulnerability scan. Branches on how the repo
# manages Python deps: uv-native repos (uv.lock) get synced and audited in
# their own resolved env; pip-based repos get audited straight from their
# lockfile. A bare `uvx pip-audit -r <file>` resolves with uvx's own default
# interpreter, which can mismatch a repo's pin and break entirely — always
# pin PYTHON_VERSION (config/repos.yaml `security.python_version`) for
# pip-based repos.
if [ -f "$ROOT/uv.lock" ]; then
  if command -v uv >/dev/null 2>&1; then
    echo; echo "${BOLD}● pip-audit (uv-native)${RESET}"
    start=$SECONDS
    if (cd "$ROOT" && uv sync --frozen && uv run --with pip-audit pip-audit --local); then
      RESULTS+=("${GREEN}PASS${RESET}  pip-audit ($((SECONDS - start))s)")
    else
      RESULTS+=("${RED}FAIL${RESET}  pip-audit ($((SECONDS - start))s)")
      FAILED=1
    fi
  else
    RESULTS+=("${YELLOW}SKIP${RESET}  pip-audit (uv not installed)")
  fi
else
  LOCKFILE=""
  for f in requirements.lock.txt requirements.txt; do
    [ -f "$ROOT/$f" ] && { LOCKFILE="$f"; break; }
  done
  if [ -n "$LOCKFILE" ]; then
    # shellcheck disable=SC2086
    run_tool "pip-audit" uvx ${PYTHON_VERSION:+--python "$PYTHON_VERSION"} pip-audit -r "$ROOT/$LOCKFILE"
  else
    RESULTS+=("${YELLOW}SKIP${RESET}  pip-audit (no uv.lock/requirements*.txt)")
  fi
fi

echo; echo "${BOLD}Summary${RESET}"
for r in "${RESULTS[@]}"; do echo "  $r"; done

if [ "$FAILED" = 1 ]; then
  echo; echo "${RED}${BOLD}Security check FAILED${RESET} — fix findings before pushing."
  exit 1
fi
echo; echo "${GREEN}${BOLD}Security check passed.${RESET}"
