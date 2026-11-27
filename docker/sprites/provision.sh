#!/usr/bin/env bash
# Turns a stock Ubuntu Sprite (Fly.io) into an OpenBots computer: what
# docker/computer.Dockerfile bakes into the computer image, installed by
# script, because a Sprite cannot boot a custom image. The server's Sprite
# provider uploads this file and an agent bundle (docker/sprites/
# build-bundle.sh) and runs, as root or as a user with passwordless sudo:
#
#   bash provision.sh /path/to/agent-bundle.tgz
#
# with OPENBOTS_AGENT_TOKEN (the bearer token the control agent requires),
# OPENBOTS_AGENT_PORT (the Sprite URL's port, 8080), OPENBOTS_PROVISION_VERSION
# and TZ in the environment. On success it has written
# OPENBOTS_PROVISION_VERSION to /opt/openbots/provision.version and exits 0.
#
# It is safe to run again: for an upgrade (a new bundle), to rotate the token,
# or after a run that failed half way. Each step checks what is already there,
# and a run that fails leaves the agent that ran before it runnable. One run
# at a time: a second one waits for the first's lock, and exits 75 if it is
# still held after PROVISION_LOCK_WAIT seconds (default 300).
# PROVISION_DRY_RUN=1 prints what it would change and changes nothing.
#
# docker/sprites/README.md describes the contract, the service it registers
# and where a Sprite differs from the container.
set -Eeuo pipefail
umask 022

readonly SELF="${BASH_SOURCE[0]}"
readonly DRY_RUN="${PROVISION_DRY_RUN:-0}"

# The image's layout (docker/computer.Dockerfile). The ids are fixed: runas.c,
# apps/computer-agent/src/users.ts and packages/shared coder-runtime.ts name
# them by number.
readonly BOT_ID=1000
readonly COOKIES_ID=1900
readonly CODERS_GID=1800
readonly CODER_ID=1800
readonly RUNNER_ID=1801
readonly SCREEN_ID_BASE=2000
readonly SCREENS=90 # screen-0 .. screen-89, as the image creates them
readonly HOME_DIR=/home/bot
readonly STATE_DIR=/var/lib/openbots
readonly OPT=/opt/openbots
readonly APP_LINK=/app
readonly BUNDLES_DIR="$OPT/bundles"
readonly CODERS_DIR="$OPT/coders"
readonly MCP_DIR="$OPT/mcp"
readonly NODE_ROOT="$OPT/node"
readonly BROWSERS_DIR=/opt/ms-playwright
readonly RUNAS=/usr/local/libexec/openbots/runas
readonly CONF_DIR=/etc/openbots
readonly TOKEN_STORE="$CONF_DIR/agent-token"
readonly AGENT_ENV="$CONF_DIR/agent.env"
readonly LAUNCHER=/usr/local/lib/openbots/sprite-agent
readonly SERVICE=openbots-agent
readonly VERSION_FILE="$OPT/provision.version"
# Exit code when another provisioning holds the lock (EX_TEMPFAIL);
# PROVISION_LOCKED_EXIT in packages/computer/src/sprites.ts.
readonly LOCKED_EXIT=75

# The image's packages (docker/computer.Dockerfile, runtime stage), which all
# exist under these names on Ubuntu 26.04 (checked against the ubuntu:26.04
# archive). Then what the image builds in other stages and a Sprite has to
# build itself: gcc and libc6-dev for the static runas helper, make and g++
# for node-pty if its prebuilt binding does not load here.
readonly PACKAGES=(
  xvfb openbox x11vnc xdotool feh imagemagick tini tzdata
  fonts-dejavu-core fonts-liberation fonts-noto-color-emoji
  ca-certificates curl git less nano procps python3 unzip xz-utils util-linux
  gcc libc6-dev make g++
)

