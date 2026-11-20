import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '../db/client.js';
import { stopPublicLinks } from '../services/artifact-sharing.js';
import { createArtifact } from '../services/artifacts.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

// Organization settings written by two people at once (plan 21.3). Each
// write is merged from the row it locked, never from a copy read before, so
// neither loses the other's change, and turning public links off always
// stops the public links of the setting it leaves behind (plan 21.11). Only
// real Postgres runs two transactions at once: PGlite runs one query at a
// time, so these are skipped there.

const realPostgres = !!process.env.DATABASE_URL;

interface Settings {
  limits: Record<string, number>;
  auditRetentionDays: number;
  publicArtifactsEnabled: boolean;
  publicArtifacts: number;
}

describe.skipIf(!realPostgres)('organization settings written at once (real Postgres)', () => {
  let t: TestApp;
  let workspaceId: string;
  let alice: string;
  let aliceId: string;
  let botId: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: 'openbots-artifacts.test',
    });
    workspaceId = await t.defaultOrganization();
    alice = (await t.signUp('alice@example.com')).cookie!;
    aliceId = await t.userId('alice@example.com');
    const res = await call('POST', '/bots', { name: 'Writer' });
    botId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => t.close());

  function call(method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: alice,
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

  const settings = () => json<Settings>(call('GET', '/settings'));

  async function publicArtifact(title: string) {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: aliceId, workspaceId },
      { title, kind: 'document', botId, content: 'numbers' },
      { userId: aliceId },
    );
    return artifact.id;
  }

  const visibilityOf = async (id: string) =>
    (await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)))[0]!.visibility;

  /** Requests waiting on a lock in this test's database. */
  const waiting = async () => {
    const rows = (await t.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { n: number }[];
    return rows[0]!.n;
  };
  const untilWaiting = (n = 1) =>
    vi.waitFor(async () => expect(await waiting()).toBeGreaterThanOrEqual(n), {
      timeout: 5_000,
      interval: 10,
    });

  /**
   * Another admin's change, in a transaction this test holds open: `write`
   * runs in it, then it stays open, holding what it locked, until released.
   */
  async function held(write: (tx: Db) => Promise<void>) {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    let ready!: () => void;
    const written = new Promise<void>((resolve) => (ready = resolve));
    const done = t.db.transaction(async (tx) => {
      await write(tx);
      ready();
      await open;
    });
    await written;
    return {
      commit: async () => {
        release();
        await done;
      },
    };
  }

  /** What another admin's PATCH writes: its fields over the stored settings. */
  const merge = async (tx: Db, fields: Record<string, unknown>) => {
    await tx.execute(
      sql`update workspaces set settings = settings || ${JSON.stringify(fields)}::jsonb
          where id = ${workspaceId}`,
    );
  };

  it('keeps both of two changes to different settings made at once', async () => {
    const before = await settings();
    const routines = before.limits.routinesPerBot! - 1;
    const other = await held((tx) => merge(tx, { auditRetentionDays: 45 }));
    const patch = call('PATCH', '/settings', { limits: { routinesPerBot: routines } });
    await untilWaiting();
    await other.commit();
    await json(patch);
    const after = await settings();
    expect(after.auditRetentionDays).toBe(45);
    expect(after.limits.routinesPerBot).toBe(routines);
  });

  it('keeps public links off when another change was read before they went off', async () => {
    await json(call('PATCH', '/settings', { publicArtifactsEnabled: true }));
    const id = await publicArtifact('Was public');
    await json(call('PUT', `/artifacts/${id}/sharing`, { visibility: 'public', confirmed: true }));
    // Admin A turns them off and stops the links, and has not committed yet...
    const a = await held(async (tx) => {
      await merge(tx, { publicArtifactsEnabled: false });
      await stopPublicLinks(tx, workspaceId, { type: 'user', id: aliceId });
    });
    // ...when admin B changes something else.
    const b = call('PATCH', '/settings', { auditRetentionDays: 90 });
    await untilWaiting();
    await a.commit();
    const answer = await json<Settings>(b);
    expect(answer).toMatchObject({ publicArtifactsEnabled: false, auditRetentionDays: 90 });
    expect(await settings()).toMatchObject({
      publicArtifactsEnabled: false,
      auditRetentionDays: 90,
      publicArtifacts: 0,
    });
    expect(await visibilityOf(id)).toBe('org');
  });

  it('never leaves a public link behind a setting written as off from an old read', async () => {
    await json(call('PATCH', '/settings', { publicArtifactsEnabled: false }));
    const id = await publicArtifact('Shared meanwhile');
    // Admin A turns public links on and a member makes an Artifact public,
    // not committed yet...
    const a = await held(async (tx) => {
      await merge(tx, { publicArtifactsEnabled: true });
      await tx
        .update(schema.artifacts)
        .set({ visibility: 'public' })
        .where(eq(schema.artifacts.id, id));
    });
    // ...when admin B, who read them as off, changes something else.
    const b = call('PATCH', '/settings', { auditRetentionDays: 60 });
    await untilWaiting();
    await a.commit();
    await json(b);
    const after = await settings();
    // Either the setting is on and the link works, or it is off and the
    // link is stopped: never off with a public Artifact left behind.
    expect(after).toMatchObject({ publicArtifactsEnabled: true, auditRetentionDays: 60 });
    expect(await visibilityOf(id)).toBe('public');
    expect(after.publicArtifacts).toBe(1);
    await json(call('PATCH', '/settings', { publicArtifactsEnabled: false }));
    expect(await visibilityOf(id)).toBe('org');
  });

  it("keeps a provider's small model and another admin's change made at once", async () => {
    const providerId = await t.providerId();
    await t.addModels(providerId, ['small-one']);
    const other = await held((tx) => merge(tx, { auditRetentionDays: 120 }));
    const patch = call('PATCH', `/providers/${providerId}`, { smallModelId: 'small-one' });
    await untilWaiting();
    await other.commit();
    await json(patch);
    expect((await settings()).auditRetentionDays).toBe(120);
    const [row] = await t.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect((row!.settings as { smallModels?: Record<string, string> }).smallModels).toEqual({
      [providerId]: 'small-one',
    });
  });
});
