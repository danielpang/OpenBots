import { WebhookSignatureSchema } from '@openbot/shared';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { clientIp } from '../client-ip.js';
import type { AppEnv } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError, notFound, unauthorized } from '../errors.js';
import { observeWebhook } from '../metrics.js';
import { effectiveSettings, ensureWorkspace } from '../workspace.js';
import {
  acceptDelivery,
  hasToken,
  INBOX_SLUG,
  parsePayload,
  recordRefusal,
  signingSecret,
  syncWaitSeconds,
  type EndpointRow,
} from './endpoints.js';
import { waitForReply } from './sync.js';
import {
  ipAllowed,
  presentedToken,
  TOKEN_PREFIX,
  tokenMatches,
  verifySignature,
} from './verify.js';

// Webhook ingress (plan 11, H1 to H4), outside the authenticated API:
//
//   POST /hooks/{botHandle}                         the Bot inbox (slug `inbox`)
//   POST /hooks/{botHandle}/{endpointSlug}          any endpoint, e.g. a Routine trigger
//   POST /hooks/{botHandle}[/{endpointSlug}]/{token} with the token in the path
//
// The pipeline, in order: the caller's rate limit, size limit, find the
// endpoint (404 for anything unknown or disabled, so slugs do not leak), IP
// allowlist, token, HMAC preset, the endpoint's rate limit, handshakes, then
// idempotency, store, match and enqueue (endpoints.ts), and the response by
// mode. A request that fails the IP, token or signature check is refused
// and, once the failed-verification bucket lets it through, kept in the
// delivery log in short form (`recordRefusal`: headers redacted and capped, a
// 2 KB body preview, no body file, the 50 newest per endpoint), so the owner
// sees why a sender's events never arrive (H5). The rate limits are token
// buckets in the infra's limiter (Redis when REDIS_URL is set). The caller's
// bucket comes before the body is read, so a flood is cut off early (S-14).
// The endpoint's bucket is charged only for verified requests, so a stranger
// cannot spend the real sender's minute; failed verifications have their own
// bucket per endpoint and address. The caller's address is the one
// client-ip.ts resolves (S-5). The three rates are limits (webhookIpRatePerMin,
// webhookFailedAuthPerMin, webhookEndpointRatePerMin): the environment's, or
// the admin's from Settings.

const tooLarge = (limit: number) =>
  new DomainError(413, 'PAYLOAD_TOO_LARGE', `Webhook payloads can be at most ${limit} bytes`);
const forbiddenIp = () =>
  new DomainError(403, 'IP_NOT_ALLOWED', "This address is not on the endpoint's allowlist");
const badSignature = (reason: string) => new DomainError(401, 'INVALID_SIGNATURE', reason);
const rateLimited = (what: string) =>
  new DomainError(429, 'RATE_LIMITED', `Too many deliveries ${what}; retry in a minute`);

/** Reads the body up to `limit` bytes; 413 past it, whatever Content-Length said. */
async function readBody(c: Context<AppEnv>, limit: number): Promise<Buffer> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > limit) throw tooLarge(limit);
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Takes a token from the bucket at `key`; 429 with `Retry-After` when it is empty. */
async function throttle(c: Context<AppEnv>, key: string, max: number, what: string) {
  const { allowed, retryAfter } = await c.var.deps.infra.limiter.consume(key, { window: 60, max });
  if (allowed) return;
  observeWebhook('inbound', 'rate_limited');
  c.header('retry-after', String(retryAfter ?? 60));
  throw rateLimited(what);
}

const lowerHeaders = (c: Context<AppEnv>) =>
  Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

/** `[slug, token]` from the path segments after the handle. */
function route(rest: string[]): [slug: string, token: string | undefined] {
  const [first, second] = rest;
  if (!first) return [INBOX_SLUG, undefined];
  if (second) return [first, second];
  return first.startsWith(TOKEN_PREFIX) ? [INBOX_SLUG, first] : [first, undefined];
}

async function findEndpoint(c: Context<AppEnv>, handle: string, slug: string) {
  const { db } = c.var.deps;
  const [found] = await db
    .select({ endpoint: schema.webhookEndpoints })
    .from(schema.webhookEndpoints)
    .innerJoin(schema.bots, eq(schema.bots.id, schema.webhookEndpoints.botId))
    .where(
      and(eq(schema.bots.handle, handle.toLowerCase()), eq(schema.webhookEndpoints.slug, slug)),
    );
  if (!found?.endpoint.enabled) throw notFound('No such webhook endpoint');
  return found.endpoint;
}

/** IP allowlist, token and signature (H3); returns whether a signature verified it. */
function authenticate(
  c: Context<AppEnv>,
  endpoint: EndpointRow,
  headers: Record<string, string>,
  body: Buffer,
  pathToken: string | undefined,
  remoteIp: string | null,
) {
  if (!ipAllowed(remoteIp, endpoint.allowedIps)) throw forbiddenIp();
  // An inbox made with its Bot accepts nothing until the owner generates its token (H1).
  if (!hasToken(endpoint)) throw unauthorized('This endpoint has no token yet');
  const signature = WebhookSignatureSchema.safeParse(endpoint.signature);
  const token = presentedToken(headers, pathToken);
  // A token, when sent, must be right; without a signature preset one is required.
  if (token !== undefined && !tokenMatches(token, endpoint.tokenHash))
    throw unauthorized('Wrong token');
  if (!signature.success) {
    if (token === undefined) throw unauthorized('Send the endpoint token');
    return;
  }
  const secret = signingSecret(c.var.deps, endpoint);
  if (!secret) throw badSignature('The endpoint has no signing secret');
  const result = verifySignature(signature.data, secret, headers, body);
  if (!result.ok) throw badSignature(result.reason);
}

