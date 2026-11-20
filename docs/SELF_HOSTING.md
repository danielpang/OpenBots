# Self-hosting and development reference

Installation, operations and development. See also the
[project README](../README.md) (quick start), [VM setup](VM_SETUP.md) (relay-only VM) and
[private relay setup](PRIVATE_RELAY_SETUP.md) (a relay you operate yourself).

## Install

Requirements: Docker with Compose v2.24 or later (Docker Desktop on macOS and Windows, Docker
Engine on Linux), and `git` to install from the repository.

### From a GitHub Release

Each [release](https://github.com/danielpang/OpenBots/releases) carries:

- **The Mac app**, `OpenBots-<version>-universal.dmg` (Apple Silicon and Intel). It connects to an
  OpenBots account or your own server, or runs everything on the Mac with Docker Desktop or
  OrbStack. If the release notes say the build is unsigned, right-click OpenBots and choose Open
  the first time, and download later releases yourself: only signed builds update themselves.
- **The compose bundle**, `openbots-compose-<version>.tar.gz`: the compose files, `.env.example`
  set to that release's images, `install.sh` and the backup and restore scripts. No `git` needed:

  ```sh
  curl -fsSLO https://github.com/danielpang/OpenBots/releases/download/v<version>/openbots-compose-<version>.tar.gz
  tar -xzf openbots-compose-<version>.tar.gz
  cd openbots-<version>
  bash install.sh
  ```

- **Image archives**, `openbots-<image>-<version>-linux-<arch>.tar.gz`, for machines that cannot
  pull from `ghcr.io`: `docker load -i <file>` each one before `docker compose up -d`.
- `SHA256SUMS` for all of them: `sha256sum --ignore-missing -c SHA256SUMS` (on macOS,
  `shasum -a 256 --ignore-missing -c SHA256SUMS`).

### From the repository

The install script clones into `OpenBots`, copies `.env.example` to `.env`, generates
`OPENBOTS_MASTER_KEY` and the database password (`POSTGRES_PASSWORD`, also written into
`DATABASE_URL`) and runs `docker compose up -d`. A rerun keeps an existing `.env`, key and password.

```sh
curl -fsSL https://raw.githubusercontent.com/danielpang/OpenBots/main/install.sh | bash
# or, from a checkout: bash install.sh [--dir <path>] [--ref <tag>] [--no-start] [--pair]
```

By hand, the same steps:

```sh
git clone https://github.com/danielpang/OpenBots.git OpenBots
cd OpenBots
(umask 077 && cp .env.example .env)
openssl rand -base64 32   # the master key
openssl rand -hex 24      # the database password
openssl rand -hex 24      # the app's database password
```

In `.env`:

1. Set `OPENBOTS_MASTER_KEY=` to the key. Keep a copy somewhere safe: every stored secret is
   encrypted with it.
2. Set `POSTGRES_PASSWORD=` to the database password and put it in `DATABASE_URL` in place of
   `change-me` (`DATABASE_URL=postgres://openbots:<password>@postgres:5432/openbots`). Postgres
   does not start without it.
3. Set `OPENBOTS_DB_APP_PASSWORD=` to the second password. The server uses it for a database role
   held to row-level security between organizations.
4. From a fork, set `OPENBOTS_IMAGE_PREFIX=ghcr.io/<owner in lower case>/openbots`.
5. Optional: add a model provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...), or add
   providers later in Settings > Models.