STEP='start'
log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
step() {
  STEP="$1"
  log "== $STEP"
}
die() {
  printf '[provision] ERROR in step "%s": %s\n' "$STEP" "$*" >&2
  exit 1
}
on_error() {
  local code=$? line=$1
  # A subshell leaves the report to the script itself.
  [ "$BASHPID" = "$$" ] || exit "$code"
  printf '[provision] FAILED in step "%s" (line %s, exit %s). Re-running is safe once the cause is fixed.\n' \
    "$STEP" "$line" "$code" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

dry() { [ "$DRY_RUN" = 1 ]; }
# A conflict stops a real run; a dry run reports it and goes on, since an
# earlier step it only printed may be what would have resolved it.
conflict() {
  if dry; then log "[dry-run] would stop here unless resolved: $*"; else die "$*"; fi
}
# Runs a command that changes the system, or in a dry run prints it. Never
# pass the token as an argument: it would show here and in `ps`.
act() {
  if dry; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}
# Writes stdin to `path` with `mode` and `owner` (user:group), atomically.
write_file() {
  local path="$1" mode="$2" owner="$3" tmp
  if dry; then
    cat >/dev/null
    printf '[dry-run] write %s (mode %s, %s)\n' "$path" "$mode" "$owner"
    return 0
  fi
  # Only a missing directory: install -d would reset an existing one's mode
  # (/etc/openbots is 0700).
  [ -d "$(dirname "$path")" ] || install -d -m 0755 "$(dirname "$path")"
  tmp="$(mktemp "$path.XXXXXX")"
  cat >"$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
}

# --- arguments and environment --------------------------------------------------

[ "$#" -eq 1 ] || die "usage: bash provision.sh /path/to/agent-bundle.tgz"
BUNDLE="$(readlink -f -- "$1")" || die "cannot resolve $1"
if [ ! -f "$BUNDLE" ] || [ ! -r "$BUNDLE" ]; then die "no readable bundle at $1"; fi

# Root is needed for apt, users and the service. sudo keeps only the variables
# named here; the token stays out of the command line.
if [ "$(id -u)" -ne 0 ] && ! dry; then
  command -v sudo >/dev/null || die "must run as root (no sudo here)"
  exec sudo -n --preserve-env=OPENBOTS_AGENT_TOKEN,OPENBOTS_AGENT_PORT,OPENBOTS_PROVISION_VERSION,TZ,PROVISION_DRY_RUN \
    bash "$SELF" "$BUNDLE"
fi

step 'check the settings'
TOKEN="${OPENBOTS_AGENT_TOKEN:-}"
PORT="${OPENBOTS_AGENT_PORT:-8080}"
PROVISION_VERSION="${OPENBOTS_PROVISION_VERSION:-}"
ZONE="${TZ:-UTC}"
# The provider's tokens are base64url (packages/computer token-archive.ts);
# the agent wants at least 16 characters.
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{16,512}$ ]] ||
  die "OPENBOTS_AGENT_TOKEN must be 16 to 512 base64url characters (it is not printed)"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "OPENBOTS_AGENT_PORT must be a port number, got '$PORT'"
fi
[[ "$PROVISION_VERSION" =~ ^[A-Za-z0-9._+:-]{1,128}$ ]] ||
  die "OPENBOTS_PROVISION_VERSION must be set (letters, digits and ._+:-), got '$PROVISION_VERSION'"
[[ "$ZONE" =~ ^[A-Za-z0-9_+/-]{1,64}$ ]] || die "TZ must be a zone name like Europe/Berlin, got '$ZONE'"
# Nothing below needs the token in the environment, and nothing we start
# should inherit it.
unset OPENBOTS_AGENT_TOKEN

# In a subshell: os-release sets VERSION and NAME among others.
os_id="$(. /etc/os-release && echo "${ID:-}")"
os_version="$(. /etc/os-release && echo "${VERSION_ID:-}")"
os_name="$(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")"
[ "$os_id" = ubuntu ] || die "expected Ubuntu, found $os_name"
[ "$os_version" = 26.04 ] || log "note: written for Ubuntu 26.04, this is $os_name"
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "no Node build for $(uname -m)" ;;
esac
log "bundle $BUNDLE, port $PORT, version $PROVISION_VERSION, TZ $ZONE"
if dry; then log "dry run: nothing is changed"; fi

# --- one run at a time --------------------------------------------------------------

step 'take the provisioning lock'
# A second run beside this one (a retry while a timed out run is still being
# ended, two starts at once) would remove this one's half made directories,
# register the service again and store another token. It waits instead: the
# provider bounds a run it lost touch with (max_run_after_disconnect, then it
# kills the session), and a re-run takes under a minute. Past the wait it
# exits LOCKED_EXIT having changed nothing, which the provider reports as a
# failure. The lock is root's and 0600, so a Bot cannot take it; it is held
# by this process and the children that keep descriptor 9, and released when
# they end. Long lived children (the service sprite-env starts) do not get it.
LOCK_FILE="${PROVISION_LOCK_FILE:-$OPT/provision.lock}"
LOCK_WAIT="${PROVISION_LOCK_WAIT:-300}"
[[ "$LOCK_WAIT" =~ ^[0-9]{1,5}$ ]] || die "PROVISION_LOCK_WAIT must be whole seconds, got '$LOCK_WAIT'"
if dry && [ -z "${PROVISION_LOCK_FILE:-}" ]; then
  log "[dry-run] take $LOCK_FILE, waiting up to $LOCK_WAIT s for another run"
else
  if [ -z "${PROVISION_LOCK_FILE:-}" ]; then install -d -m 0755 -o root -g root "$OPT"; fi
  (
    umask 077
    : >>"$LOCK_FILE"
  )
  chmod 0600 "$LOCK_FILE"
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another provisioning holds $LOCK_FILE; waiting up to $LOCK_WAIT s for it to end"
    if ! flock -w "$LOCK_WAIT" 9; then
      printf '[provision] another provisioning still holds %s after %s s. Nothing was changed; run again once it has ended.\n' \
        "$LOCK_FILE" "$LOCK_WAIT" >&2
      exit "$LOCKED_EXIT"
    fi
  fi
  log "holding $LOCK_FILE"
