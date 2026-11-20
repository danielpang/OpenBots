import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { clientIp } from '../client-ip.js';
import type { AppDeps, AppEnv } from '../context.js';
import { artifactHostKeys, resolveHostView } from '../services/artifact-sharing.js';
import { handleArtifactRequest, HOST_RATE_LIMIT, type ArtifactHostDeps } from './handler.js';
import { VIEW_TOKEN_SECONDS } from './tokens.js';

// Where the server answers for the artifact host (plan 21.11):
//
// - A request whose Host is under OPENBOTS_ARTIFACT_DOMAIN, whichever path:
//   the server itself behind a wildcard DNS name and certificate. It never
//   reaches the app's routes, its CORS or its session.
// - `/artifact-host/<path>` on the app's own host, from the edge Worker
//   (apps/artifact-worker), which sends the hostname it answered for, the
//   client's address and the shared secret (OPENBOTS_ARTIFACT_EDGE_SECRET).
//   Without that secret configured, or with a wrong one, it is a plain 404.

export const EDGE_PATH = '/artifact-host';
export const EDGE_SECRET_HEADER = 'x-openbots-edge-secret';
export const EDGE_HOST_HEADER = 'x-openbots-artifact-host';
export const EDGE_CLIENT_IP_HEADER = 'x-openbots-edge-client-ip';

export function artifactHostDeps(deps: AppDeps): ArtifactHostDeps | null {
  const host = deps.config.artifactHost;
  if (!host) return null;
  const keys = artifactHostKeys(deps.config.masterKey);
  return {
    domain: host.domain,
    keys,
    resolve: (target, viewer) => resolveHostView(deps, target, viewer),
    allow: async (key) =>
      (await deps.infra.limiter.consume(key, { window: 60, max: HOST_RATE_LIMIT })).allowed,
    // A token is good once: its nonce is claimed for longer than it lives.
    // With Redis the claim is a bucket of one in the shared limiter (one
    // atomic script, seen by every API process). Without it the server is
    // one process, and the claim is kept apart from the limiter's buckets,
    // which drop their oldest under a flood of addresses.
    claim:
      deps.infra.kind === 'redis'
        ? async (nonce) =>
            (
              await deps.infra.limiter.consume(`artifact-token:${nonce}`, {
                window: CLAIM_SECONDS,
                max: 1,
              })
            ).allowed
        : (() => {
            const claims = new MemoryClaims();
            return async (nonce: string) => claims.claim(nonce, CLAIM_SECONDS * 1000);
          })(),
  };
}

const CLAIM_SECONDS = VIEW_TOKEN_SECONDS * 2;

/**
 * Claimed nonces in one process: each kept until it expires, never dropped
 * early. Full of live claims (more tokens minted in two minutes than it
 * holds), it refuses a new one rather than forget an old one: that viewer
 * opens the link again.
 */
export class MemoryClaims {
  private readonly claims = new Map<string, number>();

  constructor(
    private readonly max = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  claim(key: string, ttlMs: number): boolean {
    const now = this.now();
    const until = this.claims.get(key);
    if (until !== undefined && until > now) return false;
    if (until === undefined && this.claims.size >= this.max) {
      for (const [k, expires] of this.claims) if (expires <= now) this.claims.delete(k);
      if (this.claims.size >= this.max) return false;
    }
    this.claims.set(key, now + ttlMs);
    return true;
  }
}

const hostnameOf = (host: string | undefined) =>
  (host ?? '').replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers every request to a host under the artifact domain, before any app route. */
export function artifactHostMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const host = artifactHostDeps(deps);
  const domain = deps.config.artifactHost?.domain;
  return async (c, next) => {
    if (!host || !domain) return next();
    const hostname = hostnameOf(c.req.header('host'));
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      if (c.req.path !== EDGE_PATH && !c.req.path.startsWith(`${EDGE_PATH}/`)) return next();
      return edge(c.req.raw, c.req.path, host, deps.config.artifactHost?.edgeSecret);
    }
    return handleArtifactRequest(c.req.raw, host, { hostname, clientIp: clientIp(c) });
  };
}

async function edge(
  request: Request,
  path: string,
  host: ArtifactHostDeps,
  secret: string | undefined,
): Promise<Response> {
  const headers = request.headers;
  if (!secret || !sameSecret(headers.get(EDGE_SECRET_HEADER) ?? undefined, secret)) {
    return new Response(JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404 }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    });
  }
  const given = hostnameOf(headers.get(EDGE_HOST_HEADER) ?? undefined);
  // Only a plain hostname goes into the URL; anything else is no host at all (404).
  const hostname = /^[a-z0-9.-]{1,253}$/.test(given) ? given : '';
  const search = new URL(request.url).search;
  const forwarded = new Request(
    `https://${hostname || 'invalid.invalid'}${path.slice(EDGE_PATH.length) || '/'}${search}`,
    {
      method: request.method,
      headers,
    },
  );
  return handleArtifactRequest(forwarded, host, {
    hostname,
    clientIp: headers.get(EDGE_CLIENT_IP_HEADER),
  });
}
