import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import type { Role } from './workspace.js';

// Signup invites (U1). Admins create them; a signup carrying the token in its
// body (`inviteToken`) or, for OAuth signups, in the `openbot_invite` cookie
// redeems it.

export const INVITE_COOKIE = 'openbot_invite';
const DEFAULT_TTL_DAYS = 7;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createInvite(
  db: Db,
  input: {
    workspaceId: string;
    createdBy: string;
    role?: Role;
    email?: string;
    expiresInDays?: number;
  },
) {
  const token = `obi_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + (input.expiresInDays ?? DEFAULT_TTL_DAYS) * 86_400_000);
  const [invite] = await db
    .insert(schema.invites)
    .values({
      workspaceId: input.workspaceId,
      tokenHash: hashInviteToken(token),
      email: input.email?.toLowerCase(),
      role: input.role ?? 'member',
      createdBy: input.createdBy,
      expiresAt,
    })
    .returning();
  return { invite: invite!, token };
}

/** An invite the token opens for this email address: unused, unexpired, and for it or for anyone. */
function redeemable(token: string, email: string) {
  return and(
    eq(schema.invites.tokenHash, hashInviteToken(token)),
    isNull(schema.invites.usedAt),
    gt(schema.invites.expiresAt, new Date()),
    or(isNull(schema.invites.email), eq(schema.invites.email, email.toLowerCase())),
  );
}

/**
 * The invite a signup may use, or undefined when the token is unknown, spent,
 * expired, or bound to another email address. It only looks: the invite is
 * spent by `redeemInvite` once the user row exists, so a signup that fails
 * after this check leaves the invite usable.
 */
export async function findRedeemableInvite(db: Db, token: string, email: string) {
  const [invite] = await db
    .select({ id: schema.invites.id })
    .from(schema.invites)
    .where(redeemable(token, email))
    .limit(1);
  return invite;
}

/**
 * Spends the invite for the user just created and returns it, or undefined
 * when it is no longer redeemable (another signup spent it first). The single
 * conditional UPDATE makes a token redeemable exactly once; run it in the
 * transaction that makes the user a member.
 */
export async function redeemInvite(db: Db, token: string, email: string, userId: string) {
  const [invite] = await db
    .update(schema.invites)
    .set({ usedAt: new Date(), usedBy: userId })
    .where(redeemable(token, email))
    .returning();
  return invite;
}

/** The invite token a signup request carries, if any. */
export function inviteTokenFrom(
  request: { body?: unknown; headers?: Headers } | null | undefined,
): string | undefined {
  const body = request?.body;
  if (body && typeof body === 'object' && 'inviteToken' in body) {
    const token = (body as { inviteToken: unknown }).inviteToken;
    if (typeof token === 'string' && token) return token;
  }
  const cookie = request?.headers?.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === INVITE_COOKIE && value.length) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
