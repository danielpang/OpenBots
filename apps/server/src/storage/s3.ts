import { createHash } from 'node:crypto';
import { pipeline, Readable } from 'node:stream';
import { AwsV4Signer } from 'aws4fetch';
import { checked } from './local.js';
import {
  StorageError,
  parseRef,
  type BlobRef,
  type BlobStore,
  type ByteRange,
  type PutBody,
  type PutOptions,
} from './index.js';

// The S3-compatible driver (OPENBOTS_STORAGE_DRIVER=s3): Cloudflare R2, AWS
// S3, MinIO or anything else that speaks the S3 API with SigV4. Requests are
// signed with aws4fetch (a SigV4 signer, no SDK) and sent with Node's fetch.
//
// - Keys: `<prefix>orgs/<organization>/<key>`, from the `files` row (see
//   index.ts), so one organization's blobs can be listed or removed by
//   prefix. A bare key from before organizations goes under its row's
//   organization too.
// - Uploads are one PUT of a known length (every blob is under the upload
//   limit, far below the 5 GiB a single PUT takes), signed over the body's
//   sha256, with Content-MD5 when known, so the store refuses a body that
//   changed on the way. A streamed body is counted and hashed as it goes.
// - Every request has a deadline; a read whose body stalls is cut off. A
//   network failure, a 5xx or a 429 is tried again, at most `attempts` times
//   with jittered exponential backoff; another 4xx is not.
// - Errors carry the HTTP status and the S3 error code only: never the
//   bucket, the endpoint, the key or a credential.
// - Content type and length are recorded on the row, not trusted from the
//   object: every object is sent as application/octet-stream.

export interface S3StorageConfig {
  driver: 's3';
  bucket: string;
  /** The service's base URL, such as https://<account>.r2.cloudflarestorage.com. */
  endpoint: string;
  /** `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Put before every key: empty, or path segments ending in `/`. */
  prefix: string;
  /** `https://endpoint/bucket/key` rather than `https://bucket.endpoint/key`. */
  pathStyle: boolean;
}

export interface S3Options {
  /** Tries per request, the first included. */
  attempts?: number;
  /** The first backoff; each later one doubles, up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Until the response's headers. A PUT gets a second more per MiB of body. */
  timeoutMs?: number;
  /** The longest a read's body may go without a byte. */
  idleMs?: number;
  fetch?: typeof fetch;
}

/** The most one PUT takes (S3 and R2 both stop near 5 GiB). */
export const MAX_SINGLE_PUT = 5 * 1024 ** 3;

const EMPTY_SHA256 = createHash('sha256').digest('hex');

/** Derived signing keys, by secret, date, region and service (aws4fetch's cache). */
const signingKeys = new Map<string, ArrayBuffer>();

type Body = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'stream'; make: () => Readable };

interface Send {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  key: string;
  headers?: Record<string, string>;
  body?: Body;
  /** The body's length, which lengthens the deadline. */
  size?: number;
}

