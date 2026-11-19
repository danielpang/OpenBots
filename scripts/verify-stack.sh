#!/usr/bin/env bash
# Boots OpenBots from this checkout for an end-to-end check of a change: a
# fresh database, the server from source on :3000 and the web app on :5173.
# The verify skills (.claude/skills/verify and the ones beside each app) use
# it; so can a person.
#
#   bash scripts/verify-stack.sh start            # self-hosted: apps/server and apps/web
#   bash scripts/verify-stack.sh start --managed  # the managed service: ee/server and ee/web
#   bash scripts/verify-stack.sh env              # the exports Playwright needs
#   bash scripts/verify-stack.sh status
#   bash scripts/verify-stack.sh stop
#
# Postgres and Redis come from scripts/dev.sh. State (pids, logs, the files
# directory) lives in .verify/, which git ignores. Each start drops and
# recreates the openbots_verify database, so a run never sees the last one's
# users. The managed stack lets several users sign up, which most specs in
# apps/web/e2e need; the self-hosted one closes sign-up after its owner.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_DIR/.verify"
ADMIN_URL="${VERIFY_ADMIN_DATABASE_URL:-postgres://openbots:openbots@127.0.0.1:5432/openbots}"
DB_NAME=openbots_verify
DATABASE_URL="${ADMIN_URL%/*}/$DB_NAME"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
SERVER_URL=http://localhost:3000
WEB_URL=http://localhost:5173

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf 'verify-stack: %s\n' "$*" >&2
  exit 1
}

# Stops a process started by this script, with its children (tsx and vite
# each run under pnpm).
stop_one() {
  local name="$1" file="$STATE_DIR/$1.pid" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
    log "Stopped $name"
  fi
  rm -f "$file"
}

wait_for() {
  local name="$1" url="$2" log_file="$3" pid
  pid="$(cat "$STATE_DIR/$name.pid")"
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 40 "$log_file" >&2
      die "$name stopped while starting; its log is $log_file"
    fi
    sleep 0.5
  done
  tail -n 40 "$log_file" >&2
  die "$name did not answer at $url; its log is $log_file"
}

print_env() {
  cat <<ENV
export E2E=1
export E2E_BASE_URL=$WEB_URL
export E2E_SERVER_LOG=$STATE_DIR/server.log
ENV
}

start() {
  local deployment=self_hosted server=@openbots/server web=@openbots/web
  for arg in "$@"; do
    case "$arg" in
      --managed)
        deployment=managed
        server=@openbots/ee-server
        web=@openbots/ee-web
        ;;
      *) die "unknown argument '$arg' (try --help)" ;;
    esac
  done

  stop_one web
  stop_one server
  mkdir -p "$STATE_DIR/files"
  for port in 3000 5173; do
    if curl -s -o /dev/null "http://localhost:$port/"; then
      die "something else is already listening on port $port; stop it first"
    fi
  done

  bash "$REPO_DIR/scripts/dev.sh" >"$STATE_DIR/services.log" 2>&1 ||
    die "Postgres and Redis did not start; see $STATE_DIR/services.log"

  log "Creating a fresh $DB_NAME database"
  psql "$ADMIN_URL" -qv ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" -c "CREATE DATABASE $DB_NAME" >/dev/null
  rm -rf "$STATE_DIR/files" && mkdir -p "$STATE_DIR/files"

  cd "$REPO_DIR"
  local key
  key="$(pnpm -s --filter @openbots/server keygen 2>/dev/null)"

  log "Starting the $deployment server from source"
  # setsid gives each its own process group, so stop can end pnpm's children.
  DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" OPENBOTS_MASTER_KEY="$key" \
    OPENBOTS_PUBLIC_URL="$SERVER_URL" OPENBOTS_DEPLOYMENT="$deployment" \
    OPENBOTS_SIGNUP_MODE=open OPENBOTS_LOCAL_ENDPOINTS=true OPENBOTS_DEV_LOG_EMAIL_LINKS=1 \
    OPENBOTS_FILES_DIR="$STATE_DIR/files" \
    setsid pnpm --filter "$server" exec tsx --conditions=@openbots/source src/main.ts \
    >"$STATE_DIR/server.log" 2>&1 &
  echo $! >"$STATE_DIR/server.pid"
  wait_for server "$SERVER_URL/readyz" "$STATE_DIR/server.log"

  log "Starting the web app"
  setsid pnpm --filter "$web" exec vite --port 5173 --strictPort >"$STATE_DIR/web.log" 2>&1 &
  echo $! >"$STATE_DIR/web.pid"
  wait_for web "$WEB_URL/" "$STATE_DIR/web.log"

  echo "$deployment" >"$STATE_DIR/deployment"
  log "Ready: $WEB_URL (the $deployment server is at $SERVER_URL). For Playwright:"
  echo
  print_env
}

status() {
  local name pid
  for name in server web; do
    pid="$(cat "$STATE_DIR/$name.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$name: running (pid $pid, log $STATE_DIR/$name.log)"
    else
      echo "$name: stopped"
    fi
  done
  [ -f "$STATE_DIR/deployment" ] && echo "deployment: $(cat "$STATE_DIR/deployment")"
  return 0
}

case "${1:-}" in
  start)
    shift
    start "$@"
    ;;
  stop)
    stop_one web
    stop_one server
    ;;
  status) status ;;
  env) print_env ;;
  -h | --help | '')
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown command '$1' (try --help)" ;;
esac
