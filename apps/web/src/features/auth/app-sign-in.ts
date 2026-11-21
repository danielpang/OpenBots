// Signing the iOS or Mac app in through this browser (server:
// services/app-sign-in.ts). The app opens /app-sign-in with its platform,
// its PKCE challenge and a state of its own. Someone not signed in yet signs
// in or up first, in whatever way the server allows; the request waits in
// this tab's session storage meanwhile, and the app's pages send them back
// to it (`resumeAppSignIn`). Once they confirm, the server makes a one-time
// code and the browser goes to `openbots://app-sign-in#code=...&state=...`.
// The code is in the fragment, so nothing between here and the app logs it.

export type AppPlatform = 'ios' | 'desktop';

export interface AppSignInRequest {
  platform: AppPlatform;
  challenge: string;
  state: string;
}

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const PENDING_KEY = 'openbots.app-sign-in';
/** How long a request waits for its person to sign in. */
export const PENDING_MS = 15 * 60_000;

/** The request in /app-sign-in's search, when it is whole and well formed. */
export function readAppSignIn(search: Record<string, unknown>): AppSignInRequest | null {
  const { platform, challenge, state } = search;
  if (platform !== 'ios' && platform !== 'desktop') return null;
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return null;
  if (typeof state !== 'string' || !STATE.test(state)) return null;
  return { platform, challenge, state };
}

/** Where the browser goes with the code: back into the app. */
export function appRedirect(state: string, result: { code: string } | { error: 'cancelled' }) {
  const fields = 'code' in result ? { code: result.code, state } : { error: result.error, state };
  const hash = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `openbots://app-sign-in#${hash}`;
}

/** "your Mac" or "your iPhone or iPad", for the confirmation. */
export function platformName(platform: AppPlatform): string {
  return platform === 'desktop'
    ? 'the OpenBots app on your Mac'
    : 'the OpenBots app on your iPhone or iPad';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps the request while its person signs in. */
export function savePendingAppSignIn(
  request: AppSignInRequest,
  now = Date.now(),
  store = storage(),
): void {
  try {
    store?.setItem(PENDING_KEY, JSON.stringify({ ...request, at: now }));
  } catch {
    // Without storage the person opens the app's link again after signing in.
  }
}

/** The request waiting in this tab, taken out of storage; null when none or too old. */
export function takePendingAppSignIn(now = Date.now(), store = storage()): AppSignInRequest | null {
  let text: string | null;
  try {
    text = store?.getItem(PENDING_KEY) ?? null;
    store?.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const saved = JSON.parse(text) as Record<string, unknown>;
    if (typeof saved.at !== 'number' || now - saved.at > PENDING_MS || saved.at > now) return null;
    return readAppSignIn(saved);
  } catch {
    return null;
  }
}
