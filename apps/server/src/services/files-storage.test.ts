import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { blobStore } from '../storage/index.js';
import { startTestS3, type TestS3 } from '../storage/test-s3.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';
import { attachmentServices, openFile, storeFile } from './files.js';

// The files service over each storage driver: what is stored where, a row
// from before organizations, a failed insert, and the store failing.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe.each(['local', 's3'] as const)('stored files with the %s driver', (driver) => {
  let t: TestApp;
  let s3: TestS3 | undefined;
  let dir: string;
  let owner: { id: string; workspaceId: string };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openbots-files-storage-'));
    s3 = driver === 's3' ? await startTestS3() : undefined;
    t = await createTestApp({
      OPENBOTS_FILES_DIR: dir,
      OPENBOTS_STORAGE_DRIVER: driver,
      ...(s3 ? s3.env('tenant-data') : {}),
    });
    await t.signUp('owner@example.com');
    owner = {
      id: await t.userId('owner@example.com'),
      workspaceId: (await ensureWorkspace(t.db)).id,
    };
  });
  afterAll(async () => {
    await t.close();
    await s3?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('names the blob by a key the server made, never by the name the user gave', async () => {
    const bytes = new TextEncoder().encode('hello');
    const row = await storeFile(t.ownerDeps, owner, {
      name: '../../orgs/other/evil\r\nx-amz-acl: public-read.txt',
      bytes,
      declaredMime: 'text/plain\r\nx-injected: 1',
      purpose: 'attachment',
    });
    expect(row.storageKey).toMatch(new RegExp(`^${owner.workspaceId}/[0-9a-f-]{36}$`));
    expect(row).toMatchObject({ size: 5, sha256: sha(bytes) });
    const { stream } = await openFile(t.ownerDeps, owner, row.id);
    expect((await buffer(stream)).toString()).toBe('hello');
    if (s3) {
      const put = s3.requests.find((q) => q.method === 'PUT')!;
      expect(put.key).toBe(`tenant-data/orgs/${row.storageKey}`);
      const sent = JSON.stringify(put.headers);
      expect(sent).not.toContain('evil');
      expect(sent).not.toContain('injected');
      expect(put.headers['content-type']).toBe('application/octet-stream');
    } else {
      expect(await readdir(path.join(dir, 'orgs', owner.workspaceId))).toHaveLength(1);
    }
  });

  it('reads ranges of an attachment for read_attachment', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const row = await storeFile(t.ownerDeps, owner, {
      name: 'n.txt',
      bytes,
      purpose: 'attachment',
    });
    const chat = { id: randomUUID(), ownerId: owner.id, workspaceId: owner.workspaceId };
    // The attachment must be referenced in the chat: check the store directly instead.
    const store = blobStore(t.deps.config);
    const part = await buffer(await store.get(row, { offset: 3, length: 4 }));
    expect(part.toString()).toBe('3456');
    // A file the chat never referenced is not found, whatever the store holds.
    await expect(attachmentServices(t.ownerDeps, chat, false).read(row.id)).rejects.toThrow(
      /No attachment/,
    );
  });

  it('loads a row from before organizations, whose key names no organization', async () => {
    const bytes = new TextEncoder().encode('an upload from an old install');
    const key = randomUUID().replace(/-/g, '');
    if (s3) {
      // After the copy command, the old row's blob sits under its organization.
      s3.objects.set(`tenant-data/orgs/${owner.workspaceId}/${key}`, Buffer.from(bytes));
    } else {
      // Where an install from before organizations wrote it.
      await mkdir(path.join(dir, key.slice(0, 2)), { recursive: true });
      await writeFile(path.join(dir, key.slice(0, 2), key), bytes);
    }
    const [row] = await t.db
      .insert(schema.files)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        name: 'old.txt',
        mime: 'text/plain',
        size: bytes.byteLength,
        storageKey: key,
        sha256: sha(bytes),
        purpose: 'attachment',
      })
      .returning();
    const { file, stream } = await openFile(t.ownerDeps, owner, row!.id);
    expect(file.storageKey).toBe(key);
    expect(new Uint8Array(await buffer(stream))).toEqual(bytes);
  });

  it('removes the blob when its row cannot be written', async () => {
    const bytes = new TextEncoder().encode('never recorded');
    const ghost = { id: randomUUID(), workspaceId: owner.workspaceId };
    // No such user: the row's foreign key refuses it.
    await expect(
      storeFile(t.ownerDeps, ghost, { name: 'x', bytes, purpose: 'attachment' }),
    ).rejects.toThrow();
    if (s3) {
      const put = s3.requests.filter((q) => q.method === 'PUT').at(-1)!;
      expect(s3.objects.has(put.key)).toBe(false);
      expect(s3.requests.at(-1)).toMatchObject({ method: 'DELETE', key: put.key });
    } else {
      const shards = await readdir(path.join(dir, 'orgs', owner.workspaceId));
      const rows = await t.db
        .select({ key: schema.files.storageKey })
        .from(schema.files)
        .where(eq(schema.files.workspaceId, owner.workspaceId));
      const onDisk = (
        await Promise.all(shards.map((s) => readdir(path.join(dir, 'orgs', owner.workspaceId, s))))
      ).flat();
      expect(onDisk.sort()).toEqual(
        rows
          .map((r) => r.key.split('/')[1])
          .filter((k): k is string => !!k)
          .sort(),
      );
    }
  });

  it.runIf(driver === 's3')(
    'answers 503 when the store is down, naming nothing about it',
    async () => {
      const bytes = new TextEncoder().encode('stored while up');
      const row = await storeFile(t.ownerDeps, owner, {
        name: 'a.txt',
        bytes,
        purpose: 'attachment',
      });
      // Every try of the one read (four by default).
      s3!.fail(4, { status: 503, code: 'SlowDown' });
      const error = await openFile(t.ownerDeps, owner, row.id).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      const text = (error as Error).message;
      for (const secret of [s3!.bucket, s3!.endpoint, s3!.secretAccessKey, row.storageKey]) {
        expect(text).not.toContain(secret);
      }
    },
  );

  it.runIf(driver === 's3')('answers 404 for a row whose object is missing', async () => {
    const bytes = new TextEncoder().encode('lost');
    const row = await storeFile(t.ownerDeps, owner, {
      name: 'b.txt',
      bytes,
      purpose: 'attachment',
    });
    s3!.objects.delete(`tenant-data/orgs/${row.storageKey}`);
    await expect(openFile(t.ownerDeps, owner, row.id)).rejects.toMatchObject({ status: 404 });
  });
});