```sh
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). The first-run wizard creates your account (the
owner), asks for and tests at least one model provider key, starts downloading the computer image
in the background when Docker is configured, and creates your first Bot. Database migrations run at
every server start.

The stack (`compose.yaml` at the root includes `docker/docker-compose.yml` and
`docker/docker-compose.tunnels.yml`):

| Service                              | Image                           | Role                                                                     |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------ |
| `openbots`                           | OpenBots server image (below)   | API, web UI, workers and scheduler on port 3000; files in volume `files` |
| `postgres`                           | `pgvector/pgvector:pg16`        | Database, volume `pgdata`                                                |
| `redis`                              | `redis:7-alpine`                | Queue and pub/sub, volume `redisdata`                                    |
| `docker-guard`                       | OpenBots server image (below)   | Checks every Docker API request the server makes (below)                 |
| `docker-socket-proxy`                | `tecnativa/docker-socket-proxy` | Docker API filtered by URL, reachable only from `docker-guard`           |
| `sandbox-firewall`                   | OpenBots sandbox firewall image | Keeps the computers' network rules applied on the Docker host            |
| `egress-proxy` (profile `egress`)    | `kalaksi/tinyproxy`             | Optional allowlisting proxy for the computers' web traffic (below)       |
| `minio` (profile `s3`)               | `minio/minio`                   | Optional object storage for the `s3` storage driver (below)              |
| `ngrok` (profile `ngrok`)            | `ngrok/ngrok`                   | Optional tunnel, see below                                               |
| `cloudflared` (profile `cloudflare`) | `cloudflare/cloudflared`        | Optional tunnel, see below                                               |

Bots' computers are containers created at runtime from `OPENBOTS_SANDBOX_IMAGE` on the sandbox
network (`openbots-sbx` unless `OPENBOTS_SANDBOX_NETWORK` names another), which has no route to
Postgres or Redis.

- **Docker guard.** The server reaches Docker only through `docker-guard`, which allows only what
  the computer provider needs: containers from the sandbox image, never privileged, with no host
  paths, no host network and every capability dropped. Anything else gets a 403. The server refuses
  a `DOCKER_HOST` that is not the guard.
- **Sandbox firewall.** Computers cannot reach each other, the server (other than answering it),
  the host, link-local metadata addresses or private and LAN addresses. `sandbox-firewall` applies
  those rules (`docker/sandbox-firewall.sh`) in the Docker host's network namespace, so Docker must
  manage iptables. Rootless Docker and Docker's nftables firewall backend are not supported: there,
  apply equivalent rules yourself and drop `sandbox-firewall` from `openbots`'s `depends_on` in a
  `compose.override.yaml`.
- **Subnet.** If `172.30.255.0/24` clashes with a network you use, change
  `OPENBOTS_SANDBOX_SUBNET` and `OPENBOTS_SANDBOX_SERVER_IP` in `.env`.

**Two stacks on one Docker host** (two checkouts, or a checkout beside the Mac app's stack) each
need their own sandbox network. In one, set `OPENBOTS_SANDBOX_NETWORK` to another name, and
`OPENBOTS_SANDBOX_SUBNET` and `OPENBOTS_SANDBOX_SERVER_IP` to another subnet in `172.30.0.0/16`.
Otherwise the second stack fails with "Address already in use" and Compose warns that the network
"exists but was not created for project".

- The host bridge takes the network's name unless `OPENBOTS_SANDBOX_BRIDGE` names it. A bridge
  name is lower case and at most 15 characters, so a longer network name needs one.
- Each guard allows computers on its own network only, and each `sandbox-firewall` keeps its own
  iptables chains (`OPENBOTS-SANDBOX` for the default bridge, `OB-<BRIDGE>` otherwise).
- The Mac app gives its stack its own network at first setup (see `apps/desktop/README.md`).

To change the network of a running install:

1. Stop the computers: `docker ps -q --filter label=openbots.computer | xargs -r docker stop`.
2. `docker compose down`.
3. Edit `.env`.
4. `docker compose up -d`. Each computer is made again on the new network at its next start,
   keeping its files.

**Timezone.** `OPENBOTS_TIMEZONE` in `.env` (an IANA name such as `Europe/London`, default `UTC`)
sets the computers' clock: shells, browsers and the wallpaper, which follows the time of day. A
change applies at each computer's next start. A `remote` computer (`OPENBOTS_COMPUTER_AGENT_URL`)
keeps its own machine's timezone.

### A remote computer

Instead of Docker, OpenBots can use a control agent on another machine
(`OPENBOTS_COMPUTER_AGENT_URL` and `OPENBOTS_COMPUTER_AGENT_TOKEN`). That machine has one
`/home/bot` and one browser cookie store, so it suits a single-person install: the first account to
use it keeps it, and every other account is told the computer is unavailable.

`OPENBOTS_COMPUTER_AGENT_SHARED=true` opens it to every account. Each Bot still gets its own
screen, but all accounts share the files under `/home/bot` and every browser login (cookies sync
across every screen). Turn it on only when the accounts fully trust each other.

### Computers on Fly Sprites (managed service)

The hosted service gives each account its own [Fly Sprite](https://docs.fly.io/sprites/) instead of
a Docker container. A self-hosted install does not need it and leaves these empty.
`OPENBOTS_SPRITES_TOKEN` (a Sprites org token) turns it on, and
`OPENBOTS_SPRITES_PROVISION_DIR` points at the provisioning files from `docker/sprites/`. A remote
agent (`OPENBOTS_COMPUTER_AGENT_URL`) still takes precedence; Docker is used only when neither is
set. Each Sprite gets a DNS egress allowlist: the Sprites defaults, the model vendors' hosts and
the domains in `OPENBOTS_SPRITES_EGRESS`. See `.env.example` for the name prefix and URL settings.
The server calls the Sprites API with Fly's `@fly/sprites` SDK. The SDK can add client headers to
its requests to the Sprites API: `Fly-Client-Interactive` and `Fly-Client-Parent` (whether the
process has a terminal, its parent process's kind), `Fly-Client-CI`, and `Fly-Client-Agent` with
`Fly-Client-Agent-Source` (a coding agent it detects from environment variables, such as
`claude-code` when the server runs under one), and the same in its User-Agent. The server turns
them off unless `SPRITES_CLIENT_SIGNALS` is set (to 1 to send them). The User-Agent still names the
SDK and its version (`sprites-js/0.2.4`). These go only to the Sprites API host.

### Billing (managed service)

The hosted service bills seats and computer hours through Stripe (`STRIPE_*` and
`OPENBOTS_BILLING` in `.env.example`; [ee/README.md](../ee/README.md#billing) says how to set them
up). A self-hosted install has no billing and leaves them empty: every computer start and run goes
ahead as before.

### Shared Artifacts

Sharing an Artifact with the organization or making it public, and opening one in a browser, is
off unless `OPENBOTS_ARTIFACT_DOMAIN` is set (default empty). With it, each Bot gets a hostname
on that domain, `https://<bot>--<organization>.<domain>/<artifact id>`, and the server answers
every request whose `Host` is under it. Use a registrable domain apart from the app's, so a
shared page never reaches the app's cookies, and point a wildcard DNS record and certificate for
`*.<domain>` at the server. The server refuses a domain that is the app's host or sits under it.

