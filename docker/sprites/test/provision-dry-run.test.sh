#!/usr/bin/env bash
# Checks the parts of docker/sprites/provision.sh that need no Docker and no
# root, against a small stand-in bundle (BUILD_INFO and the two lockfile
# directories a dry run reads):
#
# - the lock: a run waits for another that holds it, and one still held after
#   PROVISION_LOCK_WAIT exits 75 having changed nothing;
# - the plan's order: node/current switches next to /app, not before the
#   steps that can fail;
# - the launcher's choice of Node: the version its bundle's BUILD_INFO names,
#   else node/current.
#
#   bash docker/sprites/test/provision-dry-run.test.sh
#
# On Ubuntu (provision.sh checks /etc/os-release), with flock. What happens on
# a real machine (users, apt, the service) is docker/sprites/test/provision.test.sh.
#
# `A && pass || fail` is meant: pass only prints.
# shellcheck disable=SC2015,SC2016
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="$HERE/../provision.sh"
WORK="$(mktemp -d)"
holder=''
cleanup() {
  if [ -n "$holder" ]; then kill "$holder" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

# The stand-in bundle.
B="$WORK/src/openbots-agent-bundle"
mkdir -p "$B/coders" "$B/mcp-catalog"
printf 'node_version=v24.1.0\narch=x64\nsource=test\n' >"$B/BUILD_INFO"
for d in coders mcp-catalog; do
  printf '{"name":"%s","version":"0.0.0"}\n' "$d" >"$B/$d/package.json"
  printf '{"lockfileVersion":3}\n' >"$B/$d/package-lock.json"
done
tar -czf "$WORK/bundle.tgz" -C "$WORK/src" openbots-agent-bundle
LOCK="$WORK/provision.lock"

# Runs a dry run with the lock at $LOCK; output in $WORK/out, exit code returned.
dry_run() {
  local code=0
  PROVISION_DRY_RUN=1 OPENBOTS_AGENT_TOKEN=test-dry-run-token-0000 OPENBOTS_AGENT_PORT=8080 \
    OPENBOTS_PROVISION_VERSION=test PROVISION_LOCK_FILE="$LOCK" "$@" \
    bash "$PROVISION" "$WORK/bundle.tgz" >"$WORK/out" 2>&1 || code=$?
  return "$code"
}
# Holds $LOCK for `seconds` in the background; $holder is its pid.
hold_lock() {
  # -o: the lock is flock's own, so killing it lets the lock go.
  flock -o "$LOCK" sleep "$1" &
  holder=$!
  for _ in $(seq 50); do
    if ! flock -n "$LOCK" true; then return 0; fi
    sleep 0.1
  done
  echo "could not take the lock in the background" >&2
  exit 1
}

echo "== the lock"
if dry_run; then pass 'a dry run with the lock free exits 0'; else
  fail 'a dry run with the lock free exits 0'
  tail -n 20 "$WORK/out"
fi
grep -q "holding $LOCK" "$WORK/out" && pass 'it takes the lock' || fail 'it takes the lock'
flock -n "$LOCK" true && pass 'it lets the lock go when it ends' || fail 'it lets the lock go when it ends'
[ "$(stat -c %a "$LOCK")" = 600 ] && pass 'the lock file is 0600' || fail 'the lock file is 0600'

hold_lock 30
code=0
dry_run env PROVISION_LOCK_WAIT=1 || code=$?
[ "$code" = 75 ] && pass 'a run that cannot get the lock exits 75' || fail "a run that cannot get the lock exits 75 (got $code)"
grep -q 'another provisioning still holds' "$WORK/out" && pass 'and says so' || fail 'and says so'
grep -q '== unpack the agent bundle' "$WORK/out" && fail 'and stops before changing anything' ||
  pass 'and stops before changing anything'
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
holder=''

hold_lock 2
start="$(date +%s)"
if dry_run env PROVISION_LOCK_WAIT=30; then pass 'a run waits for the lock and then runs'; else
  fail 'a run waits for the lock and then runs'
  tail -n 20 "$WORK/out"
fi
grep -q "waiting up to 30 s" "$WORK/out" && pass 'it says it waits' || fail 'it says it waits'
[ $(($(date +%s) - start)) -ge 1 ] && pass 'it waited' || fail 'it waited'
wait "$holder" 2>/dev/null || true
holder=''

echo "== the plan's order"
dry_run
line_of() { grep -n -m 1 -F -- "$1" "$WORK/out" | cut -d: -f1 || true; }
app_line="$(line_of '/app.new /app')"
current_line="$(line_of '/opt/openbots/node/current.new /opt/openbots/node/current')"
chromium_line="$(line_of '== install Chromium')"
service_line="$(line_of '== register the service')"
if [ -n "$app_line" ] && [ -n "$current_line" ] && [ -n "$chromium_line" ] && [ -n "$service_line" ] &&
  [ "$chromium_line" -lt "$app_line" ] && [ "$app_line" -lt "$current_line" ] && [ "$current_line" -lt "$service_line" ]; then
  pass 'node/current switches right after /app, after the steps that can fail'
else
  fail "node/current switches right after /app (chromium $chromium_line, /app $app_line, current $current_line, service $service_line)"
fi
[ -n "$app_line" ] && ! head -n "$app_line" "$WORK/out" | grep -q -F 'node/current' &&
  pass 'nothing touches node/current before /app switches' ||
  fail 'nothing touches node/current before /app switches'
! grep -q -F -- 'test-dry-run-token-0000' "$WORK/out" && pass 'the token is not in the output' ||
  fail 'the token is not in the output'

echo "== the launcher's Node"
# The launcher's own lines, as provision.sh writes them, on stand-in paths.
snippet="$(sed -n '/^# --- node: begin$/,/^# --- node: end$/p' "$PROVISION")"
[ -n "$snippet" ] && pass 'the launcher has its Node choice' || fail 'the launcher has its Node choice'
grep -q -F '"$node" /app/apps/computer-agent/dist/main.js' "$PROVISION" &&
  pass 'the launcher runs the Node it chose' || fail 'the launcher runs the Node it chose'
node_for() {
  APP="$1" NODE_ROOT="$WORK/node" bash -c "set -euo pipefail
$snippet
printf %s \"\$node\"" 2>/dev/null
}
mkdir -p "$WORK/node/v22.11.0/bin" "$WORK/node/v24.1.0/bin" "$WORK/node/current"
for v in v22.11.0 v24.1.0; do
  printf '#!/bin/sh\n' >"$WORK/node/$v/bin/node"
  chmod +x "$WORK/node/$v/bin/node"
done
mk_bundle() {
  mkdir -p "$WORK/bundles/$1/openbots-agent-bundle/app"
  if [ -n "$2" ]; then printf '%s\n' "$2" >"$WORK/bundles/$1/openbots-agent-bundle/BUILD_INFO"; fi
  ln -sfn "$WORK/bundles/$1/openbots-agent-bundle/app" "$WORK/app-$1"
}
mk_bundle old 'node_version=v22.11.0'
mk_bundle new $'arch=x64\nnode_version=v24.1.0'
mk_bundle gone 'node_version=v20.0.0'
mk_bundle none ''
mk_bundle odd 'node_version=../../../bin/sh'
[ "$(node_for "$WORK/app-old")" = "$WORK/node/v22.11.0/bin/node" ] &&
  pass 'the previous bundle runs the Node it names (a rollback)' || fail "the previous bundle runs the Node it names: $(node_for "$WORK/app-old")"
[ "$(node_for "$WORK/app-new")" = "$WORK/node/v24.1.0/bin/node" ] &&
  pass 'the new bundle runs its own' || fail "the new bundle runs its own: $(node_for "$WORK/app-new")"
for b in gone none odd; do
  [ "$(node_for "$WORK/app-$b")" = "$WORK/node/current/bin/node" ] &&
    pass "a bundle naming no installed Node ($b) runs node/current" ||
    fail "a bundle naming no installed Node ($b) runs node/current: $(node_for "$WORK/app-$b")"
done

if [ "$failures" -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
