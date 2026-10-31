import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppDeps, AppEnv, CurrentUser } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError, forbidden, notFound, unauthorized } from '../errors.js';

// Every route that needs a caller uses one of these. A request authenticates
// with the better-auth session cookie or with an API key (U4), sent as
// `Authorization: Bearer <key>` or `x-api-key: <key>`; both reach the same
// routes with the same permissions. A member an admin disabled gets 403
// ACCOUNT_DISABLED either way, so their API keys stop working too. On a
// self-hosted install only the owner (the admin) gets in: accounts left from
// a managed install are refused, since nobody there can disable them.

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  c.set('user', await authenticate(c));
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = await authenticate(c);
  if (user.role !== 'admin') throw forbidden('Only an admin can do this');
  c.set('user', user);
  await next();
});

/**
 * Members, invites and the audit log belong to the managed service. A
 * self-hosted install has one owner and none of them: these routes answer
 * 404 there, before any sign-in check. Put it first, then `requireAdmin`.
 */
export const requireManaged = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.deps.config.deployment !== 'managed') throw notFound();
  await next();
});

export function apiKeyFrom(headers: Headers): string | undefined {
  const authorization = headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? headers.get('x-api-key') ?? undefined;
}

function authenticate(c: Context<AppEnv>): Promise<CurrentUser> {
  return authenticateHeaders(c.var.deps, c.req.raw.headers);
}

/**
 * The caller behind a set of request headers: the session cookie or an API
 * key. Throws 401 or 403. Used by the middleware above and the WS upgrade.
 */
export async function authenticateHeaders(
  { auth, db, config }: Pick<AppDeps, 'auth' | 'db' | 'config'>,
  headers: Headers,
): Promise<CurrentUser> {
  const key = apiKeyFrom(headers);

  let userId: string | undefined;
  let via: CurrentUser['via'];
  if (key) {
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key) throw unauthorized('Invalid API key');
    userId = result.key.referenceId;
    via = 'api_key';
  } else {
    const session = await auth.api.getSession({ headers });
    userId = session?.user.id;
    via = 'session';
  }
  if (!userId) throw unauthorized();

  const [row] = await db
    .select({ user: schema.users, member: schema.workspaceMembers })
    .from(schema.users)
    .innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.userId, schema.users.id))
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) throw forbidden('This account is not a member of the workspace');
  const { user, member } = row;
  if (member.disabledAt) throw accountDisabled();
  if (config.deployment === 'self_hosted' && member.role !== 'admin') throw notOwner();
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    role: member.role,
    workspaceId: member.workspaceId,
    via,
  };
}

export const notOwner = () =>
  new DomainError(403, 'NOT_OWNER', 'This OpenBot has one account, its owner.');

export const accountDisabled = () =>
  new DomainError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Ask an admin to enable it.');
