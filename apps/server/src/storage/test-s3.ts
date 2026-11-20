import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySigV4 } from './test-sigv4.js';

// An S3-compatible store in this process, for tests and for running the
// server against the s3 driver without a network (storage/s3.ts). It speaks
// PUT, GET (with Range), HEAD and DELETE for one bucket, and ListObjectsV2
// (GET on the bucket with list-type=2, prefix, max-keys, start-after and a
// continuation token), addressed by path
// (`<endpoint>/<bucket>/<key>`) or by bucket hostname (a Host of
// `<bucket>.<anything>`), and checks what a real store checks: the SigV4
// signature, verified by test-sigv4.ts (written from the specification and
// checked against AWS's own examples, sharing no code with the client's
// signer), with host, x-amz-content-sha256 and x-amz-date signed and the
// payload's sha256 signed (never UNSIGNED-PAYLOAD); the declared length; the
// sha256 itself; and Content-MD5. `fail` makes the next requests answer an
// error or drop the connection, `hold` stalls one until released, and
// `requests` records what was asked.

export interface TestS3 {
  /** The base URL, http://127.0.0.1:<port>. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** OPENBOTS_STORAGE_DRIVER=s3 and the OPENBOTS_S3_* settings for this store. */
  env(prefix?: string): Record<string, string>;
  /** Stored objects by key. */
  objects: Map<string, Buffer>;
  /** Every request: method, key and headers, in order. */
  requests: { method: string; key: string; headers: Record<string, string> }[];
  /**
   * The next `count` requests (of `method`, when given) answer `status` with
   * an S3 error document of `code`, or drop the connection (`'reset'`), or
   * answer only after `delayMs` (`'hang'`).
   */
  fail(
    count: number,
    how: { status: number; code?: string } | 'reset' | { hang: number },
    method?: string,
  ): void;
  /**
   * Holds the next request (of `method`, when given) until `release` is
   * called: `reached` settles when it has arrived. A stalled store, without
   * guessing how long a test needs.
   */
  hold(method?: string): { reached: Promise<void>; release(): void };
  /**
   * Holds the answer to the next listing (ListObjectsV2) until `release`:
   * the listing is taken when the request arrives and sent later, as a
   * slow network delivers an answer that is out of date by then.
   */
  holdListing(): { reached: Promise<void>; release(): void };
  /** Drops every failure `fail` set that is still to come: the store is back. */
  recover(): void;
  close(): Promise<void>;
}

const xmlError = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;

