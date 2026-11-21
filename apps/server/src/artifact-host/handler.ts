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
// - Every answer carries a Content-Security-Policy. Only a document whose
//   type is HTML is a page; everything else is shown as text, an image or a
//   download under a `sandbox` with no script, never as active content
//   (`presentation` below).
// - A page is served in two parts. `/<id>/` is a small wrapper the host
//   writes (`wrapperPage`), which frames `/<id>/content` in an iframe
//   sandboxed to `allow-scripts` alone: the page's scripts run in an opaque
//   origin, cannot read the host's cookie, storage or any response, cannot
//   fetch (`connect-src 'none'`), submit a form (`form-action 'none'`, no
//   `allow-forms`), open a window (no `allow-popups`) or move the tab (no
//   `allow-top-navigation`). The wrapper's `frame-src 'self'` governs
//   every navigation of that frame, so the frame cannot be sent to another
//   site (a script setting `location`, a meta refresh, a plain link): the
//   browser blocks it. The content refuses to be a page of its own: a
//   top-level request for it is sent to the wrapper, and one whose
//   destination the browser does not say gets it with no script at all
//   (`contentPolicy`).
// - A link a person clicks to another site reaches `/<id>/leave`
//   (`leavePage`): the wrapper learns of the blocked navigation from the
//   browser's CSP violation report, never from anything the page's own
//   script says, and only right after the viewer clicked or typed opens the
//   page that shows the whole address and goes there only on another click.
//   That page never redirects, takes only http and https, and answers only a
//   top-level request from this host's own page.
// - A page's scripts are not cut off from the network. Browsers do not block
//   WebRTC or DNS lookups from the frame: in Chromium a script there can send
//   UDP STUN packets to a server it names (`new RTCPeerConnection({iceServers:
//   [{urls: 'stun:host:port'}]})`), and neither `connect-src`, the sandbox
//   flags nor the CSP `webrtc` directive stops it (Chromium does not know that
//   directive; it warns and ignores it, so it is not sent). A scripted
//   Artifact can leak what it contains to a server its author chose.
// - No CORS headers, `nosniff`, `no-referrer`, a same-origin
//   Cross-Origin-Resource-Policy, no framing but the wrapper's own frame,
//   and `noindex` everywhere.
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
const ARTIFACT_PATH =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(content|leave)?)?$/;

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

/**
 * A page's content, in the wrapper's frame: its scripts run in an opaque
 * origin, with no fetch, no frames, no forms and nothing to embed but
 * inline data, and only this host may frame it. They can still reach the
 * network through WebRTC, which no directive here stops (see the top).
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

/** A page's content anywhere but the wrapper's frame: shown, with no script at all. */
const SCRIPTLESS_CONTENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox',
].join('; ');

/** Anything else runs nothing at all. */
export const STATIC_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  'sandbox',
].join('; ');

/**
 * The wrapper's one script. It cannot read the framed page (another
 * origin); it opens the leaving page for an address only when the viewer has
 * just clicked or typed (the browser's user activation, which a script in
 * the frame cannot grant itself). The address comes from one of two places:
 *
 * - The browser's report that the wrapper's `frame-src` blocked a
 *   navigation of the frame. The browser gives the wrapper only the
 *   destination's origin, so the leaving page offers that site's front page
 *   and nothing of the path or query reaches it.
 * - A message from the frame (`LINK_HELPER`, or any script there) naming
 *   the link clicked, so the leaving page can show the whole address. It is
 *   only a claim, shown in full for the viewer to judge; it cannot move the
 *   tab by itself.
 *
 * Without a click, nothing happens: a navigation the frame tries on its own
 * stays blocked. A browser without `navigator.userActivation` cannot say
 * whether the viewer clicked, so there nothing happens either: links that
 * leave the page do nothing.
 */
export const WRAPPER_SCRIPT = `(() => {
  const back = '/' + location.pathname.split('/')[1] + '/';
  const frame = document.querySelector('iframe');
  let leaving = false;
  const leave = (address) => {
    if (leaving) return;
    let to;
    try { to = new URL(address); } catch { return; }
    if (to.protocol !== 'http:' && to.protocol !== 'https:') return;
    if (to.origin === location.origin) return;
    if (!navigator.userActivation || !navigator.userActivation.isActive) return;
    leaving = true;
    location.assign(back + 'leave?to=' + encodeURIComponent(to.href));
  };
  addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data && typeof data.openbotsLink === 'string') leave(data.openbotsLink);
  });
  addEventListener('securitypolicyviolation', (event) => {
    if (event.effectiveDirective === 'frame-src') leave(event.blockedURI);
  });
})();`;

/**
 * Added at the end of a page's content in the wrapper's frame: tells the
 * wrapper which link the viewer clicked, so the leaving page can show its
 * whole address (`WRAPPER_SCRIPT`). It runs beside the page's own scripts
 * and is trusted with nothing; without it a click on a link still reaches
 * the leaving page, with the site's address only, and a link that opens a
 * new tab or the whole tab does nothing. It is added only where it would run
 * as a script (`linkHelperFits`).
 */
