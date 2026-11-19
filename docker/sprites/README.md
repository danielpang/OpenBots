# The computer on a Sprite

On the hosted service each user's computer runs on a [Fly Sprite](https://docs.fly.io/sprites/index.md) instead of a container from `docker/computer.Dockerfile`. A Sprite is a stock Ubuntu VM (Ubuntu 26.04 on new Sprites) with a persistent 100 GB disk, and it cannot boot a custom image. So everything the computer image bakes in is installed by a script, `provision.sh`, from a bundle that `build-bundle.sh` makes from this repository.

This is not the personal-use setup in [deploy/sprites](../../deploy/sprites/README.md), which runs the whole standalone image on a Sprite. Here a Sprite is only the computer; the server runs elsewhere and talks to the computer's control agent over the Sprite's URL.

| File                     | What it is                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `provision.sh`           | Turns a stock Sprite into a computer, idempotently. Runs inside the Sprite as root.                      |
| `build-bundle.sh`        | Builds `dist/agent-bundle.tgz`, copies `provision.sh` beside it and writes `dist/VERSION`.               |
| `test/provision.test.sh` | Runs `provision.sh` twice in an `ubuntu:26.04` container with a stub `sprite-env` and checks the result. |
| `test/sprite-env`        | That stub: enough of `sprite-env services` to start the agent the way the runtime would.                 |

## The contract with the provider

The server's Sprite provider uploads `provision.sh` and `agent-bundle.tgz` into the Sprite and runs, as root or as a user with passwordless sudo:

```sh
bash provision.sh /path/to/agent-bundle.tgz
```

with this environment:

| Variable                     | Meaning                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENBOTS_AGENT_TOKEN`       | The bearer token the control agent requires: 16 to 512 base64url characters. Never printed. |
| `OPENBOTS_AGENT_PORT`        | The port the Sprite URL routes to: `8080`.                                                  |
| `OPENBOTS_PROVISION_VERSION` | Written to `/opt/openbots/provision.version` on success. Use the content of `dist/VERSION`. |
| `TZ`                         | The Bots' time zone, as the docker provider passes it (`UTC` when unset).                   |

On success it exits 0, with the agent answering `GET /healthz` with 200 for the new token on that port, and `/opt/openbots/provision.version` holding `OPENBOTS_PROVISION_VERSION`. The provider can compare that file with its own `VERSION` to decide whether a Sprite needs provisioning again.

It is safe to run again, for an upgrade, to rotate the token, or after a run that failed half way: each step checks what is there first. A second run with an unchanged bundle skips apt, Node, the coding agents and Chromium and takes well under a minute; most of that is restarting the agent. Running it with a new token rotates the token: the old one stops working when the agent restarts at the end of the run.

On failure it exits non-zero and the last line names the step, for example `FAILED in step "install Chromium" (line 412, exit 1)`. Every step logs a `== <step>` line as it starts, so the output reads as progress.

No reboot or new login is needed afterwards. The first run downloads about 1 GB (apt packages, Node, the coding agents, Chromium) and takes several minutes; how long on a Sprite has not been measured.

`PROVISION_DRY_RUN=1` prints what a run would change and changes nothing (no root needed). It still needs the settings above, with any well-formed token.

## Building the bundle

```sh
bash docker/sprites/build-bundle.sh                 # the checkout as it is
bash docker/sprites/build-bundle.sh --source head   # the last commit
bash docker/sprites/build-bundle.sh --out /some/dir
```

Run it on Linux on the Sprites' architecture (x86_64) with Node 22, pnpm and a C toolchain, as the image's build stages have. It follows the Dockerfile's build and prod-deps stages in a scratch copy, so the checkout's `node_modules` and `dist/` are left alone: a full install and `pnpm --filter "@openbots/computer-agent..." run build`, then a fresh production install of the agent and the workspace packages it imports, with node-pty compiled and loaded.

It writes, in `docker/sprites/dist/` by default (ignored by git):

- `agent-bundle.tgz`, reproducible: the same input gives the same bytes.
- `provision.sh`, a copy, so the provider uploads both from one place.
- `VERSION`, `sprites-<16 hex>`, a hash of both files. It changes whenever either does, and with each commit, since the bundle records the commit it was built from.
- `SHA256SUMS`.

The bundle holds one directory, `openbots-agent-bundle/`:

| Path             | Installed as                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/`           | `/app`: `package.json`, the root `node_modules` (pnpm's store), and for `apps/computer-agent` and `packages/shared` their `package.json`, `node_modules` and `dist/`. The same paths the image has, so `/app/apps/computer-agent/dist/subscription-model.js` (`SUBSCRIPTION_BRIDGE`) and the other paths in `packages/shared` hold. |
| `native/runas.c` | Compiled on the Sprite into `/usr/local/libexec/openbots/runas`, static, as the image's build stage does.                                                                                                                                                                                                                           |
| `coders/`        | `docker/coders/package*.json`, installed with `npm ci` into `/opt/openbots/coders`, as the image's coders stage.                                                                                                                                                                                                                    |
| `mcp-catalog/`   | `docker/mcp-catalog/package*.json`, installed with `npm ci` into `/opt/openbots/mcp`, as the image's mcp-catalog stage.                                                                                                                                                                                                             |
| `BUILD_INFO`     | The Node version, architecture, glibc and Playwright version it was built with, and the commit.                                                                                                                                                                                                                                     |

The image's `/app` also holds the repository's sources; the bundle leaves them out, since nothing reads them at run time.

## What provision.sh does

Each step corresponds to part of `docker/computer.Dockerfile`:

1. **Settings.** Checks the four variables and that this is Ubuntu (it says so if it is not 26.04).
2. **Bundle.** Unpacks it into `/opt/openbots/bundles/<hash>/`, keeping the current bundle and the one before it.
3. **Packages.** The image's apt packages (`xvfb openbox x11vnc xdotool feh imagemagick tini tzdata`, the three font packages, `ca-certificates curl git less nano procps python3 unzip xz-utils util-linux`), all present under those names on Ubuntu 26.04, plus `gcc libc6-dev make g++` to build runas and, if needed, node-pty. There is no noVNC or websockify package: the agent bridges VNC to the browser itself.
4. **Node.** The official build of the exact version the bundle was built with (the image copies Node 22 from `node:22-bookworm-slim`), checked against nodejs.org's `SHASUMS256.txt`, in `/opt/openbots/node/v<version>`, linked from `/usr/local/bin/{node,npm,npx}`.
5. **Users.** The image's users with the same ids: `bot` 1000:1000 (also in `coders`), `cookies` 1900, group `coders` 1800, `coder` 1800:1800, `coder-runner` 1801:1800, and `screen-0` to `screen-89` as 2000 to 2089. The ids are fixed in `runas.c`, `apps/computer-agent/src/users.ts` and `packages/shared/src/coder-runtime.ts`. See "uid 1000" below.
6. **Directories.** `/home/bot` (the bot user's, from `/etc/skel`) and `/var/lib/openbots` (root's, 0711). The agent lays out everything inside the state directory itself at each start: the screens' directories, the cookie store, the coders' homes and config directories.
7. **runas.** Compiled from the bundle's source.
8. **node-pty.** If the bundle's binding does not load here, rebuilt with npm's node-gyp against this Node.
9. **MCP catalog and coding agents.** `npm ci --omit=dev --ignore-scripts` from the lockfiles, Claude Code's postinstall by hand, every CLI's `--version`, and a check that each is exactly its pinned version, as the image's stages do. Skipped when the lockfile is already installed. A new install is built beside the old one and swapped in.
10. **Launchers.** `/usr/local/bin/claude`, `codex`, `pi` and `openbots-git-credential`, byte for byte the image's, and the image's `git config --system` settings.
11. **Chromium.** Playwright's Chromium for the bundled `playwright-core` with `install --with-deps --no-shell chromium`, into `/opt/ms-playwright`, as in the image. Not Ubuntu's `chromium` package: on Ubuntu it is a snap, and snapd needs systemd, which a Sprite does not run. The step fails if Chromium is missing a library.
12. **Token and settings.** The token in `/etc/openbots/agent-token` (root, 0600, in a 0700 directory), the port and time zone in `/etc/openbots/agent.env`.
13. **Launcher.** `/usr/local/lib/openbots/sprite-agent`, the service's command (below).
14. **`/app`.** Switched to the new bundle in one step, only now, so a run that fails earlier leaves the running computer as it was.
15. **Service.** Registered (below), then the script waits up to 90 s for `/healthz` to answer 200 for the new token.
16. **Version.** `/opt/openbots/provision.version`.

### The service

A cold wake ends every process, and only a service registered with `sprite-env services` is started again by the runtime, at boot, after a cold wake and after a crash. There is one, `openbots-agent`:

```sh
sprite-env services create openbots-agent --cmd /usr/local/lib/openbots/sprite-agent \
  --dir /home/bot --http-port "$OPENBOTS_AGENT_PORT" --no-stream
```

It owns the HTTP port, so the Sprite's URL reaches the agent and a request to a paused Sprite starts it. Only one service may own the port; if another already does, the step fails and says so. There is no update command, so a run deletes the service and creates it again, which also restarts the agent with the new token and bundle.

Nothing else needs a service. The computer image has no entrypoint script of its own (`docker/entrypoint.sh` is the server image's); it runs `tini -- node main.js`, and the agent starts everything else itself, per screen and on demand: Xvfb, openbox, x11vnc, Chromium, the wallpaper (feh) and the cookie store sync. It also clears a stale X socket before it starts a display.

The service definition holds no token and no environment. The launcher, at each start:

1. Empties the cgroup `/sys/fs/cgroup/openbots-computer` and moves into it, so what an agent that crashed left running (Xvfb, Chromium, the Bots' shells) ends, as a stopped container would. Without a writable cgroup v2 tree it kills the screen, cookie and coder users' processes instead.
2. Mounts a tmpfs on `/dev/shm` if there is none, for Chromium.
3. Copies the token to `/var/lib/openbots/token` (root, 0600), where the agent reads and deletes it before it listens, as the docker provider puts it there before each start.
4. Starts `tini -s -- node /app/apps/computer-agent/dist/main.js` with an environment built from nothing (the image's `ENV` and what the docker provider passes: `PATH LANG NODE_ENV HOME TZ PLAYWRIGHT_BROWSERS_PATH OPENBOTS_HOME OPENBOTS_STATE_DIR OPENBOTS_AGENT_PORT`), under `setpriv --no-new-privs --bounding-set=-all,+chown,+setuid,+setgid`.

The agent's log is `/.sprite/logs/services/openbots-agent.log`.

## How the server reaches the agent

The provider (`packages/computer/src/sprites.ts`) talks to the agent through the Sprite's URL, `https://<name>-<org id>.sprites.app`, which routes to the service's HTTP port. `OPENBOTS_SPRITES_URL_AUTH` picks how:

- `public` (the default): the URL is open to the internet and the agent's own per-computer token, sent as `Authorization: Bearer`, is what guards every request. A private URL would want the Sprites org token in `Authorization`, and the Sprites docs do not say whether the proxy removes it before the request reaches the Sprite; an org token that reached a VM running a Bot's commands could act on every Sprite in the org.
- `sprite`: the URL is private to the org. The org token goes in `Authorization` for the proxy and the agent token in `X-OpenBots-Agent-Token`, which the agent also accepts. Use it only once `pnpm --filter @openbots/computer sprites-smoke` (with `SPRITES_TOKEN` set) reports that the proxy strips `Authorization`.

Either way the agent refuses any request without its token.

## Where a Sprite differs from the container

| Container (`packages/computer` docker provider)                                    | On a Sprite                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--cap-drop ALL --cap-add CHOWN,SETUID,SETGID`                                     | The same set, as the agent's bounding set (setpriv). The agent starts as root and drops to the bot user exactly as in the container.                                           |
| `no-new-privileges`                                                                | The same, set by setpriv on the agent and inherited by everything it starts, so `sudo` and other setuid programs give a Bot's command nothing.                                 |
| Its own Docker network; egress through the sandbox firewall and optional proxy     | The Sprite's network policy, set from outside the Sprite (`{ "include": "defaults" }` plus what Bots need). Nothing in the VM filters traffic, and no proxy variables are set. |
| Read-only root filesystem; writable volumes on `/home/bot` and `/var/lib/openbots` | A normal writable disk, all of it persistent. Root-owned files stay root's, but nothing stops root from writing anywhere.                                                      |
| tmpfs on `/tmp` (sized), `/var/tmp`, `/run`, cleared at each start                 | `/tmp` is on the disk and survives a cold wake. The agent clears stale X sockets itself and lays out `/tmp/openbots` at each start; nothing else is cleared.                   |
| `ShmSize`                                                                          | The VM's `/dev/shm`, or a tmpfs the launcher mounts, without the container's size limit.                                                                                       |
| Memory, CPU and pids limits                                                        | None set: the Sprite is the user's alone (8 vCPU, memory the platform manages).                                                                                                |
| `tini` as PID 1                                                                    | `tini -s` as a subreaper under the Sprite's own init.                                                                                                                          |
| Agent port 7070, on the sandbox network only                                       | Port 8080, on the Sprite URL. The provider makes the URL public by default (`OPENBOTS_SPRITES_URL_AUTH`, below), so the agent's per-computer token is what guards it.          |
| Token as a file put into the state volume before each start                        | The same file, copied from `/etc/openbots/agent-token` by the launcher before each start.                                                                                      |
| Ubuntu 24.04, Node from the official image                                         | Ubuntu 26.04, Node from nodejs.org, same major version.                                                                                                                        |

### The security boundary

In Docker, a Bot's commands are contained by the container: no capabilities beyond the three, no new privileges, a read-only root, and a network that reaches only what the firewall allows. Inside, the agent keeps the Bots from the token, from each other's screens, from the cookie store and from the coding agents' credentials by running each as its own user (S-7, I2).

On a Sprite **the VM is the boundary**. The per-user separation inside works the same way, and no-new-privileges and the capability bounding set are kept, so a Bot's command cannot become root through `sudo` or a setuid program. But a Bot that did become root, through a kernel bug for instance, would own the whole VM: the token, the cookie store, the coding agents' credentials and the disk. The container's read-only root, tmpfs mounts and resource limits have no counterpart. **Egress is the Sprite's network policy**, applied from outside by the provider; a Sprite with no policy reaches the whole internet, and nothing in the VM narrows it.

### uid 1000

`runas.c` gives the bot user uid 1000, and a Sprite may already have a user there: the image deletes Ubuntu's own `ubuntu` user, and `provision.sh` does the same. If uid 1000 belongs to another user, such as a Sprite's login user `sprite`, it moves that user (and its same-named group) to the first free id from 1001 with `usermod` and `groupmod`, so `sprite console` keeps working, and gives 1000 to bot. If that user has processes running, which is the case when `provision.sh` runs in a session of that user, the move is impossible and the step fails, saying so. The provider then has to run the first provisioning from a session that is not that user.

## Testing

Without a Sprite:

```sh
shellcheck -x docker/sprites/*.sh docker/sprites/test/*.sh docker/sprites/test/sprite-env
bash docker/sprites/build-bundle.sh
PROVISION_DRY_RUN=1 OPENBOTS_AGENT_TOKEN=dry-run-token-000000 OPENBOTS_AGENT_PORT=8080 \
  OPENBOTS_PROVISION_VERSION="$(cat docker/sprites/dist/VERSION)" \
  bash docker/sprites/provision.sh docker/sprites/dist/agent-bundle.tgz
bash docker/sprites/test/provision.test.sh   # needs Docker and network; several minutes
```

CI runs the first three. The container test gives a `sprite` user uid 1000 first, then checks the ids, files and modes, that the token is in no output and in no service definition, the agent's no-new-privileges and capability set, a command running as bot without sudo, a screen with Chromium and a screenshot, a second run with a new token (the old one refused, apt and the coding agents skipped), a dry run that changes nothing, and a bad token refused naming the step. Behind a proxy set `HTTPS_PROXY` and `TEST_CA_BUNDLE`; `IMAGE` picks another image and `KEEP=1` leaves the container running.

On a real Sprite, with the [sprite CLI](https://docs.fly.io/sprites/cli/commands.md):

```sh
bash docker/sprites/build-bundle.sh
sprite create obtest
token="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
# --env puts the token on your own command line; fine for a test Sprite.
sprite exec -s obtest \
  --file docker/sprites/dist/provision.sh:/tmp/provision.sh \
  --file docker/sprites/dist/agent-bundle.tgz:/tmp/agent-bundle.tgz \
  --env "OPENBOTS_AGENT_TOKEN=$token,OPENBOTS_AGENT_PORT=8080,OPENBOTS_PROVISION_VERSION=$(cat docker/sprites/dist/VERSION),TZ=UTC" \
  -- bash /tmp/provision.sh /tmp/agent-bundle.tgz
sprite exec -s obtest -- sprite-env services get openbots-agent
sprite exec -s obtest -- tail -n 50 /.sprite/logs/services/openbots-agent.log
sprite info -s obtest                       # the Sprite's URL
curl -H "Authorization: Bearer $token" <the URL>/healthz   # with the org's auth, unless the URL is public
```

Then check what a container cannot show: let the Sprite go cold (leave it idle long enough), and make a request to its URL; the agent should start again and answer. Start a screen (`POST /screens` with `{"n":0}`) and take a screenshot (`GET /screens/0/screenshot`). Run `provision.sh` again with a new token and check that the old one gets 401.

## Known gaps

Unverified without a real Sprite (each also marked `UNVERIFIED on a real Sprite:` in `provision.sh` where it applies):

- Which user holds uid 1000 on a Sprite, which user `sprite exec` and services run as, and that moving the uid-1000 user does not break `sprite exec` or `sprite console` (it would if the runtime started sessions by uid rather than by name).
- That the Sprite's apt sources use `archive.ubuntu.com`, `security.ubuntu.com` or `ports.ubuntu.com`, which the provider's egress policy allows with nodejs.org and Playwright's two download hosts (`SPRITES_PROVISION_DOMAINS`); the npm registry is taken to be in the Sprites `defaults` set, which is not documented host by host.
- That `/sys/fs/cgroup` is a writable cgroup v2 tree and the runtime does not mind the service moving into its own cgroup. Without it, processes of the bot user that a crashed agent left running are not ended.
- That a service's process is root (the launcher re-runs itself with `sudo -n` if not) and that `services delete` stops it.
- Playwright's dependency list on Ubuntu 26.04: Playwright may not list 26.04 yet and fall back to a release it knows. It worked in the `ubuntu:26.04` container.
- How long the first provisioning takes, and the agent's behaviour across warm and cold wakes. Open connections (a screen's VNC or a terminal's WebSocket) drop on any pause; the server reconnects.

Not done:

- Keeping a Sprite awake during a Bot's long run: the provider has `hold` and `release` (Tasks API), but the server does not call them yet.
- No memory, CPU or pids limits.
- The bundle must be built on x86_64 Linux with a glibc no newer than the Sprite's; node-pty is rebuilt on the Sprite when its binding does not load, but that path has only been reasoned about, not run.
- Bundles other than the current and the previous one are deleted; there is no rollback command, but pointing `/app` at the previous one in `/opt/openbots/bundles/` and restarting the service is one.
