import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin, requireManaged } from '../middleware/auth.js';
import {
  adminProblems,
  authenticated,
  managedProblems,
  createRouter,
  problemResponse,
} from '../openapi.js';
import { RoleSchema } from '../schemas.js';
import { listMembers, updateMember, type MemberView } from '../services/members.js';

// Members for admins (U1, U3, plan 14.1 "users and invites"): who is in the
// workspace, their role and Bot count, and whether they can sign in.
// Managed only: a self-hosted install has one owner and answers 404.

const MemberSchema = z
  .object({
    id: z.uuid().openapi({ description: 'The user id' }),
    name: z.string(),
    email: z.string(),
    role: RoleSchema,
    createdAt: z.iso.datetime().openapi({ description: 'When they joined the workspace' }),
    disabledAt: z.iso.datetime().nullable().openapi({
      description: 'When an admin disabled their sign-in; null while they can sign in',
    }),
    botCount: z.number().int().nonnegative(),
  })
  .openapi('Member');

const MemberPatchSchema = z
  .strictObject({
    role: RoleSchema.optional(),
    disabled: z.boolean().optional().openapi({
      description:
        'true ends their sessions, stops their API keys and refuses sign-in; their Bots and data stay. false lets them sign in again.',
    }),
  })
  .openapi('MemberPatch');

const toMember = (m: MemberView) => ({
  id: m.id,
  name: m.name,
  email: m.email,
  role: m.role,
  createdAt: m.createdAt.toISOString(),
  disabledAt: m.disabledAt?.toISOString() ?? null,
  botCount: m.botCount,
});

const memberResponse = {
  description: 'The member',
  content: { 'application/json': { schema: MemberSchema } },
};

export const memberRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/admin/members',
      tags: ['settings'],
      summary: 'List members',
      middleware: [requireManaged, requireAdmin] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Members, oldest first',
          content: { 'application/json': { schema: z.object({ items: z.array(MemberSchema) }) } },
        },
        ...managedProblems,
      },
    }),
    async (c) => {
      const members = await listMembers(c.var.deps.db, c.var.user.workspaceId);
      return c.json({ items: members.map(toMember) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/admin/members/{id}',
      tags: ['settings'],
      summary: "Change a member's role or sign-in",
      description:
        'The workspace always keeps an admin who can sign in (409 LAST_ADMIN), and an admin cannot disable themselves (409 CANNOT_DISABLE_SELF).',
      middleware: [requireManaged, requireAdmin] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { required: true, content: { 'application/json': { schema: MemberPatchSchema } } },
      },
      responses: {
        200: memberResponse,
        400: problemResponse('Invalid change'),
        404: problemResponse('No such member, or a self-hosted install'),
        409: problemResponse('The change would leave no admin, or disables the caller'),
        ...adminProblems,
      },
    }),
    async (c) => {
      const member = await updateMember(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(toMember(member), 200);
    },
  );