export const LINK_HELPER = `<script>addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (link) parent.postMessage({ openbotsLink: link.href }, '*');
}, true);</script>`;

const LINK_HELPER_BYTES = new TextEncoder().encode(`\n${LINK_HELPER}\n`);

/** The largest page the host reads whole to decide whether the link helper fits; a larger one goes without. */
export const LINK_HELPER_MAX_PAGE_BYTES = 1024 * 1024;

/** Elements whose content the browser reads as text, not markup, up to their end tag. */
const TEXT_ELEMENTS = 'script|style|textarea|title|xmp|iframe|noembed|noframes|noscript';
const CLOSED_TEXT_ELEMENT = new RegExp(
  `<(${TEXT_ELEMENTS})(?=[\\s/>])[\\s\\S]*?</\\1(?=[\\s/>])`,
  'g',
);
const OPEN_TEXT_ELEMENT = new RegExp(`<(?:${TEXT_ELEMENTS}|plaintext)(?=[\\s/>]|$)`);

/**
 * Whether `LINK_HELPER`, added after `page`, would run as a script rather
 * than show as text or go unread: the page is not UTF-16 (whose byte order
 * mark the browser obeys over the response's charset) and does not end
 * inside a comment, a tag, `<plaintext>` or an element whose content is text
 * (`<textarea>`, `<title>`, `<xmp>`, `<script>`, `<style>` and the like). A
 * rough reading of the markup, not a parser: when unsure it says no, and the
 * page is served as stored, without the helper.
 */
export function linkHelperFits(page: Uint8Array): boolean {
  if ((page[0] === 0xfe && page[1] === 0xff) || (page[0] === 0xff && page[1] === 0xfe)) {
    return false;
  }
  const markup = new TextDecoder()
    .decode(page)
    .toLowerCase()
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(CLOSED_TEXT_ELEMENT, '');
  if (markup.includes('<!--') || OPEN_TEXT_ELEMENT.test(markup)) return false;
  return markup.lastIndexOf('<') <= markup.lastIndexOf('>');
}

/** `page` and then `tail`, as one array. */
function concat(page: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(page.byteLength + tail.byteLength);
  joined.set(page);
  joined.set(tail, page.byteLength);
  return joined;
}

const WRAPPER_STYLE =
  'html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}';

const LEAVE_STYLE = [
  'body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#111;background:#fff}',
  'main{max-width:40rem;margin:4rem auto;padding:0 1rem}',
  'h1{font-size:1.4rem;margin:0 0 1rem}',
  'code{display:block;padding:.75rem;border:1px solid #ccc;border-radius:6px;background:#f6f6f6;word-break:break-all;white-space:pre-wrap;font-size:.95rem}',
  // A host name has no spaces to wrap at; break it anywhere rather than run off a phone's screen.
  'p.site{font-weight:600;overflow-wrap:anywhere;word-break:break-all}',
  '.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem}',
  '.actions a{padding:.5rem 1rem;border-radius:6px;border:1px solid #111;color:#111;text-decoration:none;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
  '.actions a.go{background:#111;color:#fff}',
  '@media (prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222;border-color:#444}.actions a{border-color:#eee;color:#eee}.actions a.go{background:#eee;color:#111}}',
].join('');

const hashes = new Map<string, Promise<string>>();

/** A CSP source for one inline script or style: its SHA-256, computed once. */
function sha256Source(text: string): Promise<string> {
  let hash = hashes.get(text);
  if (!hash) {
    hash = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(text))
      .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
    hashes.set(text, hash);
  }
  return hash;
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

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
  const part = (path[2] ?? 'page') as 'page' | 'content' | 'leave';
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
  if (part !== 'page' && !shown.page) {
    view.discard?.();
    return notFoundResponse();
  }
  if (part === 'leave') {
    view.discard?.();
    return leavePage(request, url, bare);
  }
  if (part === 'page' && shown.page) {
    view.discard?.();
    return wrapperPage(request, view, artifactId);
  }

  const headers = baseHeaders();
  headers.set('content-type', shown.contentType);
  headers.set('content-security-policy', STATIC_CSP);
  if (part === 'content') {
    const policy = contentPolicy(request);
    if (policy === 'wrapper') {
      // Opened as a page of its own: show it in its wrapper instead.
      view.discard?.();
      headers.set('location', bare);
      return new Response(null, { status: 303, headers });
    }
    headers.set('content-security-policy', policy === 'framed' ? PAGE_CSP : SCRIPTLESS_CONTENT_CSP);
    headers.set('x-frame-options', 'SAMEORIGIN');
    headers.set('vary', 'Cookie, Sec-Fetch-Dest, Sec-Fetch-Site');
  }
  // A page in the wrapper's frame is read whole, when small enough, to tell
  // whether the link helper can go at its end. A HEAD of it reads it too: the
  // length it reports depends on whether the helper fits. Every other HEAD
  // takes its length from the version's row and never opens the blob.
  const page =
    part === 'content' &&
    headers.get('content-security-policy') === PAGE_CSP &&
    view.size <= LINK_HELPER_MAX_PAGE_BYTES
      ? new Uint8Array(await new Response(await view.body()).arrayBuffer())
      : null;
  const served = page && linkHelperFits(page) ? concat(page, LINK_HELPER_BYTES) : page;
  headers.set(
    'content-disposition',
    `${shown.disposition}; filename*=UTF-8''${fileName(view.title)}`,
  );
  headers.set('content-length', String(served ? served.byteLength : view.size));
  // Only the public version may be kept by a browser or the edge, and only
  // for a minute, so a takedown or a change of visibility lands quickly.
  // The owner's and members' views are never stored anywhere.
  if (view.audience === 'public') headers.set('cache-control', 'public, max-age=60');
  if (request.method === 'HEAD') {
    if (!page) view.discard?.();
    return new Response(null, { status: 200, headers });
  }
  return new Response(served ?? (await view.body()), { status: 200, headers });
}

