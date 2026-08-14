#!/usr/bin/env bash
# Provision an isolated, seeded event-runtime demo environment (OPS-217).
#
#   bin/worktree-up.sh OPS-123                 # worktree + branch feat/OPS-123
#   bin/worktree-up.sh OPS-123 fix modal-bug   # branch fix/OPS-123-modal-bug
#   bin/worktree-up.sh --here                  # demo env in the CURRENT checkout
#   bin/worktree-up.sh OPS-123 --no-seed       # start empty (no demo data)
#   bin/worktree-up.sh OPS-123 --reseed        # seed again under a fresh prefix
#
# What it isolates that `git worktree add` does not: the control-API and web
# ports (hashed from the full ticket id, persisted in .factory/run/ports) and
# FACTORY_EVENT_HOME (inside the worktree's gitignored .factory/). Bring-up
# verifies /health env.home is this checkout and env.adapter matches the
# requested mode before it seeds. The runtime always starts with
# --adapter-override fake — approving a demo proposal never spawns a real
# agent — and is seeded with one of everything (event-runtime/demo/seed.mjs)
# so e2e and styling sessions have a deterministic fixture, verified by
# event-runtime/demo/verify.mjs before the script reports ready.
#
# Idempotent: re-running leaves live daemons and your uncommitted work alone,
# reinstalls only what bun decides is stale, and re-seeds only on --reseed.
source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

TICKET=""
TYPE="feat"
SLUG=""
HERE=0
SEED=1
RESEED=0
LIVE=0
POS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --here) HERE=1 ;;
    --live) LIVE=1; SEED=0 ;;
    --no-seed) SEED=0 ;;
    --reseed) RESEED=1 ;;
    -h | --help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$1' (see: bin/worktree-up.sh --help)" ;;
    *)
      POS=$((POS + 1))
      case "$POS" in
        1) TICKET="$1" ;;
        2) TYPE="$1" ;;
        3) SLUG="$1" ;;
        *) die "too many arguments (got '$1')" ;;
      esac
      ;;
  esac
  shift
done

REPO="$(repo_root)"

if [[ "$HERE" -eq 1 ]]; then
  [[ -z "$TICKET" ]] || die "--here takes no ticket — it provisions the current checkout"
  WT="$REPO"
  LABEL="here"
else
  [[ -n "$TICKET" ]] || die "usage: worktree-up.sh <TICKET-ID> [type] [slug] | --here   (--no-seed, --reseed)"
  [[ "$TICKET" =~ ^[A-Z]+-[0-9]+(-[A-Za-z0-9][A-Za-z0-9-]*)?$ ]] || die "ticket must look like OPS-123 or OPS-123-scratch"
  WT="$WT_ROOT/$TICKET"
  LABEL="$TICKET"
  BRANCH="$TYPE/$TICKET${SLUG:+-$SLUG}"

  if [[ -d "$WT" ]]; then
    info "worktree already exists: $WT"
  else
    info "fetching origin/$BASE_BRANCH"
    git -C "$REPO" fetch origin "$BASE_BRANCH" --quiet || die "could not fetch origin/$BASE_BRANCH"
    info "creating worktree $WT on $BRANCH"
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$REPO" worktree add "$WT" "$BRANCH" || die "git worktree add failed (git worktree list)"
    else
      git -C "$REPO" worktree add "$WT" -b "$BRANCH" "origin/$BASE_BRANCH" || die "git worktree add failed"
    fi
  fi
fi

RUN_DIR="$(run_dir "$WT")"
HOME_DIR="$(event_home "$WT")"
mkdir -p "$RUN_DIR"

# Resolve API/web ports only after the checkout exists so we can persist them
# under .factory/run/ports and refuse a stranger already bound on the slot.
if [[ "$HERE" -eq 1 ]]; then
  API_PORT="$HERE_API_PORT"
  WEB_PORT="$HERE_WEB_PORT"
  write_ports "$WT" "$API_PORT" "$WEB_PORT"
