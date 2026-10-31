import { createRoute, z } from '@hono/zod-openapi';
import { clientIp } from '../client-ip.js';
import { requireAdmin } from '../middleware/auth.js';
import { adminProblems, authenticated, createRouter, problemResponse } from '../openapi.js';
import {
  createAdmin,
  sandboxImageState,
  setupRequired,
  startSandboxPull,
} from '../services/setup.js';

// The first-run wizard (plan 16.3, D1). `GET /setup` is public and cheap: the
// web app asks it before sign-in to decide whether to show the wizard.
// `POST /setup/admin` creates the first user, and refuses once one exists.
// That user is the admin internally; a self-hosted install calls it the owner.

const SetupStatusSchema = z
  .object({
    setupRequired: z.boolean().openapi({ description: 'No user exists yet' }),
  })
  .openapi('SetupStatus');

const CreateAdminSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    email: z.email(),
    password: z.string().min(8).max(128),
  })
  .openapi('CreateAdmin');

const SetupAdminSchema = z
  .object({
    user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  })
  .openapi('SetupAdmin');

const SandboxImageSchema = z
  .object({
    status: z.enum(['not_configured', 'idle', 'pulling', 'ready', 'error']).openapi({
      description: '`not_configured` when Docker is not the computer provider',
    }),
    image: z.string(),
    error: z.string().nullable(),
  })
  .openapi('SandboxImage');

export const setupRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/setup',
      tags: ['setup'],
      summary: 'Whether this install still needs its first-run setup',
      responses: {
        200: {
          description: 'Setup status',
          content: { 'application/json': { schema: SetupStatusSchema } },
        },
      },
    }),
    async (c) => c.json({ setupRequired: await setupRequired(c.var.deps.db) }, 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/setup/admin',
      tags: ['setup'],
      summary: 'Create the first account (the owner) and sign them in',
      request: {
        body: { required: true, content: { 'application/json': { schema: CreateAdminSchema } } },
      },
      responses: {
        201: {
          description: 'The new account, with the session cookie set',
          content: { 'application/json': { schema: SetupAdminSchema } },
        },
        400: problemResponse('Invalid account details'),
        403: problemResponse('The request came from another origin'),
        409: problemResponse('Setup is complete: a user already exists'),
      },
    }),
    async (c) => {
      const res = await createAdmin(
        c.var.deps,
        c.req.valid('json'),
        c.req.header('origin'),
        clientIp(c),
      );
      const { user } = (await res.json()) as { user: { id: string; email: string; name: string } };
      for (const cookie of res.headers.getSetCookie())
        c.header('set-cookie', cookie, { append: true });
      return c.json({ user: { id: user.id, email: user.email, name: user.name } }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/setup/sandbox-image',
      tags: ['setup'],
      summary: 'The sandbox image pull started by the wizard',
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Pull status',
          content: { 'application/json': { schema: SandboxImageSchema } },
        },
        ...adminProblems,
      },
    }),
    (c) => c.json(sandboxImageState(c.var.deps), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/setup/sandbox-image',
      tags: ['setup'],
      summary: 'Start pulling the sandbox image in the background (Docker only)',
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: {
        202: {
          description: 'Pull status',
          content: { 'application/json': { schema: SandboxImageSchema } },
        },
        ...adminProblems,
      },
    }),
    (c) => c.json(startSandboxPull(c.var.deps), 202),
  );