export class S3BlobStore implements BlobStore {
  readonly driver = 's3' as const;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly config: S3StorageConfig,
    options: S3Options = {},
  ) {
    this.attempts = Math.max(1, options.attempts ?? 4);
    this.backoffMs = options.backoffMs ?? 200;
    this.maxBackoffMs = options.maxBackoffMs ?? 3_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.idleMs = options.idleMs ?? 60_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** The object's key in the bucket. */
  key(ref: BlobRef): string {
    const { workspaceId, key } = parseRef(ref);
    return `${this.config.prefix}orgs/${workspaceId}/${key}`;
  }

  /** The object's URL. Keys hold only [A-Za-z0-9/_-], so none needs escaping. */
  url(key: string): string {
    const base = new URL(this.config.endpoint);
    const root = base.pathname.replace(/\/+$/, '');
    if (this.config.pathStyle) {
      return `${base.origin}${root}/${this.config.bucket}/${key}`;
    }
    return `${base.protocol}//${this.config.bucket}.${base.host}${root}/${key}`;
  }

  async put(ref: BlobRef, body: PutBody, options: PutOptions): Promise<void> {
    if (options.size > MAX_SINGLE_PUT) {
      throw new StorageError('too_large', 'Larger than object storage takes in one request');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(options.size),
      'x-amz-content-sha256': options.sha256.toLowerCase(),
    };
    let sent: Body;
    if (body instanceof Uint8Array) {
      if (body.byteLength !== options.size) {
        throw new StorageError('integrity', 'Body is not the size given');
      }
      if (createHash('sha256').update(body).digest('hex') !== options.sha256.toLowerCase()) {
        throw new StorageError('integrity', 'Body does not match its sha256');
      }
      headers['content-md5'] = createHash('md5').update(body).digest('base64');
      sent = { kind: 'bytes', bytes: body };
    } else {
      if (options.md5) headers['content-md5'] = options.md5;
      // pipeline, not pipe: a source that fails fails the body too, rather than stalling it.
      sent = { kind: 'stream', make: () => pipeline(body(), checked(options), () => {}) };
    }
    const res = await this.send({
      method: 'PUT',
      key: this.key(ref),
      headers,
      body: sent,
      size: options.size,
    });
    if (!res.ok) throw await refused(res);
    await discard(res);
  }

  async get(ref: BlobRef, range?: ByteRange): Promise<Readable> {
    if (range && range.length <= 0) return Readable.from([]);
    const headers: Record<string, string> = range
      ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
      : {};
    const abort = new AbortController();
    const res = await this.send({ method: 'GET', key: this.key(ref), headers }, abort);
    if (res.status === 404) {
      await discard(res);
      throw new StorageError('not_found', 'No such blob');
    }
    if (res.status === 416) {
      // Past the end: the range is empty, as a read of the local file would be.
      await discard(res);
      return Readable.from([]);
    }
    if (!res.ok) throw await refused(res);
    if (!res.body) return Readable.from([]);
    return Readable.from(chunks(res.body, this.idleMs, abort), { objectMode: false });
  }

  async head(ref: BlobRef): Promise<{ size: number } | null> {
    const res = await this.send({ method: 'HEAD', key: this.key(ref) });
    if (res.status === 404) return null;
    if (!res.ok) throw await refused(res);
    await discard(res);
    return { size: Number(res.headers.get('content-length') ?? 0) };
  }

  async delete(ref: BlobRef): Promise<void> {
    const res = await this.send({ method: 'DELETE', key: this.key(ref) });
    // S3 answers 204 whether or not the object was there; some stores say 404.
    if (!res.ok && res.status !== 404) throw await refused(res);
    await discard(res);
  }

  /**
   * One request, tried again on a network failure, a 5xx or a 429. Answers
   * the first response that is neither; throws once the tries run out.
   * `abort`, when given, stops the answered request later: the caller
   * aborts it when the body stalls.
   */
  private async send(request: Send, abort?: AbortController): Promise<Response> {
    let last: StorageError = new StorageError('unavailable', 'Object storage did not answer');
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await sleep(this.backoff(attempt));
      const controller = new AbortController();
      const deadline =
        this.timeoutMs + (request.size ? Math.ceil(request.size / 1024 ** 2) : 0) * 1000;
      const timer = setTimeout(() => controller.abort(), deadline);
      let bodyError: unknown;
      try {
        const signed = await new AwsV4Signer({
          method: request.method,
          url: this.url(request.key),
          headers: { 'x-amz-content-sha256': EMPTY_SHA256, ...request.headers },
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
          service: 's3',
          region: this.config.region,
          cache: signingKeys,
        }).sign();
        if (signingKeys.size > 32) signingKeys.clear();
        let body: NonNullable<RequestInit['body']> | undefined;
        if (request.body?.kind === 'bytes')
          body = request.body.bytes as NonNullable<RequestInit['body']>;
        if (request.body?.kind === 'stream') {
          const stream = request.body.make();
          stream.on('error', (error) => (bodyError = error));
          body = Readable.toWeb(stream) as NonNullable<RequestInit['body']>;
        }
        const res = await this.fetch(signed.url, {
          method: signed.method,
          headers: signed.headers,
          body,
          signal: controller.signal,
          ...(body && request.body?.kind === 'stream' ? { duplex: 'half' } : {}),
        } as RequestInit);
        clearTimeout(timer);
        if (res.status >= 500 || res.status === 429) {
          last = await refused(res);
          await discard(res);
          continue;
        }
        // The caller reads the body; its abort (a stalled read) stops this request.
        if (abort) abort.signal.addEventListener('abort', () => controller.abort(), { once: true });
        return res;
      } catch (error) {
        clearTimeout(timer);
        if (bodyError instanceof StorageError) throw bodyError;
        if (error instanceof StorageError) throw error;
        last = new StorageError(
          'unavailable',
          controller.signal.aborted
            ? 'Object storage did not answer in time'
            : `Object storage could not be reached (${networkCode(error)})`,
        );
      }
    }
    throw last;
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }
}

/** A read's body as Buffers, failing it when it stalls for `idleMs` or breaks. */
async function* chunks(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  abort: AbortController,
): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new StorageError('unavailable', 'Object storage stopped sending'));
        }, idleMs);
      });
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), stall]);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError('unavailable', 'Object storage read failed');
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      yield Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Reads and drops a response's body, so its connection is free again. */
async function discard(res: Response) {
  await res.body?.cancel().catch(() => {});
}

/** A refusal as an error: its status and, when it is a plain word, its S3 code. */
async function refused(res: Response): Promise<StorageError> {
  let code = '';
  if (res.bodyUsed === false && res.body) {
    const text = await res.text().catch(() => '');
    code = /<Code>([A-Za-z][A-Za-z0-9]{0,63})<\/Code>/.exec(text)?.[1] ?? '';
  }
  const what = `HTTP ${res.status}${code ? ` ${code}` : ''}`;
  if (res.status >= 500 || res.status === 429) {
    return new StorageError('unavailable', `Object storage is unavailable (${what})`);
  }
  if (res.status === 404) return new StorageError('not_found', 'No such blob');
  if (res.status === 413 || code === 'EntityTooLarge') {
    return new StorageError('too_large', `Object storage refused the size (${what})`);
  }
  if (
    ['BadDigest', 'XAmzContentSHA256Mismatch', 'IncompleteBody', 'InvalidDigest'].includes(code)
  ) {
    return new StorageError('integrity', `Object storage refused the body (${what})`);
  }
  return new StorageError('rejected', `Object storage refused the request (${what})`);
}

/** An errno such as ECONNREFUSED from a fetch failure, never its message (it names the host). */
function networkCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  const code = cause?.code ?? (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'network error';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