`OPENBOTS_ARTIFACT_EDGE_SECRET` (default empty) is for the Cloudflare Worker in
[apps/artifact-worker](../apps/artifact-worker/README.md), which can terminate the wildcard
hostname instead and forwards to `/artifact-host/` with this secret. Without it that path answers 404.

An Artifact is private to the person who made it until they share it. Sharing with the
organization is always possible. Public links are off for every organization until an owner or
admin turns them on in Settings (Settings > Limits on a self-hosted install, Settings >
Organization on the managed service). Turning them off makes every public Artifact visible to the
organization only, and turning them on again brings none of those links back. A shared Artifact
always shows its latest version, so later edits, a Bot's included, are visible at once. An owner
or admin can stop sharing any member's Artifact, which is how what a suspended or removed member
shared is stopped. An operator can take one public link down at once with
`openbots artifacts takedown <link> [reason]` (and put it back with
`openbots artifacts restore <link>`); both are recorded in the organization's audit log.

An HTML Artifact runs its scripts in a sandboxed frame with no access to the app or the host's
cookies, and they cannot fetch anything. They are not cut off from the network, though: browsers
do not block WebRTC or DNS lookups from that frame, so a script in an Artifact can send what the
Artifact contains to a server its author names. Treat an Artifact with scripts as able to leak
what is in it, whoever it is shared with.

### Object storage

Uploads, attachments, avatars, webhook bodies and every Artifact version are stored on the
server's disk under `OPENBOTS_FILES_DIR` unless you choose otherwise. That needs nothing set and
suits a server on one machine. A server that runs on several machines (separate `api` and `worker`
processes, say) needs one store they all reach: set `OPENBOTS_STORAGE_DRIVER=s3` and point it at an
S3-compatible bucket, such as Cloudflare R2, AWS S3 or the MinIO in the compose `s3` profile.

| Setting                                                      | What it is                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENBOTS_STORAGE_DRIVER`                                    | `local` (the default) or `s3`                                                                                                                                    |
| `OPENBOTS_S3_BUCKET`                                         | The bucket, which must exist. Keep it private: the server checks who may see each file and serves it itself                                                      |
| `OPENBOTS_S3_ENDPOINT`                                       | The service's address: `https://<account id>.r2.cloudflarestorage.com` for R2, `http://minio:9000` for the compose profile. Empty for AWS                        |
| `OPENBOTS_S3_REGION`                                         | `auto` for R2 (the default when an endpoint is set); the bucket's region for AWS                                                                                 |
| `OPENBOTS_S3_ACCESS_KEY_ID`, `OPENBOTS_S3_SECRET_ACCESS_KEY` | A key that may read, write and delete objects in that bucket only (on AWS, also `s3:ListBucket` on the bucket, below). Secrets: they may be given as `NAME_FILE` |
| `OPENBOTS_S3_PREFIX`                                         | Optional: put before every key, for a bucket shared with other data, such as `openbots/prod`                                                                     |
| `OPENBOTS_S3_PATH_STYLE`                                     | `true` to address the bucket as `<endpoint>/<bucket>` (the default with an endpoint), `false` for `<bucket>.<endpoint host>` (the default for AWS)               |

The server checks these when it starts and stops with a message naming what is missing. An S3
setting without `OPENBOTS_STORAGE_DRIVER=s3` is refused too, rather than ignored. Files are stored
under `orgs/<organization id>/` in the bucket (after the prefix), named by ids the server makes.
Each upload is checked against its sha256 on the way in; a file's type and size are kept in the
database, not taken from the bucket. A request the store fails with a network error, a 5xx or a 429
is tried again up to four times; while the store is down, reading or storing a file answers 503
`STORAGE_UNAVAILABLE`. Error messages and logs never name the bucket, the endpoint, a key or a
credential.

On AWS, give the key `s3:ListBucket` on the bucket as well as `s3:GetObject`, `s3:PutObject` and
`s3:DeleteObject` on its objects: without it, AWS answers a request for a file that is not there
with 403 Access Denied instead of 404, so a missing file looks like a permission error (and
`openbots storage copy` fails every file it has not copied yet, saying so). R2 and MinIO answer 404
either way.

`OPENBOTS_FILES_DIR` stays in use with the `s3` driver for the filesystem connectors' folders and
the coding agents' session logs, which belong to the machine that runs them. The Artifact host
keeps serving through the server with either driver (the Cloudflare Worker forwards to it).

**Moving an install that already has files.** Rows written before stay as they are; only where
their bytes live changes. The last copy runs with the server stopped, so a file uploaded during the
move cannot be left behind:

1. Make the bucket and its key, and set the `OPENBOTS_S3_*` settings and
   `OPENBOTS_STORAGE_DRIVER=s3` in `.env`. A running server keeps using `local` until it restarts.
