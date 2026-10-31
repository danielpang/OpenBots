import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, count, eq } from 'drizzle-orm';
import type { ExtensionContext } from '@openbot/server';
import type { Config } from '@openbot/server/config';
import { schema, type Db } from '@openbot/server/db/client';
import { parseMasterKey } from '@openbot/server/secrets';
import {
  emailEnabled,
  errorText,
  sendSignUpNotice,
  sendVerificationCode,
  type EmailOptions,
} from './email.js';
import { invitationProof } from './invitations.js';

// Email sign-up on the managed service (plan 21.6): email first, credentials
// after, so whoever holds the inbox sets the password.
//
// 1. POST /api/auth/sign-up/start {email, invite?}: no user and no password,
//    only a pending request for the address, bound to a random id in an
//    HttpOnly cookie, and a 6-digit code emailed to the address. When the
//    address already has an account, the email says someone tried to sign
//    up with it instead, and the answer is the same.
// 2. POST /api/auth/sign-up/verify {code}: the code of this request, once.
// 3. POST /api/auth/sign-up/complete {name, password}: creates the account,
//    confirmed, and signs in. An unconfirmed account from before this flow
//    is taken over instead, in one transaction: new name and password, and
//    its sessions end.
//
// Nothing an unauthenticated request does deletes or replaces an account.
// Limits come before any work: 5 sends an hour per address (429), and per
// IP through better-auth's limiter; verify attempts count per address, 10
// an hour, whatever new codes are sent. Codes last 10 minutes, are stored
// as an HMAC bound to their request, and compared in constant time. A code
// reaches a log only on a development server without email that sets
// OPENBOT_DEV_LOG_EMAIL_LINKS (refused in production). The invite of
// /sign-up?invite=<id> travels with the request; invite mode checks it at
// both ends.

export const CODE_LENGTH = 6;
export const CODE_MINUTES = 10;
/** Codes (or notices) one address may be sent in an hour. */
export const SENDS_PER_HOUR = 5;
/** Code attempts one address may make in an hour, across its codes. */
export const TRIES_PER_HOUR = 10;
export const SIGN_UP_COOKIE = 'openbot_sign_up';
const COOKIE_PATH = '/api/auth/sign-up';

interface Pending {
  email: string;
  /** HMAC of the code, null once used or when the address has an account. */
  mac: string | null;
  invite: string | null;
  confirmed: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The request's row: keyed by a hash, so the database alone completes nothing. */
const identifierOf = (requestId: string) => `sign-up:${sha256(requestId)}`;

function codeMac(config: Pick<Config, 'masterKey'>, identifier: string, code: string) {
  const key = Buffer.from(
    hkdfSync('sha256', parseMasterKey(config.masterKey), '', 'openbot:sign-up-code', 32),
  );
  return createHmac('sha256', key).update(`${identifier}:${code}`).digest('base64url');
}

function sameMac(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const randomCode = () => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

function tooMany(code: string, message: string, retryAfter: number | null) {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { code, message },
    { 'X-Retry-After': String(retryAfter ?? 60) },
  );
}

const invalidCode = () =>
  new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'That code is wrong' });
const expired = () =>
  new APIError('BAD_REQUEST', { code: 'OTP_EXPIRED', message: 'That code expired' });

/** Invite mode lets in the first user and someone with a pending invitation for the address. */
export async function signUpAllowed(
  config: Pick<Config, 'signupMode'>,
  db: Db,
  email: string,
  invite: unknown,
): Promise<boolean> {
  if (config.signupMode === 'open') return true;
  const [users] = await db.select({ n: count() }).from(schema.users);
  if (!users?.n) return true;
  return (await invitationProof(db, email, invite)) !== null;
}

export function inviteRequired() {
  // Not FORBIDDEN: better-auth answers that from a user hook with a fake
  // success, to hide which addresses have accounts.
  return new APIError('BAD_REQUEST', {
    code: 'INVITE_REQUIRED',
    message: 'Signing up here needs the link from your invite',
  });
}

