// The artifact host's two signed values (plan 21.11). Both are
// `<payload>.<mac>`, base64url JSON with an HMAC-SHA256 over it, made with
// Web Crypto alone so the handler can run outside Node (a Worker) too.
//
// - The view token: minted by the app for one viewer and one Artifact,
//   valid for a minute and used once. It rides in the URL only until the
//   host trades it for the cookie and redirects it away.
// - The view cookie: what the host sets in exchange, valid for 30 minutes
//   on that Artifact's path only.
//
// Each has its own key (derived from the master key with HKDF, see
// `artifactHostKeys`), so one can never stand in for the other. Neither is
// the access check: the host asks again on every request whether the viewer
// may still see the Artifact.

export interface ViewClaims {
  /** The Artifact. */
  a: string;
  /** The viewer (a user id). */
  u: string;
  /** The organization the viewer was working in when it was minted. */
  w: string;
  /** Expiry, ms since the epoch. */
  e: number;
  /** A random nonce: a token is claimed once by it. */
  n: string;
}

export const VIEW_TOKEN_SECONDS = 60;
export const VIEW_COOKIE_SECONDS = 30 * 60;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(key: Uint8Array) {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signClaims(key: Uint8Array, claims: ViewClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The claims of a value signed with `key` that has not expired, or null. */
export async function verifyClaims(
  key: Uint8Array,
  value: string | null | undefined,
  now = Date.now(),
): Promise<ViewClaims | null> {
  if (!value || value.length > 1_000) return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const signature = fromBase64url(mac);
  if (!signature) return null;
  // `verify` compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(key),
    new Uint8Array(signature),
    encoder.encode(payload),
  );
  if (!valid) return null;
  const bytes = fromBase64url(payload);
  if (!bytes) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const c = claims as Partial<ViewClaims>;
  if (
    typeof c.a !== 'string' ||
    !UUID.test(c.a) ||
    typeof c.u !== 'string' ||
    !UUID.test(c.u) ||
    typeof c.w !== 'string' ||
    !UUID.test(c.w) ||
    typeof c.n !== 'string' ||
    typeof c.e !== 'number' ||
    !(c.e > now)
  ) {
    return null;
  }
  return { a: c.a, u: c.u, w: c.w, e: c.e, n: c.n };
}
