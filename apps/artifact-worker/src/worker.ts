// The Cloudflare Worker in front of the artifact host (plan 21.11). It
// answers for every `<bot>--<org>.<ARTIFACT_DOMAIN>` hostname, forwards the
// request to the server's /artifact-host/ path with the shared secret, the
// hostname it answered for and the client's address, and caches only what
// the server marks public. The server decides everything else: who may see
// what, the headers, the token exchange. Reading blobs straight from object
// storage here is a later step; the server has no object storage driver yet.

export interface Env {
  /** The artifact domain, as the server's OPENBOTS_ARTIFACT_DOMAIN. */
  ARTIFACT_DOMAIN: string;
  /** The server's public address, such as https://app.openbots.example. */
  ORIGIN: string;
  /** The server's OPENBOTS_ARTIFACT_EDGE_SECRET; a Worker secret. */
  EDGE_SECRET: string;
}

/** What the Worker needs from its runtime, so tests can stand it in. */
export interface EdgeRuntime {
  fetch(request: Request): Promise<Response>;
  cache: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
  waitUntil(promise: Promise<unknown>): void;
}

export const EDGE_SECRET_HEADER = 'x-openbots-edge-secret';
export const EDGE_HOST_HEADER = 'x-openbots-artifact-host';
export const EDGE_CLIENT_IP_HEADER = 'x-openbots-edge-client-ip';

/** The request headers the server may see; nothing else the client sent goes through. */
const FORWARDED = ['accept', 'accept-language', 'cookie', 'user-agent'];

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });

/**
 * Whether the request and its answer may be stored at the edge: a GET with
 * no cookie, no view token and no credentials, answered 200 with
 * `Cache-Control: public` and no cookie set. A private or organization view
 * always comes with the view cookie or token, and the server marks it
 * `private, no-store`, so it is never stored; both are checked.
 */
export function cacheableRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.method === 'GET' &&
    !request.headers.has('cookie') &&
    !request.headers.has('authorization') &&
    !url.searchParams.has('token')
  );
}

export function cacheableResponse(response: Response): boolean {
  const control = response.headers.get('cache-control') ?? '';
  return (
    response.status === 200 &&
    /(^|,)\s*public\s*(,|$)/.test(control) &&
    !/no-store|private/.test(control) &&
    !response.headers.has('set-cookie')
  );
}

export async function handle(request: Request, env: Env, runtime: EdgeRuntime): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  // Only names under the artifact domain; the server checks the label itself.
  if (!host.endsWith(`.${env.ARTIFACT_DOMAIN.toLowerCase()}`)) return notFound();

  // The query never changes a public answer, so it is not part of the key
  // (and cannot be used to fill the cache with copies).
  const key = new Request(`https://${host}${url.pathname}`, { method: 'GET' });
  const cacheable = cacheableRequest(request);
  if (cacheable) {
    const hit = await runtime.cache.match(key);
    if (hit) return hit;
  }

  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set(EDGE_SECRET_HEADER, env.EDGE_SECRET);
  headers.set(EDGE_HOST_HEADER, host);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set(EDGE_CLIENT_IP_HEADER, ip);
  const origin = env.ORIGIN.replace(/\/+$/, '');
  const response = await runtime.fetch(
    new Request(`${origin}/artifact-host${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      // The token exchange answers 303 with the cookie; it goes back to the browser as it is.
      redirect: 'manual',
    }),
  );
  if (cacheable && cacheableResponse(response)) {
    runtime.waitUntil(runtime.cache.put(key, response.clone()));
  }
  return response;
}

/** Cloudflare's own globals, typed here so the package needs no Workers types. */
declare const caches: { default: EdgeRuntime['cache'] };

export default {
  fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    return handle(request, env, {
      fetch: (r) => fetch(r),
      cache: caches.default,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
};
