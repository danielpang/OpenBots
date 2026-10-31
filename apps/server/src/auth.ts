import { hkdfSync } from 'node:crypto';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { symmetricEncrypt } from 'better-auth/crypto';
import { eq, isNotNull, or } from 'drizzle-orm';
import { CLIENT_IP_HEADER } from './client-ip.js';
import type { Config } from './config.js';
import { schema, type Db } from './db/client.js';
import { problem } from './errors.js';
import type { RateLimiter } from './infra/rate-limit.js';
import { findRedeemableInvite, inviteTokenFrom, redeemInvite } from './invites.js';
import type { Logger } from './logger.js';
import { parseMasterKey } from './secrets.js';
import { recordAudit } from './services/audit.js';
import { effectiveSettings, ensureWorkspace, lockWorkspace, type Role } from './workspace.js';

// better-auth (plan section 3): email and password, optional GitHub and Google
// sign-in, cookie sessions, and API keys (U4). Mounted at `/api/auth/*`.
//
// Signup policy (U1) lives in the user-create hooks so it covers every way an
// account is made, OAuth included. The first user of an instance becomes its
// admin in every mode. A self-hosted install (OPENBOT_DEPLOYMENT) is one
// person's: that first account is its owner and every later signup is
// refused, invite or not, whatever the stored signup mode. On the managed
// service, `open` lets anyone in as a member, while `first_user_admin` and
// `invite` both require an unused invite.
//
// Rate limits (plan 17 control 6, S-6) are on in every environment, in the
// infra's limiter (Redis when REDIS_URL is set), keyed on the client address
// `createApp` resolves per TRUSTED_PROXIES and passes in CLIENT_IP_HEADER.
// A request without one is refused rather than counted in a shared bucket.
//
// An admin can disable a member (services/members.ts): their sessions are
// deleted there, and the session hook below refuses new ones.
//
// Audit (S-11): every new session is an `auth.sign_in` (email, OAuth, and
// the sign-in that follows a signup), signing out is `auth.sign_out`, and a
// refused email sign-in is `auth.sign_in_failed` with the address tried.
//
// Sign-in providers' access and refresh tokens are encrypted at rest with the
// better-auth secret (`encryptOAuthTokens`, S-9); rows from before are
// encrypted at start-up by `encryptStoredOAuthTokens`.

export const API_KEY_PREFIX = 'obk_';

/**
 * The part of the better-auth instance the server uses. Spelled out because the
 * inferred type is too large to emit; widen it when a route needs more.
 */
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
    verifyApiKey(input: {
      body: { key: string };
    }): Promise<{ valid: boolean; key: { referenceId: string } | null }>;
    createApiKey(input: {
      body: { name: string; userId: string; expiresIn: number | null };
    }): Promise<{
      id: string;
      name: string | null;
      start: string | null;
      key: string;
      createdAt: Date;
      expiresAt: Date | null;
    }>;
  };
}

function inviteInvalid() {
  return new APIError('FORBIDDEN', {
    code: 'INVITE_INVALID',
    message: 'This invite is unknown, used, expired, or for another email address',
  });
}

