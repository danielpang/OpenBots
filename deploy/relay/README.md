# The OpenBots relay on Fly.io

This runs the shared relay as one Fly Machine behind one hostname. It is how the project runs the relay that every install without its own uses.

The relay runs with `SINGLE_SERVER_DEPLOY=true` (set in `fly.toml`). Its registry lives in memory and it never calls Redis, even when a `RELAY_REDIS_URL` secret is set. That is safe only because there is exactly one Machine: every server (the Mac app or a self-hosted server) and every phone (the iOS app) connects to the same Machine, so they always meet. With a second Machine, a phone that lands on a Machine other than its server's gets 4404. Keep the count at 1.

To run the relay as several Machines again, see [Several Machines](#several-machines) at the end of this page.

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account.

## Create the app

From a checkout of this repository:

```sh
cd deploy/relay
fly launch --copy-config --no-deploy --name <your app>
```

`fly launch` keeps this file's settings and writes your app name and region into it. The file has no `[build]`: every deploy names its image with `--image`, and after the first one the workflow below deploys for you.

## Set the secrets

Fly secrets reach the Machine as environment variables. Setting them restarts it.

```sh
fly secrets set RELAY_METRICS_TOKEN="$(openssl rand -hex 32)"
```

`RELAY_METRICS_TOKEN` turns on `GET /metrics`; without it the route answers 404. No Redis is needed. A `RELAY_REDIS_URL` secret left over from a multi-Machine setup is ignored while `SINGLE_SERVER_DEPLOY` is true (the relay logs `RELAY_REDIS_URL is set but not used` at start); you can remove it with `fly secrets unset RELAY_REDIS_URL` and delete the Redis.

To send the anonymous usage data the Terms describe to PostHog, set `fly secrets set POSTHOG_API_KEY=<project key>` (and `RELAY_POSTHOG_HOST` for the EU cloud). Without it the relay sends nothing. See [Anonymous usage data](../../apps/relay/README.md#anonymous-usage-data).

Push needs the project's APNs key, and only the project's own relay has one (it belongs to the App Store build). Set it as a secret that holds the `.p8` file in base64. The relay reads it once at start and deletes it from its environment, so no key file is needed:

```sh
fly secrets set RELAY_APNS_KEY="$(base64 < AuthKey_XXXXXXXXXX.p8 | tr -d '\n')" \
  RELAY_APNS_KEY_ID=XXXXXXXXXX \
  RELAY_APNS_TEAM_ID=YYYYYYYYYY \
  RELAY_APNS_TOPIC=dev.openbots.app
```

For a relay without push (tunnel only, every push answered `unavailable`), set none of these. Each push names its APNs environment (`production` or `sandbox`), so one relay serves App Store, TestFlight and development builds alike.

Presence (`GET /v1/hosts/{id}`) tells anyone who has a host id whether that server is online. To keep that to yourself, set `RELAY_PRESENCE_TOKEN` (at least 16 characters). The iOS app does not use presence, so nothing breaks.

```sh
fly secrets set RELAY_PRESENCE_TOKEN="$(openssl rand -hex 32)"
```

Leave `RELAY_NODE_ID` unset. On Fly the relay uses the Machine's own `FLY_MACHINE_ID`.

## Deploy, and keep one Machine

`.github/workflows/deploy-relay.yml` deploys the relay (see below). For the first deploy, run it by hand from the Actions tab (Deploy relay, Run workflow) once the secrets are set, or deploy a release from GHCR yourself with `fly deploy --ha=false --image ghcr.io/danielpang/openbots/relay:<version>`. Without `--ha=false`, the first `fly deploy` of an app creates two Machines. Then make sure there is exactly one:

```sh
fly scale count 1 --yes     # destroys any Machine past the first
fly status                  # one Machine, started
fly checks list
fly logs | grep SINGLE_SERVER_DEPLOY   # "SINGLE_SERVER_DEPLOY is set: one machine, ..."
```

An app that ran several Machines before needs the same `fly scale count 1`. Count stopped Machines too: `fly scale count` destroys them, and `fly machine list` should show one.

The workflow deploys on every push to `main` that changes the relay (`apps/relay`, its Dockerfile, the lockfile, or this `fly.toml`). No tag or release is needed. It runs the relay's typecheck and tests, builds `docker/relay.Dockerfile` for linux/amd64, pushes it to GHCR as `ghcr.io/<owner>/openbots/relay:sha-<commit sha>` and runs `fly deploy --image` with it, so Fly pulls it from GHCR. The `openbots/relay` package must be public (its package settings on GitHub), since Fly pulls without credentials. Only the `sha-` tag is pushed: the version tags and `latest` still move only with a release. It needs one repository secret, `FLY_API_TOKEN`:

```sh
fly tokens create deploy -a <your app>    # then: gh secret set FLY_API_TOKEN
```

Run it by hand to redeploy `main`. Do not also connect the repository in Fly's dashboard, or every push deploys twice. Self-hosted relays are unaffected: they run the GHCR image each release publishes.

The proxy never stops the Machine when it is idle (`auto_stop_machines = "off"`). If the Machine stops anyway (a host maintenance on Fly's side, `fly machine stop`, or a drain that exited), the proxy starts it again on the next request (`auto_start_machines = true`), so the relay comes back on its own. That is also why the count must stay at 1: the proxy would start a second, stopped Machine just the same, and servers and phones could then land on different Machines.

The Machine takes up to 20,000 sockets (host links and phone streams together, `RELAY_MAX_SOCKETS`), and at 20,000 the proxy sends it no more (`[http_service.concurrency]`). It also holds at most 512 MiB of bytes in flight (`RELAY_BUDGET_BYTES`), which is why it has 2 GB of memory; raise both together. To carry more, give it a bigger size (`[[vm]]` in `fly.toml`) before you reach for more Machines. `openbots_relay_sockets` and `rejections_total{reason="sockets"}` show how close it is.

## A custom hostname

The app answers at `https://<your app>.fly.dev` at once. For your own name:

```sh
fly ips list                                  # add an A record for the IPv4 and an AAAA record for the IPv6
fly certs add relay.example.com
fly certs show relay.example.com              # wait until the certificate is issued
```

Fly terminates TLS and passes WebSocket upgrades through. Point servers at it with `OPENBOTS_RELAY_URL=wss://relay.example.com`.

## Deploys

With one Machine, a deploy is a short outage. `fly deploy` replaces the Machine in place (`strategy = "rolling"`). The old one gets SIGTERM and drains:

1. `/ready` answers 503 with `"draining"`, so the proxy sends it nothing new.
2. It refuses new upgrades and pushes.
3. It closes each host link with 1012 (service restart) as soon as the pushes in flight on it are answered.
4. After 20 seconds (`RELAY_DRAIN_GRACE_MS`), or sooner once nothing is left, it closes whatever remains with 1012.

Then the new Machine starts. Until it answers, servers and phones cannot connect, and they retry with their usual backoff. A phone sees a reconnect; it does not lose its place, since the app resyncs from its last sequence number. `kill_timeout = 30` gives the drain its 20 seconds and room to close; keep it above the grace period if you change either.

A crash or a host failure on Fly's side is an outage too, until Fly restarts the Machine. That is the price of not running Redis.

A restart also resets the per host limits (stream opens and pushes an hour, bytes a minute), which live in the Machine's memory, so every host starts a fresh window after each deploy. Several relay deploys in one hour loosen those limits by that much.

## Several Machines

To run the shared relay as several Machines again (for more capacity than one Machine has, or to survive a Machine going away), all of these change together:

1. Create a Redis close to the primary region (`fly redis create`, or a Redis Machine of your own on the private network) and set `fly secrets set RELAY_REDIS_URL='redis://default:<password>@<host>:6379'`.
2. In `fly.toml`, remove `SINGLE_SERVER_DEPLOY` (or set it to `"false"`), and let the proxy stop idle Machines: `auto_stop_machines = "stop"` (`auto_start_machines` is already `true`).
3. Drop `--ha=false` from the workflow if you want Fly's default of two Machines on a new app, and scale: `fly scale count 2`, or `fly scale count 4 --region iad,fra,sin`.

Then one Machine owns each host id through a lease in Redis, and a Machine that gets a connection for a host another one owns answers with `fly-replay`, so Fly's proxy sends it to the owner. How that works, and what happens when Redis or a Machine goes away, is in [Several machines](../../apps/relay/README.md#several-machines). Replays work only on Fly; behind any other proxy, several machines need sticky routing by host id in your load balancer.

## Metrics

`GET /metrics` wants `Authorization: Bearer <RELAY_METRICS_TOKEN>`:

```sh
curl -H "Authorization: Bearer $RELAY_METRICS_TOKEN" https://relay.example.com/metrics
```

With one Machine, that is the whole relay. With several, it reaches whichever Machine the proxy picks; to scrape each, use Fly's private network from a Prometheus inside the organization (`<machine id>.vm.<your app>.internal:3200`), or Fly's managed Prometheus with a `[metrics]` section if you prefer. The series, all prefixed `openbots_relay_`:

| Metric                               | What it counts                                                     |
| ------------------------------------ | ------------------------------------------------------------------ |
| `sockets{kind}`                      | Open host links (`host`) and phone streams (`client`)              |
| `hosts_owned`                        | Host ids this Machine holds the lease for                          |
| `streams`                            | Open phone streams                                                 |
| `replays_total{kind}`                | Connections replayed to the owning Machine                         |
| `rejections_total{reason}`           | Connections turned away: `sockets`, `bytes`, `draining`, and so on |
| `bytes_forwarded_total{direction}`   | Stream bytes `to_host` and `to_client`                             |
| `paused_sources`                     | Senders paused because the other end is behind                     |
| `blocked_destinations`               | Receivers above their high-water mark                              |
| `shed_peers_total{kind}`             | Receivers closed 1013 after staying blocked for 30 seconds         |
| `lease_renewals_total{result}`       | Lease renewals, `ok` or `failed`                                   |
| `lease_losses_total{reason}`         | Leases lost or given up                                            |
| `budget_bytes`, `budget_bytes_limit` | Bytes in flight, and the budget                                    |
| `budget_sockets_limit`, `draining`   | The socket ceiling, and 1 while draining                           |
| `cluster_size`                       | Live Machines this one sees                                        |
| `registry_degraded`                  | 1 while this Machine cannot reach Redis and serves on without it   |
| `hosts_alone`, `served_alone_total`  | Hosts served on this Machine alone while Redis is away             |
| `push_failures_total`                | Pushes answered `error` because sending them failed                |

Plus Node's process metrics (CPU, memory, event loop lag) under the same prefix. Watch `shed_peers_total` and `rejections_total{reason="bytes"}`: a steady rise means the Machine is short of memory or phones are on poor networks. With one Machine, `cluster_size` stays at 1, and `lease_losses_total` and `registry_degraded` stay flat outside deploys. The relay still holds an in-memory lease for each linked host, so `hosts_owned` follows the number of linked servers and `lease_renewals_total{result="ok"}` keeps rising; that is normal.

## What the relay sees and stores

What the relay sees, what it keeps, and what its logs and metrics carry is in [What the relay sees, and what it does not](../../apps/relay/README.md#what-the-relay-sees-and-what-it-does-not). With `SINGLE_SERVER_DEPLOY` it keeps the rate counters in memory only and writes nothing to disk.
