import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  let carolId: string;
  let daveId: string;
  let botId: string;
  let carolBotId: string;

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
    carolId = await t.userId('carol@example.com');
    daveId = await t.userId('dave@example.com');
    const res = await call(alice, 'POST', '/bots', { name: 'Writer' });
    botId = ((await res.json()) as { id: string }).id;
    const carolBot = await call(carol, 'POST', '/bots', { name: 'Helper' });
    carolBotId = ((await carolBot.json()) as { id: string }).id;
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

  /** One of Carol's, made by her own Bot. */
  async function carolsArtifact(title: string, content = 'carol text') {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: carolId, workspaceId },
      { title, kind: 'document', botId: carolBotId, content },
      { userId: carolId },
    );
    return artifact.id;
  }

  /** An owner or admin turns public links on or off for the organization. */
  const publicLinks = (on: boolean) =>
    json<{ publicArtifactsEnabled: boolean; publicArtifacts: number }>(
      call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: on }),
    );

  const visibilityOf = async (id: string) =>
    (await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)))[0]!.visibility;

  const auditOf = async (id: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'artifact.visibility'), eq(schema.auditLog.targetId, id)),
      )
      .orderBy(schema.auditLog.createdAt);

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
      publicAllowed: false,
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

  it('keeps public links off in a new organization until an owner or admin turns them on', async () => {
    const id = await newArtifact('Not yet');
    // Off by default, also for a settings row written before the setting existed.
    const [org] = await t.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect(org!.settings).not.toHaveProperty('publicArtifactsEnabled');
    const settings = await json<{ publicArtifactsEnabled: boolean }>(
      call(alice, 'GET', '/settings'),
    );
    expect(settings.publicArtifactsEnabled).toBe(false);
    expect(
      (await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`))).publicAllowed,
    ).toBe(false);
    expect(
      (
        await json<{ code: string }>(
          share(alice, id, { visibility: 'public', confirmed: true }),
          403,
        )
      ).code,
    ).toBe('PUBLIC_SHARING_OFF');
    expect(await visibilityOf(id)).toBe('private');
    // Sharing with the organization needs no setting.
    expect((await json<Sharing>(share(alice, id, { visibility: 'org' }))).visibility).toBe('org');
    // A member may not turn it on.
    expect((await call(carol, 'PATCH', '/settings', { publicArtifactsEnabled: true })).status).toBe(
      403,
    );
    expect((await publicLinks(true)).publicArtifactsEnabled).toBe(true);
    expect(
      (await json<Sharing>(share(alice, id, { visibility: 'public', confirmed: true }))).visibility,
    ).toBe('public');
    await json(share(alice, id, { visibility: 'private' }));
    await publicLinks(false);
  });

  it('shows the latest version on a public link, with no version to confirm', async () => {
    await publicLinks(true);
    const id = await newArtifact('Launch', 'draft one');
    await edit(id, 'draft two');
    expect(
      (await json<{ code: string }>(share(alice, id, { visibility: 'public' }), 400)).code,
    ).toBe('CONFIRMATION_REQUIRED');
    // A version is not part of the request any more.
    expect(
      (await share(alice, id, { visibility: 'public', version: 2, confirmed: true })).status,
    ).toBe(400);
    const shared = await json<Sharing>(share(alice, id, { visibility: 'public', confirmed: true }));
    expect(shared).toMatchObject({ visibility: 'public', currentVersion: 2 });
    expect(shared).not.toHaveProperty('publicVersion');
    const anyone = await host(shared.url!);
    expect(anyone.status).toBe(200);
    expect(await anyone.text()).toBe('draft two');
    expect(anyone.headers.get('cache-control')).toBe('public, max-age=60');

    // The Bot keeps editing: the link shows each new version, with nothing to confirm.
    await edit(id, 'draft three');
    expect(await (await host(shared.url!)).text()).toBe('draft three');
    const asMember = await json<{ version: { version: number } }>(
      call(carol, 'GET', `/shared-artifacts/${id}`),
    );
    expect(asMember.version.version).toBe(3);
    const own = await json<{ items: { id: string; version: { version: number } }[] }>(
      call(alice, 'GET', '/shared-artifacts'),
    );
    expect(own.items.find((i) => i.id === id)!.version.version).toBe(3);

    const back = await json<Sharing>(share(alice, id, { visibility: 'org' }));
    expect(back.visibility).toBe('org');
    expect((await host(shared.url!)).status).toBe(404);
    expect((await auditOf(id)).map((a) => a.metadata)).toEqual([
      { from: 'private', to: 'public' },
      { from: 'public', to: 'org' },
    ]);
    await publicLinks(false);
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
      (await json<{ code: string }>(bearer('PUT', { visibility: 'public', confirmed: true }), 403))
        .code,
    ).toBe('PERSON_REQUIRED');
    await json<Sharing>(share(alice, id, { visibility: 'org' }));
    expect((await json<Sharing>(bearer('PUT', { visibility: 'private' }))).visibility).toBe(
      'private',
    );
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "judges an API key's change by the visibility it locked, not one read before (real Postgres)",
    async () => {
      const id = await newArtifact('Race');
      await json<Sharing>(share(alice, id, { visibility: 'org' }));
      const key = await json<{ key: string }>(
        call(alice, 'POST', '/api-keys', { name: 'racing script' }),
        201,
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // The owner narrows it to private, in a transaction still holding the row...
      const owner = t.db.transaction(async (tx) => {
        await tx
          .update(schema.artifacts)
          .set({ visibility: 'private' })
          .where(eq(schema.artifacts.id, id));
        locked();
        await held;
      });
      await isLocked;
      // ...when the script puts `org`, which is no wider than the `org` it can read now.
      const put = t.app.request(`/api/v1/artifacts/${id}/sharing`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'org' }),
      });
      // The script's request waits on the owner's lock before the owner commits.
      await vi.waitFor(
        async () => {
          const rows = (await t.db.execute(
            sql`select count(*)::int as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
          )) as unknown as { n: number }[];
          expect(rows[0]!.n).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 10 },
      );
      release();
      await owner;
      // Against the row it locked, `org` widens `private`: a person must do that.
      expect((await json<{ code: string }>(put, 403)).code).toBe('PERSON_REQUIRED');
      const [row] = await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
      expect(row!.visibility).toBe('private');
    },
  );

  it('lists shared Artifacts a page at a time, newest first', async () => {
    const ids: string[] = [];
    for (const title of ['Page one', 'Page two', 'Page three']) {
      const id = await newArtifact(title);
      await json<Sharing>(share(alice, id, { visibility: 'org' }));
      ids.unshift(id);
    }
    type Page = { items: { id: string; title: string }[]; nextCursor: string | null };
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page: Page = await json<Page>(call(carol, 'GET', `/shared-artifacts${query}`));
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    // The three just shared come first, newest first.
    expect(seen.slice(0, 3)).toEqual(ids);
    expect((await call(carol, 'GET', '/shared-artifacts?limit=1000')).status).toBe(400);
  });

  it("says when the organization's address is too long for a link", async () => {
    const id = await newArtifact('Long address');
    const [org] = await t.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    // As migration 0021 named an organization: from its whole name.
    await t.db
      .update(schema.workspaces)
      .set({ slug: `${'a-long-organization-name'.repeat(3)}-0123abcd` })
      .where(eq(schema.workspaces.id, workspaceId));
    try {
      const sharing = await json<Sharing & { noLink: string | null }>(
        call(alice, 'GET', `/artifacts/${id}/sharing`),
      );
      expect(sharing.url).toBeNull();
      expect(sharing.noLink).toBe('address_too_long');
      const refused = await json<{ code: string; title: string }>(
        call(alice, 'POST', `/artifacts/${id}/open`),
        409,
      );
      expect(refused.code).toBe('ADDRESS_TOO_LONG');
      expect(refused.title).toContain("organization's address is too long");
    } finally {
      await t.db
        .update(schema.workspaces)
        .set({ slug: org!.slug })
        .where(eq(schema.workspaces.id, workspaceId));
    }
    const restored = await json<Sharing & { noLink: string | null }>(
      call(alice, 'GET', `/artifacts/${id}/sharing`),
    );
    expect(restored.noLink).toBeNull();
  });

  it('turns every public link into an organization one when public links are turned off', async () => {
    await publicLinks(true);
    const first = await newArtifact('Public notes', 'hello world');
    const second = await carolsArtifact('Carol public');
    const staysOrg = await newArtifact('Org only');
    const a = await json<Sharing>(share(alice, first, { visibility: 'public', confirmed: true }));
    await json<Sharing>(share(carol, second, { visibility: 'public', confirmed: true }));
    await json<Sharing>(share(alice, staysOrg, { visibility: 'org' }));
    expect((await host(a.url!)).status).toBe(200);
    // The settings say how many links turning it off would stop.
    const before = await json<{ publicArtifacts: number }>(call(alice, 'GET', '/settings'));
    expect(before.publicArtifacts).toBe(2);

    const off = await publicLinks(false);
    expect(off).toMatchObject({ publicArtifactsEnabled: false, publicArtifacts: 0 });
    expect(await visibilityOf(first)).toBe('org');
    expect(await visibilityOf(second)).toBe('org');
    expect(await visibilityOf(staysOrg)).toBe('org');
    expect((await host(a.url!)).status).toBe(404);
    // Members still see them, as organization Artifacts.
    const seen = await json<{ visibility: string }>(
      call(dave, 'GET', `/shared-artifacts/${first}`),
    );
    expect(seen.visibility).toBe('org');

    // On again: no old link comes back; each owner makes theirs public again.
    await publicLinks(true);
    expect((await host(a.url!)).status).toBe(404);
    const state = await json<Sharing>(call(alice, 'GET', `/artifacts/${first}/sharing`));
    expect(state.visibility).toBe('org');
    await json<Sharing>(share(alice, first, { visibility: 'public', confirmed: true }));
    expect(await (await host(a.url!)).text()).toBe('hello world');

    // Audited per Artifact, and the switch with how many it stopped.
    for (const id of [first, second]) {
      expect((await auditOf(id)).map((row) => [row.actorId, row.metadata])).toContainEqual([
        aliceId,
        { from: 'public', to: 'org', reason: 'public_links_off' },
      ]);
    }
    expect((await auditOf(staysOrg)).map((row) => row.metadata)).toEqual([
      { from: 'private', to: 'org' },
    ]);
    const settingsAudit = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'));
    expect(settingsAudit.map((row) => row.metadata)).toContainEqual({
      publicArtifactsEnabled: false,
      publicLinksStopped: 2,
    });
    await json(share(alice, first, { visibility: 'private' }));
    await publicLinks(false);
  });

  /** Requests waiting on a lock in this test's database. */
  const untilWaiting = (n: number) =>
    vi.waitFor(
      async () => {
        const rows = (await t.db.execute(
          sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
        )) as unknown as { n: number }[];
        expect(rows[0]!.n).toBeGreaterThanOrEqual(n);
      },
      { timeout: 5_000, interval: 10 },
    );

  /** Holds `id`'s row locked in a transaction until the returned function commits it. */
  async function holdArtifact(id: string) {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => (ready = resolve));
    const done = t.db.transaction(async (tx) => {
      await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).for('update');
      ready();
      await open;
    });
    await locked;
    return async () => {
      release();
      await done;
    };
  }

  it.skipIf(!process.env.DATABASE_URL)(
    'stops a link made public just before public links go off (real Postgres)',
    async () => {
      await publicLinks(true);
      const id = await newArtifact('Shared first');
      // The share has taken its lock on the switch and waits for the Artifact's row...
      const commit = await holdArtifact(id);
      const shared = share(alice, id, { visibility: 'public', confirmed: true });
      await untilWaiting(1);
      // ...when an admin turns public links off: they wait for the share.
      const off = call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: false });
      await untilWaiting(2);
      await commit();
      expect((await json<Sharing>(shared)).visibility).toBe('public');
      const answer = await json<{ publicArtifactsEnabled: boolean; publicLinksStopped: number }>(
        off,
      );
      expect(answer).toMatchObject({ publicArtifactsEnabled: false, publicLinksStopped: 1 });
      expect(await visibilityOf(id)).toBe('org');
    },
  );

  it.skipIf(!process.env.DATABASE_URL)(
    'refuses a link made public just after public links go off (real Postgres)',
    async () => {
      await publicLinks(true);
      const already = await newArtifact('Already public');
      await json<Sharing>(share(alice, already, { visibility: 'public', confirmed: true }));
      const id = await newArtifact('Shared second');
      // Turning them off has taken the lock on the switch and waits for a public Artifact's row...
      const commit = await holdArtifact(already);
      const off = call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: false });
      await untilWaiting(1);
      // ...when its owner makes another one public: it waits for the switch.
      const shared = share(alice, id, { visibility: 'public', confirmed: true });
      await untilWaiting(2);
      await commit();
      expect(await json<{ publicLinksStopped: number }>(off)).toMatchObject({
        publicLinksStopped: 1,
      });
      expect((await json<{ code: string }>(shared, 403)).code).toBe('PUBLIC_SHARING_OFF');
      expect(await visibilityOf(already)).toBe('org');
      expect(await visibilityOf(id)).toBe('private');
    },
  );

  it('keeps what a suspended or removed owner shared live, and their private Artifacts hidden', async () => {
    await publicLinks(true);
    const orgId = await carolsArtifact('Team doc', 'team text');
    const pub = await carolsArtifact('Public while away', 'pub');
    const secret = await carolsArtifact('Private while away', 'secret');
    const shared = await json<Sharing>(share(carol, orgId, { visibility: 'org' }));
    const pubShared = await json<Sharing>(
      share(carol, pub, { visibility: 'public', confirmed: true }),
    );
    const carolOwn = await openAs(carol, secret);
    const daveView = await openAs(dave, orgId);
    const secretUrl = (await json<Sharing>(call(carol, 'GET', `/artifacts/${secret}/sharing`)))
      .url!;
    expect((await host(secretUrl, carolOwn.viewCookie)).status).toBe(200);

    const check = async () => {
      // A member still opens the organization Artifact; the public link works.
      expect(await (await host(shared.url!, daveView.viewCookie)).text()).toBe('team text');
      expect(await (await host(pubShared.url!)).text()).toBe('pub');
      const list = await json<{ items: { id: string }[] }>(call(dave, 'GET', '/shared-artifacts'));
      expect(list.items.map((i) => i.id)).toEqual(expect.arrayContaining([orgId, pub]));
      const one = await json<{ id: string }>(call(dave, 'GET', `/shared-artifacts/${orgId}`));
      expect(one.id).toBe(orgId);
      // Her private one is served to nobody, her own cookie included.
      expect((await host(secretUrl, carolOwn.viewCookie)).status).toBe(404);
      expect((await host(secretUrl)).status).toBe(404);
      expect((await call(dave, 'GET', `/shared-artifacts/${secret}`)).status).toBe(404);
    };

    // Suspended.
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, carolId));
    await check();
    // Removed: the membership row is deleted; her Artifacts and her Bot stay.
    const [membership] = await t.db
      .delete(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, carolId))
      .returning();
    try {
      await check();
    } finally {
      await t.db.insert(schema.workspaceMembers).values({ ...membership!, suspendedAt: null });
    }
    await json(share(carol, pub, { visibility: 'private' }));
    await publicLinks(false);
  });

  it("lets an owner or admin narrow anyone's shared Artifact, but never widen it", async () => {
    await publicLinks(true);
    const pub = await carolsArtifact('Admin narrows public');
    const org = await carolsArtifact('Admin narrows org');
    const priv = await carolsArtifact('Admin never sees');
    const pubShared = await json<Sharing>(
      share(carol, pub, { visibility: 'public', confirmed: true }),
    );
    await json<Sharing>(share(carol, org, { visibility: 'org' }));
    // Carol is suspended, so she cannot stop sharing them herself.
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, carolId));
    try {
      // A member who is not the owner cannot change it, and learns nothing.
      expect((await share(dave, org, { visibility: 'private' })).status).toBe(404);
      // An admin may not widen someone else's Artifact.
      const widen = await json<{ code: string }>(
        share(alice, org, { visibility: 'public', confirmed: true }),
        403,
      );
      expect(widen.code).toBe('OWNER_ONLY');
      const same = await json<{ code: string }>(share(alice, org, { visibility: 'org' }), 403);
      expect(same.code).toBe('OWNER_ONLY');
      // Nor touch one that is private: it is not shared with them.
      expect((await share(alice, priv, { visibility: 'private' })).status).toBe(404);

      // Narrowing: public to the organization, then to private.
      const narrowed = await json<Sharing>(share(alice, pub, { visibility: 'org' }));
      expect(narrowed).toMatchObject({ visibility: 'org', pendingRequest: null });
      expect((await host(pubShared.url!)).status).toBe(404);
      await json<Sharing>(share(alice, org, { visibility: 'private' }));
      expect(await visibilityOf(org)).toBe('private');
      // An admin's API key may narrow too, as an owner's may.
      const key = await json<{ key: string }>(
        call(alice, 'POST', '/api-keys', { name: 'admin script' }),
        201,
      );
      const byKey = await t.app.request(`/api/v1/artifacts/${pub}/sharing`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(byKey.status).toBe(200);
      expect(await visibilityOf(pub)).toBe('private');
      // Once private it is gone from the admin's reach.
      expect((await share(alice, pub, { visibility: 'private' })).status).toBe(404);
      expect((await auditOf(pub)).map((row) => [row.actorId, row.metadata])).toEqual([
        [carolId, { from: 'private', to: 'public' }],
        [aliceId, { from: 'public', to: 'org', owner: carolId }],
        [aliceId, { from: 'org', to: 'private', owner: carolId }],
      ]);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, carolId));
    }
    await publicLinks(false);
  });

  it("takes a suspended member's access away at once", async () => {
    const id = await newArtifact('Members only', 'team text');
    const shared = await json<Sharing>(share(alice, id, { visibility: 'org' }));
    const { viewCookie } = await openAs(dave, id);
    expect((await host(shared.url!, viewCookie)).status).toBe(200);
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, daveId));
    try {
      // The cookie he holds stops working at once; the app refuses him too.
      expect((await host(shared.url!, viewCookie)).status).toBe(404);
      expect((await call(dave, 'GET', '/shared-artifacts')).status).toBe(403);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, daveId));
    }
  });

  it('refuses public again after the operator took the link down', async () => {
    await publicLinks(true);
    const id = await newArtifact('Phish', '<p>log in</p>');
    const shared = await json<Sharing>(share(alice, id, { visibility: 'public', confirmed: true }));
    await t.db
      .update(schema.artifacts)
      .set({ takenDownAt: new Date() })
      .where(eq(schema.artifacts.id, id));
    expect((await host(shared.url!)).status).toBe(404);
    await json(share(alice, id, { visibility: 'private' }));
    expect(
      (
        await json<{ code: string }>(
          share(alice, id, { visibility: 'public', confirmed: true }),
          409,
        )
      ).code,
    ).toBe('TAKEN_DOWN');
    expect((await json<Sharing>(call(alice, 'GET', `/artifacts/${id}/sharing`))).takenDown).toBe(
      true,
    );
    await publicLinks(false);
  });

  it('counts only working public links, before turning them off and after', async () => {
    await publicLinks(true);
    const down = await newArtifact('Taken down');
    const live = await newArtifact('Still live');
    for (const id of [down, live]) {
      await json<Sharing>(share(alice, id, { visibility: 'public', confirmed: true }));
    }
    await t.db
      .update(schema.artifacts)
      .set({ takenDownAt: new Date() })
      .where(eq(schema.artifacts.id, down));
    // The taken down link already does not work: turning links off stops one.
    const before = await json<{ publicArtifacts: number }>(call(alice, 'GET', '/settings'));
    expect(before.publicArtifacts).toBe(1);
    const off = await json<{ publicArtifacts: number; publicLinksStopped: number }>(
      call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: false }),
    );
    expect(off).toMatchObject({ publicArtifacts: 0, publicLinksStopped: 1 });
    expect(await visibilityOf(live)).toBe('org');
    // A change that stops nothing says so.
    const again = await json<{ publicLinksStopped: number }>(
      call(alice, 'PATCH', '/settings', { publicArtifactsEnabled: false }),
    );
    expect(again.publicLinksStopped).toBe(0);
    // Only a change answers with it.
    expect(await json(call(alice, 'GET', '/settings'))).not.toHaveProperty('publicLinksStopped');
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
      host(`${origin}/${privateId}/content`),
      host(`${origin}/${privateId}/leave?to=${encodeURIComponent('https://example.com/')}`),
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

  it("serves an HTML Artifact in the host's wrapper, and its content only into the wrapper's frame", async () => {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: aliceId, workspaceId },
      {
        title: 'Page.html',
        kind: 'document',
        botId,
        content: '<a href="https://example.com/">out</a>',
      },
      { userId: aliceId },
    );
    const { link, viewCookie } = await openAs(alice, artifact.id);
    const origin = new URL(link.url).origin;
    const wrapper = await host(`${origin}/${artifact.id}/`, viewCookie);
    expect(wrapper.status).toBe(200);
    expect(wrapper.headers.get('content-security-policy')).toContain("frame-src 'self'");
    expect(wrapper.headers.get('cache-control')).toBe('private, no-store');
    const html = await wrapper.text();
    expect(html).toContain(`<iframe src="/${artifact.id}/content" sandbox="allow-scripts"`);
    expect(html).not.toContain('example.com');
    const framed = await t.app.request(`/${artifact.id}/content`, {
      headers: {
        host: new URL(origin).host,
        cookie: viewCookie!,
        'sec-fetch-dest': 'iframe',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(framed.status).toBe(200);
    expect(await framed.text()).toContain('<a href="https://example.com/">out</a>');
    expect(framed.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    // The same cookie, asked for the content as a page of its own: back to the wrapper.
    const top = await t.app.request(`/${artifact.id}/content`, {
      headers: { host: new URL(origin).host, cookie: viewCookie!, 'sec-fetch-dest': 'document' },
    });
    expect(top.status).toBe(303);
    expect(top.headers.get('location')).toBe(`/${artifact.id}/`);
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
