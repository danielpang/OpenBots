import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { organization } from 'better-auth/plugins/organization';
import { and, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { ExtensionContext } from '@openbot/server';
import type { Config } from '@openbot/server/config';
import { schema, type Db } from '@openbot/server/db/client';
import { parseMasterKey } from '@openbot/server/secrets';
import { recordAudit } from '@openbot/server/services/audit';
import { ac, roles } from './access.js';
import { emailEnabled, errorText, sendVerificationCode, type EmailOptions } from './email.js';

// better-auth on the managed service (plan 21.5): the organization plugin,
// mapped onto the core's tables, and the policy the core leaves to this
// build.
//
// The plugin's models are the core's: `organization` is `workspaces`,
// `member` is `workspace_members` (with the core's `suspended_at` as the
// `suspendedAt` field) and `invitation` is `invites`, so the core and the
// plugin read the same rows and the core keeps scoping everything by
// `workspace_id`. Its HTTP endpoints (`/api/auth/organization/*`) are not
// served: routes.ts calls the ones it needs through `auth.api`, with the
// checks they need and an audit row, and does the rest itself.
//
// Sign-up (OPENBOT_SIGNUP_MODE): `open` lets anyone sign up; `invite`
// (and `first_user_admin`, its old name) lets only the first user and
// someone who brings the invitation from their link for the address they
// sign up with: `invite` in the sign-up body (as /sign-up?invite=<id>
// sends it), or for a GitHub or Google sign-up, a short-lived signed
// cookie set when they start it from that page (`inviteCookie`), checked
// against the provider's verified address. Knowing an invited address is
// not enough.
//
// Every account confirms its email with a 6-digit code before it can sign
// in (better-auth's email OTP plugin in place of verification links): 10
// minutes, 5 tries, then a new code; codes stored encrypted and compared in
// constant time; sends rate limited per address. An unconfirmed sign-up
// holds nothing: signing up again with the address replaces it (name and
// password) and sends a new code. A confirmed account is never replaced.
// Codes reach a log only on a development server that sends no email and
// sets OPENBOT_DEV_LOG_EMAIL_LINKS (refused in production). The core also
// refuses an unconfirmed account's requests (`requireVerifiedEmail`).
//
// A new session works in the organization its user joined last, among
// those they are not suspended in, unless it names one already.

export const INVITATION_DAYS = 7;
/** Organizations one person may belong to (the plugin counts memberships). */
export const ORGANIZATIONS_PER_USER = 10;
/** Pending invitations one organization may have. */
export const PENDING_INVITATIONS = 100;
/** Members one organization may have. */
export const MEMBERS_PER_ORGANIZATION = 500;
/** Email verification codes: their length, life and tries. */
export const CODE_LENGTH = 6;
export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;
/** Codes one address may be sent in an hour. */
export const CODES_PER_HOUR = 10;
/** How long the invite cookie of a GitHub or Google sign-up lasts. */
export const INVITE_COOKIE_SECONDS = 600;
export const INVITE_COOKIE = 'openbot_oauth_invite';

export const pluginSchema = {
  organization: { modelName: 'workspace' },
  member: {
    modelName: 'workspaceMember',
    fields: { organizationId: 'workspaceId' },
    additionalFields: {
      suspendedAt: { type: 'date', required: false, input: false },
    },
  },
  invitation: {
    modelName: 'invite',
    fields: { organizationId: 'workspaceId' },
  },
} as const;

export function organizationPlugin() {
  return organization({
    ac,
    roles,
    creatorRole: 'owner',
    allowUserToCreateOrganization: true,
    organizationLimit: ORGANIZATIONS_PER_USER,
    membershipLimit: MEMBERS_PER_ORGANIZATION,
    invitationLimit: PENDING_INVITATIONS,
    invitationExpiresIn: INVITATION_DAYS * 86_400,
    cancelPendingInvitationsOnReInvite: true,
    // Accounts confirm their email before they can accept (routes.ts); an
    // invitation is for one address and its id is the secret.
    requireEmailVerificationOnInvitation: false,
    disableOrganizationDeletion: true,
    schema: pluginSchema,
  });
}

/** The email OTP plugin as the managed service uses it: sign-up codes only. */
export function verificationCodePlugin(
  { logger, infra }: ExtensionContext,
  email: EmailOptions = {},
) {
  return emailOTP({
    otpLength: CODE_LENGTH,
    expiresIn: CODE_MINUTES * 60,
    allowedAttempts: CODE_TRIES,
    storeOTP: 'encrypted',
    resendStrategy: 'rotate',
    overrideDefaultEmailVerification: true,
    disableSignUp: true,
    rateLimit: { window: 60, max: 5 },
    sendVerificationOTP: async ({ email: to, otp, type }) => {
      if (type !== 'email-verification') return;
      const allowed = await infra.limiter.consume(`code:${to.toLowerCase()}`, {
        window: 3600,
        max: CODES_PER_HOUR,
      });
      if (!allowed.allowed) {
        logger.warn('email verification code not sent: too many for one address');
        return;
      }
      // The code is a credential: it never reaches a log, except on a
      // development server that sends no email and asked for it.
      if (!emailEnabled(email)) {
        if (email.logLinks) logger.info({ email: to, code: otp }, 'email verification code');
        else logger.warn('email verification code not sent: no email set up');
        return;
      }
      await sendVerificationCode(email, { to, code: otp }, (err) =>
        logger.warn({ err: errorText(err) }, 'verification email failed'),
      );
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The invitation a sign-up brings, when it is pending, unexpired and for that address. */
export async function invitationProof(db: Db, email: string, invite: unknown) {
  if (typeof invite !== 'string' || !UUID.test(invite)) return null;
  const [row] = await db
    .select({
      id: schema.invites.id,
      workspaceId: schema.invites.workspaceId,
      role: schema.invites.role,
    })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.id, invite),
        eq(schema.invites.email, email.toLowerCase()),
        eq(schema.invites.status, 'pending'),
        gt(schema.invites.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

// --- The invite cookie of a GitHub or Google sign-up ---------------------------

function cookieKey(config: Pick<Config, 'masterKey'>) {
  return Buffer.from(
    hkdfSync('sha256', parseMasterKey(config.masterKey), '', 'openbot:oauth-invite', 32),
  );
}

/** `<invite>.<expiry ms>.<hmac>`: the invite a social sign-up started from, for 10 minutes. */
export function signInviteCookie(
  config: Pick<Config, 'masterKey'>,
  invite: string,
  now = Date.now(),
) {
  const payload = `${invite}.${now + INVITE_COOKIE_SECONDS * 1000}`;
  const mac = createHmac('sha256', cookieKey(config)).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** The invite id in a signed, unexpired cookie value, or null. */
export function readInviteCookie(
  config: Pick<Config, 'masterKey'>,
  value: string | undefined,
  now = Date.now(),
): string | null {
  const [invite, expires, mac] = (value ?? '').split('.');
  if (!invite || !expires || !mac || !UUID.test(invite)) return null;
  const expected = createHmac('sha256', cookieKey(config)).update(`${invite}.${expires}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!(Number(expires) > now)) return null;
  return invite;
}

function cookieFrom(headers: Headers | undefined, name: string): string | undefined {
  for (const part of headers?.get('cookie')?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

type HookContext =
  | {
      path?: string;
      body?: unknown;
      request?: Request;
      headers?: Headers;
    }
  | null
  | undefined;

const isOAuthCallback = (ctx: HookContext) => ctx?.path?.startsWith('/callback') ?? false;

/** The invite a sign-up proves, from its body or, for GitHub and Google, its cookie. */
function inviteOf(config: Pick<Config, 'masterKey'>, ctx: HookContext): unknown {
  if (isOAuthCallback(ctx)) {
    return readInviteCookie(
      config,
      cookieFrom(ctx?.request?.headers ?? ctx?.headers, INVITE_COOKIE),
    );
  }
  return (ctx?.body as { invite?: unknown } | undefined)?.invite;
}

/** The policy plugin: sign-up, email codes, the session's organization, and closed endpoints. */
export function managedPolicyPlugin({ config, db }: ExtensionContext): BetterAuthPlugin {
  // Accepted at account creation through a GitHub or Google sign-up, by request.
  const acceptOnCreate = new WeakMap<object, { id: string; workspaceId: string; role: string }>();

  return {
    id: 'openbot-managed',
    init: () => ({
      options: {
        emailAndPassword: { enabled: true, requireEmailVerification: true },
        emailVerification: {
          sendOnSignUp: true,
          sendOnSignIn: true,
          autoSignInAfterVerification: true,
        },
        databaseHooks: {
          user: {
            create: {
              before: async (user, ctx) => {
                const invite = inviteOf(config, ctx);
                // A GitHub or Google address the provider verified, with the
                // invite from its link, joins on creation (below).
                if (isOAuthCallback(ctx) && user.emailVerified && ctx) {
                  const proof = await invitationProof(db, user.email, invite);
                  if (proof) acceptOnCreate.set(ctx, proof);
                }
                if (config.signupMode === 'open') return;
                const [users] = await db.select({ n: count() }).from(schema.users);
                if (!users?.n) return;
                const proven =
                  isOAuthCallback(ctx) && !user.emailVerified
                    ? null
                    : await invitationProof(db, user.email, invite);
                if (!proven) {
                  // Not FORBIDDEN: better-auth answers that with a fake success, to hide
                  // which addresses have accounts, and nothing would be sent.
                  throw new APIError('BAD_REQUEST', {
                    code: 'INVITE_REQUIRED',
                    message: 'Signing up here needs the link from your invite',
                  });
                }
              },
              after: async (user, ctx) => {
                const proof = ctx ? acceptOnCreate.get(ctx) : undefined;
                if (!proof || !ctx) return;
                acceptOnCreate.delete(ctx);
                await db.transaction(async (tx) => {
                  // Once: only a pending invitation turns accepted.
                  const [accepted] = await tx
                    .update(schema.invites)
                    .set({ status: 'accepted' })
                    .where(
                      and(eq(schema.invites.id, proof.id), eq(schema.invites.status, 'pending')),
                    )
                    .returning({ id: schema.invites.id });
                  if (!accepted) return;
                  await tx
                    .insert(schema.workspaceMembers)
                    .values({ workspaceId: proof.workspaceId, userId: user.id, role: proof.role })
                    .onConflictDoNothing();
                  await recordAudit(tx, {
                    workspaceId: proof.workspaceId,
                    actor: { type: 'user', id: user.id },
                    action: 'invitation.accept',
                    targetType: 'invite',
                    targetId: proof.id,
                    metadata: { role: proof.role, via: 'oauth' },
                  });
                });
              },
            },
          },
          session: {
            create: {
              before: async (session) => {
                const named = (session as { activeOrganizationId?: string | null })
                  .activeOrganizationId;
                if (named) return;
                const [latest] = await db
                  .select({ workspaceId: schema.workspaceMembers.workspaceId })
                  .from(schema.workspaceMembers)
                  .where(
                    and(
                      eq(schema.workspaceMembers.userId, session.userId),
                      isNull(schema.workspaceMembers.suspendedAt),
                    ),
                  )
                  .orderBy(desc(schema.workspaceMembers.createdAt))
                  .limit(1);
                if (!latest) return;
                return { data: { ...session, activeOrganizationId: latest.workspaceId } };
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path?.startsWith('/organization/') ?? false,
          // Only HTTP requests carry one; `auth.api` calls from routes.ts do not.
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request) throw new APIError('NOT_FOUND', { message: 'Not found' });
          }),
        },
        {
          // The email OTP plugin serves sign-up codes only: no sign-in, password
          // reset or email change by code.
          matcher: (ctx) =>
            (ctx.path?.includes('email-otp') ?? false) &&
            ctx.path !== '/email-otp/verify-email' &&
            ctx.path !== '/email-otp/send-verification-otp',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request) throw new APIError('NOT_FOUND', { message: 'Not found' });
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/email-otp/send-verification-otp',
          handler: createAuthMiddleware(async (ctx) => {
            if ((ctx.body as { type?: unknown } | undefined)?.type !== 'email-verification') {
              throw new APIError('NOT_FOUND', { message: 'Not found' });
            }
          }),
        },
        {
          // An unconfirmed sign-up holds nothing: signing up again replaces it.
          matcher: (ctx) => ctx.path === '/sign-up/email',
          handler: createAuthMiddleware(async (ctx) => {
            const address = (ctx.body as { email?: unknown } | undefined)?.email;
            if (typeof address !== 'string') return;
            await replaceUnconfirmed(db, address);
          }),
        },
      ],
      after: [
        {
          // The invite cookie of a GitHub or Google sign-up is used once.
          matcher: (ctx) => ctx.path?.startsWith('/callback') ?? false,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.setCookie(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
          }),
        },
      ],
    },
  };
}

/**
 * Deletes the account with this address when it was never confirmed: not
 * verified, in no organization and signed in by no provider. A confirmed
 * account, or one from before verification with a membership, stays.
 */
export async function replaceUnconfirmed(db: Db, address: string): Promise<boolean> {
  const [user] = await db
    .select({ id: schema.users.id, verified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.email, address.trim().toLowerCase()));
  if (!user || user.verified) return false;
  const [member] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, user.id))
    .limit(1);
  if (member) return false;
  const [social] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, user.id), ne(schema.accounts.providerId, 'credential')))
    .limit(1);
  if (social) return false;
  await db
    .delete(schema.users)
    .where(and(eq(schema.users.id, user.id), eq(schema.users.emailVerified, false)));
  return true;
}
