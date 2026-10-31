import { createRoute, z } from '@hono/zod-openapi';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter } from '../openapi.js';
import { effectiveSettings, ensureWorkspace } from '../workspace.js';
import { LimitsSchema, RoleSchema } from '../schemas.js';

export const MeSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      email: z.string(),
      name: z.string(),
      image: z.string().nullable(),
      emailVerified: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
    role: RoleSchema,
    workspace: z.object({ id: z.uuid(), name: z.string() }),
    limits: LimitsSchema,
  })
  .openapi('Me');

export const meRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['auth'],
    summary: 'The signed-in user, their role, the workspace, and its limits',
    middleware: [requireUser] as const,
    security: authenticated,
    responses: {
      200: { description: 'The caller', content: { 'application/json': { schema: MeSchema } } },
      ...authProblems,
    },
  }),
  async (c) => {
    const { db, config } = c.var.deps;
    const user = c.var.user;
    const workspace = await ensureWorkspace(db);
    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt.toISOString(),
        },
        role: user.role,
        workspace: { id: workspace.id, name: workspace.name },
        limits: effectiveSettings(config, workspace).limits,
      },
      200,
    );
  },
);