export async function startTestS3(
  options: { bucket?: string; region?: string } = {},
): Promise<TestS3> {
  const bucket = options.bucket ?? 'openbots-test';
  const region = options.region ?? 'auto';
  const accessKeyId = `AKIA${randomBytes(8).toString('hex').toUpperCase()}`;
  const secretAccessKey = randomBytes(30).toString('base64');
  const objects = new Map<string, Buffer>();
  const requests: TestS3['requests'] = [];
  const failures: {
    count: number;
    how: { status: number; code?: string } | 'reset' | { hang: number };
    method?: string;
  }[] = [];
  const holds: { method?: string; arrived: () => void; released: Promise<void> }[] = [];
  const listingHolds: { arrived: () => void; released: Promise<void> }[] = [];

  const answer = (res: ServerResponse, status: number, code?: string) => {
    const body = code ? xmlError(code) : '';
    res.writeHead(status, { 'content-type': 'application/xml', 'content-length': body.length });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://store');
    // By bucket hostname (<bucket>.<host>/<key>) or by path (<host>/<bucket>/<key>).
    const host = (req.headers.host ?? '').split(':')[0]!;
    const byHost = host.startsWith(`${bucket}.`);
    const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
    const first = byHost ? bucket : segments[0];
    const key = (byHost ? segments : segments.slice(1)).join('/');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    requests.push({ method: req.method ?? '', key, headers });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const held = holds.findIndex((h) => !h.method || h.method === req.method);
    if (held >= 0) {
      const [hold] = holds.splice(held, 1);
      hold!.arrived();
      await hold!.released;
    }
    const failure = failures.find((f) => f.count > 0 && (!f.method || f.method === req.method));
    if (failure) {
      failure.count--;
      if (failure.how === 'reset') return void req.socket.destroy();
      if ('hang' in failure.how) {
        await new Promise((resolve) => setTimeout(resolve, (failure.how as { hang: number }).hang));
      } else {
        return answer(res, failure.how.status, failure.how.code);
      }
    }
    const listing = !key && req.method === 'GET' && url.searchParams.get('list-type') === '2';
    if (first !== bucket || (!key && !listing)) return answer(res, 404, 'NoSuchBucket');
    const denied = verifySigV4(
      { method: req.method ?? '', url: req.url ?? '/', headers: req.headers },
      { accessKeyId, secretAccessKey, region },
    );
    if (denied) return answer(res, denied === 'InvalidRequest' ? 400 : 403, denied);

    if (listing) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const max = Math.min(1000, Number(url.searchParams.get('max-keys') ?? 1000) || 1000);
      // The token is the last key sent; start-after is a key to begin after.
      const after =
        url.searchParams.get('continuation-token') ?? url.searchParams.get('start-after') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      // The key itself as the token, escaped as XML, as a real store's opaque one would be.
      const escape = (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name>` +
        `<Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        page
          .map(
            (k) =>
              `<Contents><Key>${escape(k)}</Key><Size>${objects.get(k)!.byteLength}</Size></Contents>`,
          )
          .join('') +
        (truncated
          ? `<NextContinuationToken>${escape(page[page.length - 1]!)}</NextContinuationToken>`
          : '') +
        `</ListBucketResult>`;
      const answerHeld = listingHolds.shift();
      if (answerHeld) {
        answerHeld.arrived();
        await answerHeld.released;
      }
      res.writeHead(200, {
        'content-type': 'application/xml',
        'content-length': Buffer.byteLength(body),
      });
      return void res.end(body);
    }

    switch (req.method) {
      case 'PUT': {
        const length = Number(req.headers['content-length']);
        if (!Number.isFinite(length) || length !== body.byteLength) {
          return answer(res, 400, 'IncompleteBody');
        }
        // Signed, never UNSIGNED-PAYLOAD (verifySigV4 refused that already).
        if (
          req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')
        ) {
          return answer(res, 400, 'XAmzContentSHA256Mismatch');
        }
        const md5 = req.headers['content-md5'];
        if (md5 && md5 !== createHash('md5').update(body).digest('base64')) {
          return answer(res, 400, 'BadDigest');
        }
        objects.set(key, body);
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
        return void res.end();
      }
      case 'GET':
      case 'HEAD': {
        const object = objects.get(key);
        if (!object) return answer(res, 404, req.method === 'GET' ? 'NoSuchKey' : undefined);
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        let part = object;
        let status = 200;
        const extra: Record<string, string> = {};
        if (range) {
          const start = Number(range[1]);
          if (start >= object.byteLength) return answer(res, 416, 'InvalidRange');
          const end = Math.min(Number(range[2]), object.byteLength - 1);
          part = object.subarray(start, end + 1);
          status = 206;
          extra['content-range'] = `bytes ${start}-${end}/${object.byteLength}`;
        }
        res.writeHead(status, {
          'content-type': 'application/octet-stream',
          'content-length': part.byteLength,
          ...extra,
        });
        return void res.end(req.method === 'GET' ? part : undefined);
      }
      case 'DELETE':
        objects.delete(key);
        res.writeHead(204);
        return void res.end();
      default:
        return answer(res, 405, 'MethodNotAllowed');
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) answer(res, 500, 'InternalError');
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    objects,
    requests,
    env: (prefix) => ({
      OPENBOTS_STORAGE_DRIVER: 's3',
      OPENBOTS_S3_BUCKET: bucket,
      OPENBOTS_S3_ENDPOINT: endpoint,
      OPENBOTS_S3_REGION: region,
      OPENBOTS_S3_ACCESS_KEY_ID: accessKeyId,
      OPENBOTS_S3_SECRET_ACCESS_KEY: secretAccessKey,
      ...(prefix ? { OPENBOTS_S3_PREFIX: prefix } : {}),
    }),
    fail(count, how, method) {
      failures.push({ count, how, ...(method ? { method } : {}) });
    },
    recover() {
      failures.length = 0;
    },
    holdListing() {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      listingHolds.push({ arrived, released });
      return { reached, release };
    },
    hold(method) {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.push({ arrived, released, ...(method ? { method } : {}) });
      return { reached, release };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