fi

# --- the bundle ----------------------------------------------------------------

step 'unpack the agent bundle'
BUNDLE_ID="$(sha256sum "$BUNDLE" | cut -c1-16)"
BUNDLE_DIR="$BUNDLES_DIR/$BUNDLE_ID"
if dry; then
  # Read what we need without unpacking.
  DRY_TMP="$(mktemp -d)"
  trap 'rm -rf "$DRY_TMP"' EXIT
  tar -xzf "$BUNDLE" -C "$DRY_TMP" openbots-agent-bundle/BUILD_INFO \
    openbots-agent-bundle/coders openbots-agent-bundle/mcp-catalog
  SRC="$DRY_TMP/openbots-agent-bundle"
  log "[dry-run] unpack into $BUNDLE_DIR"
elif [ -f "$BUNDLE_DIR/.complete" ]; then
  log "already unpacked in $BUNDLE_DIR"
  SRC="$BUNDLE_DIR/openbots-agent-bundle"
else
  install -d -m 0755 "$BUNDLES_DIR"
  rm -rf "$BUNDLE_DIR.partial"
  install -d -m 0755 "$BUNDLE_DIR.partial"
  tar -xzf "$BUNDLE" -C "$BUNDLE_DIR.partial" --no-same-owner
  chmod -R a+rX,go-w "$BUNDLE_DIR.partial"
  touch "$BUNDLE_DIR.partial/.complete"
  rm -rf "$BUNDLE_DIR"
  mv "$BUNDLE_DIR.partial" "$BUNDLE_DIR"
  SRC="$BUNDLE_DIR/openbots-agent-bundle"
fi
[ -f "$SRC/BUILD_INFO" ] || die "the bundle has no openbots-agent-bundle/BUILD_INFO; build it with docker/sprites/build-bundle.sh"
build_info() { sed -n "s/^$1=//p" "$SRC/BUILD_INFO"; }
NODE_VERSION="${OPENBOTS_NODE_VERSION:-$(build_info node_version)}"
NODE_VERSION="${NODE_VERSION#v}"
[[ "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] ||
  die "the bundle names Node '$NODE_VERSION'; the image runs Node 24 (node:24-bookworm-slim)"
log "bundle $BUNDLE_ID built with Node $NODE_VERSION on $(build_info arch) from $(build_info source)"

# --- system packages -----------------------------------------------------------

step 'install the system packages'
missing=()
for pkg in "${PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
done
export DEBIAN_FRONTEND=noninteractive
if [ "${#missing[@]}" -gt 0 ]; then
  log "installing: ${missing[*]}"
  # A run ended mid install (its session killed) can leave dpkg half done,
  # which apt refuses to work on until this finishes it. A no-op otherwise.
  act dpkg --configure -a
  act apt-get -o DPkg::Lock::Timeout=300 update -q
  act apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "${missing[@]}"
else
  log "all ${#PACKAGES[@]} packages are installed"
fi

# --- Node ----------------------------------------------------------------------

# The image copies node from node:24-bookworm-slim. Here the official build
# of the exact version the bundle was built with, so node-pty's binding
# matches its ABI, checked against nodejs.org's SHASUMS256.txt. It goes under
# /opt/openbots/node/v<version>, beside the versions earlier bundles use: the
# agent's launcher runs the version its bundle names, so the bundle kept for
# a rollback still finds its own. This run uses it from here on; it becomes
# node/current and /usr/local/bin/node (where the image has it and the coding
# agents' launchers find it) only when /app switches to this bundle, below.
step "install Node $NODE_VERSION"
NODE_DIR="$NODE_ROOT/v$NODE_VERSION"
NODE_BIN="$NODE_DIR/bin/node"
if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" --version)" = "v$NODE_VERSION" ]; then
  log "already installed in $NODE_DIR"
elif dry; then
  log "[dry-run] download node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz into $NODE_DIR"
else
  tmp="$(mktemp -d)"
  name="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  # The provider's egress policy allows nodejs.org (SPRITES_PROVISION_DOMAINS
  # in packages/computer/src/sprites.ts).
  curl -fsSL --retry 3 -o "$tmp/$name" "https://nodejs.org/dist/v$NODE_VERSION/$name"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep "  $name\$" SHASUMS256.txt | sha256sum -c -) || die "checksum mismatch for $name"
  install -d -m 0755 "$NODE_ROOT"
  rm -rf "$NODE_DIR.partial"
  install -d -m 0755 "$NODE_DIR.partial"
  tar -xJf "$tmp/$name" -C "$NODE_DIR.partial" --strip-components=1 --no-same-owner
  rm -rf "$tmp" "$NODE_DIR"
  mv "$NODE_DIR.partial" "$NODE_DIR"