/**
 * How a page's content may be served, from the request's fetch metadata
 * (headers a page cannot set): with its scripts only into a frame on this
 * host (the wrapper's), sent to the wrapper when it is opened as a page of
 * its own, and with no script at all otherwise, including from a browser
 * that sends no such headers. The edge Worker keys its cache by the same
 * three outcomes (`fetchPlace` in apps/artifact-worker, whose test pins it
 * to this).
 */
export function contentPolicy(request: Request): 'framed' | 'wrapper' | 'scriptless' {
  const dest = request.headers.get('sec-fetch-dest');
  const site = request.headers.get('sec-fetch-site');
  if (dest === 'iframe' && site === 'same-origin') return 'framed';
  if (dest === 'document') return 'wrapper';
  return 'scriptless';
}

/** The wrapper the host writes around a page: one sandboxed frame and its own small script. */
async function wrapperPage(
  request: Request,
  view: HostView,
  artifactId: string,
): Promise<Response> {
  const headers = baseHeaders();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set(
    'content-security-policy',
    [
      "default-src 'none'",
      `script-src ${await sha256Source(WRAPPER_SCRIPT)}`,
      `style-src ${await sha256Source(WRAPPER_STYLE)}`,
      "frame-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (view.audience === 'public') headers.set('cache-control', 'public, max-age=60');
  const title = escapeHtml(view.title);
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title><style>${WRAPPER_STYLE}</style></head><body>`,
    `<iframe src="/${artifactId}/content" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${title}"></iframe>`,
    `<script>${WRAPPER_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(html, { status: 200, headers });
}

/** The longest address the leaving page shows. */
const MAX_DESTINATION = 4096;

/**
 * "You are leaving this page": the whole destination, and a link to it that
 * the viewer must click. Never a redirect. Only http and https, with no name
 * or password in the address (`https://bank.example@evil.example`), and only
 * for a top-level request from this host's own page when the browser says
 * where a request came from; anything else is the same 404.
 */
async function leavePage(request: Request, url: URL, back: string): Promise<Response> {
  const dest = request.headers.get('sec-fetch-dest');
  const site = request.headers.get('sec-fetch-site');
  if ((dest !== null && dest !== 'document') || (site !== null && site !== 'same-origin')) {
    return notFoundResponse();
  }
  const given = url.searchParams.get('to') ?? '';
  let to: URL;
  try {
    to = new URL(given);
  } catch {
    return notFoundResponse();
  }
  if (
    (to.protocol !== 'http:' && to.protocol !== 'https:') ||
    to.username ||
    to.password ||
    to.href.length > MAX_DESTINATION
  ) {
    return notFoundResponse();
  }
  const headers = baseHeaders();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set(
    'content-security-policy',
    [
      "default-src 'none'",
      `style-src ${await sha256Source(LEAVE_STYLE)}`,
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  const href = escapeHtml(to.href);
  const host = escapeHtml(to.host);
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>You are leaving this page</title><style>${LEAVE_STYLE}</style></head><body><main>`,
    '<h1>You are leaving this page</h1>',
    '<p>The page you were viewing links to another site. OpenBots does not check that site. Look at the whole address before you go on: anything in it, such as text after a question mark, goes to that site too.</p>',
    `<p class="site">Site: ${host}</p>`,
    `<code>${href}</code>`,
    '<div class="actions">',
    `<a class="go" href="${href}" rel="noopener noreferrer">Continue to ${host}</a>`,
    `<a href="${back}">Go back</a>`,
    '</div></main></body></html>',
  ].join('');
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(html, { status: 200, headers });
}
