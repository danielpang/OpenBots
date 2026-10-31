import { and, eq } from 'drizzle-orm';
import type { AppDeps } from './context.js';
import { schema } from './db/client.js';

// What the core does when someone's access to one organization ends (plan
// 21.6): an owner or admin suspended or removed them, or they left. The
// managed build (ee/server) changes the membership and then calls this.
// Their sessions stay, since they may belong to other organizations; a
// session working in this one stops being active there, and every API
// instance closes their realtime, terminal and screen sockets for it. Their
// other organizations are untouched.

/** The bus channel that tells API instances to close a member's sockets in one organization. */
export const MEMBERSHIP_ENDED_CHANNEL = 'openbot:membership-ended';

export interface MembershipEnded {
  userId: string;
  workspaceId: string;
}

export async function endMembershipAccess(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  ended: MembershipEnded & { removed: boolean },
): Promise<void> {
  if (ended.removed) {
    await deps.db
      .update(schema.sessions)
      .set({ activeOrganizationId: null })
      .where(
        and(
          eq(schema.sessions.userId, ended.userId),
          eq(schema.sessions.activeOrganizationId, ended.workspaceId),
        ),
      );
  }
  await deps.infra.bus.publish<MembershipEnded>(MEMBERSHIP_ENDED_CHANNEL, {
    userId: ended.userId,
    workspaceId: ended.workspaceId,
  });
}
