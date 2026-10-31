import { fileURLToPath } from 'node:url';
import type { ServerExtensions } from '@openbot/server';
import type { EmailOptions } from './email.js';
import { managedPolicyPlugin, organizationPlugin } from './plugin.js';
import { organizationRoutes } from './routes.js';

// The managed service's server (plan 21.5): the core server with the
// organization plugin, its policy, the organization routes and the managed
// web build. The core never imports this; `main.ts` here starts the core
// with it.

export { organizationRoutes } from './routes.js';
export { managedPolicyPlugin, organizationPlugin } from './plugin.js';
export type { EmailOptions } from './email.js';

/** `ee/web/dist`, from both `src/` and `dist/`. */
export const MANAGED_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface ManagedOptions {
  /** Invite email (RESEND_API_KEY, OPENBOT_EMAIL_FROM); invites are links without it. */
  email?: EmailOptions;
  /** The web build to serve; the managed one by default. */
  webDist?: string;
}

/** Reads RESEND_API_KEY, OPENBOT_EMAIL_FROM and OPENBOT_DEV_LOG_EMAIL_LINKS. */
export function emailFromEnv(env: NodeJS.ProcessEnv = process.env): EmailOptions {
  const logLinks = ['1', 'true'].includes(env.OPENBOT_DEV_LOG_EMAIL_LINKS ?? '');
  if (logLinks && env.NODE_ENV === 'production') {
    throw new Error(
      'invalid configuration:\n  OPENBOT_DEV_LOG_EMAIL_LINKS: logs sign-in links; not allowed with NODE_ENV=production',
    );
  }
  return {
    ...(env.RESEND_API_KEY ? { apiKey: env.RESEND_API_KEY } : {}),
    ...(env.OPENBOT_EMAIL_FROM ? { from: env.OPENBOT_EMAIL_FROM } : {}),
    ...(logLinks ? { logLinks } : {}),
  };
}

export function managedExtensions({
  email = {},
  webDist = MANAGED_WEB_DIST,
}: ManagedOptions = {}): ServerExtensions {
  return {
    organizations: true,
    requireVerifiedEmail: true,
    authPlugins: (context) => [organizationPlugin(), managedPolicyPlugin(context, email)],
    routes: (app) => {
      app.route('/api/v1', organizationRoutes(email));
    },
    // An invitation's id is its link's secret; request logs leave it out.
    redactPath: (path) => path.replace(/\/invitations\/[^/]+/, '/invitations/[redacted]'),
    webDist,
  };
}
