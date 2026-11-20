import { describe, expect, it } from 'vitest';
import {
  handleArtifactRequest,
  hostLabel,
  LINK_HELPER,
  LINK_HELPER_MAX_PAGE_BYTES,
  PAGE_CSP,
  parseHostname,
  presentation,
  STATIC_CSP,
  VIEW_COOKIE,
  WRAPPER_SCRIPT,
  type ArtifactHostDeps,
  type ArtifactKind,
  type HostView,
  type Viewer,
} from './handler.js';
import { newNonce, signClaims, verifyClaims, type ViewClaims } from './tokens.js';

// The artifact host's handler on its own (plan 21.11): hostnames, what each
// kind is served as, the headers, the token exchange, expiry, caching and the
// rate limit, with its lookups faked. The rules behind `resolve` are tested
// against the database in routes/artifact-sharing.test.ts.

const DOMAIN = 'openbots-artifacts.test';
const HOST = `writer-1a2b3c4d--acme-0f0f0f0f.${DOMAIN}`;
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';

const keys = {
  token: crypto.getRandomValues(new Uint8Array(32)),
  cookie: crypto.getRandomValues(new Uint8Array(32)),
};

interface Fixture {
  kind?: ArtifactKind;
  mime?: string;
  body?: string | Uint8Array;
  visibility?: 'private' | 'org' | 'public';
}

