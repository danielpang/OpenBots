#!/usr/bin/env bash
# Builds the agent bundle that docker/sprites/provision.sh installs on a
# Sprite: the computer agent's build output and production node_modules in
# the image's /app layout, plus the lockfiles and source the image builds
# from in its other stages. It follows docker/computer.Dockerfile's build
# and prod-deps stages, in a scratch copy of the repository, so the
# checkout's own node_modules and dist/ are left alone.
#
#   bash docker/sprites/build-bundle.sh [--out DIR] [--source worktree|head]
#
# --out     where to write (default docker/sprites/dist/)
# --source  worktree: the checkout as it is, uncommitted changes included,
#           as `docker build .` sees it (the default); head: the last commit
#
# It writes agent-bundle.tgz, a copy of provision.sh and VERSION, a hash of
# both that changes whenever either one does: the provider passes it as
# OPENBOTS_PROVISION_VERSION and re-provisions a Sprite whose
# /opt/openbots/provision.version differs.
#
# Needs Linux on the Sprite's architecture (node-pty is compiled here;
# provision.sh compiles it again if the binding does not load there), Node
# 22, pnpm and a C++ toolchain, as the image's build stages do.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/dist"
SOURCE=worktree
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --source)
      SOURCE="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
case "$SOURCE" in worktree | head) ;; *)
  echo "--source must be worktree or head" >&2
  exit 2
  ;;
esac

STEP=start
log() { printf '[build-bundle] %s\n' "$*"; }
step() {
  STEP="$1"
  log "== $STEP"
}
on_error() {
  local code=$?
  if [ "$BASHPID" = "$$" ]; then printf '[build-bundle] FAILED in step "%s" (exit %s)\n' "$STEP" "$code" >&2; fi
  exit "$code"
}
trap on_error ERR

[ "$(uname -s)" = Linux ] || {
  echo "build the bundle on Linux: node-pty is compiled for the build machine" >&2
  exit 1
}
for tool in node pnpm tar gzip sha256sum gcc; do
  command -v "$tool" >/dev/null || {
    echo "missing $tool" >&2
    exit 1
  }
done
node_version="$(node --version)"
[[ "$node_version" == v22.* ]] || {
  echo "the image runs Node 22; this is $node_version" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src"
mkdir -p "$SRC" "$OUT"
OUT="$(cd "$OUT" && pwd)"

step "copy the repository ($SOURCE)"
if [ "$SOURCE" = head ]; then
  git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$SRC"
  revision="$(git -C "$ROOT" rev-parse HEAD)"
elif git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # What git would commit, tracked or not, without ignored files (node_modules,
  # dist/), as the .dockerignore files keep them out of the image's context.
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard --deduplicate) |
    (cd "$ROOT" && while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done) |
    tar -C "$ROOT" --null -T - -cf - | tar -x -C "$SRC"
  revision="$(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null || echo '+changes')"
else
  tar -C "$ROOT" --exclude=node_modules --exclude=dist --exclude=.turbo --exclude=.git -cf - . |
    tar -x -C "$SRC"
  revision=unknown
fi

export CI=true TURBO_TELEMETRY_DISABLED=1
cd "$SRC"

step 'build the agent and the workspace packages it imports'
# docker/computer.Dockerfile, build stage. pnpm runs the same build scripts
# turbo does there, in dependency order, without depending on how turbo finds
# the package manager on this machine.
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter "@openbots/computer-agent..." run build
mkdir "$WORK/out"
for dist in apps/*/dist packages/*/dist; do
  [ -d "$dist" ] || continue
  mkdir -p "$WORK/out/$(dirname "$dist")"
  cp -r "$dist" "$WORK/out/$dist"
done

step 'install the production dependencies'
# The prod-deps stage: a fresh production install for the agent and what it
# needs, node-pty compiled for this machine, and the build fails unless its
# binding loads.
find . -name node_modules -type d -prune -exec rm -rf {} +
pnpm install --prod --frozen-lockfile --prefer-offline --filter "@openbots/computer-agent..."
node -e "require(require.resolve('node-pty', { paths: ['apps/computer-agent'] }))"

step 'lay out the bundle'
B="$WORK/stage/openbots-agent-bundle"
mkdir -p "$B/app" "$B/native" "$B/coders" "$B/mcp-catalog"
# The image's /app holds the prod-deps stage's checkout with the build
# stage's dist/ over it. Of that, the agent needs only the packages the
# production install covered (those with node_modules), each with its
# package.json, node_modules and dist/, and the root node_modules where pnpm
# keeps the packages themselves. Symlinks stay relative, so /app works.
cp package.json "$B/app/"
cp -a node_modules "$B/app/"
for pkg in apps/* packages/*; do
  [ -d "$pkg/node_modules" ] || continue
  mkdir -p "$B/app/$pkg"
  cp "$pkg/package.json" "$B/app/$pkg/package.json"
  cp -a "$pkg/node_modules" "$B/app/$pkg/"
  if [ -d "$WORK/out/$pkg/dist" ]; then cp -r "$WORK/out/$pkg/dist" "$B/app/$pkg/"; fi
done
for need in apps/computer-agent/dist/main.js apps/computer-agent/dist/subscription-model.js \
  apps/computer-agent/dist/git-credential-helper.js packages/shared/dist; do
  [ -e "$B/app/$need" ] || {
    echo "the bundle has no $need" >&2
    exit 1
  }
done
# pnpm's bookkeeping, with timestamps and this machine's paths; nothing
# reads it at run time, and leaving it out keeps the bundle reproducible.
find "$B/app" \( -name .modules.yaml -o -name '.pnpm-workspace-state*.json' \) -delete
# What the image builds in its other stages, built on the Sprite instead:
# the runas helper (native) and the coding agents and MCP catalog servers
# (from their lockfiles, with npm ci, as the coders and mcp-catalog stages).
cp apps/computer-agent/native/runas.c "$B/native/"
cp docker/coders/package.json docker/coders/package-lock.json "$B/coders/"
cp docker/mcp-catalog/package.json docker/mcp-catalog/package-lock.json "$B/mcp-catalog/"
playwright="$(node -p "require('./apps/computer-agent/node_modules/playwright-core/package.json').version")"
cat >"$B/BUILD_INFO" <<EOF
node_version=$node_version
arch=$(uname -m)
glibc=$(ldd --version 2>/dev/null | head -n1 | awk '{print $NF}')
playwright_core=$playwright
source=$revision
EOF

step 'pack'
# A fixed order, owner and time, so the same input gives the same bytes and
# VERSION only changes with the content. BUILD_INFO names the commit, so a new
# commit is a new bundle even when the agent's files are the same.
tar -C "$WORK/stage" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --format=gnu -cf - openbots-agent-bundle | gzip -n -9 >"$OUT/agent-bundle.tgz.new"
mv -f "$OUT/agent-bundle.tgz.new" "$OUT/agent-bundle.tgz"
cp "$HERE/provision.sh" "$OUT/provision.sh"
version="sprites-$(cat "$OUT/provision.sh" "$OUT/agent-bundle.tgz" | sha256sum | cut -c1-16)"
printf '%s\n' "$version" >"$OUT/VERSION"
(cd "$OUT" && sha256sum agent-bundle.tgz provision.sh >SHA256SUMS)
log "wrote $OUT/agent-bundle.tgz ($(du -h "$OUT/agent-bundle.tgz" | cut -f1)), provision.sh, VERSION ($version)"
