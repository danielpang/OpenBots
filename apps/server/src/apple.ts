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
//   default, its issuer, an audience of the app's bundle ID only (a token
//   made for the web Services ID is not the app's), an hour's age at most,
//   and the nonce the app made. The app asks Apple for the SHA-256 of its
//   nonce, in hex, so that is what the token carries, and it sends the nonce
//   itself here. Only the hash of what is sent may match the claim: were the
//   claim itself accepted, anyone holding a token could send its own claim
//   back as the nonce, and the nonce would stop nothing.
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

/** Whether the nonce in a token is the SHA-256, in hex, of the nonce the app sent. */
export function sameNonce(claim: unknown, nonce: string): boolean {
  if (typeof claim !== 'string') return false;
  const a = Buffer.from(claim);
  const b = Buffer.from(createHash('sha256').update(nonce).digest('hex'));
  return a.length === b.length && timingSafeEqual(a, b);
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
  // The native sign-in is the app's: the web's Services ID is not accepted
  // here. Without a bundle ID there is no native sign-in at all.
  const appAudience = config.appBundleId;
  let current: { secret: string; expiresAt: number } | null = null;

  return {
    clientId: config.clientId,
    get clientSecret(): string {
      const at = now();
      if (!current || current.expiresAt - at < DAY_MS) current = appleClientSecret(config, key, at);
      return current.secret;
    },
    ...(config.appBundleId ? { appBundleIdentifier: config.appBundleId } : {}),
    /** The native sign-in's ID token: Apple's, for this app, recent, with the app's nonce. */
    async verifyIdToken(token: string, nonce?: string): Promise<boolean> {
      if (!appAudience) return false;
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: APPLE_ISSUER,
          audience: appAudience,
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
