import {
  newNonce,
  signClaims,
  verifyClaims,
  VIEW_COOKIE_SECONDS,
  type ViewClaims,
} from './tokens.js';

// The artifact host (plan 21.11): `https://<bot>--<org>.<domain>/<id>`
// serves one Artifact a viewer may see. A Request goes in and a Response
// comes out; what it looks up and the bytes it serves are injected, so the
// same handler runs mounted in the server (by the Host header, or behind the
// edge Worker at /artifact-host/) and could run in a Worker reading object
// storage later. It uses web APIs only.
//
// Everything served here is untrusted, the person viewing it included:
//
// - Every answer carries a Content-Security-Policy with `sandbox`. Only a
//   document whose type is HTML is a page, and its scripts run in an opaque
//   origin (no `allow-same-origin`): they cannot read the host's cookie,
//   storage or any response, and `connect-src 'none'` keeps them off the
//   network. Everything else is shown as text, an image or a download, never
//   as active content (`presentation` below).
// - No CORS headers, `nosniff`, `no-referrer`, a same-origin
//   Cross-Origin-Resource-Policy, no framing, and `noindex` everywhere.
// - A private or organization view needs a signed token the app mints for
//   one viewer and one Artifact. The host claims it once, trades it for an
//   HttpOnly cookie on that Artifact's path only, and redirects to the bare
//   path, so the token leaves the address bar and is never sent on. Who may
//   see the Artifact is asked again on every request (`resolve`).
// - "No such Artifact", "not shared" and "not yours" are the same 404, and
//   a hostname that is not exactly one `<bot>--<org>` label under the domain
//   is that 404 too. The only redirect goes to the same host's bare
//   Artifact path, built from a checked id, so the host redirects nowhere
//   else. Requests are rate limited per client address.

export const VIEW_COOKIE = '__Secure-ob_view';
export const TOKEN_PARAM = 'token';

/** Requests a client address may make in a minute. */
export const HOST_RATE_LIMIT = 300;

export type ArtifactKind = 'document' | 'code' | 'data' | 'design' | 'file';

/** The Bot and organization a hostname names. */
export interface HostTarget {
  botSlug: string;
  orgSlug: string;
}

/** What one request may be served, as `resolve` decides it. */
export interface HostView {
  /** Why it may: its owner, a member of its organization, or anyone (the public version). */
  audience: 'owner' | 'member' | 'public';
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  mime: string;
  size: number;
  /** The version's bytes; called once, and not for HEAD. */
  body(): Promise<ReadableStream<Uint8Array>>;
  /** Releases what `resolve` opened when the body is not read (HEAD). */
  discard?(): void;
}

export interface Viewer {
  userId: string;
  workspaceId: string;
}

export interface ArtifactHostDeps {
  /** The artifact domain (OPENBOTS_ARTIFACT_DOMAIN), lower case. */
  domain: string;
  keys: { token: Uint8Array; cookie: Uint8Array };
  /**
   * The version this viewer (or nobody) may see of the Artifact the request
   * names, or null. Every rule lives here: visibility, membership, an owner
   * who was suspended, the organization's public setting, a takedown.
   */
  resolve(
    target: HostTarget & { artifactId: string },
    viewer: Viewer | null,
  ): Promise<HostView | null>;
  /** True when this key is still under its limit for the minute. */
  allow(key: string): Promise<boolean>;
  /** True the first time a token's nonce is claimed, false after. */
  claim(nonce: string): Promise<boolean>;
  now?(): number;
}

const LABEL = /^([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ARTIFACT_PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/;

/**
 * The Bot and organization of a hostname: exactly one DNS label of at most
 * 63 characters directly under `domain`, split at its only `--` (neither
 * slug may hold one). Anything else is null: the bare domain, a deeper
 * name, a port-less mismatch, upper case that is not folded, an IDN label.
 */
export function parseHostname(hostname: string, domain: string): HostTarget | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.length > 63 || label.includes('.')) return null;
  const match = LABEL.exec(label);
  if (!match) return null;
  // `xn--` and any other label with `--` at the third and fourth characters
  // is reserved for internationalized names; a two letter Bot slug would make one.
  if (match[1]!.length < 3) return null;
  return { botSlug: match[1]!, orgSlug: match[2]! };
}

/** `<bot>--<org>`, or null when it would not fit one DNS label. */
export function hostLabel(botSlug: string, orgSlug: string): string | null {
  const label = `${botSlug}--${orgSlug}`;
  return label.length <= 63 && LABEL.test(label) && botSlug.length >= 3 ? label : null;
}

// --- How each kind is served ---------------------------------------------------

const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const isText = (mime: string) =>
  mime.startsWith('text/') ||
  ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime);

export interface Presentation {
  contentType: string;
  /** `inline` is shown in the tab; `attachment` is a download. */
  disposition: 'inline' | 'attachment';
  /** An HTML page: its scripts may run, in the sandbox. */
  page: boolean;
}

/**
 * What a version is served as. Only a document whose type is HTML is a
 * page. Text of any kind is plain text (Markdown, CSV and code are shown,
 * never run); JSON stays JSON; raster images are images; an SVG design is an
 * image under a CSP that runs no script; everything else, PDFs included, is
 * a download, so no uploaded type becomes active content in the browser.
 */
