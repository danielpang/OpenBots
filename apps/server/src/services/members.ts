import { and, asc, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { lockWorkspace, type Role } from '../workspace.js';
import { recordAudit, userActor } from './audit.js';

// Members and invites for admins (U1, U3, plan 14.1 "users and invites").
// An admin lists the members, changes a role, and disables or re-enables a
// member's sign-in; the workspace always keeps one admin who can sign in.
// Disabling ends the member's sessions, stops their API keys (the auth
// middleware refuses a disabled member) and refuses new sign-ins
// (auth.ts), and the realtime gateway closes their open sockets. Their Bots
// and data stay; deleting a member is not offered.

/** The bus channel that tells API instances to close a disabled member's sockets. */
export const MEMBER_DISABLED_CHANNEL = 'openbot:member-disabled';

export interface MemberDisabled {
  userId: string;
}

type Admin = Pick<CurrentUser, 'id' | 'workspaceId'>;
type MembersDeps = Pick<AppDeps, 'db' | 'infra'>;

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: Date;
  disabledAt: Date | null;
  botCount: number;
}

export const lastAdmin = () =>
  new DomainError(
    409,
    'LAST_ADMIN',
    'The workspace needs an admin who can sign in. Make someone else an admin first.',
  );

export async function listMembers(db: Db, workspaceId: string): Promise<MemberView[]> {
  const bots = db
    .select({ ownerId: schema.bots.ownerId, botCount: count().as('bot_count') })
    .from(schema.bots)
    .where(and(eq(schema.bots.workspaceId, workspaceId), isNull(schema.bots.archivedAt)))
    .groupBy(schema.bots.ownerId)
    .as('owned');
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.workspaceMembers.role,
      createdAt: schema.workspaceMembers.createdAt,
      disabledAt: schema.workspaceMembers.disabledAt,
      botCount: bots.botCount,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .leftJoin(bots, eq(bots.ownerId, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(schema.workspaceMembers.createdAt), asc(schema.users.email));
  return rows.map((r) => ({ ...r, botCount: Number(r.botCount ?? 0) }));
}

/**
 * Changes a member's role or whether they can sign in. Refuses to leave the
 * workspace without an enabled admin and to disable the caller themselves.
 * Returns the member after the change.
 */
export async function updateMember(
  deps: MembersDeps,
  admin: Admin,
  userId: string,
  patch: { role?: Role; disabled?: boolean },
): Promise<MemberView> {
  const { db } = deps;
  const changes = await db.transaction(async (tx) => {
    // Serializes the last-admin check against a concurrent change.
    await lockWorkspace(tx);
    const [member] = await tx
      .select()
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, admin.workspaceId),
          eq(schema.workspaceMembers.userId, userId),
        ),
      );
    if (!member) throw notFound('Member not found');
    if (patch.disabled === true && userId === admin.id) {
      throw new DomainError(409, 'CANNOT_DISABLE_SELF', 'You cannot disable your own sign-in');
    }
    const role = patch.role ?? member.role;
    const disabledAt =
      patch.disabled === undefined
        ? member.disabledAt
        : patch.disabled
          ? (member.disabledAt ?? new Date())
          : null;
    const wasActiveAdmin = member.role === 'admin' && member.disabledAt === null;
    const staysActiveAdmin = role === 'admin' && disabledAt === null;
    if (wasActiveAdmin && !staysActiveAdmin) {
      const [other] = await tx
        .select({ id: schema.workspaceMembers.id })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, admin.workspaceId),
            eq(schema.workspaceMembers.role, 'admin'),
            isNull(schema.workspaceMembers.disabledAt),
            ne(schema.workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      if (!other) throw lastAdmin();
    }
    await tx
      .update(schema.workspaceMembers)
      .set({ role, disabledAt })
      .where(eq(schema.workspaceMembers.id, member.id));

    const audits: { action: string; metadata: Record<string, unknown> }[] = [];
    if (role !== member.role) {
      audits.push({ action: 'member.role', metadata: { from: member.role, to: role } });
    }
    const disabling = member.disabledAt === null && disabledAt !== null;
    if (disabling) {
      // Ends every session; API keys stop at the auth middleware.
      const ended = await tx
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId))
        .returning({ id: schema.sessions.id });
      audits.push({ action: 'member.disable', metadata: { sessionsEnded: ended.length } });
    }
    if (member.disabledAt !== null && disabledAt === null) {
      audits.push({ action: 'member.enable', metadata: {} });
    }
    for (const entry of audits) {
      await recordAudit(tx, {
        workspaceId: admin.workspaceId,
        actor: userActor(admin),
        action: entry.action,
        targetType: 'user',
        targetId: userId,
        metadata: entry.metadata,
      });
    }
    return { disabling };
  });
  if (changes.disabling) {
    await deps.infra.bus.publish<MemberDisabled>(MEMBER_DISABLED_CHANNEL, { userId });
  }
  const member = (await listMembers(db, admin.workspaceId)).find((m) => m.id === userId);
  return member!;
}

export interface PendingInvite {
  id: string;
  email: string | null;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  createdByEmail: string | null;
}

/** Invites nobody has redeemed that have not expired, newest first. */
export async function listPendingInvites(db: Db, workspaceId: string): Promise<PendingInvite[]> {
  return db
    .select({
      id: schema.invites.id,
      email: schema.invites.email,
      role: schema.invites.role,
      createdAt: schema.invites.createdAt,
      expiresAt: schema.invites.expiresAt,
      createdByEmail: schema.users.email,
    })
    .from(schema.invites)
    .leftJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
    .where(
      and(
        eq(schema.invites.workspaceId, workspaceId),
        isNull(schema.invites.usedAt),
        gt(schema.invites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));
}

/** Deletes an unused invite so its token no longer signs anyone up. */
export async function revokeInvite(db: Db, admin: Admin, inviteId: string): Promise<void> {
  const [invite] = await db
    .delete(schema.invites)
    .where(
      and(
        eq(schema.invites.id, inviteId),
        eq(schema.invites.workspaceId, admin.workspaceId),
        isNull(schema.invites.usedAt),
      ),
    )
    .returning();
  if (!invite) throw notFound('Invite not found, or already used');
  await recordAudit(db, {
    workspaceId: admin.workspaceId,
    actor: userActor(admin),
    action: 'invite.revoke',
    targetType: 'invite',
    targetId: invite.id,
    metadata: { email: invite.email, role: invite.role },
  });
}
