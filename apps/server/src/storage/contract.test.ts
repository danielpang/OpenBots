import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isStorageError, type BlobRef, type BlobStore } from './index.js';
import { LocalBlobStore } from './local.js';
import { S3BlobStore } from './s3.js';
import { startTestS3, type TestS3 } from './test-s3.js';

// One contract, run against each driver: what services/files.ts relies on.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const workspaceId = randomUUID();
const newRef = (): BlobRef => ({ workspaceId, storageKey: `${workspaceId}/${randomUUID()}` });
const bytesOf = (text: string) => new TextEncoder().encode(text);

/** A stream of `chunks`, made fresh for each attempt. */
const streamOf = (chunks: Uint8Array[]) => () => Readable.from(chunks.map((c) => Buffer.from(c)));

const drivers: [string, () => Promise<{ store: BlobStore; close(): Promise<void> }>][] = [
  [
    'local',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'openbots-blobs-'));
      return { store: new LocalBlobStore(dir), close: () => rm(dir, { recursive: true }) };
    },
  ],
  [
    's3',
    async () => {
      const s3: TestS3 = await startTestS3();
      const store = new S3BlobStore(
        {
          driver: 's3',
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          region: s3.region,
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          prefix: '',
          pathStyle: true,
        },
        { backoffMs: 1, maxBackoffMs: 2 },
      );
      return { store, close: () => s3.close() };
    },
  ],
];

