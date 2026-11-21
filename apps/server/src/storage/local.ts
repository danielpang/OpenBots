import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  StorageError,
  listAll,
  pageSizeOf,
  parseListing,
  parseRef,
  type BlobRef,
  type ListOptions,
  type ListedBlob,
  type BlobStore,
  type ByteRange,
  type PutBody,
  type PutOptions,
} from './index.js';

// The local driver: OPENBOTS_FILES_DIR on this machine, laid out as it always
// was. `orgs/<organization>/<first two characters>/<key>` for keys made since
// organizations (plan 21.3), `<first two characters>/<key>` for the bare keys
// from before. files-dir.ts keeps both out of reach of stdio MCP servers.
// Errors carry the errno only: a file system error's own message holds the
// path, which names the organization and the key.

export class LocalBlobStore implements BlobStore {
  readonly driver = 'local' as const;

  constructor(private readonly filesDir: string) {}

  /** Where a blob lives on disk. */
  path(ref: BlobRef): string {
    const { workspaceId, inKey, key } = parseRef(ref);
    // Two-character fan-out keeps any one directory small.
    return inKey
      ? path.join(this.filesDir, 'orgs', workspaceId, key.slice(0, 2), key)
      : path.join(this.filesDir, key.slice(0, 2), key);
  }

  async put(ref: BlobRef, body: PutBody, options: PutOptions): Promise<void> {
    const target = this.path(ref);
    const part = `${target}.part`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      // Write then rename, so a crash never leaves a half file under a real key.
      const source = body instanceof Uint8Array ? Readable.from([body]) : body();
      await pipeline(source, checked(options), createWriteStream(part));
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      throw localError(error);
    }
  }

  async get(ref: BlobRef, range?: ByteRange): Promise<Readable> {
    const target = this.path(ref);
    // Opened here, so a missing blob is an error now rather than in the stream.
    const handle = await open(target, 'r').catch((error: unknown) => {
      throw localError(error);
    });
    if (range && range.length <= 0) {
      await handle.close();
      return Readable.from([]);
    }
    return handle
      .createReadStream({
        ...(range ? { start: range.offset, end: range.offset + range.length - 1 } : {}),
      })
      .on('error', () => {});
  }

  async head(ref: BlobRef): Promise<{ size: number } | null> {
    try {
      return { size: (await stat(this.path(ref))).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw localError(error);
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    await rm(this.path(ref), { force: true }).catch((error: unknown) => {
      throw localError(error);
    });
  }

  list(workspaceId: string, keyPrefix: string): Promise<ListedBlob[]> {
    return listAll(this.listPages(workspaceId, keyPrefix));
  }

  async *listPages(
    workspaceId: string,
    keyPrefix: string,
    options: ListOptions = {},
  ): AsyncGenerator<ListedBlob[]> {
    parseListing(workspaceId, keyPrefix, options);
    const size = pageSizeOf(options);
    // Every key with the prefix shares its first two characters, so one shard holds them all.
    const shard = path.join(this.filesDir, 'orgs', workspaceId, keyPrefix.slice(0, 2));
    let names: string[];
    try {
      names = await readdir(shard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw localError(error);
    }
    const after = options.startAfter;
    const keys = names
      .filter((n) => n.startsWith(keyPrefix) && /^[A-Za-z0-9_-]+$/.test(n))
      .filter((n) => after === undefined || n > after)
      .sort();
    for (let i = 0; i < keys.length; i += size) {
      const page: ListedBlob[] = [];
      for (const name of keys.slice(i, i + size)) {
        // lstat: a symbolic link is not a blob, and is not followed.
        const info = await lstat(path.join(shard, name)).catch(() => null);
        if (info?.isFile()) page.push({ storageKey: `${workspaceId}/${name}`, size: info.size });
      }
      if (page.length) yield page;
    }
  }
}

/**
 * Passes the body through, failing it once it runs past `size` and, at its
 * end, when it is short or its sha256 is not `sha256`.
 */
export function checked({ size, sha256 }: PutOptions): Transform {
  const hash = createHash('sha256');
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.byteLength;
      if (seen > size) return done(new StorageError('integrity', 'Body is longer than its size'));
      hash.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      if (seen !== size)
        return done(new StorageError('integrity', 'Body is shorter than its size'));
      if (hash.digest('hex') !== sha256.toLowerCase()) {
        return done(new StorageError('integrity', 'Body does not match its sha256'));
      }
      done();
    },
  });
}

function localError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new StorageError('not_found', 'No such blob');
  return new StorageError(
    'unavailable',
    `Local file storage failed (${typeof code === 'string' ? code : 'error'})`,
  );
}
