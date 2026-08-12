#!/usr/bin/env bash
# Shared helpers for bin/worktree-up.sh / bin/worktree-down.sh (OPS-217).
# Modelled on coach-wattz's worktree tooling: git isolation does not isolate
# ports or state directories — these scripts do.
set -euo pipefail

WT_ROOT="${FACTORY_WT_ROOT:-$HOME/Develop/.worktrees/factory}"
BASE_BRANCH="${FACTORY_BASE_BRANCH:-develop}"

# Port allocation. Interactive instances use the 7381+ band (7381 default API,
# 7382 default web, 7383/7384 seen in ad-hoc second instances); the --here
# demo env and per-ticket worktrees live above it:
#   --here demo:      API 7391, web 7392
#   ticket worktrees: API 7400 + 2*(ticket % 200), web = API + 1  (7400–7799)
PORT_BASE=7400
PORT_SPAN=200
HERE_API_PORT=7391
HERE_WEB_PORT=7392

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }

repo_root() { git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel; }

ticket_number() {
  [[ "$1" =~ ^[A-Z]+-([0-9]+) ]] || die "ticket must look like OPS-123 (got '$1')"
  printf '%s' "${BASH_REMATCH[1]}"
}
ticket_api_port() { printf '%s' "$((PORT_BASE + 2 * ($(ticket_number "$1") % PORT_SPAN)))"; }

# Runtime state for a checkout lives under its own .factory/ (gitignored):
#   .factory/event-runtime/   FACTORY_EVENT_HOME (db + workspaces)
#   .factory/run/             pidfiles + logs
run_dir() { printf '%s/.factory/run' "$1"; }
event_home() { printf '%s/.factory/event-runtime' "$1"; }

pid_alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

stop_daemon() { # <pidfile> <label>
  if pid_alive "$1"; then
    info "stopping $2 (pid $(cat "$1"))"
    kill "$(cat "$1")" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pid_alive "$1" || break
      sleep 0.3
    done
    pid_alive "$1" && kill -9 "$(cat "$1")" 2>/dev/null || true
  fi
  rm -f "$1"
}
