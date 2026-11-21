import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../openapi.js';
import { computerAvailable } from '../services/computer.js';
import { folderConnectorsOn } from '../services/connectors.js';
import { RELAY_PROTOCOL_VERSION, serverVersion } from '../version.js';

// What this install has turned on, for clients deciding what to show before
// sign-in (GitHub, Google and Apple buttons, U1), whether there is a computer
// (Phase 4), and what kind of install it is: self-hosted has one owner and no
// admin screens; managed has organizations, which the managed build adds. `auth` says
// whether the Mac app signs the owner in itself (routes/local.ts). `version`
// and `protocol` let a phone tell an owner their server is too old for it
// (version.ts). Public: it names no secrets.

const CapabilitiesSchema = z
  .object({
    oauth: z.object({
      github: z.boolean(),
      google: z.boolean(),
      // Optional: older servers do not send it. Always sent.
      apple: z.boolean().optional().openapi({
        description: 'Sign in with Apple is configured (APPLE_CLIENT_ID and the rest)',
      }),
    }),
    nativeAppleSignIn: z.boolean().optional().openapi({
      description:
        "The iOS app may sign in with Apple natively (APPLE_APP_BUNDLE_ID is set beside Apple's other settings)",
    }),
    // Optional for the same reason; always sent.
    computer: z.boolean().optional().openapi({
      description: 'A computer provider (Docker or a remote agent) is configured',
    }),
    deployment: z.enum(['self_hosted', 'managed']).openapi({
      description:
        '`self_hosted`: one account, its owner, with sign-up closed once it exists and no members, invites or audit log. `managed`: the hosted service, with admins and members.',
    }),
    // Optional, like `computer`: older servers do not send it. Always sent.
    customStdio: z.boolean().optional().openapi({
      description:
        'Admins may turn on custom command (stdio) connectors (OPENBOTS_CUSTOM_STDIO; off by default on the managed service)',
    }),
    folderConnectors: z.boolean().optional().openapi({
      description:
        "Folder (filesystem) connectors can be added and run. Always where stdio connectors run in each member's computer (OPENBOTS_STDIO_RUNNER=computer, the managed service's default), where the folder is in that computer; where they run on the server, as OPENBOTS_FOLDER_CONNECTORS says (on by default self-hosted, off by default managed). Off: the catalog leaves them out, adding one answers 403 `FOLDER_CONNECTORS_UNAVAILABLE`, and one that exists reads as disabled and offers no tools.",
    }),
    localEndpoints: z.boolean().optional().openapi({
      description:
        'Admins may mark endpoints as on their own network (OPENBOTS_LOCAL_ENDPOINTS; off by default on the managed service)',
    }),
    relay: z.boolean().optional().openapi({
      description:
        'A private relay is configured (OPENBOTS_RELAY_URL), so phones can pair and connect with no public URL',
    }),
    version: z.string().optional().openapi({
      description:
        "The server's release version (the root package.json, which the release stamps), such as `1.2.0`; `0.0.0` on a development build",
      example: '1.2.0',
    }),
    protocol: z
      .object({
        relay: z.number().int().openapi({
          description: 'The relay and tunnel protocol version (docs/RELAY_PROTOCOL.md)',
        }),
      })
      .optional()
      .openapi({ description: 'Protocol versions this server speaks' }),
    setupPairingOnly: z.boolean().optional().openapi({
      description:
        'The first owner is made by pairing a phone (`openbots pair`), not the web wizard (OPENBOTS_SETUP_PAIRING_ONLY)',
    }),
    artifactSharing: z.boolean().optional().openapi({
      description:
        'Artifacts can be shared with the organization or made public and opened in a browser on the artifact domain (OPENBOTS_ARTIFACT_DOMAIN). Off: no share control, and the sharing routes answer 404.',
    }),
    auth: z.enum(['password', 'local']).optional().openapi({
      description:
        '`local`: the Mac app on This Mac signs its owner in itself (OPENBOTS_LOCAL_TOKEN), so there is no sign-in, sign-up or sign-out. `password`: the usual sign-in.',
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
    const { oauth, deployment, localToken, customStdio, localEndpoints } = c.var.deps.config;
    return c.json(
      {
        oauth: { github: !!oauth.github, google: !!oauth.google, apple: !!oauth.apple },
        nativeAppleSignIn: !!oauth.apple?.appBundleId,
        computer: computerAvailable(c.var.deps),
        deployment,
        customStdio,
        folderConnectors: folderConnectorsOn(c.var.deps.config),
        localEndpoints,
        relay: !!c.var.deps.config.relayUrl,
        version: serverVersion(),
        protocol: { relay: RELAY_PROTOCOL_VERSION },
        setupPairingOnly: c.var.deps.config.setupPairingOnly,
        artifactSharing: !!c.var.deps.config.artifactHost,
        auth: localToken ? ('local' as const) : ('password' as const),
      },
      200,
    );
  },
);
