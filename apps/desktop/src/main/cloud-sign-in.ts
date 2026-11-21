import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isSessionCookie, type SessionToken } from './tokens.js';

// Signing in to OpenBots Cloud in the default browser (the server's
// services/app-sign-in.ts). Google refuses sign-in inside an app's own web
// view, and the browser already knows the person's passwords and passkeys,
// so the app never shows a sign-in form for the hosted service:
//
// 1. `start` makes a PKCE verifier and a state, kept here in memory only,
//    and opens <cloud>/app-sign-in?platform=desktop&challenge=...&state=...
// 2. The person signs in or up there, as the hosted service allows, and
//    confirms. The browser opens `openbots://app-sign-in#code=...&state=...`.
// 3. `finish` checks the state is the one it made, then trades the code and
//    the verifier at `POST /api/v1/app-sign-in/session` for a session cookie,
//    which the app keeps sealed in the Keychain like any other (./tokens.ts).
//    The server lists this Mac in Settings > Devices, where it can be revoked.
//
// A link that is not the answer to this run's request (another state, none
// open, or older than SIGN_IN_MS) is refused before anything is sent. The
// code and the verifier never reach a log or an error message.

export const SIGN_IN_PATH = '/app-sign-in';
/** How long the app waits for the browser to come back. */
export const SIGN_IN_MS = 15 * 60_000;

export class CloudSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudSignInError';
  }
}

export type SignInCallback =
  { kind: 'code'; code: string; state: string } | { kind: 'cancelled'; state: string };

/** Reads `openbots://app-sign-in#code=...&state=...` (or `#error=cancelled&state=...`). */
export function parseSignInCallback(raw: string): SignInCallback | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'openbots:' || url.hostname !== 'app-sign-in') return null;
  if (url.pathname !== '' || url.search !== '' || url.username !== '' || raw.length > 4096) {
    return null;
  }
  const fields = new URLSearchParams(url.hash.slice(1));
  const state = fields.get('state');
  if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  if (fields.get('error') === 'cancelled') return { kind: 'cancelled', state };
  const code = fields.get('code');
  if (!code || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) return null;
  return { kind: 'code', code, state };
}

/** The session cookie in a response's Set-Cookie headers, or null. */
export function sessionFromSetCookie(headers: readonly string[]): SessionToken | null {
  for (const header of headers) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (!pair || index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (isSessionCookie(name) && value) return { name, value };
  }
  return null;
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface CloudSignInOptions {
  /** The hosted server's origin (./app-config.ts). */
  cloudUrl: string;
  openExternal(url: string): Promise<void>;
  fetch: typeof fetch;
  /** This Mac's name in the server's Devices list. */
  deviceName(): Promise<string>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export interface CloudSignIn {
  /** Opens the browser at the hosted sign-in, for this Mac. */
  start(): Promise<void>;
  /**
   * The browser's answer: the session for the cloud profile. Throws
   * CloudSignInError with a sentence to show when it is not one.
   */
  finish(link: string): Promise<SessionToken>;
}

export function createCloudSignIn(options: CloudSignInOptions): CloudSignIn {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((n: number) => randomBytes(n));
  let pending: { verifier: string; state: string; at: number } | null = null;

  return {
    async start() {
      const verifier = Buffer.from(random(32)).toString('base64url');
      const state = Buffer.from(random(16)).toString('base64url');
      pending = { verifier, state, at: now() };
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(SIGN_IN_PATH, options.cloudUrl);
      url.searchParams.set('platform', 'desktop');
      url.searchParams.set('challenge', challenge);
      url.searchParams.set('state', state);
      await options.openExternal(url.toString());
    },

    async finish(link) {
      const answer = parseSignInCallback(link);
      const request = pending;
      if (!answer) throw new CloudSignInError('That sign-in link is not one this app can use.');
      if (!request || now() - request.at > SIGN_IN_MS || !sameText(answer.state, request.state)) {
        throw new CloudSignInError(
          'That sign-in is not the one this app started, or it is too old. Choose Sign in again.',
        );
      }
      // One answer per request, whatever happens next.
      pending = null;
      if (answer.kind === 'cancelled') throw new CloudSignInError('Sign-in was cancelled.');
      let response: Response;
      try {
        response = await options.fetch(new URL('/api/v1/app-sign-in/session', options.cloudUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: answer.code,
            codeVerifier: request.verifier,
            name: (await options.deviceName()).trim().slice(0, 100) || 'Mac',
          }),
          redirect: 'error',
        });
      } catch {
        throw new CloudSignInError(
          "Could not reach OpenBots Cloud. Check this Mac's internet connection, then sign in again.",
        );
      }
      if (!response.ok) {
        throw new CloudSignInError(
          response.status === 429
            ? 'Too many sign-in attempts. Wait a while, then sign in again.'
            : response.status === 401
              ? 'That sign-in expired or was already used. Choose Sign in again.'
              : `OpenBots Cloud could not sign this Mac in (${response.status}). Try again.`,
        );
      }
      const token = sessionFromSetCookie(response.headers.getSetCookie());
      if (!token) {
        throw new CloudSignInError('OpenBots Cloud answered in a way this app does not know.');
      }
      return token;
    },
  };
}
