#!/usr/bin/env bash
# Runs docker/sprites/provision.sh in a stock Ubuntu container standing in
# for a Sprite, with the stub sprite-env next to this file, and checks what it
# leaves behind: the users and ids, the files and their modes, the service
# definition, a running agent that takes the token, a screen with Chromium,
# the privileges of the Bots' commands, the version marker, that a second
# run with a new token works and rotates it, and that a third waits for one
# holding the provisioning lock. Needs Docker and network access
# (apt, nodejs.org, npm, Playwright's CDN); it takes several minutes.
#
#   bash docker/sprites/test/provision.test.sh
#
# IMAGE picks the image (default ubuntu:26.04). BUNDLE_DIR points at a built
# bundle (default docker/sprites/dist, built first if it is missing).
# Behind an HTTP proxy, set HTTPS_PROXY (passed through, with host
# networking), and TEST_CA_BUNDLE to a PEM file the container should trust.
# KEEP=1 leaves the container running for a look around. CHROMIUM_ZIP is a
# chrome-linux64.zip of the Chrome for Testing build the bundle's Playwright
# wants, for networks that block Playwright's CDN: it is put where
# Playwright looks, and provision.sh then installs only its libraries.
#
# What a container cannot show: the real sprite-env, cold wakes, the Sprite
# URL, its network policy, and whether a Sprite's uid 1000 is its login user
# (the container gets a `sprite` user with uid 1000 to stand for that case).
#
# `A && pass || fail` is meant: pass only prints. The checks are single
# quoted on purpose: they run in the container's shell, not this one.
# shellcheck disable=SC2015,SC2016
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPRITES="$(cd "$HERE/.." && pwd)"
IMAGE="${IMAGE:-ubuntu:26.04}"
BUNDLE_DIR="${BUNDLE_DIR:-$SPRITES/dist}"
NAME="openbots-sprite-test-$$"
LOGS="$(mktemp -d)"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}
cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    echo "container left running: docker exec -it $NAME bash; logs in $LOGS"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$LOGS"
  fi
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || {
  echo "Docker is not available" >&2
  exit 1
}
if [ ! -f "$BUNDLE_DIR/agent-bundle.tgz" ]; then
  bash "$SPRITES/build-bundle.sh" --out "$BUNDLE_DIR"
fi
# The provision.sh under test, not the copy in the bundle directory.
VERSION="$(cat "$BUNDLE_DIR/VERSION")"

run_args=(-d --name "$NAME" --init --hostname computer)
exec_env=()
if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
  # A proxy on the host's loopback is only reachable with host networking.
  run_args+=(--network host)
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    if [ -n "${!v:-}" ]; then exec_env+=(-e "$v"); fi
  done
fi
if [ -n "${TEST_CA_BUNDLE:-}" ]; then
  # ca-certificates adds it to the system store when apt installs it, and Node
  # reads it from NODE_EXTRA_CA_CERTS.
  run_args+=(-v "$TEST_CA_BUNDLE:/usr/local/share/ca-certificates/test-ca.crt:ro")
  exec_env+=(-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/test-ca.crt)
fi
# Nothing on 8080 may answer for the agent but the agent: with host
# networking the container shares the host's ports.
PORT="${PORT:-18080}"

docker run "${run_args[@]}" \
  -v "$SPRITES/provision.sh:/upload/provision.sh:ro" \
  -v "$BUNDLE_DIR/agent-bundle.tgz:/upload/agent-bundle.tgz:ro" \
  -v "$HERE/sprite-env:/usr/local/bin/sprite-env:ro" \
  "$IMAGE" sleep infinity >/dev/null

in_box() { docker exec "${exec_env[@]}" "$NAME" bash -c "$1"; }