else
  resolved=0
  if recorded=$(read_ports "$WT"); then
    API_PORT="${recorded%% *}"
    WEB_PORT="${recorded##* }"
    occupant=$(health_field "$(health_json "$API_PORT")" home)
    if [[ -n "$occupant" && "$occupant" != "$HOME_DIR" ]]; then
      if pid_alive "$RUN_DIR/serve.pid"; then
        die "port $API_PORT is owned by another runtime (env.home=$occupant, this worktree=$HOME_DIR) — refusing to seed"
      fi
      warn "recorded port $API_PORT is owned by $occupant — allocating a free port"
    else
      info "reusing recorded ports $API_PORT / $WEB_PORT"
      resolved=1
    fi
  fi
  if [[ "$resolved" -eq 0 ]] && pid_alive "$RUN_DIR/serve.pid"; then
    if sp=$(listen_tcp_port "$RUN_DIR/serve.pid"); then
      API_PORT="$sp"
      if pid_alive "$RUN_DIR/web.pid" && wp=$(listen_tcp_port "$RUN_DIR/web.pid"); then
        WEB_PORT="$wp"
      else
        WEB_PORT=$((API_PORT + 1))
      fi
      info "reusing live daemon ports $API_PORT / $WEB_PORT"
      write_ports "$WT" "$API_PORT" "$WEB_PORT"
      resolved=1
    fi
  fi
  if [[ "$resolved" -eq 0 ]]; then
    preferred="$(ticket_api_port "$TICKET")"
    API_PORT="$(allocate_api_port "$preferred" "$HOME_DIR")"
    WEB_PORT=$((API_PORT + 1))
    write_ports "$WT" "$API_PORT" "$WEB_PORT"
    info "allocated ports $API_PORT / $WEB_PORT (preferred $preferred)"
  fi
fi

# ------------------------------------------------------------ dependencies ---
command -v bun >/dev/null || die "bun is required (https://bun.sh)"
info "installing dependencies (bun install, root + web)"
(cd "$WT" && bun install --frozen-lockfile >/dev/null) || die "bun install failed in $WT"
(cd "$WT/event-runtime/web" && bun install --frozen-lockfile >/dev/null) || die "bun install failed in $WT/event-runtime/web"

# Rebuild only when the build inputs changed since the last successful build.
# The stamp lives inside dist/, so vite wiping the output dir also wipes the
# stamp and a half-finished build can never masquerade as current. build:fast
# skips `tsc --noEmit` — type-checking belongs to verification/CI, not env
# bring-up (`bun run build` in ci.yml still type-checks).
WEB_DIR="$WT/event-runtime/web"
WEB_HASH="$(web_build_hash "$WEB_DIR")"
if [[ -f "$WEB_DIR/dist/index.html" && "$(cat "$WEB_DIR/dist/.buildstamp" 2>/dev/null)" == "$WEB_HASH" ]]; then
  info "web bundle up to date — skipping build"
else
  info "building the web bundle"
  (cd "$WEB_DIR" && bun run build:fast >/dev/null) || die "web build failed — run it manually: cd $WEB_DIR && bun run build"
  printf '%s\n' "$WEB_HASH" >"$WEB_DIR/dist/.buildstamp"
fi

# ---------------------------------------------------------------- daemons ---
FRESH=0
[[ -f "$HOME_DIR/runtime.db" ]] || FRESH=1

ADAPTER_ARG=""
if [[ "$LIVE" -ne 1 ]]; then
  ADAPTER_ARG="--adapter-override fake"
fi

# Last line of defence before bind: if the chosen port already serves a
# different event home, refuse now (naming both homes) instead of starting a
# serve that dies at bind and then mistaking the stranger's /health for ours.
occupant=$(health_field "$(health_json "$API_PORT")" home)
if [[ -n "$occupant" && "$occupant" != "$HOME_DIR" ]]; then
  die "port $API_PORT is owned by another runtime (env.home=$occupant, this worktree=$HOME_DIR) — refusing to seed"
fi

if pid_alive "$RUN_DIR/serve.pid"; then
  info "event runtime already running (pid $(cat "$RUN_DIR/serve.pid"), port $API_PORT)"
else
  info "starting event runtime on $API_PORT ($([[ "$LIVE" -eq 1 ]] && echo "live adapters" || echo "fake adapter"), home $HOME_DIR)"
  # exec so the subshell BECOMES bun: $! is the daemon's real pid, and no
  # bash wrapper lingers holding the caller's stdout open.
  (
    cd "$WT" || exit 1
    exec env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
      bun event-runtime/cli.mjs serve ${ADAPTER_ARG} \
      </dev/null >"$RUN_DIR/serve.log" 2>&1
  ) &
  echo $! >"$RUN_DIR/serve.pid"
fi

