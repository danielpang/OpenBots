import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CLIENT_IP_HEADER } from '../client-ip.js';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, forbidden } from '../errors.js';
import { computerProvider } from './computer.js';

// First run (plan 16.3, D1). An install needs setup until its first user
// exists; that user becomes the admin (auth.ts), called the owner on a
// self-hosted install, where it is the only account. The wizard then asks for a
// provider key through the providers API, starts the sandbox image pull and
// creates a first Bot through the Bots API.

export async function setupRequired(db: Db): Promise<boolean> {
  const [anyUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  return !anyUser;
}

export const setupComplete = () =>
  new DomainError(409, 'SETUP_COMPLETE', 'This OpenBot is already set up. Sign in instead.');

export interface AdminInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Creates the first user through better-auth's email signup, so the session
 * cookie and the signup hooks (which make the first user admin) are the usual
 * ones. Refuses once any user exists. Two concurrent calls on an empty install
 * both pass the check; the hooks still make only one of them admin.
 *
 * `requestOrigin` is the caller's Origin header: better-auth refuses foreign
 * origins on its own routes, and this one must too, or any web page could
 * claim a fresh install for its visitor.
 */
export async function createAdmin(
  deps: AppDeps,
  input: AdminInput,
  requestOrigin: string | undefined,
  clientAddress: string | null = null,
): Promise<Response> {
  const origin = new URL(deps.config.publicUrl).origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    throw forbidden('Create the first account from the OpenBot page itself');
  }
  if (!(await setupRequired(deps.db))) throw setupComplete();
  const res = await deps.auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      // better-auth rate-limits sign-ups by client address and refuses a
      // request without one (S-6), so pass on the caller's.
      headers: {
        'content-type': 'application/json',
        origin,
        ...(clientAddress ? { [CLIENT_IP_HEADER]: clientAddress } : {}),
      },
      body: JSON.stringify(input),
    }),
  );
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  throw new DomainError(
    res.status as ContentfulStatusCode,
    body.code ?? 'SIGNUP_FAILED',
    body.message ?? 'The account could not be created',
  );
}

export type SandboxImageStatus = 'not_configured' | 'idle' | 'pulling' | 'ready' | 'error';

export interface SandboxImageState {
  status: SandboxImageStatus;
  image: string;
  error: string | null;
}

// Per process: the pull is a convenience that warms the Docker cache, and the
// first `create` pulls anyway if this one never ran or failed.
const pulls = new WeakMap<
  AppDeps,
  { status: 'pulling' | 'ready' | 'error'; error: string | null }
>();

export function sandboxImageState(deps: AppDeps): SandboxImageState {
  const image = deps.config.sandboxImage;
  if (!computerProvider(deps)?.prepareImage)
    return { status: 'not_configured', image, error: null };
  const pull = pulls.get(deps);
  return { status: pull?.status ?? 'idle', image, error: pull?.error ?? null };
}

/** Starts the sandbox image pull in the background when Docker is configured. */
export function startSandboxPull(deps: AppDeps): SandboxImageState {
  const provider = computerProvider(deps);
  const current = pulls.get(deps)?.status;
  if (provider?.prepareImage && current !== 'pulling' && current !== 'ready') {
    pulls.set(deps, { status: 'pulling', error: null });
    provider.prepareImage(deps.config.sandboxImage).then(
      () => pulls.set(deps, { status: 'ready', error: null }),
      (err: unknown) => {
        deps.logger.warn({ err, image: deps.config.sandboxImage }, 'sandbox image pull failed');
        pulls.set(deps, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }
  return sandboxImageState(deps);
}
