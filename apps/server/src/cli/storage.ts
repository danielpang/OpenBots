import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { and, asc, eq, gt } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { forEachWorkspace } from '../db/scope.js';
import {
  blobStore,
  isStorageError,
  StorageError,
  type BlobRef,
  type BlobStore,
} from '../storage/index.js';
import { LocalBlobStore } from '../storage/local.js';
import type { CliContext, CliResult } from './context.js';

// `openbots storage copy [--dry-run]`: copies every stored file's blob from
// local disk (OPENBOTS_FILES_DIR) to the object store the configuration
// names (OPENBOTS_STORAGE_DRIVER=s3), for an install moving off local disk.
//
// It goes by the `files` rows, organization by organization, so what it
// copies is exactly what the server would read, under the same keys. Each
// blob is checked against its row before it is sent (its size, then its
// sha256), sent with that sha256 for the store to check, and looked up
// again afterwards. One already in the store at the right size is skipped,
// so the command can be stopped and run again, and run again after a
// later sync while the old server is still up. It reads the rows a page at
// a time by id, so a file uploaded while it runs is copied when its id
// sorts after the page being read, and otherwise by the next run (which is
// why the move to s3 ends with a run while the server is stopped). It never
// deletes anything, from either side. Lines name files by their id only.

export const STORAGE_USAGE = 'usage: openbots storage copy [--dry-run]';

const PAGE = 200;

interface Counts {
  organizations: number;
  files: number;
  copied: number;
  present: number;
  missing: number;
  mismatched: number;
  failed: number;
}

/**
 * AWS answers 403, not 404, for a key that is not there when the access key
 * may not list the bucket: what the copy's first lookup of every file sees.
 */
export const LIST_BUCKET_HINT =
  'object storage refused to look the file up (HTTP 403). On AWS, a missing object answers 403 unless the access key may list the bucket: give it s3:ListBucket on the bucket as well as object read, write and delete (docs/SELF_HOSTING.md)';

export async function runStorage(
  args: string[],
  ctx: CliContext,
  { pageSize = PAGE }: { pageSize?: number } = {},
): CliResult {
  const { config, write } = ctx;
  const [command, ...flags] = args;
  if (command !== 'copy' || flags.some((flag) => flag !== '--dry-run')) {
    write(STORAGE_USAGE);
    return 2;
  }
  const dryRun = flags.includes('--dry-run');
  if (config.storage.driver !== 's3') {
    write(
      'storage: copy sends files from OPENBOTS_FILES_DIR to an object store; set OPENBOTS_STORAGE_DRIVER=s3 and the OPENBOTS_S3_ settings first',
    );
    return 1;
  }
  const source = new LocalBlobStore(config.filesDir);
  const target = blobStore(config);
  const counts: Counts = {
    organizations: 0,
    files: 0,
    copied: 0,
    present: 0,
    missing: 0,
    mismatched: 0,
    failed: 0,
  };

  await forEachWorkspace(ctx.db, async (workspaceId) => {
    counts.organizations++;
    let after: string | undefined;
    for (;;) {
      const rows = await ctx.db
        .select({
          id: schema.files.id,
          workspaceId: schema.files.workspaceId,
          storageKey: schema.files.storageKey,
          size: schema.files.size,
          sha256: schema.files.sha256,
        })
        .from(schema.files)
        .where(
          and(
            eq(schema.files.workspaceId, workspaceId),
            after ? gt(schema.files.id, after) : undefined,
          ),
        )
        .orderBy(asc(schema.files.id))
        .limit(pageSize);
      for (const row of rows) {
        counts.files++;
        const outcome = await copyOne(source, target, row, dryRun).catch((error: unknown) => {
          if (!isStorageError(error)) throw error;
          return `failed: file ${row.id} (${error.message})`;
        });
        if (outcome === 'copied') counts.copied++;
        else if (outcome === 'present') counts.present++;
        else {
          if (outcome.startsWith('missing')) counts.missing++;
          else if (outcome.startsWith('mismatched')) counts.mismatched++;
          else counts.failed++;
          write(outcome);
        }
      }
      if (rows.length < pageSize) break;
      after = rows[rows.length - 1]!.id;
    }
  });

  const problems = counts.missing + counts.mismatched + counts.failed;
  write(
    `${dryRun ? 'Would copy' : 'Copied'} ${counts.copied} of ${plural(counts.files, 'file')} in ${plural(counts.organizations, 'organization')}; ` +
      `${counts.present} already in the object store, ${counts.missing} missing from ${config.filesDir}, ` +
      `${counts.mismatched} not matching their record, ${counts.failed} failed. Nothing was deleted.`,
  );
  if (counts.failed && !dryRun) write('Run the command again to retry the files that failed.');
  return problems ? 1 : 0;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Row = BlobRef & { id: string; size: number; sha256: string };

/** `copied`, `present`, or a line saying what is wrong with this file. */
async function copyOne(
  source: LocalBlobStore,
  target: BlobStore,
  row: Row,
  dryRun: boolean,
): Promise<string> {
  const there = await target.head(row).catch((error: unknown) => {
    if (isStorageError(error, 'rejected') && error.status === 403) {
      throw new StorageError('rejected', LIST_BUCKET_HINT, 403);
    }
    throw error;
  });
  if (there && there.size === row.size) return 'present';
  const here = await source.head(row);
  if (!here) return `missing: file ${row.id} is not on local disk`;
  if (here.size !== row.size) {
    return `mismatched: file ${row.id} is ${here.size} bytes on disk, ${row.size} in its record`;
  }
  // Read once to check it against its record (and for Content-MD5), then send it.
  const file = source.path(row);
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  try {
    for await (const chunk of createReadStream(file)) {
      sha256.update(chunk as Buffer);
      md5.update(chunk as Buffer);
    }
  } catch {
    return `failed: file ${row.id} could not be read from local disk`;
  }
  if (sha256.digest('hex') !== row.sha256.toLowerCase()) {
    return `mismatched: file ${row.id} on disk does not match the sha256 in its record`;
  }
  if (dryRun) return 'copied';
  await target.put(row, () => createReadStream(file), {
    size: row.size,
    sha256: row.sha256,
    md5: md5.digest('base64'),
  });
  const copied = await target.head(row);
  if (!copied || copied.size !== row.size) {
    return `failed: file ${row.id} is not in the object store at its size after the copy`;
  }
  return 'copied';
}