2. Optional, to shorten the time the server is down: copy while it is still running,
   `docker compose run --rm openbots storage copy` (from a checkout:
   `pnpm --filter @openbots/server storage copy`). It reads every stored file's record, checks the
   file on disk against its size and sha256, uploads it, and checks it arrived. `--dry-run` only
   counts. It prints one line for each file it could not copy (by its id) and a summary, and exits
   with status 1 if any was missing, did not match its record or failed. It skips what is already
   in the bucket, so it can be stopped and run again at any time.
3. Stop the server: `docker compose stop openbots` (every api and worker process, if you run them
   apart).
4. Run the copy a final time, as in step 2. It sends only what was uploaded since the last run.
   Repeat it until it reports nothing failed.
5. Start the server with the new settings, `docker compose up -d`, and check that an old upload and
   an Artifact open.

It never deletes anything, from the disk or the bucket. Once the server has run on the bucket for a
while, the old copies under `OPENBOTS_FILES_DIR/orgs/` and its two character directories can be
removed by hand (keep `connectors/` and `coders/`). To go back to `local`, unset the settings: the
files on disk are as they were, without anything uploaded since.

### Egress proxy for the computers

By default a computer reaches the whole public internet. To limit it to listed hosts, run the
`egress` profile, a [tinyproxy](https://tinyproxy.github.io/) on the sandbox network that refuses
every host its allowlist does not match. In `.env`:

```sh
OPENBOTS_SANDBOX_EGRESS_PROXY=http://172.30.255.3:8888
OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY=true
```

Then `docker compose --profile egress up -d`.

- **Allowlist:** [docker/egress-proxy/allowlist](../docker/egress-proxy/allowlist), one regular
  expression per host pattern. For a copy outside the checkout, set
  `OPENBOTS_SANDBOX_EGRESS_ALLOWLIST` to its path.
- **Proxy address:** `OPENBOTS_SANDBOX_EGRESS_PROXY_IP` (inside `OPENBOTS_SANDBOX_SUBNET`).
- **How computers use it:** as `HTTP_PROXY` and `HTTPS_PROXY` (and the lower case spellings), which
  the browser and tools such as `curl`, `git` and `pip` follow. `OPENBOTS_SANDBOX_NO_PROXY` lists
  what skips it (default `localhost,127.0.0.1`).
- **Enforcement:** a program can ignore those variables. `OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY=true`
  makes the sandbox firewall drop every connection a computer opens except to the proxy and DNS,
  which makes the allowlist binding. The proxy's own traffic still cannot reach private, LAN or
  link-local addresses.
- **Another HTTP proxy:** set `OPENBOTS_SANDBOX_EGRESS_PROXY` to its URL, with the port. The
  firewall lets computers reach that address and port even when it is private (your LAN or the
  Docker host), so give an IPv4 address: a host name gets no exception, and
  `OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY` needs the address.
- **Changes** apply at each computer's next start, when its container is made again (home and
  browser profiles are kept). To apply one at once, stop the computer on its Computer page.

Every setting is in `.env`, documented in [.env.example](../.env.example). Apply edits with
`docker compose up -d`. Health endpoints: `/healthz` (process up), `/readyz` (database and Redis
reachable, used by the container healthcheck) and `/metrics` (Prometheus, off unless
`OPENBOTS_METRICS_TOKEN` is set).

Each release tag (`v1.2.0`) publishes five images for linux/amd64 and linux/arm64, tagged `1.2.0`,
`1.2` and `latest` (`.github/workflows/release.yml`; `1.2` and `latest` move only once every image
is pushed), and attaches the release files listed above
([apps/desktop/RELEASING.md](../apps/desktop/RELEASING.md)):

