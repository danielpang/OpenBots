import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { startTestS3, type TestS3 } from '../storage/test-s3.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';
import { createArtifact, openVersion, readText, writeArtifact } from './artifacts.js';

// An Artifact write talks to object storage with no transaction open and no
// row locked: a slow store must not hold a connection from the pool, or a
// lock other writers wait on. Only the row inserts happen under the lock,
// after the version they build on is checked again.

describe('Artifact writes and object storage', () => {
  let t: TestApp;
  let s3: TestS3;
  let owner: { id: string; workspaceId: string };
  const author = () => ({ userId: owner.id });

  beforeAll(async () => {
    s3 = await startTestS3();
    t = await createTestApp(s3.env());
    await t.signUp('owner@example.com');
    owner = {
      id: await t.userId('owner@example.com'),
      workspaceId: (await ensureWorkspace(t.db)).id,
    };
  });
  afterAll(async () => {
    await t.close();
    await s3.close();
  });

  const text = async (id: string) => readText((await openVersion(t.ownerDeps, owner, id)).stream);

  const versionNumbers = async (id: string) =>
    (
      await t.db
        .select({ version: schema.artifactVersions.version })
        .from(schema.artifactVersions)
        .where(eq(schema.artifactVersions.artifactId, id))
        .orderBy(asc(schema.artifactVersions.version))
    ).map((row) => row.version);

  /**
   * Fails unless no transaction is open: the Artifact's row can be locked
   * at once from another connection, and (on real Postgres) no session sits
   * idle inside a transaction. On PGlite, one connection, a query waits for
   * an open transaction to end, so it would not finish while one is open.
   */
  async function expectNoTransactionOpen(id: string) {
    const lock = t.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.artifacts.id })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id))
        .for('update', { noWait: true });
    });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      lock.then(
        () => 'locked',
        (error: unknown) => `refused: ${(error as Error).message}`,
      ),
      new Promise<string>((resolve) => (timer = setTimeout(() => resolve('waiting'), 5_000))),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe('locked');
    if (t.testDb.kind === 'postgres') {
      const rows = (await t.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and state like 'idle in transaction%'`,
      )) as unknown as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    }
  }

  it('creates an Artifact with no transaction open while its blob is stored', async () => {
    const put = s3.hold('PUT');
    const created = createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Notes', kind: 'document', content: 'one\n' },
      author(),
    );
    await put.reached;
    // No Artifact row exists yet, so a transaction would be the only trace.
    expect(
      await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.title, 'Notes')),
    ).toEqual([]);
    if (t.testDb.kind === 'postgres') {
      const rows = (await t.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and state like 'idle in transaction%'`,
      )) as unknown as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    }
    put.release();
    const { artifact, version } = await created;
    expect(version.version).toBe(1);
    expect(await text(artifact.id)).toBe('one\n');
  });

  it('reads the previous text and stores the new blob with the row unlocked', async () => {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Plan', kind: 'document', content: 'a\nb\nc\n' },
      author(),
    );
    // The read of the previous text, for the patch, stalls.
    const get = s3.hold('GET');
    const patched = writeArtifact(
      t.ownerDeps,
      owner,
      artifact.id,
      { patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n' },
      author(),
    );
    await get.reached;
    await expectNoTransactionOpen(artifact.id);
    // Then the new blob's upload stalls.
    const put = s3.hold('PUT');
    get.release();
    await put.reached;
    await expectNoTransactionOpen(artifact.id);
    put.release();
    const { version } = await patched;
    expect(version.version).toBe(2);
    expect(await text(artifact.id)).toBe('a\nB\nc\n');
  });

  it('fails a write whose store is down without holding the row', async () => {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Down', kind: 'document', content: 'x\n' },
      author(),
    );
    // Every try of the upload (the driver's four) answers 503.
    s3.fail(4, { status: 503, code: 'SlowDown' }, 'PUT');
    const failed = writeArtifact(t.ownerDeps, owner, artifact.id, { content: 'y\n' }, author());
    await expect(failed).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    await expectNoTransactionOpen(artifact.id);
    expect(await versionNumbers(artifact.id)).toEqual([1]);
  });

  it('builds a patch on the version that won when another write lands first', async () => {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Shared', kind: 'document', content: 'one\ntwo\nthree\nfour\nfive\n' },
      author(),
    );
    // The first writer reads version 1 and stalls uploading its blob...
    const put = s3.hold('PUT');
    const first = writeArtifact(
      t.ownerDeps,
      owner,
      artifact.id,
      { patch: '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n' },
      author(),
    );
    await put.reached;
    // ...while the second writes version 2 from the same version 1.
    const second = await writeArtifact(
      t.ownerDeps,
      owner,
      artifact.id,
      { patch: '--- a\n+++ b\n@@ -4,2 +4,2 @@\n four\n-five\n+FIVE\n' },
      author(),
    );
    expect(second.version.version).toBe(2);
    put.release();
    // The first finds version 1 is no longer current and applies its patch to version 2.
    const won = await first;
    expect(won.version.version).toBe(3);
    expect(await text(artifact.id)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(await versionNumbers(artifact.id)).toEqual([1, 2, 3]);
    // Every version names its own blob; the losing attempt's blob is not one of them.
    const keys = await t.db
      .select({ key: schema.artifactVersions.storageKey })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, artifact.id));
    expect(new Set(keys.map((k) => k.key)).size).toBe(3);
  });

  it('refuses a stale baseVersion found only at commit', async () => {
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Edited', kind: 'document', content: 'v1\n' },
      author(),
    );
    const put = s3.hold('PUT');
    const edit = writeArtifact(t.ownerDeps, owner, artifact.id, { content: 'mine\n' }, author(), {
      baseVersion: 1,
    });
    await put.reached;
    await writeArtifact(t.ownerDeps, owner, artifact.id, { content: 'theirs\n' }, author());
    put.release();
    await expect(edit).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(await text(artifact.id)).toBe('theirs\n');
    expect(await versionNumbers(artifact.id)).toEqual([1, 2]);
    // The losing attempt's blob is removed, and its row was never written.
    const files = await t.db
      .select({ key: schema.files.storageKey })
      .from(schema.files)
      .where(and(eq(schema.files.workspaceId, owner.workspaceId)));
    const stored = [...s3.objects.keys()].map((key) => key.split('/').slice(-2).join('/'));
    expect(stored.sort()).toEqual(files.map((f) => f.key).sort());
  });

  // Two writers on a pool of real connections, interleaved by a lock this
  // test holds: both read version 1 and store their blobs, then wait on the
  // Artifact's row; one commits version 2, the other finds it and builds on it.
  it.skipIf(!process.env.DATABASE_URL)(
    'loses no edit and repeats no version number under concurrent writers (real Postgres)',
    async () => {
      const { artifact } = await createArtifact(
        t.ownerDeps,
        owner,
        { title: 'Race', kind: 'document', content: 'one\ntwo\nthree\nfour\nfive\n' },
        author(),
      );
      let release!: () => void;
      const open = new Promise<void>((resolve) => (release = resolve));
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => (ready = resolve));
      const holder = t.db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, artifact.id))
          .for('update');
        ready();
        await open;
      });
      await locked;
      const writers = [
        writeArtifact(
          t.ownerDeps,
          owner,
          artifact.id,
          { patch: '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n' },
          author(),
        ),
        writeArtifact(
          t.ownerDeps,
          owner,
          artifact.id,
          { patch: '--- a\n+++ b\n@@ -4,2 +4,2 @@\n four\n-five\n+FIVE\n' },
          author(),
        ),
      ];
      // Both have read version 1 and stored their blobs, and wait on the row.
      await vi.waitFor(
        async () => {
          const rows = (await t.db.execute(
            sql`select count(*)::int as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
          )) as unknown as { n: number }[];
          expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5_000, interval: 10 },
      );
      release();
      await holder;
      const results = await Promise.all(writers);
      expect(results.map((r) => r.version.version).sort()).toEqual([2, 3]);
      expect(await text(artifact.id)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
      expect(await versionNumbers(artifact.id)).toEqual([1, 2, 3]);
    },
  );
});