function fakeDeps(fixtures: Record<string, Fixture>, now = () => Date.now(), limit = 1_000) {
  const claimed = new Set<string>();
  const hits = new Map<string, number>();
  const deps: ArtifactHostDeps = {
    domain: DOMAIN,
    keys,
    now,
    async resolve(target, viewer: Viewer | null): Promise<HostView | null> {
      if (target.botSlug !== 'writer-1a2b3c4d' || target.orgSlug !== 'acme-0f0f0f0f') return null;
      const f = fixtures[target.artifactId];
      if (!f) return null;
      const owner = viewer?.userId === ALICE && viewer.workspaceId === ORG;
      if (!owner && f.visibility !== 'public') return null;
      const body = f.body ?? 'hello';
      return {
        audience: owner ? 'owner' : 'public',
        artifactId: target.artifactId,
        kind: f.kind ?? 'document',
        title: 'Report "Q3"',
        version: 1,
        mime: f.mime ?? 'text/plain',
        size:
          typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength,
        body: async () => new Response(body).body!,
      };
    },
    async allow(key) {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return hits.get(key)! <= limit;
    },
    async claim(nonce) {
      if (claimed.has(nonce)) return false;
      claimed.add(nonce);
      return true;
    },
  };
  return deps;
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://${HOST}${path}`, init);

const serve = (deps: ArtifactHostDeps, path: string, init: RequestInit = {}, ip = '198.51.100.7') =>
  handleArtifactRequest(request(path, init), deps, { hostname: HOST, clientIp: ip });

const token = (claims: Partial<ViewClaims> = {}) =>
  signClaims(keys.token, {
    a: ID,
    u: ALICE,
    w: ORG,
    e: Date.now() + 60_000,
    n: newNonce(),
    ...claims,
  });

describe('artifact host hostnames', () => {
  it('reads exactly one <bot>--<org> label under the domain', () => {
    expect(parseHostname(HOST, DOMAIN)).toEqual({
      botSlug: 'writer-1a2b3c4d',
      orgSlug: 'acme-0f0f0f0f',
    });
    expect(parseHostname(HOST.toUpperCase(), DOMAIN)).not.toBeNull();
    expect(parseHostname(`${HOST}.`, DOMAIN)).not.toBeNull();
    for (const bad of [
      DOMAIN,
      `writer.${DOMAIN}`,
      `a.${HOST}`,
      `writer--acme.evil.test`,
      `writer--acme.${DOMAIN}.evil.test`,
      `writer---acme.${DOMAIN}`,
      `writer--acme--x.${DOMAIN}`,
      `-writer--acme.${DOMAIN}`,
      `writer--acme-.${DOMAIN}`,
      `writer_x--acme.${DOMAIN}`,
      `xn--acme.${DOMAIN}`,
      `ab--acme.${DOMAIN}`,
      `${'a'.repeat(40)}--${'b'.repeat(22)}.${DOMAIN}`,
      `writer--acme.x${DOMAIN}`,
    ]) {
      expect(parseHostname(bad, DOMAIN), bad).toBeNull();
    }
  });

  it('builds a label only when it fits one DNS label', () => {
    expect(hostLabel('writer-1a2b3c4d', 'acme-0f0f0f0f')).toBe('writer-1a2b3c4d--acme-0f0f0f0f');
    expect(hostLabel('a'.repeat(40), 'b'.repeat(22))).toBeNull();
    expect(hostLabel('ab', 'acme')).toBeNull();
  });
});

describe('what each kind is served as', () => {
  it.each<[ArtifactKind, string, string, 'inline' | 'attachment', boolean]>([
    ['document', 'text/html', 'text/html; charset=utf-8', 'inline', true],
    ['document', 'text/markdown', 'text/plain; charset=utf-8', 'inline', false],
    ['document', 'application/pdf', 'application/octet-stream', 'attachment', false],
    ['code', 'text/html', 'text/plain; charset=utf-8', 'inline', false],
    ['code', 'text/javascript', 'text/plain; charset=utf-8', 'inline', false],
    ['code', 'image/svg+xml', 'application/octet-stream', 'attachment', false],
    ['data', 'application/json', 'application/json; charset=utf-8', 'inline', false],
    ['data', 'text/csv', 'text/plain; charset=utf-8', 'inline', false],
    ['design', 'image/png', 'image/png', 'inline', false],
    ['design', 'image/svg+xml', 'image/svg+xml', 'inline', false],
    ['design', 'text/html', 'text/plain; charset=utf-8', 'inline', false],
    ['file', 'image/jpeg', 'image/jpeg', 'inline', false],
    ['file', 'text/html', 'application/octet-stream', 'attachment', false],
    ['file', 'application/pdf', 'application/octet-stream', 'attachment', false],
    ['file', 'image/svg+xml', 'application/octet-stream', 'attachment', false],
    ['file', 'application/zip', 'application/octet-stream', 'attachment', false],
  ])('%s %s is %s, %s', (kind, mime, type, disposition, page) => {
    expect(presentation(kind, mime)).toEqual({ contentType: type, disposition, page });
  });
});

/**
 * Runs the wrapper's script against a stand-in browser: `activation` is
 * `navigator.userActivation` (undefined where the browser has none).
 * Returns what it would send the tab to, and how to deliver events to it.
 */
function runWrapperScript(activation: { isActive: boolean } | undefined) {
  const frame = { contentWindow: {} };
  const listeners = new Map<string, (event: unknown) => void>();
  const assigned: string[] = [];
  const location = {
    pathname: `/${ID}/`,
    origin: `https://${HOST}`,
    assign: (to: string) => assigned.push(to),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('location', 'document', 'navigator', 'addEventListener', WRAPPER_SCRIPT)(
    location,
    { querySelector: (selector: string) => (selector === 'iframe' ? frame : null) },
    activation === undefined ? {} : { userActivation: activation },
    (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
  );
  return {
    assigned,
    message: (link: string) =>
      listeners.get('message')!({ source: frame.contentWindow, data: { openbotsLink: link } }),
    blocked: (uri: string) =>
      listeners.get('securitypolicyviolation')!({
        effectiveDirective: 'frame-src',
        blockedURI: uri,
      }),
  };
}

describe("the wrapper's script", () => {
  const leaveTo = (to: string) => `/${ID}/leave?to=${encodeURIComponent(to)}`;

  it('opens the leaving page right after the viewer clicked', () => {
    const wrapper = runWrapperScript({ isActive: true });
    wrapper.message('https://example.com/a?b=1');
    expect(wrapper.assigned).toEqual([leaveTo('https://example.com/a?b=1')]);
  });

  it('does nothing when the viewer did not just click', () => {
    const wrapper = runWrapperScript({ isActive: false });
    wrapper.message('https://example.com/a');
    wrapper.blocked('https://example.com');
    expect(wrapper.assigned).toEqual([]);
  });

  it('does nothing in a browser that cannot say whether the viewer clicked', () => {
    // Without user activation to ask, a message or a blocked navigation the
    // page made on its own would look the same as a click.
    const wrapper = runWrapperScript(undefined);
    wrapper.message('https://example.com/a');
    wrapper.blocked('https://example.com');
    expect(wrapper.assigned).toEqual([]);
  });
});

describe('artifact host responses', () => {
  it('serves an HTML page as a small wrapper that frames it in a sandbox', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/html', body: '<p>hi</p>' } });
    const res = await serve(deps, `/${ID}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = res.headers.get('content-security-policy')!;
    // The wrapper runs only its own script, frames only this host, and is framed by nobody.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    const html = await res.text();
    expect(html).not.toContain('<p>hi</p>');
    // No allow-same-origin, no top navigation, no popups, no forms.
    expect(html).toContain(
      `<iframe src="/${ID}/content" sandbox="allow-scripts" referrerpolicy="no-referrer"`,
    );
    expect(html).toContain('<title>Report &quot;Q3&quot;</title>');
    expect(html).toContain(WRAPPER_SCRIPT);
    const hash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(WRAPPER_SCRIPT)),
    ).toString('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it('escapes the title in the wrapper', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/html' } });
    const evil = {
      ...deps,
      resolve: async (...args: Parameters<ArtifactHostDeps['resolve']>) => {
        const view = await deps.resolve(...args);
        return view && { ...view, title: '</title><script>alert(1)</script>' };
      },
    };
    const html = await (await serve(evil, `/${ID}/`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('adds the link helper only where it would run as a script', async () => {
    const framed = async (body: string | Uint8Array) => {
      const res = await serve(
        fakeDeps({ [ID]: { visibility: 'public', mime: 'text/html', body } }),
        `/${ID}/content`,
        { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' } },
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Number(res.headers.get('content-length'))).toBe(bytes.byteLength);
      return bytes;
    };
    const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    // A page that ends as most do gets it.
    for (const body of [
      '<p>hi</p>',
      '<!doctype html><title>x</title><textarea>a</textarea><p>done',
      '<script>let a = "<title>";</script><p>done</p>',
      '<!-- note --><p>done</p>',
      '\uFEFF<p>UTF-8, with its byte order mark</p>',
    ]) {
      expect(text(await framed(body)), body).toBe(`${body}\n${LINK_HELPER}\n`);
    }
    // One that ends where the browser would show it as text, or not run it,
    // is served as stored.
    for (const body of [
      '<p>notes</p><textarea>unfinished',
      '<title>unfinished',
      '<TITLE >unfinished',
      '<xmp>unfinished',
      '<plaintext>everything after this is text</plaintext><p>still text',
      '<style>p{color:red}',
      '<script>let a = 1;',
      '<p>hi</p><!-- unfinished',
      '<p title="unfinished',
    ]) {
      expect(text(await framed(body)), body).toBe(body);
    }
    // So is a page in UTF-16, which says so with its byte order mark.
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...[...'<p>hi</p>'].flatMap((c) => [c.charCodeAt(0), 0]),
    ]);
    expect(await framed(utf16)).toEqual(utf16);
    const utf16be = new Uint8Array([
      0xfe,
      0xff,
      ...[...'<p>hi</p>'].flatMap((c) => [0, c.charCodeAt(0)]),
    ]);
    expect(await framed(utf16be)).toEqual(utf16be);
    // And one too large to read whole first.
    const large = `<p>${'a'.repeat(LINK_HELPER_MAX_PAGE_BYTES)}</p>`;
    expect(text(await framed(large))).toBe(large);
  });

  it("serves the page itself only into the wrapper's frame, sandboxed with no fetch", async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/html', body: '<p>hi</p>' } });
    const framed = await serve(deps, `/${ID}/content`, {
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
    });
    expect(framed.status).toBe(200);
    // The page as stored, then the link helper (a convenience the page could equally fake).
    const body = await framed.text();
    expect(body).toBe(`<p>hi</p>\n${LINK_HELPER}\n`);
    expect(Number(framed.headers.get('content-length'))).toBe(
      new TextEncoder().encode(body).byteLength,
    );
    const csp = framed.headers.get('content-security-policy')!;
    expect(csp).toBe(PAGE_CSP);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
    expect(csp).not.toContain('allow-popups');
    expect(csp).not.toContain('allow-forms');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'none'");
    // Framed by the wrapper on this host only.
    expect(csp).toContain("frame-ancestors 'self'");
    expect(framed.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(framed.headers.get('vary')).toMatch(/Sec-Fetch-Dest/);
    expect(framed.headers.get('content-disposition')).toBe(
      `inline; filename*=UTF-8''Report%20_Q3_`,
    );

    // Opened as a page of its own, it sends the browser to the wrapper instead.
    const top = await serve(deps, `/${ID}/content`, {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
    });
    expect(top.status).toBe(303);
    expect(top.headers.get('location')).toBe(`/${ID}/`);
    expect(top.body).toBeNull();

    // Without the browser's word for where it goes (an old browser, a script),
    // or framed by anything but this host, it is served with no script at all.
    for (const headers of [
      {},
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'object' },
      { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' },
    ] as Record<string, string>[]) {
      const res = await serve(deps, `/${ID}/content`, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
      expect(await res.text()).toBe('<p>hi</p>');
      const scriptless = res.headers.get('content-security-policy')!;
      expect(scriptless).toMatch(/; sandbox$/);
      expect(scriptless).not.toContain('script-src');
      expect(scriptless).toContain("frame-ancestors 'self'");
    }
  });

  it('has no content path for anything that is not a page', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/plain' } });
    const res = await serve(deps, `/${ID}/content`, {
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('runs nothing in anything that is not a page', async () => {
    const deps = fakeDeps({
      [ID]: { visibility: 'public', kind: 'design', mime: 'image/svg+xml', body: '<svg/>' },
    });
    const res = await serve(deps, `/${ID}`);
    expect(res.headers.get('content-security-policy')).toBe(STATIC_CSP);
    expect(STATIC_CSP).toMatch(/sandbox$/);
    expect(STATIC_CSP).not.toContain('script-src');
  });

  it('lets only the public version be cached, for a minute, and never a private view', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public' }, [OTHER]: { visibility: 'private' } });
    expect((await serve(deps, `/${ID}/`)).headers.get('cache-control')).toBe('public, max-age=60');
    const cookie = await signClaims(keys.cookie, {
      a: OTHER,
      u: ALICE,
      w: ORG,
      e: Date.now() + 60_000,
      n: newNonce(),
    });
    const own = await serve(deps, `/${OTHER}/`, {
      headers: { cookie: `${VIEW_COOKIE}=${cookie}` },
    });
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('private, no-store');
    expect((await serve(deps, `/${OTHER}/`)).headers.get('cache-control')).toBe(
      'private, no-store',
    );
  });

  it('answers HEAD without a body, and refuses other methods', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public' } });
    const head = await serve(deps, `/${ID}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect((await serve(deps, `/${ID}/`, { method: 'POST', body: 'x' })).status).toBe(405);
  });
});

describe('the view token and cookie', () => {
  it('trades a token for a cookie on that path and redirects it out of the address', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'private' } });
    const res = await serve(deps, `/${ID}?token=${await token()}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/${ID}/`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(
      new RegExp(
        `^${VIEW_COOKIE}=[^;]+; Path=/${ID}; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$`,
      ),
    );
    const page = await serve(deps, `/${ID}/`, { headers: { cookie: set.split(';')[0]! } });
    expect(page.status).toBe(200);
  });

  it("sets nothing for an expired, forged, reused or other Artifact's token, with the same redirect", async () => {
    let clock = Date.now();
    const deps = fakeDeps({ [ID]: { visibility: 'private' } }, () => clock);
    const expired = await token({ e: clock + 1_000 });
    const forged = await signClaims(keys.cookie, {
      a: ID,
      u: ALICE,
      w: ORG,
      e: clock + 60_000,
      n: newNonce(),
    });
    const other = await token({ a: OTHER });
    const once = await token();
    expect((await serve(deps, `/${ID}?token=${once}`)).headers.get('set-cookie')).not.toBeNull();
    clock += 2_000;
    for (const value of [expired, forged, other, once, 'garbage', `${once}x`]) {
      const res = await serve(deps, `/${ID}?token=${encodeURIComponent(value)}`);
      expect(res.status, value).toBe(303);
      expect(res.headers.get('location')).toBe(`/${ID}/`);
      expect(res.headers.get('set-cookie'), value).toBeNull();
    }
  });

  it('keeps a cookie to its Artifact and its expiry', async () => {
    let clock = Date.now();
    const deps = fakeDeps(
      { [ID]: { visibility: 'private' }, [OTHER]: { visibility: 'private' } },
      () => clock,
    );
    const set = (await serve(deps, `/${ID}?token=${await token()}`)).headers.get('set-cookie')!;
    const cookie = { cookie: set.split(';')[0]! };
    expect((await serve(deps, `/${ID}/`, { headers: cookie })).status).toBe(200);
    expect((await serve(deps, `/${OTHER}/`, { headers: cookie })).status).toBe(404);
    // A token is not a cookie, and a cookie is not a token: their keys differ.
    const asCookie = { cookie: `${VIEW_COOKIE}=${await token()}` };
    expect((await serve(deps, `/${ID}/`, { headers: asCookie })).status).toBe(404);
    clock += 31 * 60_000;
    expect((await serve(deps, `/${ID}/`, { headers: cookie })).status).toBe(404);
  });

  it('verifies claims in constant shape: tampering with the payload fails', async () => {
    const value = await token();
    const [payload, mac] = value.split('.') as [string, string];
    const tampered = `${payload.slice(0, -2)}AA.${mac}`;
    expect(await verifyClaims(keys.token, tampered)).toBeNull();
    expect(await verifyClaims(keys.token, value)).toMatchObject({ a: ID, u: ALICE, w: ORG });
  });
});