describe.each(drivers)('the %s blob store', (_name, make) => {
  let store: BlobStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ store, close } = await make());
  });
  afterAll(() => close());

  it('stores bytes and reads them back whole', async () => {
    const ref = newRef();
    const bytes = bytesOf('hello, blob');
    await store.put(ref, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    expect(new Uint8Array(await buffer(await store.get(ref)))).toEqual(bytes);
    expect(await store.head(ref)).toEqual({ size: bytes.byteLength });
  });

  it('stores a streamed body of a known length', async () => {
    const ref = newRef();
    const parts = [bytesOf('first '), bytesOf('second '), bytesOf('third')];
    const all = Buffer.concat(parts);
    await store.put(ref, streamOf(parts), { size: all.byteLength, sha256: sha(all) });
    expect(await buffer(await store.get(ref))).toEqual(all);
  });

  it('reads a byte range, and an empty one past the end', async () => {
    const ref = newRef();
    const bytes = bytesOf('0123456789');
    await store.put(ref, bytes, { size: 10, sha256: sha(bytes) });
    expect((await buffer(await store.get(ref, { offset: 2, length: 3 }))).toString()).toBe('234');
    expect((await buffer(await store.get(ref, { offset: 8, length: 5 }))).toString()).toBe('89');
    expect((await buffer(await store.get(ref, { offset: 0, length: 0 }))).byteLength).toBe(0);
    expect((await buffer(await store.get(ref, { offset: 10, length: 4 }))).byteLength).toBe(0);
  });

  it('refuses a streamed body longer or shorter than its size, and keeps nothing', async () => {
    const long = newRef();
    const parts = [bytesOf('aaaa'), bytesOf('bbbb')];
    const all = Buffer.concat(parts);
    const tooLong = store.put(long, streamOf(parts), { size: 5, sha256: sha(all) });
    await expect(tooLong).rejects.toSatisfy((e) => isStorageError(e, 'integrity'));
    expect(await store.head(long)).toBeNull();

    const short = newRef();
    const tooShort = store.put(short, streamOf(parts), { size: 20, sha256: sha(all) });
    await expect(tooShort).rejects.toSatisfy((e) => isStorageError(e, 'integrity'));
    expect(await store.head(short)).toBeNull();
  });

  it('fails, keeping nothing, when the source breaks part way', async () => {
    const ref = newRef();
    const broken = () =>
      Readable.from(
        (async function* () {
          yield Buffer.from('start of it ');
          throw new Error('disk read failed');
        })(),
      );
    await expect(
      store.put(ref, broken, { size: 100, sha256: sha(bytesOf('x')) }),
    ).rejects.toBeTruthy();
    expect(await store.head(ref)).toBeNull();
  });

  it('refuses a body whose sha256 is not the one given', async () => {
    const ref = newRef();
    const bytes = bytesOf('the real bytes');
    const wrong = sha(bytesOf('other bytes'));
    await expect(
      store.put(ref, bytes, { size: bytes.byteLength, sha256: wrong }),
    ).rejects.toSatisfy((e) => isStorageError(e, 'integrity'));
    await expect(
      store.put(ref, streamOf([bytes]), { size: bytes.byteLength, sha256: wrong }),
    ).rejects.toSatisfy((e) => isStorageError(e, 'integrity'));
    expect(await store.head(ref)).toBeNull();
  });

  it('answers not found for a missing blob, and deletes one that is already gone', async () => {
    const ref = newRef();
    await expect(store.get(ref)).rejects.toSatisfy((e) => isStorageError(e, 'not_found'));
    expect(await store.head(ref)).toBeNull();
    await expect(store.delete(ref)).resolves.toBeUndefined();
  });

  it('deletes a blob', async () => {
    const ref = newRef();
    const bytes = bytesOf('short lived');
    await store.put(ref, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    await store.delete(ref);
    expect(await store.head(ref)).toBeNull();
    await expect(store.get(ref)).rejects.toSatisfy((e) => isStorageError(e, 'not_found'));
  });

  it('reads a bare key from before organizations', async () => {
    const ref = { workspaceId, storageKey: randomUUID().replace(/-/g, '') };
    const bytes = bytesOf('an old upload');
    await store.put(ref, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    expect(new Uint8Array(await buffer(await store.get(ref)))).toEqual(bytes);
  });

  it('refuses a key that is not one the server makes, or names another organization', async () => {
    const bytes = bytesOf('x');
    const options = { size: 1, sha256: sha(bytes) };
    for (const storageKey of ['../escape', 'a/b/c', `${workspaceId}/../x`, 'key with space', '']) {
      await expect(store.put({ workspaceId, storageKey }, bytes, options)).rejects.toSatisfy((e) =>
        isStorageError(e, 'rejected'),
      );
    }
    const other = { workspaceId, storageKey: `${randomUUID()}/${randomUUID()}` };
    await expect(store.get(other)).rejects.toSatisfy((e) => isStorageError(e, 'rejected'));
  });

  it("lists one organization's blobs by key prefix, with their sizes", async () => {
    const org = randomUUID();
    const other = randomUUID();
    const put = (ws: string, key: string, text: string) =>
      store.put({ workspaceId: ws, storageKey: `${ws}/${key}` }, bytesOf(text), {
        size: text.length,
        sha256: sha(bytesOf(text)),
      });
    await put(org, 'logpart_a_0001', 'one');
    await put(org, 'logpart_a_0002', 'three');
    await put(org, 'logpart_b_0001', 'other session');
    await put(org, 'notlisted', 'x');
    await put(other, 'logpart_a_0001', 'another organization');
    expect(await store.list(org, 'logpart_a_')).toEqual([
      { storageKey: `${org}/logpart_a_0001`, size: 3 },
      { storageKey: `${org}/logpart_a_0002`, size: 5 },
    ]);
    expect((await store.list(org, 'logpart_')).map((b) => b.storageKey)).toEqual([
      `${org}/logpart_a_0001`,
      `${org}/logpart_a_0002`,
      `${org}/logpart_b_0001`,
    ]);
    expect(await store.list(randomUUID(), 'logpart_')).toEqual([]);
    for (const prefix of ['', 'a', '../x', 'a/b', 'with space']) {
      await expect(store.list(org, prefix)).rejects.toSatisfy((e) => isStorageError(e, 'rejected'));
    }
    await expect(store.list('not-an-organization', 'logpart_')).rejects.toSatisfy((e) =>
      isStorageError(e, 'rejected'),
    );
  });

  it('keeps blobs of the same key in different organizations apart', async () => {
    const key = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const a = { workspaceId: first, storageKey: `${first}/${key}` };
    const b = { workspaceId: second, storageKey: `${second}/${key}` };
    await store.put(a, bytesOf('A'), { size: 1, sha256: sha(bytesOf('A')) });
    expect(await store.head(b)).toBeNull();
  });
});