fi
export PATH="$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- users and groups ----------------------------------------------------------

step 'create the users and groups'
# Ubuntu's own uid 1000 makes way, as in the image. On a Sprite uid 1000 may
# instead be its login user (`sprite`): that one is moved to a free id rather
# than deleted, so `sprite console` keeps working, and the bot user takes
# 1000, which runas.c requires.
# UNVERIFIED on a real Sprite: which user holds uid 1000, and that the
# runtime starts exec sessions by user name, so moving it is harmless.
free_id() {
  local id
  for id in $(seq 1001 1099); do
    if ! getent passwd "$id" >/dev/null && ! getent group "$id" >/dev/null; then
      echo "$id"
      return 0
    fi
  done
  die "no free uid between 1001 and 1099"
}
holder="$(getent passwd "$BOT_ID" | cut -d: -f1 || true)"
if [ -n "$holder" ] && [ "$holder" != bot ]; then
  if pgrep -u "$BOT_ID" >/dev/null; then
    die "uid $BOT_ID belongs to '$holder', which has running processes (perhaps the session that runs
this script), so it cannot be moved. The bot user must be uid $BOT_ID (apps/computer-agent/native/runas.c).
Run provision.sh from a session that is not '$holder', or move it by hand: usermod -u <id> $holder"
  fi
  if [ "$holder" = ubuntu ]; then
    log "removing Ubuntu's own user 'ubuntu' (uid $BOT_ID), as the image does"
    act userdel --remove ubuntu
    if getent group ubuntu >/dev/null; then act groupdel ubuntu; fi
  else
    new="$(free_id)"
    log "moving '$holder' from uid $BOT_ID to $new so that bot can have $BOT_ID"
    holder_home="$(getent passwd "$holder" | cut -d: -f6)"
    act usermod -u "$new" "$holder"
    if [ "$(getent group "$BOT_ID" | cut -d: -f1)" = "$holder" ]; then
      act groupmod -g "$new" "$holder"
      [ -d "$holder_home" ] && act chown -R -h --from=":$BOT_ID" ":$new" "$holder_home"
    fi
  fi
fi
group_holder="$(getent group "$BOT_ID" | cut -d: -f1 || true)"
if [ -n "$group_holder" ] && [ "$group_holder" != bot ]; then
  conflict "gid $BOT_ID belongs to group '$group_holder'; the bot user's group must be gid $BOT_ID"
fi

# Creates group `name` with `gid`, or checks the one that exists.
ensure_group() {
  local name="$1" gid="$2" have
  have="$(getent group "$name" | cut -d: -f3 || true)"
  if [ -z "$have" ]; then
    getent group "$gid" >/dev/null && conflict "gid $gid is taken by $(getent group "$gid" | cut -d: -f1), needed for $name"
    act groupadd --gid "$gid" "$name"
  elif [ "$have" != "$gid" ]; then
    conflict "group $name exists with gid $have, expected $gid"
  fi
}
# Creates user `name` (uid, gid, home, shell), or checks and corrects the one
# that exists. The homes under the state directory are the agent's to lay out.
ensure_user() {
  local name="$1" uid="$2" gid="$3" home="$4" shell="$5" entry
  entry="$(getent passwd "$name" || true)"
  if [ -z "$entry" ]; then
    getent passwd "$uid" >/dev/null && conflict "uid $uid is taken by $(getent passwd "$uid" | cut -d: -f1), needed for $name"
    act useradd --uid "$uid" --gid "$gid" --no-create-home --home-dir "$home" --shell "$shell" "$name"
    return 0
  fi
  [ "$(cut -d: -f3 <<<"$entry")" = "$uid" ] || conflict "user $name exists with uid $(cut -d: -f3 <<<"$entry"), expected $uid"
  if [ "$(cut -d: -f4 <<<"$entry")" != "$gid" ] || [ "$(cut -d: -f6 <<<"$entry")" != "$home" ] ||
    [ "$(cut -d: -f7 <<<"$entry")" != "$shell" ]; then
    act usermod --gid "$gid" --home "$home" --shell "$shell" "$name"
  fi
}

ensure_group bot "$BOT_ID"
ensure_user bot "$BOT_ID" "$BOT_ID" "$HOME_DIR" /bin/bash
ensure_group cookies "$COOKIES_ID"
ensure_user cookies "$COOKIES_ID" "$COOKIES_ID" "$STATE_DIR/cookies" /usr/sbin/nologin
ensure_group coders "$CODERS_GID"
ensure_user coder "$CODER_ID" "$CODERS_GID" "$STATE_DIR/coders/home" /bin/bash
ensure_user coder-runner "$RUNNER_ID" "$CODERS_GID" "$STATE_DIR/coders/runner-home" /usr/sbin/nologin
# The bot user shares the repositories with coder through the coders group
# (I2), and nothing else: in particular no sudo or admin group.
if ! dry || getent passwd bot >/dev/null; then
  current="$(id -nG bot 2>/dev/null || true)"
  [[ " $current " == *" coders "* ]] || act usermod -aG coders bot
  for g in sudo admin wheel; do
    if [[ " $current " == *" $g "* ]]; then act gpasswd -d bot "$g"; fi
  done