export function createAuth({
  config,
  db,
  logger,
  limiter,
  rateLimit = true,
}: {
  config: Config;
  db: Db;
  logger: Logger;
  limiter: RateLimiter;
  /** Tests that sign many people up from no address turn this off. */
  rateLimit?: boolean;
}): Auth {
  const origin = new URL(config.publicUrl).origin;
  const { github, google } = config.oauth;
  // Signups whose `before` hook found they need an invite, by request.
  const inviteRequired = new WeakSet<object>();

  const instance = betterAuth({
    appName: 'OpenBot',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: authSecret(config.masterKey),
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    emailAndPassword: { enabled: true },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      ...(github && { github }),
      ...(google && { google }),
    },
    rateLimit: {
      enabled: rateLimit,
      // better-auth's own defaults, stated; sign-in and sign-up get its
      // stricter built-in rules (3 per 10 s).
      window: 10,
      max: 100,
      customStorage: {
        consume: (key, rule) => limiter.consume(`auth:${key}`, rule),
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.publicUrl.startsWith('https://'),
      // Postgres generates uuid ids (see db/schema/auth.ts).
      database: { generateId: false },
    },
    logger: {
      log: (level, message, ...args) => logger[level]({ args }, `better-auth: ${message}`),
    },
    plugins: [
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        // Keys stand in for a session on the whole API; quotas belong to the
        // routes, not the key.
        rateLimit: { enabled: false },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // The invite is checked here and spent in `after`, once the user row
          // exists, so a signup that fails in between does not burn it (U1).
          before: async (user, ctx) => {
            const workspace = await ensureWorkspace(db);
            const [anyUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
            if (!anyUser) return;
            if (config.deployment === 'self_hosted') {
              throw new APIError('FORBIDDEN', {
                code: 'SIGNUP_CLOSED',
                message: 'This OpenBot already has its owner. Sign in instead.',
              });
            }
            if (effectiveSettings(config, workspace).signupMode === 'open') return;
            const token = inviteTokenFrom(ctx);
            if (!token) {
              throw new APIError('FORBIDDEN', {
                code: 'INVITE_REQUIRED',
                message: 'Signing up on this OpenBot needs an invite',
              });
            }
            if (!(await findRedeemableInvite(db, token, user.email))) throw inviteInvalid();
            if (ctx) inviteRequired.add(ctx);
          },
          after: async (user, ctx) => {
            const token = inviteTokenFrom(ctx);
            const required = ctx != null && inviteRequired.delete(ctx);
            const joined = await db.transaction(async (tx) => {
              await lockWorkspace(tx);
              const invite = token ? await redeemInvite(tx, token, user.email, user.id) : undefined;
              if (required && !invite) return false;
              const workspace = await ensureWorkspace(tx);
              const [admin] = await tx
                .select({ id: schema.workspaceMembers.id })
                .from(schema.workspaceMembers)
                .where(eq(schema.workspaceMembers.role, 'admin'))
                .limit(1);
              // Two first signups can both pass `before`; under the lock only
              // the first becomes the owner of a self-hosted install.
              if (admin && config.deployment === 'self_hosted') return 'closed';
              let role: Role = admin ? 'member' : 'admin';
              if (invite?.role === 'admin') role = 'admin';
              await tx
                .insert(schema.workspaceMembers)
                .values({ workspaceId: workspace.id, userId: user.id, role });
              if (invite) {
                await recordAudit(tx, {
                  workspaceId: workspace.id,
                  actor: { type: 'user', id: user.id },
                  action: 'invite.redeem',
                  targetType: 'invite',
                  targetId: invite.id,
                  metadata: { role },
                });
              }
              return true;
            });
            if (joined === 'closed') {
              await db.delete(schema.users).where(eq(schema.users.id, user.id));
              throw new APIError('FORBIDDEN', {
                code: 'SIGNUP_CLOSED',
                message: 'This OpenBot already has its owner. Sign in instead.',
              });
            }
            if (!joined) {
              // Another signup spent the invite after `before` checked it: this
              // one never joins, so its user row (and its session) goes.
              await db.delete(schema.users).where(eq(schema.users.id, user.id));
              throw inviteInvalid();
            }
          },
        },
      },
      session: {
        create: {
          // A member an admin disabled cannot sign in again (U3), and on a
          // self-hosted install nobody but the owner can.
          before: async (session) => {
            const [member] = await db
              .select({
                disabledAt: schema.workspaceMembers.disabledAt,
                role: schema.workspaceMembers.role,
              })
              .from(schema.workspaceMembers)
              .where(eq(schema.workspaceMembers.userId, session.userId));
            if (member?.disabledAt) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DISABLED',
                message: 'This account is disabled. Ask an admin to enable it.',
              });
            }
            if (member && config.deployment === 'self_hosted' && member.role !== 'admin') {
              throw new APIError('FORBIDDEN', {
                code: 'NOT_OWNER',
                message: 'This OpenBot has one account, its owner.',
              });
            }
          },
          after: async (session, ctx) => {
            await auditAuth(db, 'auth.sign_in', session.userId, {
              via: ctx?.path ?? null,
              ip: session.ipAddress ?? null,
            });
          },
        },
        delete: {
          after: async (session, ctx) => {
            // Expiry and revocation delete sessions too; only signing out counts.
            if (ctx?.path !== '/sign-out') return;
            await auditAuth(db, 'auth.sign_out', session.userId, {});
          },
        },
      },
    },
  });

  return {
    api: instance.api,
    async handler(request) {
      if (rateLimit && !request.headers.get(CLIENT_IP_HEADER)) {
        const body = problem(400, "The client's address is unknown", { code: 'CLIENT_IP_UNKNOWN' });
        return Response.json(body, {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== SIGN_IN_EMAIL) {
        return instance.handler(request);
      }
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { email?: unknown } | null;
      const response = await instance.handler(request);
      if (response.status === 401 || response.status === 403) {
        const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
        await auditFailedSignIn(db, email, request.headers.get(CLIENT_IP_HEADER), response.status);
      }
      return response;
    },
  };
}

const SIGN_IN_EMAIL = '/api/auth/sign-in/email';

async function auditAuth(
  db: Db,
  action: 'auth.sign_in' | 'auth.sign_out',
  userId: string,
  metadata: Record<string, unknown>,
) {
  const workspace = await ensureWorkspace(db);
  await recordAudit(db, {
    workspaceId: workspace.id,
    actor: { type: 'user', id: userId },
    action,
    targetType: 'user',
    targetId: userId,
    metadata,
  });
}

/** The account tried, when there is one, is the actor; an unknown address has none. */
async function auditFailedSignIn(db: Db, email: string | null, ip: string | null, status: number) {
  const [user] = email
    ? await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
    : [];
  const workspace = await ensureWorkspace(db);
  await recordAudit(db, {
    workspaceId: workspace.id,
    actor: { type: 'user', id: user?.id ?? null },
    action: 'auth.sign_in_failed',
    targetType: 'user',
    targetId: user?.id ?? null,
    metadata: { email, ip, status },
  });
}

/** better-auth's own test for an encrypted token (`isLikelyEncrypted` in its oauth2 utils). */
export const isEncrypted = (token: string) =>
  token.startsWith('$ba$') || (token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token));