/** Slack `url_verification`, GitHub `ping` and a generic `{challenge}` echo (H4). */
function handshake(
  c: Context<AppEnv>,
  endpoint: EndpointRow,
  headers: Record<string, string>,
  body: Buffer,
) {
  const payload = parsePayload(body, headers['content-type']) as Record<string, unknown>;
  const preset = WebhookSignatureSchema.safeParse(endpoint.signature).data?.preset;
  if (payload['type'] === 'url_verification' && typeof payload['challenge'] === 'string') {
    return c.json({ challenge: payload['challenge'] }, 200);
  }
  if (headers['x-github-event'] === 'ping') return c.json({ ok: true }, 200);
  if (preset !== 'slack' && preset !== 'github' && typeof payload['challenge'] === 'string') {
    const keys = Object.keys(payload).filter((k) => k !== 'type');
    if (keys.length === 1) return c.json({ challenge: payload['challenge'] }, 200);
  }
  return null;
}

async function ingress(c: Context<AppEnv>, rest: string[]) {
  const { deps } = c.var;
  const { limits } = effectiveSettings(deps.config, await ensureWorkspace(deps.db));
  const handle = c.req.param('handle')!;
  const [slug, pathToken] = route(rest);
  const remoteIp = clientIp(c);
  if (remoteIp)
    await throttle(c, `hook-ip:${remoteIp}`, limits.webhookIpRatePerMin, 'from this address');
  const body =
    c.req.method === 'GET' ? Buffer.alloc(0) : await readBody(c, limits.webhookPayloadBytes);
  const endpoint = await findEndpoint(c, handle, slug);
  const headers = lowerHeaders(c);
  try {
    authenticate(c, endpoint, headers, body, pathToken, remoteIp);
  } catch (error) {
    observeWebhook('inbound', 'rejected');
    deps.logger.warn(
      { endpointId: endpoint.id, remoteIp, reason: (error as Error).message },
      'webhook rejected',
    );
    await throttle(
      c,
      `hook-fail:${endpoint.id}:${remoteIp ?? 'unknown'}`,
      limits.webhookFailedAuthPerMin,
      'failing verification from this address',
    );
    await recordRefusal(deps, endpoint, {
      headers,
      body,
      remoteIp,
      reason: (error as Error).message,
    }).catch((err: unknown) =>
      deps.logger.error({ err, endpointId: endpoint.id }, 'could not log a refused webhook'),
    );
    throw error;
  }
  await throttle(
    c,
    `hook-endpoint:${endpoint.id}`,
    endpoint.rateLimitPerMin ?? limits.webhookEndpointRatePerMin,
    'to this endpoint',
  );

  // A GET is only ever a challenge echo (`?challenge=`), used by some senders to check the URL.
  if (c.req.method === 'GET') {
    const challenge = c.req.query('challenge') ?? c.req.query('hub.challenge');
    if (!challenge) throw new DomainError(405, 'METHOD_NOT_ALLOWED', 'Deliver events with POST');
    return c.text(challenge, 200);
  }
  const shook = handshake(c, endpoint, headers, body);
  if (shook) return shook;

  const accepted = await acceptDelivery(deps, endpoint, {
    headers,
    body,
    remoteIp,
    verified: true,
    origin: 'ingress',
    ...(headers['idempotency-key'] ? { idempotencyKey: headers['idempotency-key'] } : {}),
  });
  const { delivery, run } = accepted;
  if (accepted.duplicate) {
    observeWebhook('inbound', 'duplicate');
    return c.json({ delivery_id: delivery.id, run_id: delivery.runId, duplicate: true }, 200);
  }
  if (!run) {
    observeWebhook('inbound', 'unmatched');
    return c.json({ delivery_id: delivery.id, run_id: null, matched: delivery.matched }, 200);
  }
  observeWebhook('inbound', 'started');
  if (endpoint.responseMode !== 'sync') {
    return c.json({ delivery_id: delivery.id, run_id: run.id }, 202);
  }
  const seconds = syncWaitSeconds(endpoint, limits.syncWebhookWaitSeconds);
  const reply = await waitForReply(deps, run.id, seconds * 1000);
  if (!reply) {
    // Still running: the caller has the ids and the reply lands in the transcript.
    return c.json(
      { delivery_id: delivery.id, run_id: run.id, status: 'running', text: null, timed_out: true },
      202,
    );
  }
  return c.json(
    {
      delivery_id: delivery.id,
      run_id: run.id,
      status: reply.status,
      text: reply.text,
      ...(reply.error ? { error: reply.error } : {}),
    },
    200,
  );
}

export const hookIngressRoutes = new Hono<AppEnv>()
  .on(['GET', 'POST'], '/hooks/:handle', (c) => ingress(c, []))
  .on(['GET', 'POST'], '/hooks/:handle/:a', (c) => ingress(c, [c.req.param('a')]))
  .on(['GET', 'POST'], '/hooks/:handle/:a/:b', (c) =>
    ingress(c, [c.req.param('a'), c.req.param('b')]),
  );
