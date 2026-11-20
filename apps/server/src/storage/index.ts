import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LocalBlobStore } from './local.js';
import { S3BlobStore } from './s3.js';

// Where stored files' bytes live (plan 4.8; services/files.ts is the only
// caller). Two drivers behind one narrow interface, made from the config:
//
// - `local` (the default): OPENBOTS_FILES_DIR on this machine, exactly as
//   before this module existed.
// - `s3`: an S3-compatible bucket (OPENBOTS_STORAGE_DRIVER=s3), so several
//   api and worker machines share one store.
//
// A blob is named by its `files` row: the organization and the row's
// `storage_key`, which the server generated (`<organization>/<uuid>`, or a
// bare `<uuid>` from before organizations). Nothing a user typed is ever part
// of where a blob lives or of a header sent to the store. The row, not the
// store, is the record of a blob's type, size and sha256.
//
// The methods are what the files service needs and no more: put (before the
// row is written), get (whole, or a byte range for `read_attachment`), head
// (the copy command's "already there?" and its check after a copy), and
// delete (a blob whose row was never written). `list` finds one
// organization's blobs by the start of their key: coding session logs
// (services/coder-log.ts) are kept as numbered parts with no row of their
// own, so their reader and the sweep of logs whose session is gone list
// them. Nothing deletes blobs in bulk yet; that comes with the deletion of
// an organization, by its key prefix.

/** A blob, as its `files` row names it. */
export interface BlobRef {
  workspaceId: string;
  storageKey: string;
}

/** A byte range: `length` bytes from `offset`. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface PutOptions {
  /** The exact length; the store refuses a body that is longer or shorter. */
  size: number;
  /** Hex sha256 of the body; the store refuses a body that does not match. */
  sha256: string;
  /** Base64 MD5 of a streamed body, when the caller has it (sent as Content-MD5). */
  md5?: string;
}

/** A blob `list` found: its full storage key (`<organization>/<key>`) and size. */
export interface ListedBlob {
  storageKey: string;
  size: number;
}

/** The bytes to store: whole, or a stream made fresh for each attempt. */
export type PutBody = Uint8Array | (() => Readable);

export interface BlobStore {
  readonly driver: 'local' | 's3';
  /** Stores the blob whole, or not at all: a reader never sees part of one. */
  put(ref: BlobRef, body: PutBody, options: PutOptions): Promise<void>;
  /** The blob's bytes; a `StorageError` with kind `not_found` when there is none. */
  get(ref: BlobRef, range?: ByteRange): Promise<Readable>;
  /** The blob's size, or null when there is none. */
  head(ref: BlobRef): Promise<{ size: number } | null>;
  /** Removes the blob; one that is already gone is not an error. */
  delete(ref: BlobRef): Promise<void>;
  /**
   * The organization's blobs whose key (after `<organization>/`) starts with
   * `keyPrefix`, in key order. The prefix is one the server made: two or
   * more of [A-Za-z0-9_-]. Bare keys from before organizations are not listed.
   */
  list(workspaceId: string, keyPrefix: string): Promise<ListedBlob[]>;
}

export type StorageErrorKind =
  /** No such blob. */
  | 'not_found'
  /** The store could not be reached or kept failing: worth trying again later. */
  | 'unavailable'
  /** The store refused the request (credentials, permissions, a bad request). */
  | 'rejected'
  /** The body did not have the size or checksum it was stored with. */
  | 'integrity'
  /** Larger than the store takes in one request. */
  | 'too_large';

/**
 * A storage failure. Its message names what went wrong (an HTTP status, an
 * S3 error code, an errno) and never the bucket, the endpoint, the key, a
 * path or a credential, so it may be logged or wrapped as it is.
 */
export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
    /** The store's HTTP status, when it answered with one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export const isStorageError = (error: unknown, kind?: StorageErrorKind): error is StorageError =>
  error instanceof StorageError && (!kind || error.kind === kind);

/** `<organization>/<key>`, or a bare `<key>` from before organizations. */
const STORAGE_KEY = /^(?:([0-9a-f-]{36})\/)?([A-Za-z0-9_-]+)$/;
const WORKSPACE_ID = /^[0-9a-f-]{36}$/;

/**
 * The parts of a blob's name, checked: the key must be one the server made,
 * and a key that names an organization must name the row's own.
 */
export function parseRef(ref: BlobRef): { workspaceId: string; inKey: boolean; key: string } {
  const match = STORAGE_KEY.exec(ref.storageKey);
  if (!match || !WORKSPACE_ID.test(ref.workspaceId)) {
    throw new StorageError('rejected', 'Malformed storage key');
  }
  const [, keyWorkspace, key] = match as unknown as [string, string | undefined, string];
  if (keyWorkspace && keyWorkspace !== ref.workspaceId) {
    throw new StorageError('rejected', 'Storage key belongs to another organization');
  }
  return { workspaceId: ref.workspaceId, inKey: !!keyWorkspace, key };
}

const KEY_PREFIX = /^[A-Za-z0-9_-]{2,200}$/;

/** Checks `list`'s arguments: an organization id and a prefix the server made. */
export function parseListing(workspaceId: string, keyPrefix: string): void {
  if (!WORKSPACE_ID.test(workspaceId) || !KEY_PREFIX.test(keyPrefix)) {
    throw new StorageError('rejected', 'Malformed storage key prefix');
  }
}

/** The store the config names; cheap to make, so made where it is needed. */
export function blobStore(config: Pick<Config, 'filesDir' | 'storage'>): BlobStore {
  return config.storage.driver === 's3'
    ? new S3BlobStore(config.storage)
    : new LocalBlobStore(config.filesDir);
}