describe('the rate limit', () => {
  it('answers 429 past the limit for a client address, before any lookup', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public' } }, undefined, 5);
    for (let i = 0; i < 5; i++) expect((await serve(deps, `/${ID}/`)).status).toBe(200);
    const limited = await serve(deps, `/${ID}/`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // Another address is not held back.
    expect((await serve(deps, `/${ID}/`, {}, '203.0.113.9')).status).toBe(200);
  });
});

describe('leaving an Artifact page', () => {
  const page = () =>
    fakeDeps({
      [ID]: {
        visibility: 'public',
        mime: 'text/html',
        body: '<a href="https://example.com">x</a>',
      },
      [OTHER]: { visibility: 'private', mime: 'text/html' },
    });
  const fromPage = { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
  const leave = (deps: ArtifactHostDeps, to: string, headers: Record<string, string> = fromPage) =>
    serve(deps, `/${ID}/leave?to=${encodeURIComponent(to)}`, { headers });

  it('shows the whole destination and goes there only on a click', async () => {
    const res = await leave(page(), 'https://example.com/path?d=secret#frag');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('refresh')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('You are leaving this page');
    expect(html).toContain('<code>https://example.com/path?d=secret#frag</code>');
    expect(html).toContain('example.com');
    expect(html).toContain(
      '<a class="go" href="https://example.com/path?d=secret#frag" rel="noopener noreferrer">',
    );
    expect(html).toContain(`<a href="/${ID}/">`);
    expect(html).not.toMatch(/<script|http-equiv/i);
  });

  it('shows an internationalized host as the browser would send it', async () => {
    const html = await (await leave(page(), 'https://еxample.com/')).text();
    expect(html).toContain('https://xn--xample-2of.com/');
  });

  it('escapes what it shows', async () => {
    // The URL parser percent-encodes `"`, `<` and `>`, so this cannot reach the page as markup...
    const html = await (
      await leave(page(), 'https://evil.example/"><script>alert(1)</script>')
    ).text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><script');
    // ...but it keeps `&` and `'` as they are. Unescaped, `&lt;` would show
    // as `<` and the link would lead to an address other than the one given.
    const to = "https://evil.example/it's?q=&lt;b&gt;&amp;x";
    expect(new URL(to).href).toBe(to);
    const shown = await (await leave(page(), to)).text();
    const escaped = 'https://evil.example/it&#39;s?q=&amp;lt;b&amp;gt;&amp;amp;x';
    expect(shown).toContain(`<code>${escaped}</code>`);
    expect(shown).toContain(`href="${escaped}"`);
    expect(shown).not.toContain('q=&lt;b');
  });

  it('wraps a long site name instead of running off a narrow screen', async () => {
    const long = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example/`;
    const res = await leave(page(), long);
    const html = await res.text();
    const style = /<style>([^<]*)<\/style>/.exec(html)![1]!;
    // Checked at phone width in Chromium too; here, that the rules are there and allowed.
    expect(style).toMatch(/p\.site\{[^}]*overflow-wrap:anywhere/);
    expect(style).toMatch(/\.actions a\{[^}]*overflow-wrap:anywhere/);
    const hash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style)),
    ).toString('base64');
    expect(res.headers.get('content-security-policy')).toContain(`style-src 'sha256-${hash}'`);
  });

  it('allows only http and https, with no name or password in the address', async () => {
    for (const to of [
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'file:///etc/passwd',
      'ftp://example.com/',
      'https://bank.example@evil.example/',
      'https://user:pass@evil.example/',
      'not a url',
      '',
      `https://example.com/${'a'.repeat(5000)}`,
    ]) {
      const res = await leave(page(), to);
      expect(res.status, to).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
    expect((await serve(page(), `/${ID}/leave`, { headers: fromPage })).status).toBe(404);
  });

  it('is not served to a request that did not come from the Artifact page', async () => {
    const deps = page();
    // A link elsewhere (another site, a typed or emailed address), or anything but a top-level page.
    for (const headers of [
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' },
    ]) {
      expect(
        (await leave(deps, 'https://example.com/', headers)).status,
        JSON.stringify(headers),
      ).toBe(404);
    }
    // A browser that sends no such headers cannot be told apart; it still needs the click.
    expect((await leave(deps, 'https://example.com/', {})).status).toBe(200);
  });

  it('is only for an Artifact page the viewer may see', async () => {
    const deps = page();
    const res = await serve(
      deps,
      `/${OTHER}/leave?to=${encodeURIComponent('https://example.com/')}`,
      {
        headers: fromPage,
      },
    );
    expect(res.status).toBe(404);
    const text = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/plain' } });
    expect((await leave(text, 'https://example.com/')).status).toBe(404);
  });
});