if [ -n "${CHROMIUM_ZIP:-}" ]; then
  rev="$(tar -xzOf "$BUNDLE_DIR/agent-bundle.tgz" --wildcards \
    'openbots-agent-bundle/app/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/browsers.json' |
    sed -n '/"name": "chromium"/,/revision/s/.*"revision": "\([0-9]*\)".*/\1/p' | head -n1)"
  unzip -q "$CHROMIUM_ZIP" -d "$LOGS/chromium"
  docker exec "$NAME" mkdir -p "/opt/ms-playwright/chromium-$rev"
  docker cp "$LOGS/chromium/." "$NAME:/opt/ms-playwright/chromium-$rev/"
  docker exec "$NAME" bash -c "chown -R root:root /opt/ms-playwright && touch /opt/ms-playwright/chromium-$rev/INSTALLATION_COMPLETE"
fi

# A Sprite's login user, with uid 1000, in place of Ubuntu's own.
in_box 'userdel --remove ubuntu 2>/dev/null; useradd --uid 1000 --user-group --create-home --shell /bin/bash sprite'

token_a="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
token_b="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"

provision() {
  local token="$1" out="$2" start
  start="$(date +%s)"
  docker exec "${exec_env[@]}" -e OPENBOTS_AGENT_TOKEN="$token" -e OPENBOTS_AGENT_PORT="$PORT" \
    -e OPENBOTS_PROVISION_VERSION="$VERSION" -e TZ=Europe/Berlin -w /upload "$NAME" \
    bash provision.sh /upload/agent-bundle.tgz >"$out" 2>&1
  local code=$?
  echo "    took $(($(date +%s) - start)) s, exit $code"
  return $code
}
# The agent's answer with `token`: the HTTP status, and the body in $LOGS/body.
call() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  docker exec "$NAME" bash -c "curl -sS -o /tmp/body -w '%{http_code}' -X $method \
    -H 'Authorization: Bearer $token' -H 'content-type: application/json' \
    ${body:+--data '$body'} http://127.0.0.1:$PORT$path; cp /tmp/body /tmp/body.last" || true
  docker exec "$NAME" cat /tmp/body.last >"$LOGS/body" 2>/dev/null || true
}

echo "== first run"
if provision "$token_a" "$LOGS/run1.log"; then pass 'provision.sh exits 0'; else
  fail 'provision.sh exits 0'
  tail -n 30 "$LOGS/run1.log"
  exit 1
fi
grep -q -- "$token_a" "$LOGS/run1.log" && fail 'the token is not in the output' || pass 'the token is not in the output'
grep -q "moving 'sprite' from uid 1000" "$LOGS/run1.log" && pass 'the uid-1000 login user is moved' || fail 'the uid-1000 login user is moved'

echo "== users and files"
check() { in_box "$2" >/dev/null 2>&1 && pass "$1" || fail "$1"; }
check 'bot is 1000:1000 with the coders group' '[ "$(id -u bot):$(id -g bot)" = 1000:1000 ] && id -nG bot | grep -qw coders'
check 'bot is in no sudo group' '! id -nG bot | grep -qwE "sudo|admin"'
check 'sprite moved off 1000 and still has its home' '[ "$(id -u sprite)" != 1000 ] && [ "$(stat -c %u /home/sprite)" = "$(id -u sprite)" ]'
check 'cookies is 1900:1900' '[ "$(id -u cookies):$(id -g cookies)" = 1900:1900 ]'
check 'coder is 1800:1800' '[ "$(id -u coder):$(id -g coder)" = 1800:1800 ] && [ "$(getent group coders | cut -d: -f3)" = 1800 ]'
check 'coder-runner is 1801:1800' '[ "$(id -u coder-runner):$(id -g coder-runner)" = 1801:1800 ]'
check 'screen-0 and screen-89 are 2000 and 2089' '[ "$(id -u screen-0)" = 2000 ] && [ "$(id -u screen-89):$(id -g screen-89)" = 2089:2089 ]'
check '/home/bot is the bot user'"'"'s' '[ "$(stat -c %u:%g /home/bot)" = 1000:1000 ]'
check '/var/lib/openbots is root'"'"'s, 0711' '[ "$(stat -c %u:%a /var/lib/openbots)" = 0:711 ]'
check 'the token store is root'"'"'s, 0600' '[ "$(stat -c %u:%a /etc/openbots/agent-token)" = 0:600 ] && [ "$(stat -c %a /etc/openbots)" = 700 ]'
check 'the agent took and deleted its token file' '[ ! -e /var/lib/openbots/token ]'
check 'runas is root'"'"'s, 0755, static' '[ "$(stat -c %u:%a /usr/local/libexec/openbots/runas)" = 0:755 ] && ! ldd /usr/local/libexec/openbots/runas >/dev/null 2>&1'
check '/app has the subscription bridge' '[ -f /app/apps/computer-agent/dist/subscription-model.js ]'
check 'node is the bundle'"'"'s version' '[ "$(node --version)" = "$(tar -xzOf /upload/agent-bundle.tgz openbots-agent-bundle/BUILD_INFO | sed -n "s/^node_version=//p")" ]'
check 'the coding agents answer --version' 'claude --version && codex --version && pi --version'
check 'git asks the credential helper' '[ "$(git config --system credential.helper)" = /usr/local/bin/openbots-git-credential ]'
check 'the MCP catalog is installed' '[ -d /opt/openbots/mcp/node_modules ]'
check 'the version marker is written' "[ \"\$(cat /opt/openbots/provision.version)\" = '$VERSION' ]"