export function signUpPlugin(
  { config, db, logger, infra }: ExtensionContext,
  email: EmailOptions = {},
): BetterAuthPlugin {
  const cookie = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.publicUrl.startsWith('https://'),
    path: COOKIE_PATH,
  };

  /** The request behind the cookie, unexpired. */
  async function pendingOf(requestId: string | null) {
    if (!requestId) throw invalidCode();
    const identifier = identifierOf(requestId);
    const [row] = await db
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.identifier, identifier));
    if (!row) throw invalidCode();
    if (row.expiresAt.getTime() <= Date.now()) throw expired();
    return { row, identifier, pending: JSON.parse(row.value) as Pending };
  }

  async function deliver(to: string, code: string | null) {
    if (!emailEnabled(email)) {
      // The code is a credential: logged only where asked, on a development server.
      if (code && email.logLinks) logger.info({ email: to, code }, 'email verification code');
      else logger.warn('sign-up email not sent: no email set up');
      return;
    }
    const log = (err: unknown) => logger.warn({ err: errorText(err) }, 'verification email failed');
    if (code) await sendVerificationCode(email, { to, code }, log);
    else await sendSignUpNotice(email, { to }, log);
  }

  return {
    id: 'openbot-sign-up',
    rateLimit: [
      { pathMatcher: (path) => path === '/sign-up/start', window: 600, max: 10 },
      { pathMatcher: (path) => path === '/sign-up/verify', window: 600, max: 30 },
      { pathMatcher: (path) => path === '/sign-up/complete', window: 600, max: 10 },
    ],
    endpoints: {
      signUpStart: createAuthEndpoint(
        '/sign-up/start',
        {
          method: 'POST',
          body: z.object({ email: z.email().max(254), invite: z.string().max(64).optional() }),
        },
        async (ctx) => {
          const address = ctx.body.email.trim().toLowerCase();
          // Before anything is made or sent.
          const sends = await infra.limiter.consume(`sign-up-send:${address}`, {
            window: 3600,
            max: SENDS_PER_HOUR,
          });
          if (!sends.allowed) {
            throw tooMany('TOO_MANY_CODES', 'Too many codes for this email', sends.retryAfter);
          }
          const invite = ctx.body.invite ?? null;
          if (!(await signUpAllowed(config, db, address, invite))) throw inviteRequired();
          const [user] = await db
            .select({ verified: schema.users.emailVerified })
            .from(schema.users)
            .where(eq(schema.users.email, address));
          const requestId = randomBytes(32).toString('base64url');
          const identifier = identifierOf(requestId);
          // An account already has the address: no code, a notice instead, and the same answer.
          const code = user?.verified ? null : randomCode();
          const pending: Pending = {
            email: address,
            mac: code ? codeMac(config, identifier, code) : null,
            invite,
            confirmed: false,
          };
          await db.insert(schema.verifications).values({
            identifier,
            value: JSON.stringify(pending),
            expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
          });
          await deliver(address, code);
          ctx.setCookie(SIGN_UP_COOKIE, requestId, { ...cookie, maxAge: 2 * CODE_MINUTES * 60 });
          return ctx.json({ sent: true });
        },
      ),

      signUpVerify: createAuthEndpoint(
        '/sign-up/verify',
        { method: 'POST', body: z.object({ code: z.string().trim().max(16) }) },
        async (ctx) => {
          const { row, identifier, pending } = await pendingOf(ctx.getCookie(SIGN_UP_COOKIE));
          if (pending.confirmed) return ctx.json({ confirmed: true });
          // Counted per address before comparing, and not reset by a new code.
          const tries = await infra.limiter.consume(`sign-up-try:${pending.email}`, {
            window: 3600,
            max: TRIES_PER_HOUR,
          });
          if (!tries.allowed) {
            throw tooMany('TOO_MANY_ATTEMPTS', 'Too many tries. Try again later', tries.retryAfter);
          }
          if (!pending.mac || !sameMac(codeMac(config, identifier, ctx.body.code), pending.mac)) {
            throw invalidCode();
          }
          // Once: only the row as read turns confirmed.
          const [used] = await db
            .update(schema.verifications)
            .set({
              value: JSON.stringify({ ...pending, mac: null, confirmed: true } satisfies Pending),
              expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
            })
            .where(
              and(eq(schema.verifications.id, row.id), eq(schema.verifications.value, row.value)),
            )
            .returning({ id: schema.verifications.id });
          if (!used) throw invalidCode();
          return ctx.json({ confirmed: true });
        },
      ),

      signUpComplete: createAuthEndpoint(
        '/sign-up/complete',
        {
          method: 'POST',
          body: z.object({ name: z.string().trim().min(1).max(100), password: z.string() }),
        },
        async (ctx) => {
          const { row, pending } = await pendingOf(ctx.getCookie(SIGN_UP_COOKIE));
          if (!pending.confirmed) {
            throw new APIError('BAD_REQUEST', {
              code: 'EMAIL_NOT_VERIFIED',
              message: 'Enter the code first',
            });
          }
          const { password } = ctx.body;
          const limits = ctx.context.password.config;
          if (password.length < limits.minPasswordLength) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_TOO_SHORT',
              message: 'Password too short',
            });
          }
          if (password.length > limits.maxPasswordLength) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_TOO_LONG',
              message: 'Password too long',
            });
          }
          // The invite may have been revoked since step 1.
          if (!(await signUpAllowed(config, db, pending.email, pending.invite))) {
            throw inviteRequired();
          }
          // Once: the request is gone whatever happens next.
          const [taken] = await db
            .delete(schema.verifications)
            .where(
              and(eq(schema.verifications.id, row.id), eq(schema.verifications.value, row.value)),
            )
            .returning({ id: schema.verifications.id });
          if (!taken) throw invalidCode();

          const hash = await ctx.context.password.hash(password);
          const [existing] = await db
            .select({ id: schema.users.id, verified: schema.users.emailVerified })
            .from(schema.users)
            .where(eq(schema.users.email, pending.email));
          let userId: string;
          if (existing?.verified) {
            throw new APIError('BAD_REQUEST', {
              code: 'ACCOUNT_EXISTS',
              message: 'This email has an account. Sign in instead',
            });
          } else if (existing) {
            userId = existing.id;
            await takeOver(db, userId, ctx.body.name, hash);
          } else {
            const user = await ctx.context.internalAdapter.createUser(
              { email: pending.email, name: ctx.body.name, emailVerified: true },
              { method: 'email-code' },
            );
            userId = user.id;
            await ctx.context.internalAdapter.linkAccount({
              userId,
              providerId: 'credential',
              accountId: userId,
              password: hash,
            });
          }
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) throw invalidCode();
          const session = await ctx.context.internalAdapter.createSession(userId);
          await setSessionCookie(ctx, { session, user });
          ctx.setCookie(SIGN_UP_COOKIE, '', { ...cookie, maxAge: 0 });
          return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
        },
      ),
    },
  };
}

/**
 * An unconfirmed account from before this flow, now confirmed by whoever
 * holds its inbox: their name and password, and its old sessions end.
 */
async function takeOver(db: Db, userId: string, name: string, hash: string) {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .update(schema.users)
      .set({ name, emailVerified: true, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), eq(schema.users.emailVerified, false)))
      .returning({ id: schema.users.id });
    if (!user) throw invalidCode();
    await tx
      .delete(schema.accounts)
      .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')));
    await tx
      .insert(schema.accounts)
      .values({ userId, providerId: 'credential', accountId: userId, password: hash });
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  });
}