export function presentation(kind: ArtifactKind, mime: string): Presentation {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const text = (type = 'text/plain'): Presentation => ({
    contentType: `${type}; charset=utf-8`,
    disposition: 'inline',
    page: false,
  });
  const download: Presentation = {
    contentType: 'application/octet-stream',
    disposition: 'attachment',
    page: false,
  };
  switch (kind) {
    case 'document':
      if (base === 'text/html') {
        return { contentType: 'text/html; charset=utf-8', disposition: 'inline', page: true };
      }
      return isText(base) ? text() : download;
    case 'code':
      return isText(base) ? text() : download;
    case 'data':
      if (base === 'application/json') return text('application/json');
      return isText(base) ? text() : download;
    case 'design':
      if (RASTER.has(base)) return { contentType: base, disposition: 'inline', page: false };
      if (base === 'image/svg+xml') {
        return { contentType: base, disposition: 'inline', page: false };
      }
      return isText(base) ? text() : download;
    case 'file':
      if (RASTER.has(base)) return { contentType: base, disposition: 'inline', page: false };
      return isText(base) && base !== 'text/html' ? text() : download;
  }
}

/** A page's scripts run in an opaque origin, with no network and nothing to embed but inline data. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts',
].join('; ');

/** Anything else runs nothing at all. */
export const STATIC_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  'sandbox',
].join('; ');

/** On every answer, a 404 and a redirect included. */
function baseHeaders(): Headers {
  return new Headers({
    'content-security-policy': STATIC_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'strict-transport-security': 'max-age=31536000',
    'cache-control': 'private, no-store',
    vary: 'Cookie',
  });
}

/** The one answer for every Artifact a request may not see, whatever the reason. */
export function notFoundResponse(): Response {
  const headers = baseHeaders();
  headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response('Not found', { status: 404, headers });
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  const headers = baseHeaders();
  headers.set('content-type', 'text/plain; charset=utf-8');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(text, { status, headers });
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function fileName(title: string): string {
  const cleaned = title.replace(/[\\/"\r\n]/g, '_').trim() || 'artifact';
  return encodeURIComponent(cleaned.slice(0, 120));
}

export interface HandleOptions {
  /** The hostname the request came to: the Host header's, or the edge Worker's forwarded one. */
  hostname: string;
  /** The client's address for the rate limit, when known. */
  clientIp: string | null;
}

export async function handleArtifactRequest(
  request: Request,
  deps: ArtifactHostDeps,
  { hostname, clientIp }: HandleOptions,
): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  if (!(await deps.allow(`artifact-host:${clientIp ?? 'unknown'}`))) {
    return plain(429, 'Too many requests', { 'retry-after': '60' });
  }
  const target = parseHostname(hostname, deps.domain);
  if (!target) return notFoundResponse();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
  }
  const url = new URL(request.url);
  const path = ARTIFACT_PATH.exec(url.pathname);
  if (!path) return notFoundResponse();
  const artifactId = path[1]!;
  const bare = `/${artifactId}/`;

  // A token: trade it for the cookie and take it out of the address. Every
  // token, good or bad, ends in the same redirect, so the answer says
  // nothing about the Artifact; only a good one sets the cookie.
  if (url.searchParams.has(TOKEN_PARAM)) {
    const headers = baseHeaders();
    headers.set('location', bare);
    const claims = await verifyClaims(deps.keys.token, url.searchParams.get(TOKEN_PARAM), now);
    if (claims && claims.a === artifactId && (await deps.claim(claims.n))) {
      const viewer = { userId: claims.u, workspaceId: claims.w };
      const view = await deps.resolve({ ...target, artifactId }, viewer);
      view?.discard?.();
      // Public access needs no cookie; only the owner's and members' views get one.
      if (view && view.audience !== 'public') {
        const cookie: ViewClaims = {
          a: artifactId,
          u: claims.u,
          w: claims.w,
          e: now + VIEW_COOKIE_SECONDS * 1000,
          n: newNonce(),
        };
        headers.append(
          'set-cookie',
          `${VIEW_COOKIE}=${await signClaims(deps.keys.cookie, cookie)}; Path=/${artifactId}; Max-Age=${VIEW_COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
        );
      }
    }
    return new Response(null, { status: 303, headers });
  }

  const claims = await verifyClaims(deps.keys.cookie, cookieValue(request, VIEW_COOKIE), now);
  const viewer =
    claims && claims.a === artifactId ? { userId: claims.u, workspaceId: claims.w } : null;
  const view = await deps.resolve({ ...target, artifactId }, viewer);
  if (!view) return notFoundResponse();

  const shown = presentation(view.kind, view.mime);
  const headers = baseHeaders();
  headers.set('content-type', shown.contentType);
  headers.set('content-security-policy', shown.page ? PAGE_CSP : STATIC_CSP);
  headers.set(
    'content-disposition',
    `${shown.disposition}; filename*=UTF-8''${fileName(view.title)}`,
  );
  headers.set('content-length', String(view.size));
  // Only the public version may be kept by a browser or the edge, and only
  // for a minute, so a takedown or a change of visibility lands quickly.
  // The owner's and members' views are never stored anywhere.
  if (view.audience === 'public') headers.set('cache-control', 'public, max-age=60');
  if (request.method === 'HEAD') {
    view.discard?.();
    return new Response(null, { status: 200, headers });
  }
  return new Response(await view.body(), { status: 200, headers });
}