/**
 * Encrypts OAuth tokens stored in plain text before `encryptOAuthTokens` was
 * on (S-9). better-auth reads both, so this can run at any start; `main.ts`
 * calls it after the migrations. The id token is left alone, as better-auth
 * never encrypts it.
 */
export async function encryptStoredOAuthTokens({
  db,
  config,
}: {
  db: Db;
  config: Pick<Config, 'masterKey'>;
}): Promise<number> {
  const key = authSecret(config.masterKey);
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(or(isNotNull(schema.accounts.accessToken), isNotNull(schema.accounts.refreshToken)));
  let changed = 0;
  for (const row of rows) {
    const set: { accessToken?: string; refreshToken?: string } = {};
    for (const field of ['accessToken', 'refreshToken'] as const) {
      const token = row[field];
      if (token && !isEncrypted(token)) set[field] = await symmetricEncrypt({ key, data: token });
    }
    if (!Object.keys(set).length) continue;
    await db.update(schema.accounts).set(set).where(eq(schema.accounts.id, row.id));
    changed++;
  }
  return changed;
}

/**
 * better-auth's signing secret, derived from the master key so installs need
 * no extra variable. A new master key means a new secret: sessions end, and
 * `rotateMasterKey` re-encrypts the OAuth tokens.
 */
export function authSecret(masterKey: string): string {
  const key = hkdfSync('sha256', parseMasterKey(masterKey), '', 'openbot:better-auth', 32);
  return Buffer.from(key).toString('base64');
}
