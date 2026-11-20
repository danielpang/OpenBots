import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import { AwsV4Signer } from 'aws4fetch';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isStorageError, StorageError, type BlobRef } from './index.js';
import { MAX_SINGLE_PUT, S3BlobStore, type S3Options, type S3StorageConfig } from './s3.js';
import { startTestS3, type TestS3 } from './test-s3.js';

// What the S3 driver adds to the contract (contract.test.ts): key shape,
// retries, deadlines and errors that name nothing secret.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = new TextEncoder().encode('object body');

describe('the S3 blob store', () => {
  let s3: TestS3;
  const workspaceId = randomUUID();
  const ref = (): BlobRef => ({ workspaceId, storageKey: `${workspaceId}/${randomUUID()}` });

  const config = (over: Partial<S3StorageConfig> = {}): S3StorageConfig => ({
    driver: 's3',
    bucket: s3.bucket,
    endpoint: s3.endpoint,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    prefix: '',
    pathStyle: true,
    ...over,
  });
  const store = (over: Partial<S3StorageConfig> = {}, options: S3Options = {}) =>
    new S3BlobStore(config(over), { backoffMs: 1, maxBackoffMs: 4, ...options });

  /** Nothing an operator keeps private, nor where the blob is, in a message. */
  const expectNothingSecret = (error: unknown, key?: string) => {
    expect(error).toBeInstanceOf(StorageError);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
    for (const secret of [
      s3.bucket,
      s3.endpoint,
      '127.0.0.1',
      s3.accessKeyId,
      s3.secretAccessKey,
    ]) {
      expect(text).not.toContain(secret);
    }
    if (key) expect(text).not.toContain(key);
    expect(text).not.toContain(workspaceId);
  };

  beforeAll(async () => {
    s3 = await startTestS3();
  });
  afterAll(() => s3.close());
  beforeEach(() => {
    s3.requests.length = 0;
  });

  it("keeps each organization's blobs under its own prefix, after the configured one", async () => {
    const bare = { workspaceId, storageKey: 'abcdef0123' };
    const r = ref();
    const prefixed = store({ prefix: 'openbots/prod/' });
    await prefixed.put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    await prefixed.put(bare, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    const uuid = r.storageKey.split('/')[1];
    expect([...s3.objects.keys()]).toEqual(
      expect.arrayContaining([
        `openbots/prod/orgs/${workspaceId}/${uuid}`,
        `openbots/prod/orgs/${workspaceId}/abcdef0123`,
      ]),
    );
  });

  it('addresses the bucket by path or by hostname', () => {
    const r = { workspaceId, storageKey: `${workspaceId}/k1` };
    const path = store({ endpoint: 'https://acct.r2.cloudflarestorage.com' });
    expect(path.url(path.key(r))).toBe(
      `https://acct.r2.cloudflarestorage.com/${s3.bucket}/orgs/${workspaceId}/k1`,
    );
    const host = store({ endpoint: 'https://s3.eu-west-1.amazonaws.com', pathStyle: false });
    expect(host.url(host.key(r))).toBe(
      `https://${s3.bucket}.s3.eu-west-1.amazonaws.com/orgs/${workspaceId}/k1`,
    );
  });

  it('sends only what the server made: the key, the length and checksums, a fixed type', async () => {
    const r = ref();
    await store().put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    const put = s3.requests.find((q) => q.method === 'PUT')!;
    expect(put.key).toBe(`orgs/${workspaceId}/${r.storageKey.split('/')[1]}`);
    expect(put.headers['content-type']).toBe('application/octet-stream');
    expect(put.headers['x-amz-content-sha256']).toBe(sha(bytes));
    expect(put.headers['content-md5']).toBe(createHash('md5').update(bytes).digest('base64'));
    expect(Object.keys(put.headers).filter((h) => h.startsWith('x-amz-meta'))).toEqual([]);
  });

  it('tries a 5xx, a 429 and a dropped connection again, and then succeeds', async () => {
    const r = ref();
    s3.fail(1, { status: 503, code: 'SlowDown' }, 'PUT');
    s3.fail(1, { status: 429 }, 'PUT');
    s3.fail(1, 'reset', 'PUT');
    await store().put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    expect(s3.requests.filter((q) => q.method === 'PUT')).toHaveLength(4);
    s3.fail(2, { status: 500, code: 'InternalError' }, 'GET');
    expect(new Uint8Array(await buffer(await store().get(r)))).toEqual(bytes);
  });

  it('gives up after its tries, as unavailable, naming nothing secret', async () => {
    const r = ref();
    s3.fail(3, { status: 503, code: 'SlowDown' });
    const error = await store({}, { attempts: 3 })
      .put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) })
      .catch((e: unknown) => e);
    expect(isStorageError(error, 'unavailable')).toBe(true);
    expect((error as Error).message).toBe('Object storage is unavailable (HTTP 503 SlowDown)');
    expect(s3.requests).toHaveLength(3);
    expectNothingSecret(error, r.storageKey);
  });

  it('does not try a 4xx again, and maps it', async () => {
    const r = ref();
    s3.fail(1, { status: 403, code: 'AccessDenied' });
    const denied = await store()
      .head(r)
      .catch((e: unknown) => e);
    expect(isStorageError(denied, 'rejected')).toBe(true);
    expect(s3.requests).toHaveLength(1);
    expectNothingSecret(denied, r.storageKey);

    s3.fail(1, { status: 400, code: 'EntityTooLarge' });
    const large = await store()
      .put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) })
      .catch((e: unknown) => e);
    expect(isStorageError(large, 'too_large')).toBe(true);
  });

  it('is refused with wrong credentials, and the message holds none of them', async () => {
    const r = ref();
    const wrong = store({ secretAccessKey: 'not-the-secret-0123456789' });
    const error = await wrong
      .put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) })
      .catch((e: unknown) => e);
    expect(isStorageError(error, 'rejected')).toBe(true);
    expect((error as Error).message).toContain('SignatureDoesNotMatch');
    expect((error as Error).message).not.toContain('not-the-secret');
    expectNothingSecret(error, r.storageKey);
  });

  it('names an errno, not the host, when the store cannot be reached', async () => {
    const r = ref();
    // A port nothing listens on: taken, then let go.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const gone = store({ endpoint: `http://127.0.0.1:${port}` }, { attempts: 2 });
    const error = await gone.head(r).catch((e: unknown) => e);
    expect(isStorageError(error, 'unavailable')).toBe(true);
    expect((error as Error).message).toBe('Object storage could not be reached (ECONNREFUSED)');
    expectNothingSecret(error, r.storageKey);
  });

  it('stops waiting at its deadline and tries again', async () => {
    const r = ref();
    await store().put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    s3.fail(1, { hang: 500 }, 'HEAD');
    expect(await store({}, { timeoutMs: 50 }).head(r)).toEqual({ size: bytes.byteLength });
    s3.fail(2, { hang: 500 }, 'HEAD');
    const error = await store({}, { timeoutMs: 50, attempts: 2 })
      .head(r)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Object storage did not answer in time');
  });

  it('cuts off a read whose body stalls', async () => {
    const stalled: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
        }),
        { status: 200 },
      );
    const stream = await store({}, { fetch: stalled, idleMs: 30 }).get(ref());
    const error = await buffer(stream).catch((e: unknown) => e);
    expect(isStorageError(error, 'unavailable')).toBe(true);
    expect((error as Error).message).toBe('Object storage stopped sending');
  });

  it('refuses a body over what one request takes before sending anything', async () => {
    const error = await store()
      .put(
        ref(),
        () => {
          throw new Error('never read');
        },
        { size: MAX_SINGLE_PUT + 1, sha256: sha(bytes) },
      )
      .catch((e: unknown) => e);
    expect(isStorageError(error, 'too_large')).toBe(true);
    expect(s3.requests).toHaveLength(0);
  });

  it('refuses a body changed on the way', async () => {
    // Same length, other bytes: the signed sha256 and Content-MD5 no longer match.
    const tamper: typeof fetch = (input, init) =>
      fetch(input, { ...init, body: new Uint8Array(bytes.byteLength).fill(120) });
    const error = await store({}, { fetch: tamper })
      .put(ref(), bytes, { size: bytes.byteLength, sha256: sha(bytes) })
      .catch((e: unknown) => e);
    expect(isStorageError(error, 'integrity')).toBe(true);
    expect((error as Error).message).toContain('XAmzContentSHA256Mismatch');
    expect(s3.requests).toHaveLength(1);
  });

  it('refuses the whole object in answer to a ranged read', async () => {
    const r = ref();
    const ten = new TextEncoder().encode('0123456789');
    await store().put(r, ten, { size: 10, sha256: sha(ten) });
    // A store (or a proxy on the way) that ignores Range answers 200 and everything.
    const ignoring: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('range');
      return fetch(input, { ...init, headers });
    };
    const error = await store({}, { fetch: ignoring })
      .get(r, { offset: 5, length: 3 })
      .then(buffer)
      .catch((e: unknown) => e);
    expect(isStorageError(error, 'unavailable')).toBe(true);
    expectNothingSecret(error, r.storageKey);
    // A 206 for other bytes than the ones asked for is refused too.
    const elsewhere: typeof fetch = async () =>
      new Response('012', { status: 206, headers: { 'content-range': 'bytes 0-2/10' } });
    const shifted = await store({}, { fetch: elsewhere })
      .get(r, { offset: 5, length: 3 })
      .catch((e: unknown) => e);
    expect(isStorageError(shifted, 'unavailable')).toBe(true);
    // The real answer, a 206 from the offset asked for, is read.
    expect((await buffer(await store().get(r, { offset: 5, length: 3 }))).toString()).toBe('567');
  });

  it('follows no redirect, and says where to look without naming the bucket or key', async () => {
    const r = ref();
    let reached = 0;
    const elsewhere = createHttpServer((_req, res) => {
      reached++;
      res.writeHead(200, { 'content-length': '5' });
      res.end('other');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const target = `http://localhost:${(elsewhere.address() as AddressInfo).port}/x`;
    const redirector = createHttpServer((_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    try {
      for (const call of [
        (s: S3BlobStore) => s.get(r).then(buffer),
        (s: S3BlobStore) => s.head(r),
        (s: S3BlobStore) => s.put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) }),
        (s: S3BlobStore) => s.delete(r),
      ]) {
        const error = await call(store({ endpoint })).catch((e: unknown) => e);
        expect(isStorageError(error, 'rejected')).toBe(true);
        expect((error as Error).message).toMatch(/redirect \(HTTP 307\).*OPENBOTS_S3_REGION/);
        expectNothingSecret(error, r.storageKey);
        expect((error as Error).message).not.toContain(endpoint);
      }
      expect(reached).toBe(0);
    } finally {
      elsewhere.close();
      redirector.close();
    }
  });

  it('reaches the bucket by its hostname, as AWS addresses it', async () => {
    // <bucket>.<host> does not resolve here: send it to the stand-in with that Host.
    const port = new URL(s3.endpoint).port;
    const byHostname: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe(`${s3.bucket}.storage.test`);
      const headers = {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        host: url.host,
      };
      const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: url.pathname, method: init?.method, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const empty = init?.method === 'HEAD' || res.statusCode === 204;
              resolve(
                new Response(empty ? null : Buffer.concat(chunks), {
                  status: res.statusCode!,
                  headers: res.headers as Record<string, string>,
                }),
              );
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    };
    const hosted = store(
      { endpoint: `http://storage.test:${port}`, pathStyle: false },
      { fetch: byHostname },
    );
    const r = ref();
    await hosted.put(r, bytes, { size: bytes.byteLength, sha256: sha(bytes) });
    const put = s3.requests.find((q) => q.method === 'PUT')!;
    expect(put.headers.host).toBe(`${s3.bucket}.storage.test:${port}`);
    expect(put.key).toBe(`orgs/${workspaceId}/${r.storageKey.split('/')[1]}`);
    expect(await hosted.head(r)).toEqual({ size: bytes.byteLength });
    expect((await buffer(await store().get(r))).toString()).toBe('object body');
  });

  it('is refused by the stand-in for an unsigned payload, even signed correctly otherwise', async () => {
    const url = `${s3.endpoint}/${s3.bucket}/orgs/${workspaceId}/unsigned`;
    const signed = await new AwsV4Signer({
      method: 'PUT',
      url,
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      body: bytes,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      service: 's3',
      region: s3.region,
    }).sign();
    const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes });
    expect(await res.text()).toContain('<Code>InvalidRequest</Code>');
    expect(res.status).toBe(400);
    expect(s3.objects.has(`orgs/${workspaceId}/unsigned`)).toBe(false);
  });
});