fi
for n in $(seq 0 $((SCREENS - 1))); do
  ensure_group "screen-$n" $((SCREEN_ID_BASE + n))
  ensure_user "screen-$n" $((SCREEN_ID_BASE + n)) $((SCREEN_ID_BASE + n)) \
    "$STATE_DIR/screens/screen-$n" /usr/sbin/nologin
done

step 'lay out the home and the state directory'
# The image makes /home/bot with useradd --create-home (so it holds the
# skeleton files) and the state directory root's, mode 0711. The agent lays
# out everything inside the state directory itself at each start
# (privileges.ts layOut), the cookie store and the coders' homes included.
if [ ! -d "$HOME_DIR" ]; then
  act install -d -m 0750 -o "$BOT_ID" -g "$BOT_ID" "$HOME_DIR"
  act cp -rT /etc/skel "$HOME_DIR"
  act chown -R "$BOT_ID:$BOT_ID" "$HOME_DIR"
else
  # After a uid move the home may still carry an old owner; only its top.
  act chown "$BOT_ID:$BOT_ID" "$HOME_DIR"
fi
act install -d -m 0711 -o root -g root "$STATE_DIR"
act install -d -m 0755 -o root -g root "$OPT"

# --- the application -----------------------------------------------------------

step 'build the runas helper'
# The image builds it static in its build stage (no dynamic loader reads LD_*
# for it); here from the same source, for this machine's architecture.
if dry; then
  log "[dry-run] gcc -O2 -Wall -Werror -static -o $RUNAS runas.c"
else
  tmp="$(mktemp -d)"
  gcc -O2 -Wall -Werror -static -o "$tmp/runas" "$SRC/native/runas.c"
  if ! cmp -s "$tmp/runas" "$RUNAS" 2>/dev/null; then
    install -D -m 0755 -o root -g root "$tmp/runas" "$RUNAS"
  fi
  rm -rf "$tmp"
fi

step 'check node-pty'
# The bundle carries node-pty compiled on the build machine. If that binding
# does not load here (another architecture or an older glibc), compile it
# again with npm's own node-gyp against this Node's headers, as the image's
# prod-deps stage compiles it on the target platform.
pty_loads() { (cd "$SRC/app/apps/computer-agent" && node -e "require(require.resolve('node-pty'))") 2>/dev/null; }
if dry; then
  log "[dry-run] load node-pty from the bundle, rebuild it if it does not load"
elif pty_loads; then
  log "node-pty loads"
else
  log "node-pty does not load here; rebuilding it"
  pty_dir="$(cd "$SRC/app/apps/computer-agent" && node -p "require('path').dirname(require.resolve('node-pty/package.json'))")"
  gyp="$NODE_DIR/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  (cd "$pty_dir" && node "$gyp" rebuild --release --nodedir="$NODE_DIR")
  chmod -R a+rX "$pty_dir"
  pty_loads || die "node-pty still does not load after the rebuild"
fi

