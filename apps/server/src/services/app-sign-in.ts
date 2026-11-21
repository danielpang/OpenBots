import { wsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { asDirectory, inWorkspace } from '../db/scope.js';
import { DomainError } from '../errors.js';
import { publishEvent, type Infra } from '../infra/index.js';
import { recordAudit, userActor } from './audit.js';
import {
  PAIRING_CODE_BYTES,
  createPairing,
  fromBase64url,
  pairingInvalid,
  spendPairing,
  undoPairing,
  type DeviceRow,
} from './devices.js';

// Signing the iOS and Mac apps in through the browser, so the hosted
// service needs no QR code (plan 7-8; docs/SELF_HOSTING.md#app-sign-in).
// Nothing here is the hosted service's alone: a self-hosted server with a
// public address can do the same.
//
// 1. The app makes a PKCE verifier, and opens the system browser at the web
//    app's /app-sign-in with its S256 challenge and a state of its own.
// 2. Signed in there (email, GitHub, Google or Apple, and on the managed
//    service only as its sign-up policy allows), the person confirms.
//    `POST /api/v1/app-sign-in/codes`, from that browser session only, makes
//    a one-time code: an ordinary device pairing (services/devices.ts) for
//    them in their active organization, good for 5 minutes and once, stored
//    as its hash, with the challenge beside it. The page sends the browser
//    to `openbots://app-sign-in#code=...&state=...`.
// 3. The app trades the code and its verifier for its own credential:
//    - the iOS app at `POST /api/v1/devices/pair`, as for a QR code, for a
//      device API key;
//    - the Mac app at `POST /api/v1/app-sign-in/session`, for a session (the
//      Mac app shows the whole web app, whose credential and invitation
//      routes a device key may not use). The session is a device too, in
//      Settings > Devices: revoking it deletes the session, and signing out
//      or the session ending revokes it (auth.ts).
//
// The verifier is what makes a caught redirect useless: another app that
// registered `openbots://` gets the code but not the verifier. Both routes
// that take a code are rate-limited per client and per code.

export const APP_SIGN_IN_PLATFORMS = ['ios', 'desktop'] as const;
export type AppSignInPlatform = (typeof APP_SIGN_IN_PLATFORMS)[number];

/** An S256 challenge: the base64url SHA-256 of a verifier, 43 characters. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const PLATFORM_NAMES: Record<AppSignInPlatform, string> = { ios: 'iOS app', desktop: 'Mac app' };

/**
 * A one-time code for the app that opened the browser, for the signed-in
 * caller in their active organization. Only a browser session may ask: an
 * API key (a device's included) answers 403, so a device cannot mint
 * credentials for another one.
 */
export async function createAppSignInCode(input: {
  db: Db;
  config: Config;
  user: CurrentUser;
  platform: AppSignInPlatform;
  codeChallenge: string;
}): Promise<{ code: string; expiresAt: string }> {
  const { db, config, user, platform, codeChallenge } = input;
  if (user.via !== 'session') {
    throw new DomainError(403, 'SESSION_REQUIRED', 'Sign in on the web to sign an app in.');
  }
  if (!CODE_CHALLENGE.test(codeChallenge)) {
    throw new DomainError(400, 'VALIDATION_FAILED', 'codeChallenge must be an S256 challenge');
  }
  const pairing = await createPairing({
    db,
    config,
    workspaceId: user.workspaceId,
    ownerId: user.id,
    name: PLATFORM_NAMES[platform],
    createdBy: 'app',
    actor: userActor(user),
    codeChallenge,
  });
  return { code: pairing.qr.code, expiresAt: pairing.expiresAt };
}

export interface AppSessionResult {
  device: { id: string; name: string; platform: 'desktop'; createdAt: string };
  user: { id: string; name: string };
  /** The session cookie, as Set-Cookie headers, for the route to pass on. */
  cookies: string[];
}

/**
 * `POST /app-sign-in/session`: spends a code an app sign-in made (only such
 * a code, and only with its verifier), then makes a session for its owner
 * in its organization and the device that holds it. Whatever fails after
 * the code is spent is undone and the code given back.
 */
export async function completeAppSession(input: {
  db: Db;
  auth: Auth;
  config: Config;
  infra: Pick<Infra, 'bus'>;
  body: { code: string; codeVerifier: string; name: string };
  /** The caller's address and user agent, for the session row. */
  headers: Headers;
}): Promise<AppSessionResult> {
  const { db, auth, infra, body, headers } = input;
  const code = fromBase64url(body.code, PAIRING_CODE_BYTES);
  if (!code) throw pairingInvalid();
  const { workspaceId, pairing } = await spendPairing(db, code, {
    codeVerifier: body.codeVerifier,
    requireChallenge: true,
  });

  let sessionId: string | null = null;
  let device: DeviceRow;
  let cookies: string[];
  const ownerId = pairing.ownerId;
  try {
    if (!ownerId) throw pairingInvalid();
    const res = await auth.api.createAppSession({
      body: { userId: ownerId, workspaceId },
      headers,
      asResponse: true,
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new DomainError(
        res.status as ContentfulStatusCode,
        problem.code ?? 'APP_SIGN_IN_FAILED',
        problem.message ?? 'The app could not be signed in',
      );
    }
    sessionId = ((await res.json()) as { session: { id: string } }).session.id;
    cookies = res.headers.getSetCookie();
    const session = sessionId;
    device = await inWorkspace(workspaceId, async () => {
      const [row] = await db
        .insert(schema.devices)
        .values({
          workspaceId,
          ownerId,
          name: body.name,
          platform: 'desktop',
          sessionId: session,
          lastSeenAt: new Date(),
        })
        .returning();
      return row!;
    });
  } catch (error) {
    // No device, no session: a session nobody can see in Devices could not be revoked there.
    if (sessionId) {
      const id = sessionId;
      await asDirectory(() => db.delete(schema.sessions).where(eq(schema.sessions.id, id))).catch(
        () => undefined,
      );
    }
    await undoPairing(db, {
      workspaceId,
      pairing,
      apiKeyId: null,
      createdOwner: false,
      ownerId,
    });
    throw error;
  }

  const owner = ownerId;
  const [ownerRow] = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, owner));
  await inWorkspace(workspaceId, async () => {
    await recordAudit(db, {
      workspaceId,
      actor: { type: 'user', id: owner },
      action: 'device.paired',
      targetType: 'device',
      targetId: device.id,
      metadata: {
        name: device.name,
        platform: device.platform,
        pairingId: pairing.id,
        via: 'app_sign_in',
        createdOwner: false,
      },
    });
    await publishEvent(
      infra.bus,
      wsEvent(
        'device.paired',
        {
          device: {
            id: device.id,
            name: device.name,
            platform: device.platform,
            createdAt: device.createdAt.toISOString(),
            revokedAt: null,
          },
        },
        { user_id: owner, workspace_id: workspaceId },
      ),
    );
  });
  return {
    device: {
      id: device.id,
      name: device.name,
      platform: 'desktop',
      createdAt: device.createdAt.toISOString(),
    },
    user: { id: owner, name: ownerRow?.name ?? '' },
    cookies,
  };
}
