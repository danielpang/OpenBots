import { describe, expect, it } from 'vitest';
import {
  handleArtifactRequest,
  hostLabel,
  PAGE_CSP,
  parseHostname,
  presentation,
  STATIC_CSP,
  VIEW_COOKIE,
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
  body?: string;
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
        size: new TextEncoder().encode(body).byteLength,
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

describe('artifact host responses', () => {
  it('sandboxes an HTML page: scripts in an opaque origin, no network, no framing', async () => {
    const deps = fakeDeps({ [ID]: { visibility: 'public', mime: 'text/html', body: '<p>hi</p>' } });
    const res = await serve(deps, `/${ID}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toBe(PAGE_CSP);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''Report%20_Q3_`);
    for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    expect(await res.text()).toBe('<p>hi</p>');
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
