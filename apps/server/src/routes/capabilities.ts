import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../openapi.js';
import { computerAvailable } from '../services/computer.js';

// What this install has turned on, for clients deciding what to show before
// sign-in (GitHub and Google buttons, U1), whether there is a computer
// (Phase 4), and what kind of install it is: self-hosted has one owner and no
// admin screens; managed has admins, members and invites. Public: it names
// no secrets.

const CapabilitiesSchema = z
  .object({
    oauth: z.object({ github: z.boolean(), google: z.boolean() }),
    // Optional for the same reason; always sent.
    computer: z.boolean().optional().openapi({
      description: 'A computer provider (Docker or a remote agent) is configured',
    }),
    deployment: z.enum(['self_hosted', 'managed']).openapi({
      description:
        '`self_hosted`: one account, its owner, with sign-up closed once it exists and no members, invites or audit log. `managed`: the hosted service, with admins and members.',
    }),
  })
  .openapi('Capabilities');

export const capabilityRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/capabilities',
    tags: ['auth'],
    summary: 'Sign-in providers and features this install has enabled',
    responses: {
      200: {
        description: 'Enabled capabilities',
        content: { 'application/json': { schema: CapabilitiesSchema } },
      },
    },
  }),
  (c) => {
    const { oauth, deployment } = c.var.deps.config;
    return c.json(
      {
        oauth: { github: !!oauth.github, google: !!oauth.google },
        computer: computerAvailable(c.var.deps),
        deployment,
      },
      200,
    );
  },
);