# Wait for /health BEFORE starting the worker: on a fresh DB, serve and worker
# opening the database concurrently race on the WAL journal-mode switch and
# the loser dies with SQLITE_BUSY (OPS-376). Health up ⇒ serve owns a settled
# DB, so the worker joins an existing WAL.
#
# Ownership, not liveness (OPS-460): a stranger answering /health must not
# count as ready. If our recorded pid died at bind, say so from serve.log
# instead of adopting the process that won the port.
HEALTH_JSON=""
for _ in {1..50}; do
  HEALTH_JSON=$(curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" 2>/dev/null) && break
  HEALTH_JSON=""
  if ! pid_alive "$RUN_DIR/serve.pid"; then
    die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
  fi
  sleep 0.1
done
if ! pid_alive "$RUN_DIR/serve.pid"; then
  die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
fi
[[ -n "$HEALTH_JSON" ]] || HEALTH_JSON=$(curl -sf -m 2 "http://127.0.0.1:$API_PORT/health") \
  || die "control API never came up on $API_PORT — see $RUN_DIR/serve.log"
assert_event_home "$HEALTH_JSON" "$HOME_DIR" "$API_PORT"
assert_event_adapter "$HEALTH_JSON" "$LIVE" "$API_PORT"
HEALTH_ADAPTER=$(health_field "$HEALTH_JSON" adapter)

# The worker is its own process (OPS-233): restarting the runtime or the web
# server must never interrupt a running agent.
if pid_alive "$RUN_DIR/worker.pid"; then
  info "worker already running (pid $(cat "$RUN_DIR/worker.pid"))"
else
  info "starting worker ($([[ "$LIVE" -eq 1 ]] && echo "live adapters" || echo "fake adapter"))"
  (
    cd "$WT" || exit 1
    exec env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
      bun event-runtime/cli.mjs work ${ADAPTER_ARG} \
      </dev/null >"$RUN_DIR/worker.log" 2>&1
  ) &
  echo $! >"$RUN_DIR/worker.pid"
fi

if pid_alive "$RUN_DIR/web.pid"; then
  info "web server already running (pid $(cat "$RUN_DIR/web.pid"), port $WEB_PORT)"
else
  info "starting web server on $WEB_PORT"
  (
    cd "$WT" || exit 1
    exec env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
      bun event-runtime/web/serve.mjs \
      </dev/null >"$RUN_DIR/web.log" 2>&1
  ) &
  echo $! >"$RUN_DIR/web.pid"
fi

# ------------------------------------------------------------------- seed ---
if [[ "$SEED" -eq 1 && ( "$FRESH" -eq 1 || "$RESEED" -eq 1 ) ]]; then
  PREFIX="demo"
  [[ "$RESEED" -eq 1 && "$FRESH" -eq 0 ]] && PREFIX="demo-$(date +%s)"
  info "seeding demo data (prefix $PREFIX)"
  (cd "$WT" && bun event-runtime/demo/seed.mjs --port "$API_PORT" --prefix "$PREFIX") || die "seed failed — see output above"
elif [[ "$SEED" -eq 1 ]]; then
  info "existing database found — not reseeding (use --reseed for a fresh set)"
else
  warn "skipping demo seed (--no-seed)"
fi

# Verify only when this run actually (re)seeded — on an idempotent re-run the
# fixture was already verified when it was created, and /health above is the
# liveness signal. `bun ... verify.mjs` stays in the report for on-demand use.
if [[ "$SEED" -eq 1 && ( "$FRESH" -eq 1 || "$RESEED" -eq 1 ) ]]; then
  info "verifying the e2e fixture"
  (cd "$WT" && bun event-runtime/demo/verify.mjs --port "$API_PORT") || die "fixture verification failed"
fi

# ----------------------------------------------------------------- report ---
cat <<EOF

$(info "ready — $LABEL")

  checkout   $WT
  event home $HOME_DIR
  control    http://127.0.0.1:$API_PORT      $(adapter_banner "$HEALTH_ADAPTER")
  web UI     http://127.0.0.1:$WEB_PORT
  logs       $RUN_DIR/{serve,worker,web}.log

  status:  FACTORY_EVENT_PORT=$API_PORT bun event-runtime/cli.mjs status
  verify:  cd $WT && bun test event-runtime/ && bun event-runtime/demo/verify.mjs --port $API_PORT
  down:    bin/worktree-down.sh $([[ "$HERE" -eq 1 ]] && echo "--here" || echo "$TICKET")
EOF