# Installs docker/<name>/package-lock.json into `target` the way the image's
# stage does (npm ci, no install scripts), unless that lockfile is already
# installed there. It builds beside the old one and swaps, so a failure
# leaves the old install working. `check` runs in the new directory first.
npm_install() {
  local name="$1" target="$2" check="$3" sum
  sum="$(cat "$SRC/$name/package.json" "$SRC/$name/package-lock.json" | sha256sum | cut -c1-64)"
  if [ "$(cat "$target/.openbots-lock.sha256" 2>/dev/null || true)" = "$sum" ]; then
    log "$target is up to date"
    return 0
  fi
  if dry; then
    log "[dry-run] npm ci --omit=dev --ignore-scripts into $target"
    return 0
  fi
  rm -rf "$target.new"
  install -d -m 0755 "$target.new"
  cp "$SRC/$name/package.json" "$SRC/$name/package-lock.json" "$target.new/"
  local cache
  cache="$(mktemp -d)"
  (cd "$target.new" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$cache")
  rm -rf "$cache"
  (cd "$target.new" && eval "$check")
  printf '%s\n' "$sum" >"$target.new/.openbots-lock.sha256"
  chown -R root:root "$target.new"
  chmod -R a+rX,go-w "$target.new"
  rm -rf "$target.old"
  if [ -e "$target" ]; then mv "$target" "$target.old"; fi
  mv "$target.new" "$target"
  rm -rf "$target.old"
}

step 'install the MCP catalog servers'
# Root's: the Bots can run the catalog's stdio servers but not change them.
npm_install mcp-catalog "$MCP_DIR" 'true'

step 'install the coding agents'
# docker/computer.Dockerfile, coders stage: Claude Code's postinstall by hand
# (it puts the native binary in place), then each CLI answers --version and
# is exactly its pinned version.
# shellcheck disable=SC2016 # the template literals are for node
CODERS_CHECK='node node_modules/@anthropic-ai/claude-code/install.cjs \
  && node_modules/@anthropic-ai/claude-code/bin/claude.exe --version \
  && node node_modules/@openai/codex/bin/codex.js --version \
  && node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version \
  && node -e '"'"'
    const want = require("./package.json").dependencies;
    for (const name of Object.keys(want)) {
      const have = require(`./node_modules/${name}/package.json`).version;
      if (have !== want[name]) { console.error(`${name}: installed ${have}, pinned ${want[name]}`); process.exit(1); }
      console.log(`${name} ${have}`);
    }'"'"
npm_install coders "$CODERS_DIR" "$CODERS_CHECK"

step 'install the launchers and git settings'
# The same launchers as the image (docker/computer.Dockerfile): Claude Code
# and Codex hold openbots-auth.lock while a credential-owning session runs,
# pi runs its bundle, and git asks the agent's credential helper (I5).
agents="$CODERS_DIR/node_modules"
# shellcheck disable=SC2016 # $1, $HOME and friends are for the launchers
{
  printf '#!/bin/sh\ncli=%s\ncase "$1:$2" in --version:*|auth:status) exec "$cli" "$@";; esac\ndir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}\nmkdir -p "$dir"\nexec flock -x "$dir/openbots-auth.lock" "$cli" "$@"\n' \
    "$agents/@anthropic-ai/claude-code/bin/claude.exe" | write_file /usr/local/bin/claude 0755 root:root
  printf '#!/bin/sh\ncli=%s\ncase "$1:$2" in --version:*|login:status) exec node "$cli" "$@";; esac\ndir=${CODEX_HOME:-$HOME/.codex}\nmkdir -p "$dir"\nexec flock -x "$dir/openbots-auth.lock" node "$cli" "$@"\n' \
    "$agents/@openai/codex/bin/codex.js" | write_file /usr/local/bin/codex 0755 root:root
  printf '#!/bin/sh\nexec node %s "$@"\n' "$agents/@earendil-works/pi-coding-agent/dist/bundle/cli.js" |
    write_file /usr/local/bin/pi 0755 root:root
  printf '#!/bin/sh\nexec node %s "$@"\n' /app/apps/computer-agent/dist/git-credential-helper.js |
    write_file /usr/local/bin/openbots-git-credential 0755 root:root
}
act git config --system credential.helper /usr/local/bin/openbots-git-credential
act git config --system credential.useHttpPath true
act git config --system init.defaultBranch main

step 'install Chromium'
# The image's Chromium: Playwright's build for the bundled playwright-core,
# with the system libraries it needs, no headless shell. Not Ubuntu's
# chromium package, which is a snap, and snapd needs systemd, which a Sprite
# does not run.
# The provider's egress policy allows Playwright's two download hosts and the
# Ubuntu archive (SPRITES_PROVISION_DOMAINS in packages/computer/src/sprites.ts).
# UNVERIFIED on a real Sprite: that its apt sources use those archive hosts
# and not a mirror of its own.
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"
pw_cli="$SRC/app/apps/computer-agent/node_modules/playwright-core/cli.js"
chromium_path() { (cd "$SRC/app/apps/computer-agent" && node -e "process.stdout.write(require('playwright-core').chromium.executablePath())"); }
if dry; then
  log "[dry-run] node playwright-core/cli.js install --with-deps --no-shell chromium"
elif [ -x "$(chromium_path)" ]; then
  log "Chromium is installed: $(chromium_path)"
  # Its system libraries can go missing (an OS upgrade, a Chromium put there
  # by hand); Playwright installs them again.
  if ldd "$(chromium_path)" | grep -q 'not found'; then
    node "$pw_cli" install-deps chromium
  fi
else
  # Playwright knows Ubuntu up to the release it was built for; on a newer
  # one it installs the dependencies of the newest it knows, with a warning.
  # UNVERIFIED on a real Sprite: Playwright's dependency list on Ubuntu 26.04
  # (checked only in the ubuntu:26.04 container, docker/sprites/test).
  node "$pw_cli" install --with-deps --no-shell chromium
  chmod -R a+rX "$BROWSERS_DIR"
fi
if ! dry; then
  chrome="$(chromium_path)"
  [ -x "$chrome" ] || die "Chromium is not at $chrome after the install"
  missing_libs="$(ldd "$chrome" | grep 'not found' || true)"
  [ -z "$missing_libs" ] || die "Chromium is missing libraries: $missing_libs"
fi

# --- the agent's settings and launcher ------------------------------------------

step 'store the agent token and settings'
# The token in a root-only file, never in the service definition or the
# environment: the launcher copies it to where the agent reads and deletes it
# (S-7) at every start, so a cold boot and a crash restart find it too.
if dry; then
  log "[dry-run] write $TOKEN_STORE (mode 0600, root), contents not shown"
else
  install -d -m 0700 -o root -g root "$CONF_DIR"
  chmod 0700 "$CONF_DIR"
  (
    umask 077
    printf '%s' "$TOKEN" >"$TOKEN_STORE.new"
  )
  chown root:root "$TOKEN_STORE.new"
  mv -f "$TOKEN_STORE.new" "$TOKEN_STORE"
fi
TOKEN=''
printf 'OPENBOTS_AGENT_PORT=%s\nTZ=%s\n' "$PORT" "$ZONE" | write_file "$AGENT_ENV" 0600 root:root

step 'install the agent launcher'
# What the runtime starts as the service. It does at each start what the
# container gives the agent (docker/computer.Dockerfile and the provider's
# containerSpec in packages/computer docker.ts), as far as a VM can.
write_file "$LAUNCHER" 0755 root:root <<'LAUNCHER'
#!/usr/bin/env bash
# The OpenBots control agent as a Sprite service, written by
# docker/sprites/provision.sh. The Sprite runtime starts it at boot, after a
# cold wake and after a crash.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exec sudo -n "$0" "$@"; fi
# shellcheck disable=SC1091
. /etc/openbots/agent.env
readonly APP=/app NODE_ROOT=/opt/openbots/node

# The Node the bundle at /app was built with, from its BUILD_INFO: its
# node-pty binding is built for that version, and provision.sh keeps every
# version a kept bundle names. So /app pointed back at the previous bundle (a
# rollback) runs that bundle's Node, and a provisioning that failed before
# switching /app leaves the old bundle on its own Node. A bundle that names
# none, or one not installed, runs node/current.
# --- node: begin
app="$(readlink -f "$APP")"
want="$(sed -n 's/^node_version=v\{0,1\}//p' "${app%/*}/BUILD_INFO" 2>/dev/null | head -n 1 || true)"
node="$NODE_ROOT/current/bin/node"
if [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -x "$NODE_ROOT/v$want/bin/node" ]; then
  node="$NODE_ROOT/v$want/bin/node"
else
  echo "sprite-agent: no Node ${want:-named} for $app; running $node" >&2
fi
# --- node: end

# A container starts empty; a service restarted after a crash finds what the
# last agent started (Xvfb, Chromium, the Bots' shells) still running. They
# all live in one cgroup, which is emptied first, the way stopping the
# container ends them.
# UNVERIFIED on a real Sprite: that /sys/fs/cgroup is a writable cgroup v2
# tree and the runtime does not mind the service leaving its own cgroup.
cg=/sys/fs/cgroup/openbots-computer
if [ -f /sys/fs/cgroup/cgroup.controllers ] && mkdir -p "$cg" 2>/dev/null && [ -w "$cg/cgroup.procs" ]; then
  if [ -e "$cg/cgroup.kill" ]; then echo 1 >"$cg/cgroup.kill"; fi
  for _ in $(seq 50); do [ -s "$cg/cgroup.procs" ] || break; sleep 0.1; done
  echo $$ >"$cg/cgroup.procs"
else
  # Without cgroups, the users only the agent's programs run as. The bot
  # user's own processes are left: the terminal's shells end with their pty.
  ids=(1800 1801 1900)
  for n in $(seq 2000 2089); do ids+=("$n"); done
  pkill -KILL -u "$(IFS=,; echo "${ids[*]}")" || true
fi

# Chromium needs shared memory; the container has its own /dev/shm.
if ! mountpoint -q /dev/shm; then
  mkdir -p /dev/shm
  mount -t tmpfs -o rw,nosuid,nodev,mode=1777 shm /dev/shm
fi

# The token where the agent reads it, root's and 0600 as it requires; it
# deletes the file before it listens (apps/computer-agent/src/privileges.ts).
install -m 0600 -o root -g root /etc/openbots/agent-token /var/lib/openbots/token.new
mv -f /var/lib/openbots/token.new /var/lib/openbots/token

# The container's environment (docker/computer.Dockerfile ENV and the
# provider's), built from nothing so the runtime's own variables do not reach
# the Bots. Then the container's privileges: only CHOWN, SETUID and SETGID
# (cap-drop ALL, cap-add those three) and no-new-privileges, so no setuid
# program (sudo) gives anything the agent starts more than that. tini reaps
# what the Bots leave behind, as the image's entrypoint.
exec env -i \
  PATH="${node%/*}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  LANG=C.UTF-8 \
  NODE_ENV=production \
  HOME=/home/bot \
  TZ="$TZ" \
  PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  OPENBOTS_HOME=/home/bot \
  OPENBOTS_STATE_DIR=/var/lib/openbots \
  OPENBOTS_AGENT_PORT="$OPENBOTS_AGENT_PORT" \
  /usr/bin/setpriv --no-new-privs --inh-caps=-all --bounding-set=-all,+chown,+setuid,+setgid -- \
  /usr/bin/tini -s -- "$node" /app/apps/computer-agent/dist/main.js
LAUNCHER

step 'switch /app to the bundle'
# /app is a link to the unpacked bundle, so an upgrade switches in one step
# and the old one stays until the next upgrade, in case of a rollback. Every
# step that can fail for want of something (a download, a build, Chromium)
# is above: up to here the agent that ran before is still the one that runs.
if [ -e "$APP_LINK" ] && [ ! -L "$APP_LINK" ]; then
  aside="$APP_LINK.pre-openbots.$(date -u +%Y%m%d%H%M%S)"
  log "moving the existing $APP_LINK aside to $aside"
  act mv "$APP_LINK" "$aside"
fi
act ln -sfn "$BUNDLE_DIR/openbots-agent-bundle/app" "$APP_LINK.new"
act mv -Tf "$APP_LINK.new" "$APP_LINK"
# Then this bundle's Node as the system's, also in one step. Not before /app:
# until then the previous bundle is the agent, and a launcher from before
# provision.sh chose each bundle's Node runs node/current.
act ln -sfn "$NODE_DIR" "$NODE_ROOT/current.new"
act mv -Tf "$NODE_ROOT/current.new" "$NODE_ROOT/current"
for bin in node npm npx; do act ln -sfn "$NODE_ROOT/current/bin/$bin" "/usr/local/bin/$bin"; done
if ! dry; then
  [ -f "$APP_LINK/apps/computer-agent/dist/main.js" ] || die "the bundle has no apps/computer-agent/dist/main.js"
  # SUBSCRIPTION_BRIDGE in packages/shared names this path.
  [ -f "$APP_LINK/apps/computer-agent/dist/subscription-model.js" ] || die "the bundle has no subscription-model.js"
  # Keep this bundle and the one before it.
  previous="$(cat "$BUNDLES_DIR/.current" 2>/dev/null || true)"
  if [ "$previous" != "$BUNDLE_ID" ]; then
    printf '%s\n' "$previous" >"$BUNDLES_DIR/.previous"
    printf '%s\n' "$BUNDLE_ID" >"$BUNDLES_DIR/.current"
  fi
  keep_prev="$(cat "$BUNDLES_DIR/.previous" 2>/dev/null || true)"
  for dir in "$BUNDLES_DIR"/*/; do
    id="$(basename "$dir")"
    [ "$id" = "$BUNDLE_ID" ] || [ "$id" = "$keep_prev" ] || rm -rf "$dir"
  done
fi

# --- the service -----------------------------------------------------------------

step 'register the service'
# One service, the control agent, owns the Sprite URL's port. It starts
# everything else itself, per screen and on demand: Xvfb, openbox, x11vnc,
# Chromium, the wallpaper and the cookie store (apps/computer-agent/src).
# There is no update command: delete and create again, so a new definition
# and a new token both take effect.
if dry; then
  log "[dry-run] sprite-env services delete $SERVICE (if it exists)"
  log "[dry-run] sprite-env services create $SERVICE --cmd $LAUNCHER --dir $HOME_DIR --http-port $PORT --no-stream"
else
  command -v sprite-env >/dev/null || die "sprite-env is not on PATH; is this a Sprite?"
  # 9>&-: what sprite-env starts must not hold the lock.
  if sprite-env services get "$SERVICE" >/dev/null 2>&1 9>&-; then
    sprite-env services stop "$SERVICE" >/dev/null 2>&1 9>&- || true
    sprite-env services delete "$SERVICE" >/dev/null 9>&-
  fi
  # Only one service may own the HTTP port (409 otherwise).
  if ! sprite-env services create "$SERVICE" --cmd "$LAUNCHER" --dir "$HOME_DIR" \
    --http-port "$PORT" --no-stream 9>&-; then
    die "could not create the service; another service may own the HTTP port: sprite-env services list"
  fi
fi

step 'wait for the agent'
if dry; then
  log "[dry-run] wait for http://127.0.0.1:$PORT/healthz to accept the new token"
else
  # /healthz needs the token too, so a 200 shows the new one is in force.
  code=000
  for _ in $(seq 90); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
      -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_STORE")") \
      "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  if [ "$code" != 200 ]; then
    log "the agent's log (/.sprite/logs/services/$SERVICE.log):"
    tail -n 40 "/.sprite/logs/services/$SERVICE.log" 2>/dev/null || true
    die "the agent did not answer /healthz with 200 within 90 s (last status $code)"
  fi
  log "the agent answers on port $PORT"
fi

step 'record the version'
printf '%s\n' "$PROVISION_VERSION" | write_file "$VERSION_FILE" 0644 root:root
log "done: $PROVISION_VERSION"
