---
name: verify
description: Verify a change to the OpenBots images, compose files, install and backup scripts, the docker guard or the Bot computer (docker/, compose.yaml, install.sh, scripts/backup.sh, scripts/restore.sh, packages/computer, apps/computer-agent) on a Docker host. Use before committing any change to how OpenBots is built, started, isolated, backed up or restored.
---

# Verify a container change

These need a running Docker daemon. Check first: `docker info`. Without one (many cloud containers), run the first section, stamp the commit `Verified: tests-only`, and say in the pull request that the image and lifecycle checks are left to CI's `server-image` and `standalone-image` jobs.

## Without Docker

```sh
shellcheck -x install.sh scripts/*.sh docker/*.sh docker/standalone/lib/*.sh docker/standalone/bin/* \
  docker/standalone/test/*.sh docker/standalone/s6-rc.d/*/run
bash docker/standalone/test/init-lib.test.sh
pnpm turbo run test --filter @openbots/computer --filter @openbots/computer-agent
```

The computer package's tests check the docker guard's rules and the compose files without Docker. They cannot show the firewall working.

## With Docker: build it and boot it

The compose stack, as `install.sh` sets it up:

```sh
docker run --rm -v "$PWD:/repo:ro" -w /repo hadolint/hadolint:v2.12.0 hadolint docker/*.Dockerfile
cp -n .env.example .env && docker compose config --quiet
docker build -f docker/server.Dockerfile -t openbots-ci/server:ci .
# Set OPENBOTS_MASTER_KEY, OPENBOTS_IMAGE_PREFIX=openbots-ci and OPENBOTS_VERSION=ci in .env, then:
docker compose up -d --wait
curl -fsS http://localhost:3000/readyz
curl -fsS http://localhost:3000/ | grep -q '<title>OpenBots</title>'
```

The standalone image is one container on one volume. Its lifecycle is the check: first boot, backup, a clean stop, a start on the same volume, restore. The `standalone-image` job in `.github/workflows/ci.yml` is the script for it. Run the steps your change touches in that order, and always the stop and start: a volume written by the image before your change must still boot after it.

## Isolation is the product

A Bot's computer runs commands a model chose. If your change touches the guard, the sandbox network, the firewall, capabilities or what a container can mount, run the matching numbered steps of `docs/plans/RELEASE_CHECKS.md` on the running stack and paste what each printed into the pull request. The ones that matter most:

- step 3: the guard refuses a privileged container with a 403
- step 6: from inside a computer, the server, the metadata address, the host and another computer are all unreachable, and the internet is not
- step 12: a stdio MCP server runs as `nobody` and cannot read the server's environment

A change that makes any of those weaker is not a refactor. Say so in the pull request title.

Stamp the commit `Verified: verify` when you built and booted what you changed.
