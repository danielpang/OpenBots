import { createHash, createPrivateKey, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppleSignInConfig } from './config.js';

// Sign in with Apple (U1), off until the operator sets APPLE_CLIENT_ID,
// APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (config.ts). Generic: a
// self-hosted install can turn it on too, as with GitHub and Google.
//
// The web sign-in is better-auth's own `apple` provider. Two things it
// leaves to us:
//
// - The client secret. Apple wants a JWT signed with the team's .p8 key,
//   good for six months at most. One is made here when first asked for, for
//   SECRET_DAYS, and made again a day before it ends, so nobody pastes a new
//   one twice a year. better-auth reads `clientSecret` each time it swaps a
//   code for tokens, so the getter below is asked then.
// - The ID token check, for the iOS app's native sign-in (`POST
//   /api/auth/sign-in/social` with `idToken`). Done here rather than by
//   better-auth's default so the keys can be faked in tests: Apple's keys by
//   default, its issuer, an audience of the Services ID or the app's bundle
//   ID, an hour's age at most, and the nonce the app made (Apple puts the
//   SHA-256 of the app's nonce in the token, as hex; the app sends the nonce).
//
// The provider's answer is data: the email and name it carries make an
// account (through the user hooks, which decide whether sign-up is allowed),
// nothing more.

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
/** How long a client secret this server makes lasts (Apple allows up to 180 days). */
export const SECRET_DAYS = 30;
const DAY_MS = 86_400_000;

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * The client secret Apple's token endpoint wants: an ES256 JWT from the team,
 * about the Services ID, signed with the key. Lasts SECRET_DAYS from `now`.
 */
export function appleClientSecret(
  config: Pick<AppleSignInConfig, 'clientId' | 'teamId' | 'keyId'>,
  key: KeyObject,
  now = Date.now(),
): { secret: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + SECRET_DAYS * 86_400;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: config.teamId, iat, exp, aud: APPLE_ISSUER, sub: config.clientId }),
  );
  const input = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return { secret: `${input}.${base64url(signature)}`, expiresAt: exp * 1000 };
}

export interface AppleProviderOptions {
  /** Apple's signing keys; its published set by default. Tests pass their own. */
  keys?: JWTVerifyGetKey;
  /** The clock, for the client secret's life. */
  now?: () => number;
}

/** Whether the nonce in a token is the app's, or its SHA-256 in hex (as Apple puts it). */
export function sameNonce(claim: unknown, nonce: string): boolean {
  if (typeof claim !== 'string') return false;
  const hashed = createHash('sha256').update(nonce).digest('hex');
  for (const candidate of [nonce, hashed]) {
    const a = Buffer.from(claim);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * better-auth's options for its `apple` provider. The key is read once; a
 * key that does not parse fails at start, with a message that names the
 * variable and not the key.
 */
export function appleProvider(config: AppleSignInConfig, options: AppleProviderOptions = {}) {
  let key: KeyObject;
  try {
    key = createPrivateKey(config.privateKey);
  } catch {
    throw new Error(
      'invalid configuration:\n  APPLE_PRIVATE_KEY: not a key this server can read; paste the .p8 file Apple gave',
    );
  }
  const now = options.now ?? Date.now;
  const keys = options.keys ?? createRemoteJWKSet(new URL(APPLE_KEYS_URL));
  const audience = [config.clientId, ...(config.appBundleId ? [config.appBundleId] : [])];
  let current: { secret: string; expiresAt: number } | null = null;

  return {
    clientId: config.clientId,
    get clientSecret(): string {
      const at = now();
      if (!current || current.expiresAt - at < DAY_MS) current = appleClientSecret(config, key, at);
      return current.secret;
    },
    audience,
    ...(config.appBundleId ? { appBundleIdentifier: config.appBundleId } : {}),
    /** The native sign-in's ID token: Apple's, for this app, recent, with the app's nonce. */
    async verifyIdToken(token: string, nonce?: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: APPLE_ISSUER,
          audience,
          algorithms: ['RS256'],
          maxTokenAge: '1h',
          currentDate: new Date(now()),
        });
        // A token without a nonce could be replayed from anywhere it was seen.
        return typeof nonce === 'string' && nonce.length > 0 && sameNonce(payload.nonce, nonce);
      } catch {
        return false;
      }
    },
  };
}