echo "== the service"
check 'one service, with the HTTP port and the launcher' "grep -q 'services create openbots-agent --cmd /usr/local/lib/openbots/sprite-agent --dir /home/bot --http-port $PORT' /var/lib/sprite-env-stub/calls.log"
check 'the service definition holds no token' "! grep -rq -- '$token_a' /var/lib/sprite-env-stub"
check 'the agent runs with no_new_privs' 'pid=$(pgrep -f "^/opt/openbots/node/v[0-9.]*/bin/node /app/apps/computer-agent/dist/main.js") && grep -q "^NoNewPrivs:[[:space:]]*1" /proc/$pid/status'
check 'the agent keeps only CHOWN, SETUID and SETGID' 'pid=$(pgrep -f "^/opt/openbots/node/v[0-9.]*/bin/node /app/apps/computer-agent/dist/main.js") && grep -q "^CapBnd:[[:space:]]*00000000000000c1" /proc/$pid/status'
check 'the agent runs the Node its bundle names' 'v=$(sed -n "s/^node_version=//p" "$(readlink -f /app)/../BUILD_INFO") && pgrep -f "^/opt/openbots/node/$v/bin/node /app/apps/computer-agent/dist/main.js"'
check 'node/current is that Node too' '[ "$(readlink -f /opt/openbots/node/current)" = "/opt/openbots/node/$(sed -n "s/^node_version=//p" "$(readlink -f /app)/../BUILD_INFO")" ]'
check 'the agent does not hold the provisioning lock' 'flock -n /opt/openbots/provision.lock true'
check 'the provisioning lock is root'"'"'s, 0600' '[ "$(stat -c %u:%a /opt/openbots/provision.lock)" = 0:600 ]'
check 'the agent runs as bot (effective uid)' 'pid=$(pgrep -f "^/opt/openbots/node/v[0-9.]*/bin/node /app/apps/computer-agent/dist/main.js") && [ "$(awk "/^Uid:/{print \$3}" /proc/$pid/status)" = 1000 ]'

echo "== the agent"
[ "$(call "$token_a" GET /healthz)" = 200 ] && pass 'healthz takes the token' || fail 'healthz takes the token'
[ "$(call wrong-token-wrong-token GET /healthz)" = 401 ] && pass 'healthz refuses another token' || fail 'healthz refuses another token'
code="$(call "$token_a" POST /exec '{"command":"id -u; sudo -n true 2>&1 || echo no-sudo; echo $HOME"}')"
{ [ "$code" = 200 ] && grep -q '"data":"1000' "$LOGS/body" && grep -q no-sudo "$LOGS/body"; } &&
  pass 'a command runs as bot, without sudo' || fail "a command runs as bot, without sudo ($code: $(head -c 300 "$LOGS/body"))"
