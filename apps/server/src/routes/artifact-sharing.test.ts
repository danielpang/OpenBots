import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createArtifact, writeArtifact } from '../services/artifacts.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

// Sharing an Artifact (plan 21.11) through the core routes, with the
// artifact host mounted by the Host header: who may change it, who sees
// which version, the organization's switch, suspension, and the audit log.

const DOMAIN = 'openbots-artifacts.test';

interface Sharing {
  visibility: 'private' | 'org' | 'public';
  currentVersion: number | null;
  publicVersion: number | null;
  publicAllowed: boolean;
  takenDown: boolean;
  url: string | null;
  pendingRequest: unknown;
}

describe('sharing Artifacts (plan 21.11)', () => {
  let t: TestApp;
  let workspaceId: string;
  let alice: string;
  let carol: string;
  let dave: string;
  let aliceId: string;
  let daveId: string;
  let botId: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: DOMAIN,
    });
    workspaceId = await t.defaultOrganization();
    alice = (await t.signUp('alice@example.com')).cookie!; // the owner of the organization
    carol = (await t.signUp('carol@example.com')).cookie!; // a member
    dave = (await t.signUp('dave@example.com')).cookie!; // a member, suspended later
    aliceId = await t.userId('alice@example.com');
    daveId = await t.userId('dave@example.com');
    const res = await call(alice, 'POST', '/bots', { name: 'Writer' });
    botId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as T;
  }

  async function newArtifact(title = 'Plan', content = 'v1 text', kind = 'document' as const) {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: aliceId, workspaceId },
      { title, kind, botId, content },
      { userId: aliceId },
    );
    return artifact.id;
  }

  const edit = (id: string, content: string) =>
    writeArtifact(t.ownerDeps, { id: aliceId, workspaceId }, id, { content }, { userId: aliceId });

  /** A request to the artifact host, as a browser on the link would send it. */
  function host(url: string, cookie?: string) {
    const parsed = new URL(url);
    return t.app.request(`${parsed.pathname}${parsed.search}`, {
      headers: { host: parsed.host, ...(cookie ? { cookie } : {}) },
    });
  }

  /** Opens an Artifact on the host as `cookie`'s user: the token, then the cookie it is traded for. */
  async function openAs(cookie: string, id: string) {
    const link = await json<{ url: string }>(call(cookie, 'POST', `/artifacts/${id}/open`));
    const traded = await host(link.url);
    expect(traded.status).toBe(303);
    const set = traded.headers.get('set-cookie');
    return { link, traded, viewCookie: set ? set.split(';')[0]! : undefined };
  }

  const share = (cookie: string, id: string, body: unknown) =>
    call(cookie, 'PUT', `/artifacts/${id}/sharing`, body);

  it('keeps a new Artifact private, with its link on its own Bot subdomain', async () => {
    const id = await newArtifact();
    const sharing = await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`));
    expect(sharing).toMatchObject({
      visibility: 'private',
      currentVersion: 1,
      publicVersion: null,
      publicAllowed: true,
      takenDown: false,
      pendingRequest: null,
    });
    const [bot] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, botId));
    const [org] = await t.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect(bot!.publicSlug).toMatch(/^writer-[0-9a-f]{8}$/);
    expect(sharing.url).toBe(`http://${bot!.publicSlug}--${org!.slug}.${DOMAIN}/${id}/`);
    const artifact = await json<{ visibility: string }>(call(alice, 'GET', `/artifacts/${id}`));
    expect(artifact.visibility).toBe('private');
    // Nobody else sees it, in the app or on the host.
    expect(
      (await json<{ items: unknown[] }>(call(carol, 'GET', '/shared-artifacts'))).items,
    ).toEqual([]);
    expect((await call(carol, 'GET', `/shared-artifacts/${id}`)).status).toBe(404);
    expect((await call(carol, 'POST', `/artifacts/${id}/open`)).status).toBe(404);
    expect((await host(sharing.url!)).status).toBe(404);
  });

  it('shares with the organization at the latest version, read only, and audits it', async () => {
    const id = await newArtifact('Roadmap', 'first');
    const shared = await json<Sharing>(share(alice, id, { visibility: 'org' }));
    expect(shared.visibility).toBe('org');

    const list = await json<{
      items: { id: string; version: { version: number }; ownerName: string; mine: boolean }[];
    }>(call(carol, 'GET', '/shared-artifacts'));
    expect(list.items.find((i) => i.id === id)).toMatchObject({
      version: { version: 1 },
      ownerName: 'alice',
      mine: false,
    });
    await edit(id, 'second');
    const one = await json<{ version: { version: number } }>(
      call(carol, 'GET', `/shared-artifacts/${id}`),
    );
    expect(one.version.version).toBe(2);
    const content = await call(carol, 'GET', `/shared-artifacts/${id}/content`);
    expect(await content.text()).toBe('second');
    expect(content.headers.get('content-security-policy')).toContain('sandbox');

    // Read only, and nothing else of Alice's comes with it.
    expect((await call(carol, 'GET', `/artifacts/${id}`)).status).toBe(404);
    expect((await call(carol, 'GET', `/artifacts/${id}/versions`)).status).toBe(404);
    expect((await call(carol, 'GET', `/artifacts/${id}/sharing`)).status).toBe(404);
    expect((await call(carol, 'PUT', `/artifacts/${id}`, { content: 'x' })).status).toBe(404);
    expect((await share(carol, id, { visibility: 'private' })).status).toBe(404);
    expect((await call(carol, 'GET', `/bots/${botId}`)).status).toBe(404);
    expect((await call(carol, 'GET', `/bots/${botId}/artifacts`)).status).toBe(404);

    // On the host: a member's token opens it at the latest version.
    const { viewCookie } = await openAs(carol, id);
    expect(viewCookie).toBeDefined();
    const page = await host(shared.url!, viewCookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('second');
    expect(page.headers.get('cache-control')).toBe('private, no-store');

    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'artifact.visibility'), eq(schema.auditLog.targetId, id)),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'user',
      actorId: aliceId,
      metadata: { from: 'private', to: 'org' },
    });
  });

  it('makes public only the version a person confirmed, until they confirm again', async () => {
    const id = await newArtifact('Launch', 'draft one');
    await edit(id, 'draft two');
    expect(
      (await json<{ code: string }>(share(alice, id, { visibility: 'public', version: 2 }), 400))
        .code,
    ).toBe('CONFIRMATION_REQUIRED');
    expect(
      (
        await json<{ code: string }>(
          share(alice, id, { visibility: 'public', version: 1, confirmed: true }),
          409,
        )
      ).code,
    ).toBe('VERSION_CONFLICT');
    const shared = await json<Sharing>(
      share(alice, id, { visibility: 'public', version: 2, confirmed: true }),
    );
    expect(shared).toMatchObject({ visibility: 'public', publicVersion: 2, currentVersion: 2 });

    // The Bot keeps editing: the link still shows the confirmed version.
    await edit(id, 'draft three');
    const anyone = await host(shared.url!);
    expect(anyone.status).toBe(200);
    expect(await anyone.text()).toBe('draft two');
    expect(anyone.headers.get('cache-control')).toBe('public, max-age=60');
    // Members see what anyone sees: the confirmed version, not the newer one.
    const asMember = await json<{ version: { version: number } }>(
      call(carol, 'GET', `/shared-artifacts/${id}`),
    );
    expect(asMember.version.version).toBe(2);
    const state = await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`));
    expect(state).toMatchObject({ publicVersion: 2, currentVersion: 3 });
    // Her own list shows it as others see it.
    const own = await json<{ items: { id: string; version: { version: number } }[] }>(
      call(alice, 'GET', '/shared-artifacts'),
    );
    expect(own.items.find((i) => i.id === id)!.version.version).toBe(2);

    // "Update the public version": the same confirmation, for the current version.
    await json<Sharing>(share(alice, id, { visibility: 'public', version: 3, confirmed: true }));
    expect(await (await host(shared.url!)).text()).toBe('draft three');

    // Back to the organization forgets the confirmed version.
    const back = await json<Sharing>(share(alice, id, { visibility: 'org' }));
    expect(back.publicVersion).toBeNull();
    expect((await host(shared.url!)).status).toBe(404);
    const [row] = await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row!.publicVersionId).toBeNull();
    const audit = await t.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'artifact.visibility'), eq(schema.auditLog.targetId, id)),
      );
    expect(audit.map((a) => a.metadata)).toEqual([
      { from: 'private', to: 'public', version: 2 },
      { from: 'public', to: 'public', fromVersion: 2, version: 3 },
      { from: 'public', to: 'org', fromVersion: 3 },
    ]);
  });

  it('lets an API key narrow what is shared but never widen it', async () => {
    const id = await newArtifact('Keys');
    const key = await json<{ key: string }>(
      call(alice, 'POST', '/api-keys', { name: 'script' }),
      201,
    );
    const bearer = (method: string, body: unknown) =>
      t.app.request(`/api/v1/artifacts/${id}/sharing`, {
        method,
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await json<{ code: string }>(bearer('PUT', { visibility: 'org' }), 403)).code).toBe(
      'PERSON_REQUIRED',
    );
    expect(
      (
        await json<{ code: string }>(
          bearer('PUT', { visibility: 'public', version: 1, confirmed: true }),
          403,
        )
      ).code,
    ).toBe('PERSON_REQUIRED');
    await json<Sharing>(share(alice, id, { visibility: 'org' }));
    expect((await json<Sharing>(bearer('PUT', { visibility: 'private' }))).visibility).toBe(
      'private',
    );
  });

  it('lets owners and admins turn public links off, which stops existing ones', async () => {
    const id = await newArtifact('Public notes', 'hello world');
    const shared = await json<Sharing>(
      share(alice, id, { visibility: 'public', version: 1, confirmed: true }),
    );
    expect((await host(shared.url!)).status).toBe(200);
    // A member may not change it.
    expect(
      (await call(carol, 'PATCH', '/settings', { publicArtifactsEnabled: false })).status,
    ).toBe(403);
    const off = await json<{ publicArtifactsEnabled: boolean }>(
      call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: false }),
    );
    expect(off.publicArtifactsEnabled).toBe(false);
    expect((await host(shared.url!)).status).toBe(404);
    expect((await call(carol, 'GET', `/shared-artifacts/${id}`)).status).toBe(404);
    const other = await newArtifact('Another');
    expect(
      (
        await json<{ code: string }>(
          share(alice, other, { visibility: 'public', version: 1, confirmed: true }),
          403,
        )
      ).code,
    ).toBe('PUBLIC_SHARING_OFF');
    const state = await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`));
    expect(state).toMatchObject({ visibility: 'public', publicAllowed: false });
    // On again: the link works again, at the version confirmed before.
    await json(call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: true }));
    expect(await (await host(shared.url!)).text()).toBe('hello world');
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'));
    expect(audit.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([{ publicArtifactsEnabled: false }, { publicArtifactsEnabled: true }]),
    );
  });

  it("takes a suspended member's access away, and stops serving what a suspended owner shared", async () => {
    const id = await newArtifact('Team doc', 'team text');
    const shared = await json<Sharing>(share(alice, id, { visibility: 'org' }));
    const { viewCookie } = await openAs(dave, id);
    expect((await host(shared.url!, viewCookie)).status).toBe(200);
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, daveId));
    // The cookie he holds stops working at once; the app refuses him too.
    expect((await host(shared.url!, viewCookie)).status).toBe(404);
    expect((await call(dave, 'GET', '/shared-artifacts')).status).toBe(403);
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: null })
      .where(eq(schema.workspaceMembers.userId, daveId));

    // Alice is suspended: neither her organization Artifact nor her public one is served.
    const pub = await newArtifact('Public while suspended', 'pub');
    const pubShared = await json<Sharing>(
      share(alice, pub, { visibility: 'public', version: 1, confirmed: true }),
    );
    const carolView = await openAs(carol, id);
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, aliceId));
    try {
      expect((await host(shared.url!, carolView.viewCookie)).status).toBe(404);
      expect((await host(pubShared.url!)).status).toBe(404);
      const list = await json<{ items: { id: string }[] }>(call(carol, 'GET', '/shared-artifacts'));
      expect(list.items.map((i) => i.id)).not.toContain(id);
      expect(list.items.map((i) => i.id)).not.toContain(pub);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, aliceId));
    }
    expect((await host(pubShared.url!)).status).toBe(200);
  });

  it('refuses public again after the operator took the link down', async () => {
    const id = await newArtifact('Phish', '<p>log in</p>');
    const shared = await json<Sharing>(
      share(alice, id, { visibility: 'public', version: 1, confirmed: true }),
    );
    await t.db
      .update(schema.artifacts)
      .set({ takenDownAt: new Date() })
      .where(eq(schema.artifacts.id, id));
    expect((await host(shared.url!)).status).toBe(404);
    await json(share(alice, id, { visibility: 'private' }));
    expect(
      (
        await json<{ code: string }>(
          share(alice, id, { visibility: 'public', version: 1, confirmed: true }),
          409,
        )
      ).code,
    ).toBe('TAKEN_DOWN');
    expect((await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`))).takenDown).toBe(
      true,
    );
  });

  it("opens an owner's private Artifact on the host with a token for that Artifact only", async () => {
    const mine = await newArtifact('Mine', 'mine text');
    const other = await newArtifact('Other', 'other text');
    const { link, traded, viewCookie } = await openAs(alice, mine);
    expect(link.url).toMatch(/\?token=/);
    expect(traded.headers.get('location')).toBe(`/${mine}/`);
    expect(traded.headers.get('referrer-policy')).toBe('no-referrer');
    const setCookie = traded.headers.get('set-cookie')!;
    expect(setCookie).toContain(`Path=/${mine}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
    expect(await (await host(new URL(link.url).origin + `/${mine}/`, viewCookie)).text()).toBe(
      'mine text',
    );
    // The same cookie on the same Bot's subdomain does not open another Artifact.
    const otherUrl = `${new URL(link.url).origin}/${other}/`;
    expect((await host(otherUrl, viewCookie)).status).toBe(404);
    // Nor does the token: used on another Artifact's path it sets nothing.
    const fresh = await json<{ url: string }>(call(alice, 'POST', `/artifacts/${mine}/open`));
    const token = new URL(fresh.url).searchParams.get('token')!;
    const reused = await host(`${otherUrl}?token=${token}`);
    expect(reused.status).toBe(303);
    expect(reused.headers.get('set-cookie')).toBeNull();
    // A token is good once.
    const again = await host(link.url);
    expect(again.status).toBe(303);
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it("answers the same 404 for an unknown, a private and another organization's Artifact", async () => {
    const privateId = await newArtifact('Private');
    const sharing = await json<Sharing>(call(alice, 'GET', `/artifacts/${privateId}/sharing`));
    const origin = new URL(sharing.url!).origin;
    const label = new URL(origin).hostname.split('.')[0]!;
    const [botSlug, orgSlug] = label.split('--') as [string, string];
    const answers = await Promise.all([
      host(`${origin}/00000000-0000-4000-8000-000000000000/`),
      host(`${origin}/${privateId}/`),
      host(`http://${botSlug}--other-org-1a2b3c4d.${DOMAIN}/${privateId}/`),
      host(`http://nobody-12345678--${orgSlug}.${DOMAIN}/${privateId}/`),
      host(`http://${DOMAIN}/${privateId}/`),
      host(`http://a.${label}.${DOMAIN}/${privateId}/`),
      host(`${origin}/${privateId}/extra/path`),
      host(`${origin}//evil.example/`),
    ]);
    const shapes = await Promise.all(
      answers.map(async (r) => ({
        status: r.status,
        body: await r.text(),
        type: r.headers.get('content-type'),
        cache: r.headers.get('cache-control'),
        csp: r.headers.get('content-security-policy'),
      })),
    );
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    expect(shapes[0]!.status).toBe(404);
  });

  it('is not an open redirect', async () => {
    const id = await newArtifact('Redirects');
    const sharing = await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`));
    const res = await host(
      `${sharing.url}?token=x&next=https://evil.example/&redirect=//evil.example`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/${id}/`);
  });
});

describe('sharing Artifacts off (no OPENBOTS_ARTIFACT_DOMAIN)', () => {
  let t: TestApp;
  let cookie: string;
  let id: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('owner@example.com')).cookie!;
    const ownerId = await t.userId('owner@example.com');
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Solo' }),
    });
    const botId = ((await res.json()) as { id: string }).id;
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: ownerId, workspaceId: await t.defaultOrganization() },
      { title: 'Notes', kind: 'document', botId, content: 'notes' },
      { userId: ownerId },
    );
    id = artifact.id;
  });
  afterAll(() => t.close());

  it('answers 404 on every sharing route and serves no artifact host', async () => {
    const get = (path: string, method = 'GET', body?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          cookie,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await get(`/artifacts/${id}/sharing`)).status).toBe(404);
    expect((await get(`/artifacts/${id}/sharing`, 'PUT', { visibility: 'org' })).status).toBe(404);
    expect((await get(`/artifacts/${id}/open`, 'POST')).status).toBe(404);
    expect((await get('/shared-artifacts')).status).toBe(404);
    expect((await get(`/shared-artifacts/${id}`)).status).toBe(404);
    // The Artifact itself reads as before; it is private.
    const artifact = (await (await get(`/artifacts/${id}`)).json()) as { visibility: string };
    expect(artifact.visibility).toBe('private');
    // No host: the edge path is the app's own 404.
    const edge = await t.app.request(`/artifact-host/${id}/`, {
      headers: { 'x-openbots-artifact-host': `a--b.${DOMAIN}` },
    });
    expect(edge.status).toBe(404);
  });
});
