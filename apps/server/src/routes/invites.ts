import { createRoute, z } from '@hono/zod-openapi';
import { createInvite } from '../invites.js';
import { requireAdmin, requireManaged } from '../middleware/auth.js';
import {
  adminProblems,
  authenticated,
  managedProblems,
  createRouter,
  problemResponse,
} from '../openapi.js';
import { RoleSchema } from '../schemas.js';
import { recordAudit, userActor } from '../services/audit.js';
import { listPendingInvites, revokeInvite } from '../services/members.js';

// Signup invites (U1, plan 14.1 "users and invites"). The token is returned
// once; signup redeems it. Admins list the pending ones and revoke them.
// Managed only: a self-hosted install has one owner and answers 404.

const CreateInviteSchema = z
  .strictObject({
    email: z.email().optional().openapi({ description: 'Only this address can redeem it' }),
    role: RoleSchema.default('member'),
    expiresInDays: z.number().int().min(1).max(90).default(7),
  })
  .openapi('CreateInvite');

const InviteSchema = z
  .object({
    id: z.uuid(),
    token: z.string().openapi({
      description: 'Send as `inviteToken` in the signup body; shown only once',
    }),
    email: z.string().nullable(),
    role: RoleSchema,
    expiresAt: z.iso.datetime(),
  })
  .openapi('Invite');

const PendingInviteSchema = z
  .object({
    id: z.uuid(),
    email: z.string().nullable().openapi({ description: 'Only this address can redeem it' }),
    role: RoleSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    createdBy: z.string().nullable().openapi({ description: 'The email of the admin who made it' }),
  })
  .openapi('PendingInvite');

export const inviteRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/admin/invites',
      tags: ['settings'],
      summary: 'Create a signup invite',
      middleware: [requireManaged, requireAdmin] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CreateInviteSchema } } },
      },
      responses: {
        201: {
          description: 'The invite',
          content: { 'application/json': { schema: InviteSchema } },
        },
        400: problemResponse('Invalid invite'),
        ...managedProblems,
      },
    }),
    async (c) => {
      const { db } = c.var.deps;
      const user = c.var.user;
      const body = c.req.valid('json');
      const { invite, token } = await createInvite(db, {
        workspaceId: user.workspaceId,
        createdBy: user.id,
        ...body,
      });
      await recordAudit(db, {
        workspaceId: user.workspaceId,
        actor: userActor(user),
        action: 'invite.create',
        targetType: 'invite',
        targetId: invite.id,
        metadata: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      });
      return c.json(
        {
          id: invite.id,
          token,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/admin/invites',
      tags: ['settings'],
      summary: 'List pending invites',
      description: 'Invites nobody has redeemed that have not expired, newest first.',
      middleware: [requireManaged, requireAdmin] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Pending invites',
          content: {
            'application/json': {
              schema: z.object({ items: z.array(PendingInviteSchema) }),
            },
          },
        },
        ...managedProblems,
      },
    }),
    async (c) => {
      const invites = await listPendingInvites(c.var.deps.db, c.var.user.workspaceId);
      return c.json(
        {
          items: invites.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            createdAt: i.createdAt.toISOString(),
            expiresAt: i.expiresAt.toISOString(),
            createdBy: i.createdByEmail,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/admin/invites/{id}',
      tags: ['settings'],
      summary: 'Revoke an invite',
      description: 'Its token no longer signs anyone up. A used invite cannot be revoked.',
      middleware: [requireManaged, requireAdmin] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        204: { description: 'Revoked' },
        404: problemResponse('No such pending invite, or a self-hosted install'),
        ...adminProblems,
      },
    }),
    async (c) => {
      await revokeInvite(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