- `ghcr.io/danielpang/openbots/server`
- `ghcr.io/danielpang/openbots/computer`
- `ghcr.io/danielpang/openbots/sandbox-firewall`
- `ghcr.io/danielpang/openbots/relay` (the private relay)
- `ghcr.io/danielpang/openbots/standalone` (all of OpenBots in one container, see
  [Run OpenBots 24/7 on a VM](#run-openbots-247-on-a-vm))

In `.env`, `OPENBOTS_IMAGE_PREFIX` says where the images come from (a fork publishes to
`ghcr.io/<its owner>/openbots`, and `OPENBOTS_GITHUB_OWNER=<owner> bash install.sh` sets it) and
`OPENBOTS_VERSION` picks the release. Computers run the same release's computer image unless
`OPENBOTS_SANDBOX_IMAGE` names another. If the server or sandbox firewall image cannot be pulled,
`docker compose up -d` builds it from your checkout (`docker/server.Dockerfile`,
`docker/sandbox-firewall.Dockerfile`). To build them yourself: `docker compose build`.

## Connect GitHub for coding agents

1. Open **Connectors → GitHub for coding agents → Connect GitHub**.
2. Install the shared OpenBots GitHub App on your account or organization and select repositories.
3. Back in OpenBots, choose **Authorize on GitHub** to enter the device code. Installing the App
   alone does not complete device authorization.

The shared flow works on a Mac or localhost without a PAT, custom App registration, public HTTPS
URL, client secret or App private key. Alternatives:

- **Use a different GitHub App**: a custom App's public client ID and slug, with Device Flow
  enabled.
- **Advanced: server-managed GitHub App** (optional): still requires server-held App secrets and
  public HTTPS for callbacks/webhooks.

See [GitHub repositories for coding agents](GITHUB_REPOSITORIES.md) for setup, repository selection,
token permissions, approved-push boundaries and verification. Existing GitHub MCP/tool connections
remain separate and retain their Bot bindings.

## Upgrade

```sh
docker compose pull && docker compose up -d
```

Back up first (below). Migrations run when the new server starts.

- `OPENBOTS_VERSION=latest` moves to the newest release. To stay on a release line, set it to one
  such as `1.2` or `1.2.0` first.
- A compose bundle install is pinned to its release: set `OPENBOTS_VERSION` in `.env` to the new
  version (or `latest`) first.
- Built from source: `git pull && docker compose up -d --build`.

Upgrading to the release with shared Artifacts (migration `0048_artifact_sharing`): the migration
gives every existing Bot its address on the artifact domain, and while it does it locks the
organizations (`workspaces`) and `bots` tables, so every request that reads or changes a Bot or an
organization waits until it ends. That takes moments on most installs. On a very large one, upgrade in a
quiet period.

Computers move to the new computer image too. The server pulls it at start, and each computer is
made again from it at its next start, keeping its files and browser logins (the Computer page and
the run's event row say it is updating). A running computer is never replaced under a task: it
moves after it next stops, at its idle timeout or when you press Stop on its Computer page and
start it again.

Upgrading to the release that moves to Node 24: the server, the relay and the Bots' computer now
need Node 24. The official images (server, computer, relay and standalone) already include it, so a
Docker, compose bundle, Fly or standalone install needs no change. A server or relay run from a
checkout without Docker needs Node 24 first: run `bash scripts/dev-setup.sh` again (it installs
Node 24 when the one it finds is another major version), or install Node 24 yourself, then run
`pnpm install` and `pnpm rebuild` so native modules are built for it. Node 22 is no longer
accepted by `pnpm install`.

Upgrading from a version without `docker-guard`:

1. Set `DOCKER_HOST=tcp://docker-guard:2375` in `.env` (the computer refuses the socket proxy
   directly).
2. `docker compose down`.
3. Remove any computer containers (their home volumes stay):
   `docker ps -aq --filter label=openbots.computer | xargs -r docker rm -f`.
4. `docker network rm openbots-sbx` (the sandbox network now has fixed options, so it must be
   recreated).
5. `docker compose up -d`.

## Backup and restore

```sh
bash scripts/backup.sh                      # writes a new backups/<timestamp>/ each time
bash scripts/restore.sh backups/<timestamp> # replaces the current data, asks first
bash scripts/restore.sh backups/<timestamp> --yes   # the same without asking, for scripts
```

- `backup.sh <dir>` writes a new `<dir>/<timestamp>`. `--out <dir>` writes into exactly `dir`,
  which must be new or empty.
- `restore.sh` without `--yes` and without a terminal to ask on (a script, cron, `docker exec`
  without `-it`) stops with a message and changes nothing.
- Run both from the checkout that runs the stack, which can be up or down.

A backup, readable by your user only, holds:

- `database.dump`: a `pg_dump` of the database.
- `files.tar.gz`: the `files` volume (every upload and Artifact file with the default `local`
  storage driver).
- `computers/<volume>.tar.gz`: each Bot computer's home volume.
- `MANIFEST`: checksums and the file count.

**It does not hold `OPENBOTS_MASTER_KEY`.** Back up `.env` separately and restore with the same
key, or stored secrets cannot be decrypted.

`backup.sh` verifies its output: `pg_restore` must read the dump and find the users table, and
every archive must pass `gzip -t`. A failed backup is removed, so a directory under `backups/` with
a `MANIFEST` is a good one.

`restore.sh`:

1. Checks the backup (checksums from `MANIFEST`, the dump, the archives, where each archive goes,
   and twice the backup's size in free space) and stops before touching anything if a check fails.
2. Asks (skip with `--yes`).
3. Stops `openbots` and the computers, recreates the database, refills the volumes and starts the
   stack.
4. Checks that the restored file count matches the backup.

A standalone image backup also restores into the compose stack: its files go to the server's uid
1000, and its Bots' home (`home.tar.gz`) fills the home volume of the computer its database names.
The standalone computer's browser sign-ins are left out with a message (the Bots sign in to sites
again). If its database has no computer, the restore stops before changing anything; `--skip-home`
restores without the Bots' home.

**Restoring onto a new install.** A new install generates its own master key. Before restoring, set
`OPENBOTS_MASTER_KEY=<the old key>` in `.env` (for the standalone image: in `/data/.env`, or as a
secret such as `fly secrets set OPENBOTS_MASTER_KEY=...`), restart (`docker compose up -d`, or
restart the container), then restore with `--yes`. The standalone image refuses to boot on an
existing database whose master key is missing, rather than generate one that could not open its
secrets.

**Moving a server: stop the old one first.** A backup carries the server's identity, the key it
links to the relay with. If both copies run, they dial the relay as one server and the phone
reaches whichever linked last. Stop the old install (`docker compose down`,
`docker stop -t 60 <container>`, `fly machine stop`) before you start the restored one.

**With the `s3` storage driver** ([Object storage](#object-storage)), uploads and Artifact files
are in the bucket, not in the `files` volume, so `files.tar.gz` holds only the connectors' folders
and session logs. Back the bucket up with your provider's own tools (versioning, replication or a
scheduled copy) at the same time as the database: a restore needs both from the same moment, since
a file whose record is in the dump but whose object is gone reads as not found.

Without Docker (a development install), both scripts use `DATABASE_URL` and `OPENBOTS_FILES_DIR`
and need `pg_dump` / `pg_restore` on `PATH`; computer volumes are skipped.

The files volume has two owners: the server (uid 1000) and `nobody` (files stdio MCP servers
wrote). So both scripts run on it as root with minimal capabilities: `backup.sh` with
DAC_READ_SEARCH, `restore.sh` with CHOWN, DAC_OVERRIDE and FOWNER.

## Rotating the master key

`OPENBOTS_MASTER_KEY` encrypts every stored secret (provider keys, connector secrets and tokens,
webhook signing secrets, computer tokens) and signs sign-in sessions. Rotate it when it may have
leaked, or on a schedule:

1. Back up: `bash scripts/backup.sh`. Keep the current key with that backup, since only it opens
   the secrets in it.
2. Make a new key: `docker compose run --rm openbots keygen`.
3. In `.env`, move the current key to `OPENBOTS_MASTER_KEY_PREVIOUS` and put the new one in its
   place:
   ```sh
   OPENBOTS_MASTER_KEY=<the new key>
   OPENBOTS_MASTER_KEY_PREVIOUS=<the old key>
   ```
4. `docker compose up -d`. The server seals new secrets with the new key and still opens old ones
   with the previous key. Its worker re-encrypts every stored secret in the background, and
   `docker compose logs openbots` says `master key rotation done` when finished.
5. Optional: run the job yourself with `docker compose run --rm openbots rotate-key`. It prints its
   progress, can be stopped and rerun, and can run while the server is up. While any secret opens
   with neither key, it exits with status 1 and names each one.
6. When it reports done, empty `OPENBOTS_MASTER_KEY_PREVIOUS` and run `docker compose up -d` again.

**Rotating signs everyone out.** Sessions are signed with a secret derived from the master key, so
existing sessions, email links and sign-ins in progress stop working once the server restarts with
the new key. This is on purpose: sessions signed with a leaked key should end with it. API keys,
invites, webhook URLs and signing secrets, event subscriptions and computers keep working (their
secrets are re-encrypted, not changed).

`OPENBOTS_MASTER_KEY_PREVIOUS` takes several keys separated by commas, for a rotation started before
the last one finished. A backup made before a rotation needs the key it was made with.

### Secrets in files

Each secret setting (`OPENBOTS_MASTER_KEY`, `OPENBOTS_MASTER_KEY_PREVIOUS`, `DATABASE_URL`,
`REDIS_URL`, the provider API keys, the OAuth client secrets, `OPENBOTS_COMPUTER_AGENT_TOKEN`,
`OPENBOTS_METRICS_TOKEN`, `OPENBOTS_ARTIFACT_EDGE_SECRET` and the object storage keys
`OPENBOTS_S3_ACCESS_KEY_ID` and `OPENBOTS_S3_SECRET_ACCESS_KEY`) can be given as `NAME_FILE` instead: the path of a file holding the value,
such as a Docker or Kubernetes secret. Set one or the other, not both.

The compose stack does this itself: its entrypoint moves the secrets from `.env` into private
in-memory files (`/run/openbots`) before the server starts, so the server's process environment
holds only their paths. Anywhere else, the server logs a warning naming each secret found in its
environment.

## Monitoring

`/metrics` serves Prometheus metrics once `OPENBOTS_METRICS_TOKEN` is set in `.env` (16
characters or more; `openssl rand -hex 32`); until then it answers 404. Scrapers send the token
as a bearer token, from inside the compose network (`openbots:3000`) or on the published port:

```yaml
scrape_configs:
  - job_name: openbots
    authorization:
      credentials: <OPENBOTS_METRICS_TOKEN>
    static_configs:
      - targets: ['openbots:3000']
```

Besides the Node process and HTTP request metrics:

| Metric                                                    | What it measures                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `openbots_runs{status}`                                   | Runs `queued` (the queue depth), `running` and `waiting` right now |
| `openbots_runs_finished_total{status,trigger}`            | Runs that completed, failed or were cancelled                      |
| `openbots_run_duration_seconds{status}`                   | Start to finish of each run, waits included                        |
| `openbots_webhook_deliveries_total{direction,outcome}`    | Inbound webhooks by outcome; outbound event delivery attempts      |
| `openbots_provider_step_duration_seconds{provider,model}` | One model step, request to finished response                       |

`openbots_runs` is read from the database at scrape time, so every server process reports the same
value: aggregate it with `max`, not `sum`. For a ready-made overview, import
[docs/grafana-dashboard.json](grafana-dashboard.json) into Grafana (Dashboards > New > Import) and
pick your Prometheus data source.

Maintainers check the container hardening by hand before a release: see
[release checks](plans/RELEASE_CHECKS.md#checking-the-container-hardening).

## Exposing your OpenBots server to the internet

By default OpenBots listens on `http://localhost:3000`. To receive webhooks, complete OAuth flows
for connectors, or use the Mac app away from home, put a tunnel in front of it. Then set
`OPENBOTS_PUBLIC_URL` in `.env` to the public URL and run `docker compose up -d`. OpenBots builds
webhook URLs and OAuth redirect URIs from it.

**Before exposing anything:** use a strong password and consider the tunnel provider's access
controls (below). A self-hosted install (`OPENBOTS_DEPLOYMENT=self_hosted`, the default) has one
account and closes sign-up once it exists. The managed service (`OPENBOTS_DEPLOYMENT=managed`) runs
from the managed build in `ee/`, where every account verifies its email.

### Option A: ngrok

1. Install ngrok (`brew install ngrok` on macOS) and add your token:
   `ngrok config add-authtoken <token>`.
2. Start a tunnel: `ngrok http 3000`. The free plan includes one static domain. Use it so the URL
   survives restarts: `ngrok http --url=your-name.ngrok.app 3000`.
3. Set `OPENBOTS_PUBLIC_URL=https://your-name.ngrok.app` in `.env` and run `docker compose up -d`.
4. To run ngrok inside the stack instead, set `NGROK_AUTHTOKEN` and `NGROK_URL` (the domain alone,
   e.g. `NGROK_URL=your-name.ngrok.app`) in `.env` and run `docker compose --profile ngrok up -d`.
5. Optional hardening: protect the UI with ngrok's OAuth or basic auth (`--oauth=google`,
   `--basic-auth=user:pass`). Webhook endpoints live under `/hooks/`, so exempt that path with
   ngrok Traffic Policy, or run a second tunnel for it.

### Option B: Cloudflare Tunnel

Quick tunnel (no account, random URL that changes each run):

1. Install cloudflared (`brew install cloudflared`).
2. Run `cloudflared tunnel --url http://localhost:3000` and copy the
   `https://<random>.trycloudflare.com` URL it prints.
3. Set `OPENBOTS_PUBLIC_URL` to that URL and run `docker compose up -d`.

Named tunnel (stable hostname on your own domain, recommended):

1. `cloudflared tunnel login`, then `cloudflared tunnel create openbots`.
2. `cloudflared tunnel route dns openbots openbots.example.com`.
3. Create `~/.cloudflared/config.yml`, then run `cloudflared tunnel run openbots`:

   ```yaml
   tunnel: openbots
   credentials-file: /Users/you/.cloudflared/<tunnel id>.json
   ingress:
     - hostname: openbots.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```

4. Or run it inside the stack: create the tunnel in the Cloudflare Zero Trust dashboard, set its
   public hostname to service `http://openbots:3000`, put the token in `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`, and start with `docker compose --profile cloudflare up -d`.
5. Set `OPENBOTS_PUBLIC_URL=https://openbots.example.com` and restart.
6. Optional hardening: add a Cloudflare Access policy for the hostname so only you can reach the
   UI. Add a bypass rule for the path `/hooks/*` so webhooks still arrive, or publish webhooks on a
   second hostname without Access.

Both providers pass WebSockets, which the live screen and terminal views need. If the screen view
fails through a tunnel, check that no intermediate proxy strips the `Upgrade` header.

When you start the stack with a profile, keep passing it (`docker compose --profile ngrok up -d`,
`docker compose --profile ngrok pull`), or set `COMPOSE_PROFILES=ngrok` in `.env` so plain
`docker compose` commands include the tunnel.

## Reaching your server from your phone

A phone pairs with a server by scanning a QR code. It then reaches the server directly (a public
URL from the section above, or the same network) or through a relay, which needs no public
address, port, DNS or certificate. The iOS app is in development
([docs/plans/IOS_APP_PLAN.md](plans/IOS_APP_PLAN.md)). Wire protocol:
[docs/RELAY_PROTOCOL.md](RELAY_PROTOCOL.md). Design:
[docs/plans/MOBILE_AND_VM_PLAN.md](plans/MOBILE_AND_VM_PLAN.md).

**Pairing.** Settings > Devices in the web app (and "Pair your phone…" in the Mac app) shows the QR
code. A code works once, for 5 minutes. On a fresh install with no owner yet, the first phone to
pair becomes the owner. A paired device holds a key with the owner's access. Revoke a lost phone in
Settings > Devices, which stops its key at once. On a VM with no browser, use the terminal:

```sh
docker compose run --rm openbots pair          # add --link to print the link too
docker compose run --rm openbots devices       # list paired devices, or `devices revoke <id>`
docker compose run --rm openbots relay         # the server's host id and whether the relay sees it
```

**The relay.** Set `OPENBOTS_RELAY_URL` in `.env` to a relay's `wss://` address and run
`docker compose up -d`. The server dials out only once a device is paired or a pairing is open. The
phone uses the relay when no direct address answers. Traffic is end-to-end encrypted; see
[what the relay sees](../apps/relay/README.md#what-the-relay-sees-and-what-it-does-not). The
[VM setup guide](VM_SETUP.md) uses the shared relay. To run your own, follow the
[private relay guide](PRIVATE_RELAY_SETUP.md). A self-hosted relay sends no push notifications, so
the phone gets notices only while the app is open.

## Run OpenBots 24/7 on a VM

The Mac app's This Mac stack pauses while the Mac sleeps: Routines wait, and Bots stop mid-task
until the lid opens. For round-the-clock work, run OpenBots on a machine that stays on, such as a
cloud VM or a home server. The phone reaches it through the relay, so the VM needs no public
address, open port, DNS or certificate.

- [VM setup guide](VM_SETUP.md): the compose stack with the shared relay, step by step. This is the
  hardened path. Use it wherever Docker runs.
- [Deployment templates](../deploy/README.md): EC2, Fly, Sprites and other platforms, and how the
  compose stack and the standalone image differ.
- [Standalone image](../docker/standalone/README.md): one container for platforms without Docker
  inside, its flags, and the isolation it gives up.

**Cost.** You pay for a machine that runs all month, plus your model provider's usage. Check
current prices: [Fly.io](https://fly.io/docs/about/pricing/),
[Amazon EC2](https://aws.amazon.com/ec2/pricing/on-demand/), [Railway](https://railway.com/pricing),
[Render](https://render.com/pricing).

## Development

Requirements: Linux or macOS with `curl`, `tar` and `xz`. Nothing else needs to be preinstalled.

```sh
bash scripts/dev-setup.sh            # Node 24, pnpm (via corepack), pnpm install
bash scripts/dev-setup.sh --services # also Postgres 16 + pgvector and Redis (Ubuntu, apt)
```

The script is idempotent. It reuses a Node 24 on `PATH`, or installs one into a toolchain directory
(`/workspace/.openbots-toolchain` when it has room, else `~/.local/openbots-toolchain`; set
`OPENBOTS_TOOLCHAIN_DIR` to choose). It prints the exports to add to your shell and writes them to
`<toolchain dir>/env.sh`.

Then:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

Unit tests need no external services. Tests that need Postgres or Redis run only when
`DATABASE_URL` or `REDIS_URL` is set (`--services` prints both).

`pnpm dev` needs Postgres, Redis and a few variables. `bash scripts/dev.sh` starts Postgres and
Redis (with Docker Compose when Docker is running, published on `127.0.0.1`, otherwise the services
from `dev-setup.sh --services`) and prints the exports:

```sh
bash scripts/dev.sh
export DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots
export REDIS_URL=redis://127.0.0.1:6379
export OPENBOTS_MASTER_KEY=$(pnpm -s --filter @openbots/server keygen)
pnpm dev
```

The catalog's Filesystem and Postgres connectors run servers the image installs from
`docker/mcp-catalog/package-lock.json`. From source, install them once with
`(cd docker/mcp-catalog && npm ci --omit=dev --ignore-scripts)` and
`export OPENBOTS_MCP_DIR=$PWD/docker/mcp-catalog`, or set `OPENBOTS_MCP_NPX_FALLBACK=true` to let
them download through `npx` instead.

Bot computers need Docker through the docker guard: the server refuses a `DOCKER_HOST` that is the
Docker socket or the socket proxy. `pnpm --filter @openbots/computer docker-guard` runs the guard
from source on `127.0.0.1:2375`, in front of `/var/run/docker.sock` (`OPENBOTS_DOCKER_UPSTREAM`,
`OPENBOTS_DOCKER_GUARD_PORT` and `OPENBOTS_SANDBOX_IMAGE` change that). Run it in a second terminal
and point the server at it before `pnpm dev`:

```sh
pnpm --filter @openbots/computer docker-guard   # second terminal
export DOCKER_HOST=tcp://127.0.0.1:2375
```

The sandbox firewall is not running in this setup, so computers are not network-isolated from the
host the way they are in the compose stack. The end-to-end tests in `apps/web/e2e` use the same
setup; `computer.spec.ts` is skipped unless the server has a computer provider.

To run the whole stack from your checkout with the server reloading on source changes:

```sh
docker compose --project-directory . -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml up -d --build
```

Before a release, also run the
[Docker verification checklist](plans/RELEASE_CHECKS.md#docker-verification-checklist).

## License

The OpenBots core is under [Apache License 2.0](../LICENSE). You may use,
modify, self-host, host for others, and sell setup or support services.

The `ee/` directory (organizations, billing and subscriptions) is proprietary
under [ee/LICENSE](../ee/LICENSE). The mobile app source is visible for review,
but all rights are reserved under [apps/mobile/LICENSE](../apps/mobile/LICENSE).
Copying, modifying, building, distributing or publishing it requires written permission.
The OpenBots name and logo are trademarks of Daniel Pang and may not be used
for forks or hosted services without permission.

## Terms

Using OpenBots, including the apps and the shared relay, means you accept the
[Terms and Conditions](TERMS.md). In short: you are responsible for what your Bots do, and
OpenBots is not liable for their actions; the shared relay is free, with no promise of
availability or latency, and may change at any time.

The website serves a copy at `/terms/`. Change [docs/TERMS.md](TERMS.md) here: the
`terms-www` workflow then opens a matching pull request on
[OpenBots-www](https://github.com/danielpang/OpenBots-www) and links it from yours, so merge both
together. It needs the `OPENBOTS_WWW_TOKEN` secret (see the workflow for the token it expects).
