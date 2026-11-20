import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { schema } from '../db/client.js';
import { generateMasterKey } from '../secrets.js';
import { openFile, storeFile } from '../services/files.js';
import { startTestS3, type TestS3 } from '../storage/test-s3.js';
import { createTestApp, type TestApp } from '../test-app.js';
import type { CliContext } from './context.js';
import { runStorage } from './storage.js';

// `openbots storage copy`: a populated install on local disk moves its blobs
// to an object store, checked, resumably, deleting nothing.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, relative. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe('the storage copy command', () => {
  let t: TestApp;
  let s3: TestS3;
  let dir: string;
  let lines: string[];
  const owners: { id: string; workspaceId: string }[] = [];
  const stored: { id: string; workspaceId: string; key: string; bytes: Uint8Array }[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openbots-copy-'));
    s3 = await startTestS3();
    // The install as it was: the local driver, two organizations with files.
    t = await createTestApp({
      OPENBOTS_FILES_DIR: dir,
      OPENBOTS_STORAGE_DRIVER: 'local',
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
    });
    await t.signUp('a@example.com');
    await t.signUp('b@example.com');
    const second = await t.createOrganization('Second');
    await t.addMember(await t.userId('b@example.com'), second);
    owners.push(
      { id: await t.userId('a@example.com'), workspaceId: await t.defaultOrganization() },
      { id: await t.userId('b@example.com'), workspaceId: second },
    );
    for (const [i, owner] of owners.entries()) {
      for (const n of [1, 2, 3]) {
        const bytes = new TextEncoder().encode(`organization ${i} file ${n} `.repeat(n * 50));
        const row = await t.inOrganization(
          () => storeFile(t.deps, owner, { name: `f${n}.txt`, bytes, purpose: 'attachment' }),
          owner.workspaceId,
        );
        stored.push({ id: row.id, workspaceId: owner.workspaceId, key: row.storageKey, bytes });
      }
    }
    // A row from before organizations: a bare key, at the top of the files directory.
    const legacy = new TextEncoder().encode('from an old install');
    const key = randomUUID().replace(/-/g, '');
    await mkdir(path.join(dir, key.slice(0, 2)), { recursive: true });
    await writeFile(path.join(dir, key.slice(0, 2), key), legacy);
    const [row] = await t.db
      .insert(schema.files)
      .values({
        workspaceId: owners[0]!.workspaceId,
        ownerId: owners[0]!.id,
        name: 'old.txt',
        mime: 'text/plain',
        size: legacy.byteLength,
        storageKey: key,
        sha256: sha(legacy),
        purpose: 'attachment',
      })
      .returning();
    stored.push({ id: row!.id, workspaceId: owners[0]!.workspaceId, key, bytes: legacy });
  });
  afterAll(async () => {
    await t.close();
    await s3.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The same install, now configured for the object store. */
  const s3Config = () =>
    loadConfig({
      OPENBOTS_MASTER_KEY: generateMasterKey(),
      DATABASE_URL: 'postgres://unused',
      OPENBOTS_FILES_DIR: dir,
      ...s3.env('prod'),
    });
  const ctx = (config = s3Config()): CliContext => {
    lines = [];
    return { config, db: t.deps.db, infra: t.deps.infra, write: (l) => lines.push(l) };
  };
  const objectKey = (f: (typeof stored)[number]) =>
    `prod/orgs/${f.workspaceId}/${f.key.split('/').at(-1)}`;

  it('refuses without an object store configured, and with bad arguments', async () => {
    expect(await runStorage(['copy'], ctx(t.deps.config))).toBe(1);
    expect(lines[0]).toContain('OPENBOTS_STORAGE_DRIVER=s3');
    expect(await runStorage(['move'], ctx())).toBe(2);
    expect(await runStorage(['copy', '--delete'], ctx())).toBe(2);
  });

  it('counts without copying on a dry run', async () => {
    expect(await runStorage(['copy', '--dry-run'], ctx())).toBe(0);
    expect(lines.at(-1)).toMatch(/^Would copy 7 of 7 files in 2 organizations; 0 already/);
    expect(s3.objects.size).toBe(0);
  });

  it('copies every blob under its organization, checked, and keeps the source', async () => {
    const before = await filesUnder(dir);
    expect(await runStorage(['copy'], ctx())).toBe(0);
    expect(lines.at(-1)).toMatch(/^Copied 7 of 7 files in 2 organizations; 0 already/);
    expect(lines.at(-1)).toContain('Nothing was deleted.');
    for (const f of stored) {
      expect(s3.objects.get(objectKey(f))).toEqual(Buffer.from(f.bytes));
    }
    expect(s3.objects.size).toBe(stored.length);
    expect(await filesUnder(dir)).toEqual(before);
    // Each upload carried the sha256 and MD5 for the store to check.
    const puts = s3.requests.filter((q) => q.method === 'PUT');
    expect(puts.every((q) => q.headers['content-md5'] && q.headers['x-amz-content-sha256'])).toBe(
      true,
    );
  });

  it('is idempotent: a second run copies nothing', async () => {
    s3.requests.length = 0;
    expect(await runStorage(['copy'], ctx())).toBe(0);
    expect(lines.at(-1)).toMatch(/^Copied 0 of 7 files in 2 organizations; 7 already/);
    expect(s3.requests.filter((q) => q.method === 'PUT')).toHaveLength(0);
  });

  it('resumes after a failure, copying only what is not there yet', async () => {
    const [a, b] = stored;
    s3.objects.delete(objectKey(a!));
    s3.objects.delete(objectKey(b!));
    // Every try of one upload fails: that file is reported, the other copied.
    s3.fail(4, { status: 500, code: 'InternalError' }, 'PUT');
    expect(await runStorage(['copy'], ctx())).toBe(1);
    expect(lines.filter((l) => l.startsWith('failed:'))).toHaveLength(1);
    expect(lines.at(-2)).toMatch(/^Copied 1 of 7 files .* 5 already .* 1 failed/);
    expect(lines.at(-1)).toBe('Run the command again to retry the files that failed.');
    expect(lines.join('\n')).not.toContain(s3.bucket);
    s3.requests.length = 0;
    expect(await runStorage(['copy'], ctx())).toBe(0);
    expect(lines.at(-1)).toMatch(/^Copied 1 of 7 files in 2 organizations; 6 already/);
    expect(s3.requests.filter((q) => q.method === 'PUT')).toHaveLength(1);
  });

  it('reports a blob that is missing or does not match its row, and copies neither', async () => {
    const [, , c, d] = stored;
    s3.objects.delete(objectKey(c!));
    s3.objects.delete(objectKey(d!));
    const local = (f: (typeof stored)[number]) => {
      const [ws, key] = f.key.split('/') as [string, string];
      return path.join(dir, 'orgs', ws, key.slice(0, 2), key);
    };
    await rm(local(c!));
    // Same size, other bytes: only the sha256 tells.
    await writeFile(local(d!), new Uint8Array(d!.bytes.byteLength).fill(65));
    expect(await runStorage(['copy'], ctx())).toBe(1);
    expect(lines).toContain(`missing: file ${c!.id} is not on local disk`);
    expect(lines).toContain(
      `mismatched: file ${d!.id} on disk does not match the sha256 in its record`,
    );
    expect(s3.objects.has(objectKey(c!))).toBe(false);
    expect(s3.objects.has(objectKey(d!))).toBe(false);
  });

  it('leaves the files the server reads under the s3 driver, old rows included', async () => {
    const config = s3Config();
    const deps = { ...t.deps, config };
    for (const f of stored.slice(4)) {
      const owner = owners.find((o) => o.workspaceId === f.workspaceId)!;
      const { stream } = await t.inOrganization(() => openFile(deps, owner, f.id), f.workspaceId);
      expect(new Uint8Array(await buffer(stream))).toEqual(f.bytes);
    }
  });

  it('points at s3:ListBucket when a lookup is refused with 403, as AWS answers for a missing key', async () => {
    const [, , , , e] = stored;
    s3.objects.delete(objectKey(e!));
    // AWS, to a key that may not list the bucket, says 403 AccessDenied for "no such key".
    s3.fail(1, { status: 403, code: 'AccessDenied' }, 'HEAD');
    expect(await runStorage(['copy'], ctx())).toBe(1);
    const refused = lines.filter((l) => l.includes('HTTP 403'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('s3:ListBucket');
    expect(refused[0]).not.toContain(s3.bucket);
    expect(refused[0]).not.toContain('prod/orgs');
    // The next run, with the lookup answered, copies it.
    expect(await runStorage(['copy'], ctx())).toBe(1);
    expect(s3.objects.has(objectKey(e!))).toBe(true);
  });

  it('pages through the rows, including one added while it runs', async () => {
    s3.objects.clear();
    s3.requests.length = 0;
    // The first upload stalls; meanwhile a file is uploaded in its organization
    // whose id sorts after every other, so it is on a page not read yet.
    const put = s3.hold('PUT');
    const run = runStorage(['copy'], ctx(), { pageSize: 2 });
    await put.reached;
    const held = s3.requests.find((q) => q.method === 'PUT')!.key;
    const workspaceId = held.split('/')[2]!;
    const owner = owners.find((o) => o.workspaceId === workspaceId)!;
    const bytes = new TextEncoder().encode('uploaded during the copy');
    const row = await t.inOrganization(
      () => storeFile(t.deps, owner, { name: 'late.txt', bytes, purpose: 'attachment' }),
      workspaceId,
    );
    const lastId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    await t.db.update(schema.files).set({ id: lastId }).where(eq(schema.files.id, row.id));
    put.release();
    // Two missing or mismatched from the test above; every other row, the late one too.
    expect(await run).toBe(1);
    expect(lines.at(-1)).toMatch(
      /^Copied 6 of 8 files in 2 organizations; 0 already in the object store, 1 missing .*, 1 not matching their record, 0 failed/,
    );
    expect(s3.objects.get(`prod/orgs/${row.storageKey}`)).toEqual(Buffer.from(bytes));
    await t.db.delete(schema.files).where(eq(schema.files.id, lastId));
  });
});
