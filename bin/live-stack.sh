#!/usr/bin/env bash
# Manage the live production event-runtime stack (OPS-233, WM-60).
#
#   factory up                   # start live api (7381), worker, and web UI (7382)
#   factory up --fake            # start with fake adapter (for staging/testing on live db)
#   factory down                 # cleanly stop live daemons
#   factory tail                 # tail all live logs (serve.log, worker.log, web.log)
#   factory tail worker          # tail a specific daemon log
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

ACTION="${1:-up}"
shift || true

HOME_DIR="${FACTORY_EVENT_HOME:-$HOME/.factory/event-runtime}"
RUN_DIR="${FACTORY_RUN_DIR:-$HOME/.factory/run}"
API_PORT="${FACTORY_EVENT_PORT:-7381}"
WEB_PORT="${FACTORY_EVENT_WEB_PORT:-7382}"

mkdir -p "$RUN_DIR" "$HOME_DIR"
REPO="$(repo_root)"

case "$ACTION" in
  up)
    ADAPTER_FLAG=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --fake) ADAPTER_FLAG=("--adapter-override" "fake") ;;
        --adapter-override) ADAPTER_FLAG=("--adapter-override" "$2"); shift ;;
        --port) API_PORT="$2"; shift ;;
        --web-port) WEB_PORT="$2"; shift ;;
        -h|--help)
          echo "usage: factory up [--fake] [--port 7381] [--web-port 7382]"
          exit 0
          ;;
        *) die "unknown option '$1' (see: factory up --help)" ;;
      esac
      shift
    done

    # 1. Start or verify event runtime API server
    if pid_alive "$RUN_DIR/serve.pid"; then
      info "event runtime already running (pid $(cat "$RUN_DIR/serve.pid"), port $API_PORT)"
    else
      info "starting event runtime on $API_PORT (home $HOME_DIR)"
      if [[ ${#ADAPTER_FLAG[@]} -gt 0 ]]; then
        spawn_daemon "$RUN_DIR/serve.pid" "$RUN_DIR/serve.log" "$REPO" \
          env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
          bun "$REPO/event-runtime/cli.mjs" serve --port "$API_PORT" "${ADAPTER_FLAG[@]}"
      else
        spawn_daemon "$RUN_DIR/serve.pid" "$RUN_DIR/serve.log" "$REPO" \
          env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
          bun "$REPO/event-runtime/cli.mjs" serve --port "$API_PORT"
      fi
    fi

    # 2. Wait for API to respond
    for i in $(seq 30); do
      if curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    if ! curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
      die "event runtime failed to start on $API_PORT — check logs at $RUN_DIR/serve.log"
    fi

    # 3. Start or verify worker
    if pid_alive "$RUN_DIR/worker.pid"; then
      info "worker already running (pid $(cat "$RUN_DIR/worker.pid"))"
    else
      info "starting worker"
      spawn_daemon "$RUN_DIR/worker.pid" "$RUN_DIR/worker.log" "$REPO" \
        env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
        bun "$REPO/event-runtime/cli.mjs" work
    fi

    # 4. Start or verify web server
    if pid_alive "$RUN_DIR/web.pid"; then
      info "web server already running (pid $(cat "$RUN_DIR/web.pid"), port $WEB_PORT)"
    else
      info "starting web server on $WEB_PORT"
      spawn_daemon "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$REPO/event-runtime/web" \
        env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
        bun "$REPO/event-runtime/web/serve.mjs"
    fi

    # 5. Wait for web server
    for i in $(seq 30); do
      if curl -sf -m 1 "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done

    printf '\n\033[32m==>\033[0m \033[1mready — live factory stack\033[0m\n\n'
    printf '  event home %s\n' "$HOME_DIR"
    printf '  control    http://127.0.0.1:%s\n' "$API_PORT"
    printf '  web UI     http://127.0.0.1:%s\n' "$WEB_PORT"
    printf '  logs       %s/{serve,worker,web}.log\n\n' "$RUN_DIR"
    printf '  status:  factory events status\n'
    printf '  tail:    factory tail\n'
    printf '  down:    factory down\n\n'
    ;;

  down)
    info "stopping live factory stack..."
    term_daemon "$RUN_DIR/web.pid" "web server"
    term_daemon "$RUN_DIR/worker.pid" "worker"
    term_daemon "$RUN_DIR/serve.pid" "event runtime"
    await_daemon "$RUN_DIR/web.pid" "web server"
    await_daemon "$RUN_DIR/worker.pid" "worker"
    await_daemon "$RUN_DIR/serve.pid" "event runtime"
    rm -f "$RUN_DIR"/*.pid
    info "done — live factory stack is down (durable state preserved at $HOME_DIR)"
    ;;

  tail)
    if [[ $# -gt 0 ]]; then
      TARGET="$1"
      LOG_FILE="$RUN_DIR/$TARGET.log"
      [[ -f "$LOG_FILE" ]] || die "log file does not exist: $LOG_FILE"
      exec tail -n 50 -f "$LOG_FILE"
    else
      LOGS=()
      for f in "$RUN_DIR"/{serve,worker,web}.log; do
        [[ -f "$f" ]] && LOGS+=("$f")
      done
      if [[ ${#LOGS[@]} -eq 0 ]]; then
        touch "$RUN_DIR/serve.log" "$RUN_DIR/worker.log" "$RUN_DIR/web.log"
        LOGS=("$RUN_DIR/serve.log" "$RUN_DIR/worker.log" "$RUN_DIR/web.log")
      fi
      exec tail -n 50 -f "${LOGS[@]}"
    fi
    ;;

  *)
    die "unknown action '$ACTION' (expected: up, down, tail)"
    ;;
esac
