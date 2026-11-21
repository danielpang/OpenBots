# Artifact edge Worker

A small Cloudflare Worker in front of the artifact host (plan 21.11 in
[TECHNICAL_PLAN.md](../../docs/plans/TECHNICAL_PLAN.md)). Shared Artifacts are served at
`https://<bot>--<organization>.<artifact domain>/<artifact id>/`, on a registrable domain apart
from the app's. This Worker answers for every one of those hostnames, so the server does not need
a wildcard certificate of its own:

- It forwards each request to the server's `/artifact-host/<path>` with the shared secret
  (`EDGE_SECRET`, the server's `OPENBOTS_ARTIFACT_EDGE_SECRET`), the hostname it answered for and
  the client's address. Only a few request headers go through (the cookie and the browser's
  `Sec-Fetch-Dest` and `Sec-Fetch-Site` among them); anything else the client sent, including its
  own copy of the Worker's headers, does not.
- The server decides everything else: who may see what, the sandboxing headers, the view token
  and cookie, the 404s and the rate limit.
- It caches only answers the server marks `Cache-Control: public` (a public Artifact, for 60
  seconds), and only for a GET with no cookie, no token and no credentials. A private or
  organization view is never stored at the edge, and neither is the page that asks before a viewer
  leaves an Artifact (`/<id>/leave`). The cache key is the path with `Sec-Fetch-Dest` and
  `Sec-Fetch-Site`, since the server serves an HTML page's content with its scripts only into the
  frame of the host's wrapper (`/<id>/content`), and differently to anything else.

Nothing here is deployed by CI. The artifact domain is not bought yet.

## Deploy

1. Add the artifact domain to Cloudflare, with a proxied wildcard DNS record (`*.<domain>`) so
   Cloudflare holds the certificate for every Bot's name. Leave the bare domain unused.
2. In `wrangler.toml`, set `ARTIFACT_DOMAIN`, `ORIGIN` (the server's `OPENBOTS_PUBLIC_URL`) and
   the route `*.<domain>/*`.
3. Generate a secret (`pnpm -s --filter @openbots/server keygen` makes a long random one), set it
   on the server as `OPENBOTS_ARTIFACT_EDGE_SECRET` and on the Worker with
   `wrangler secret put EDGE_SECRET`.
4. Set `OPENBOTS_ARTIFACT_DOMAIN` on the server to the same domain, then `wrangler deploy`.

## Taking a public link down

`openbots artifacts takedown <link> [reason]` on the server stops serving it at once. The edge may
still hold the last public answer for up to 60 seconds; purge the URL in Cloudflare (the dashboard
or the purge API) when that minute matters.

## Where the bytes come from

Every request goes to the server, which decides on each one who may see the Artifact and streams
its bytes from wherever the server stores files: its own disk under `OPENBOTS_FILES_DIR` with the
default `local` storage driver, or an S3-compatible bucket (Cloudflare R2 on the hosted service)
with `OPENBOTS_STORAGE_DRIVER=s3`. The Worker never reads the bucket. It caches public answers
only, for 60 seconds, as above.

## Later

Reading public blobs straight from the bucket at the edge, so public Artifacts are served without
the server, is a later optimization. Visibility is decided by the server per request, so the
Worker would need that decision too (a takedown, or a change of visibility or of the organization's
public links switch, must still land within a minute). The server's handler
(`apps/server/src/artifact-host/`) uses web APIs only, so it can move into this Worker with its
lookups and blob access injected when that is worth doing.

## Tests

```sh
pnpm --filter @openbots/artifact-worker test
```
