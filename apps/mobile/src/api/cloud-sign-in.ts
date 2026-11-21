import { base64urlEncode } from '@openbots/tunnel';
import { pairWithCode } from '../hosts/pairing';
import type { HostSecrets, SavedHost } from '../hosts/types';
import { normalizeServerUrl } from '../transport';
import { sessionAndPair } from './sign-in';

// Signing in to OpenBots Cloud (the server's services/app-sign-in.ts) with no
// QR code. The app opens the hosted sign-in in an authentication session
// (ASWebAuthenticationSession), where the person signs in or up as the
// hosted service allows (email, Google, GitHub, Apple) and confirms. The
// session ends at `openbots://app-sign-in#code=...&state=...`, which only
// this session receives. The app checks the state is its own and trades the
// code, with the PKCE verifier only it holds, at `POST /api/v1/devices/pair`
// for its own device key, revocable from Devices on the web. Native Sign in
// with Apple, when the server and this build both allow it, signs in with
// Apple's ID token instead and pairs the same way.
//
// Everything native comes in as a function, so this file runs in the tests.

export const CLOUD_CALLBACK = 'openbots://app-sign-in';
export const CLOUD_HOST_NAME = 'OpenBots Cloud';

export class CloudSignInCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled.');
    this.name = 'CloudSignInCancelled';
  }
}

/** The host an OpenBots Cloud sign-in saves: direct only, as an account. */
export function cloudHost(origin: string): SavedHost {
  return {
    id: `account-${origin}`,
    name: CLOUD_HOST_NAME,
    kind: 'account',
    directUrls: [origin],
    relayUrl: null,
  };
}

/** The code in the session's final URL, when its state is ours; throws otherwise. */
export function readCallback(url: string, state: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'openbots:' || parsed.hostname !== 'app-sign-in' || parsed.search)
    throw new Error('OpenBots Cloud answered in a way this app does not know.');
  const fields = new URLSearchParams(parsed.hash.slice(1));
  if (fields.get('state') !== state)
    throw new Error('That sign-in is not the one this app started. Sign in again.');
  if (fields.get('error') === 'cancelled') throw new CloudSignInCancelled();
  const code = fields.get('code');
  if (!code || !/^[A-Za-z0-9_-]{1,256}$/.test(code))
    throw new Error('OpenBots Cloud answered in a way this app does not know.');
  return code;
}

export interface CloudSignInOptions {
  cloudUrl: string;
  deviceName: string;
  /**
   * Opens the URL in an authentication session that ends at `callback`;
   * resolves the final URL, or null when the person closed it.
   */
  openAuthSession(url: string, callback: string): Promise<string | null>;
  /** Base64url SHA-256 of the text (the PKCE challenge of a verifier). */
  sha256Base64url(text: string): Promise<string>;
  randomBytes(length: number): Uint8Array;
  fetch?: typeof fetch;
}

/** The browser sign-in, start to end: the saved host and its device key. */
export async function signInToCloud(
  options: CloudSignInOptions,
): Promise<{ host: SavedHost; secrets: HostSecrets }> {
  const origin = normalizeServerUrl(options.cloudUrl);
  const verifier = base64urlEncode(options.randomBytes(32));
  const state = base64urlEncode(options.randomBytes(16));
  const url = new URL('/app-sign-in', origin);
  url.searchParams.set('platform', 'ios');
  url.searchParams.set('challenge', await options.sha256Base64url(verifier));
  url.searchParams.set('state', state);
  const answer = await options.openAuthSession(url.toString(), CLOUD_CALLBACK);
  if (!answer) throw new CloudSignInCancelled();
  const code = readCallback(answer, state);
  const result = await pairWithCode(cloudHost(origin), code, {
    deviceName: options.deviceName,
    codeVerifier: verifier,
    fetch: options.fetch,
    randomBytes: options.randomBytes,
  });
  return { host: result.host, secrets: result.secrets };
}

export interface AppleSignInOptions {
  cloudUrl: string;
  deviceName: string;
  /** Sign in with Apple, asking for this (hashed) nonce; resolves Apple's ID token and name. */
  signInWithApple(hashedNonce: string): Promise<{ identityToken: string; name?: string }>;
  /** Hex SHA-256 of the text: Apple puts the hashed nonce in its token. */
  sha256Hex(text: string): Promise<string>;
  randomBytes(length: number): Uint8Array;
  fetch?: typeof fetch;
}

/**
 * Native Sign in with Apple: Apple's ID token, with the nonce the app made,
 * signs in on OpenBots Cloud for a moment, long enough to pair this device
 * (as an email sign-in does here). The session is signed out after.
 */
export async function signInWithAppleToCloud(
  options: AppleSignInOptions,
): Promise<{ host: SavedHost; secrets: HostSecrets }> {
  const origin = normalizeServerUrl(options.cloudUrl);
  const nonce = base64urlEncode(options.randomBytes(32));
  const apple = await options.signInWithApple(await options.sha256Hex(nonce));
  const result = await sessionAndPair(
    {
      address: origin,
      deviceName: options.deviceName,
      signIn: (auth) =>
        auth.signInIdToken({
          provider: 'apple',
          token: apple.identityToken,
          nonce,
          ...(apple.name ? { name: apple.name } : {}),
        }),
    },
    options.fetch,
  );
  // Saved as the account, direct only, like the browser sign-in's.
  const { deviceId, ownerId, lastSeenAt } = result.host;
  return { host: { ...cloudHost(origin), deviceId, ownerId, lastSeenAt }, secrets: result.secrets };
}