code="$(call "$token_a" POST /screens '{"n":0}')"
[ "$code" = 201 ] || [ "$code" = 200 ] && pass 'a screen starts' || fail "a screen starts ($code: $(head -c 300 "$LOGS/body"))"
code="$(call "$token_a" GET /screens/0/screenshot)"
[ "$code" = 200 ] && head -c 4 "$LOGS/body" | grep -q PNG && pass 'its screenshot is a PNG' || fail "its screenshot is a PNG ($code)"
check 'Chromium runs as screen-0' 'pgrep -u screen-0 -f chrome >/dev/null'

echo "== second run, new token"
before="$(in_box 'md5sum /etc/passwd /etc/group | md5sum')"
if provision "$token_b" "$LOGS/run2.log"; then pass 'provision.sh runs again'; else
  fail 'provision.sh runs again'
  tail -n 30 "$LOGS/run2.log"
fi
grep -q -- "$token_b" "$LOGS/run2.log" && fail 'the new token is not in the output' || pass 'the new token is not in the output'
[ "$before" = "$(in_box 'md5sum /etc/passwd /etc/group | md5sum')" ] && pass 'the users are unchanged' || fail 'the users are unchanged'
grep -q 'all [0-9]* packages are installed' "$LOGS/run2.log" && pass 'apt is skipped' || fail 'apt is skipped'
grep -q '/opt/openbots/coders is up to date' "$LOGS/run2.log" && pass 'the coding agents are kept' || fail 'the coding agents are kept'
[ "$(call "$token_b" GET /healthz)" = 200 ] && pass 'the new token works' || fail 'the new token works'
[ "$(call "$token_a" GET /healthz)" = 401 ] && pass 'the old token no longer works' || fail 'the old token no longer works'
check 'no screen user is left running from the old agent' '! pgrep -u screen-0'
check 'the version marker is still written' "[ \"\$(cat /opt/openbots/provision.version)\" = '$VERSION' ]"

echo "== a run waits for one that holds the lock"
docker exec -d "$NAME" flock -o /opt/openbots/provision.lock sleep 8
sleep 1
if provision "$token_b" "$LOGS/run3.log"; then pass 'provision.sh runs once the lock is free'; else
  fail 'provision.sh runs once the lock is free'
  tail -n 30 "$LOGS/run3.log"
fi
grep -q 'another provisioning holds' "$LOGS/run3.log" && pass 'it waited for the lock' || fail 'it waited for the lock'
[ "$(call "$token_b" GET /healthz)" = 200 ] && pass 'the agent answers after it' || fail 'the agent answers after it'

echo "== dry run changes nothing"
before="$(in_box 'ls -la --time-style=full-iso /etc/openbots /opt/openbots /usr/local/bin; md5sum /etc/passwd /etc/openbots/agent-token' | md5sum)"
docker exec "${exec_env[@]}" -e PROVISION_DRY_RUN=1 -e OPENBOTS_AGENT_TOKEN="$token_a" -e OPENBOTS_AGENT_PORT="$PORT" \
  -e OPENBOTS_PROVISION_VERSION=dry -w /upload "$NAME" bash provision.sh /upload/agent-bundle.tgz >"$LOGS/dry.log" 2>&1 &&
  pass 'the dry run exits 0' || fail 'the dry run exits 0'
[ "$before" = "$(in_box 'ls -la --time-style=full-iso /etc/openbots /opt/openbots /usr/local/bin; md5sum /etc/passwd /etc/openbots/agent-token' | md5sum)" ] &&
  pass 'the dry run left the files alone' || fail 'the dry run left the files alone'
[ "$(call "$token_b" GET /healthz)" = 200 ] && pass 'the dry run left the token alone' || fail 'the dry run left the token alone'

echo "== bad settings"
docker exec -e OPENBOTS_AGENT_TOKEN=short -e OPENBOTS_PROVISION_VERSION=x -w /upload "$NAME" \
  bash provision.sh /upload/agent-bundle.tgz >"$LOGS/bad.log" 2>&1 && fail 'a short token is refused' ||
  { grep -q 'ERROR in step "check the settings"' "$LOGS/bad.log" && pass 'a short token is refused, naming the step' || fail 'a short token is refused, naming the step'; }

if [ "$failures" -gt 0 ]; then
  echo "$failures failed; logs in $LOGS"
  KEEP=1
  exit 1
fi
echo "all passed"
