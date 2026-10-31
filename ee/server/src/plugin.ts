import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import type { ExtensionContext } from '@openbot/server';
import { schema } from '@openbot/server/db/client';
import { ac, roles } from './access.js';

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
// people with a pending invitation. A new session works in the
// organization its user joined last, among those they are not suspended
// in, unless it names one already.

export const INVITATION_DAYS = 7;
/** Organizations one person may belong to (the plugin counts memberships). */
export const ORGANIZATIONS_PER_USER = 10;
/** Pending invitations one organization may have. */
export const PENDING_INVITATIONS = 100;
/** Members one organization may have. */
export const MEMBERS_PER_ORGANIZATION = 500;

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
    // Accounts are not verified by email here; an invitation is for one
    // address and its id is the secret, as invite links were before.
    requireEmailVerificationOnInvitation: false,
    disableOrganizationDeletion: true,
    schema: pluginSchema,
  });
}

/** The policy plugin: sign-up, the session's organization, and no organization HTTP endpoints. */
export function managedPolicyPlugin({ config, db }: ExtensionContext): BetterAuthPlugin {
  return {
    id: 'openbot-managed',
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user) => {
                if (config.signupMode === 'open') return;
                const [users] = await db.select({ n: count() }).from(schema.users);
                if (!users?.n) return;
                const [invited] = await db
                  .select({ id: schema.invites.id })
                  .from(schema.invites)
                  .where(
                    and(
                      eq(schema.invites.email, user.email.toLowerCase()),
                      eq(schema.invites.status, 'pending'),
                      gt(schema.invites.expiresAt, new Date()),
                    ),
                  )
                  .limit(1);
                if (!invited) {
                  throw new APIError('FORBIDDEN', {
                    code: 'INVITE_REQUIRED',
                    message: 'Signing up here needs an invite',
                  });
                }
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
      ],
    },
  };
}
