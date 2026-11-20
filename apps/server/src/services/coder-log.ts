import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { currentWorkspace, forEachWorkspace } from '../db/scope.js';
import { blobStore, isStorageError, type BlobStore } from '../storage/index.js';
import { storageProblem } from './files.js';

// A coding session's log: the CLI's raw output, which the runner writes and
// `GET /coding-sessions/{id}/log` serves (its last 2 MB, the widget's "View
// log"). It is history, not the live view: the feed and the transcript reach
// the apps through the database and the event bus (coder-state.ts), so the
// log only has to be readable from whichever server answers the request.
//
// With the `local` storage driver it is what it always was: one file,
// `<filesDir>/coders/<session id>.log`, appended line by line, read from
// the end, on the machine that ran the session.
//
// With the `s3` driver several machines share one object store, and an
// object cannot be appended to. The writer appends to a spool file on its
// own disk, `<filesDir>/coders/<session id>.<offset>.spool` (the offset in
// the log where the spool starts), and stores what it holds as numbered
// parts, each written once under the session's organization:
// `<organization>/coderlog_<session id>_<offset, 12 digits>`. A part is
// stored once LOG_PART_BYTES are waiting, or LOG_PART_MS after the first
// byte that is waiting (for the first LOG_TIMED_PARTS_MAX parts of a
// session; after that only by size), and at the end of the run, when the
// spool is removed. So:
//
// - a reader on any machine sees the log up to the last stored part, and
//   the reader on the writer's machine sees the spool after it too;
// - a machine that dies mid-session loses at most what was waiting: under
//   LOG_PART_BYTES, or LOG_PART_MS of output. Its spool, if the disk
//   survives, is stored when the session next runs there or when the worker
//   starts there again (`storeLeftoverSpools`);
// - a read lists the session's parts (one request a thousand parts) and
//   reads only those that hold the last bytes asked for, at most
//   LOG_READ_PARTS_MAX of them; memory is the bytes returned.
//
// Keys and paths are made from the session's id and organization, never
// from anything a person typed, and no log line names the log's content.
// Storage calls are never made inside a database transaction.

/** The most a session log grows to; the writer writes SESSION_LOG_FULL once and stops. */
export const SESSION_LOG_MAX = 8 * 1024 * 1024;
export const SESSION_LOG_FULL = '[openbots] The session log reached 8 MB; later output is not kept';

/** A part is stored once this much is waiting in the spool. */
export const LOG_PART_BYTES = 1024 * 1024;
/** ... or this long after the first byte that is waiting. */
export const LOG_PART_MS = 30_000;
/** Parts stored by time, per session; after these, only by size and at the end of a run. */
export const LOG_TIMED_PARTS_MAX = 64;
/** The most parts one read fetches; older output past these is left out. */
export const LOG_READ_PARTS_MAX = 128;

type LogDeps = Pick<AppDeps, 'config' | 'logger'>;
type SweepDeps = Pick<AppDeps, 'config' | 'logger' | 'db'>;

/** The session a log belongs to: its id and its organization. */
export interface LogSession {
  id: string;
  workspaceId: string;
}

export interface LogWriterOptions {
  partBytes?: number;
  partMs?: number;
}

const PART_PREFIX = 'coderlog_';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_KEY = /^coderlog_([0-9a-f-]{36})_(\d{12})$/;

const codersDir = (deps: LogDeps) => path.join(deps.config.filesDir, 'coders');

/** Where a session's log is on the server with the local driver. */
export function sessionLogPath(
  deps: { config: Pick<AppDeps['config'], 'filesDir'> },
  sessionId: string,
): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) throw new Error('Not a session id');
  return path.join(deps.config.filesDir, 'coders', `${sessionId}.log`);
}

function checkSession(session: LogSession) {
  if (!SESSION_ID.test(session.id)) throw new Error('Not a session id');
}

/** The object store the log goes to, or null with the local driver. */
function logStore(deps: LogDeps): BlobStore | null {
  return deps.config.storage.driver === 's3' ? blobStore(deps.config) : null;
}

const partPrefix = (sessionId: string) => `${PART_PREFIX}${sessionId}_`;

const partRef = (session: LogSession, offset: number) => ({
  workspaceId: session.workspaceId,
  storageKey: `${session.workspaceId}/${partPrefix(session.id)}${String(offset).padStart(12, '0')}`,
});

interface Part {
  offset: number;
  size: number;
  storageKey: string;
}

/** The session's stored parts, by offset. */
async function listParts(store: BlobStore, session: LogSession): Promise<Part[]> {
  const listed = await store.list(session.workspaceId, partPrefix(session.id));
  const parts: Part[] = [];
  for (const blob of listed) {
    const match = PART_KEY.exec(blob.storageKey.slice(session.workspaceId.length + 1));
    if (match && match[1] === session.id) {
      parts.push({ offset: Number(match[2]), size: blob.size, storageKey: blob.storageKey });
    }
  }
  return parts.sort((a, b) => a.offset - b.offset);
}

const storedEnd = (parts: Part[]) => parts.reduce((end, p) => Math.max(end, p.offset + p.size), 0);

async function storePart(store: BlobStore, session: LogSession, offset: number, bytes: Buffer) {
  await store.put(partRef(session, offset), bytes, {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

interface Spool {
  file: string;
  /** Where in the log the file starts. */
  base: number;
}

/**
 * The session's spools on this machine, by offset: `<id>.<offset>.spool`,
 * and `<id>.log`, a log from before the s3 driver, which starts the log.
 */
async function localSpools(deps: LogDeps, sessionId: string): Promise<Spool[]> {
  const dir = codersDir(deps);
  const names = await readdir(dir).catch(() => [] as string[]);
  const spools: Spool[] = [];
  for (const name of names) {
    if (name === `${sessionId}.log`) spools.push({ file: path.join(dir, name), base: 0 });
    const match = /^([0-9a-f-]{36})\.(\d{1,12})\.spool$/.exec(name);
    if (match && match[1] === sessionId) {
      spools.push({ file: path.join(dir, name), base: Number(match[2]) });
    }
  }
  return spools.sort((a, b) => a.base - b.base);
}

/** `length` bytes of a file from `position` (fewer when it is shorter). */
async function readRange(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const out = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await handle.read(out, 0, out.length, position);
    return out.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const fileSize = (file: string) =>
  stat(file).then(
    (info) => info.size,
    () => 0,
  );

/**
 * Stores what the session's spools on this machine hold past the stored
 * log, then removes them: a spool a run left behind (the process ended
 * before its last part was stored), or a log from before the s3 driver.
 */
async function storeSpools(deps: LogDeps, store: BlobStore, session: LogSession): Promise<number> {
  let stored = 0;
  for (const spool of await localSpools(deps, session.id)) {
    const end = storedEnd(await listParts(store, session));
    const size = await fileSize(spool.file);
    if (spool.base + size > end) {
      const from = Math.max(end, spool.base);
      const bytes = await readRange(spool.file, from - spool.base, spool.base + size - from);
      if (bytes.byteLength) {
        await storePart(store, session, from, bytes);
        stored++;
      }
    }
    await rm(spool.file, { force: true });
  }
  return stored;
}

/**
 * Appends a session's log for one run of it. `open` makes one, `write`
 * adds a line (at SESSION_LOG_MAX, one marker line and nothing more), and
 * `close` waits for every write and, with the s3 driver, stores the rest.
 */
export class SessionLogWriter {
  /** The log's size, all runs together: what the cap counts. */
  bytes = 0;
  full = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Spool bytes written, and how many of them are stored (s3 only). */
  private spooled = 0;
  private uploaded = 0;
  private uploads: Promise<unknown> = Promise.resolve();
  private flushQueued = false;
  private timer: NodeJS.Timeout | null = null;
  private timedLeft = 0;
  private closed = false;

  private constructor(
    private readonly deps: LogDeps,
    private readonly session: LogSession,
    /** The file appended: the log itself (local), or the spool (s3). */
    readonly file: string,
    private readonly store: BlobStore | null,
    /** Where the spool starts in the log (s3). */
    private readonly base: number,
    private readonly partBytes: number,
    private readonly partMs: number,
  ) {}

  static async open(
    deps: LogDeps,
    session: LogSession,
    options: LogWriterOptions = {},
  ): Promise<SessionLogWriter> {
    checkSession(session);
    await mkdir(codersDir(deps), { recursive: true });
    const partBytes = options.partBytes ?? LOG_PART_BYTES;
    const partMs = options.partMs ?? LOG_PART_MS;
    const store = logStore(deps);
    if (!store) {
      const file = sessionLogPath(deps, session.id);
      const writer = new SessionLogWriter(deps, session, file, null, 0, partBytes, partMs);
      writer.bytes = await fileSize(file);
      writer.full = writer.bytes >= SESSION_LOG_MAX;
      return writer;
    }
    // A run on this machine that ended before storing everything comes first.
    await storeSpools(deps, store, session);
    const parts = await listParts(store, session);
    const base = storedEnd(parts);
    const file = path.join(codersDir(deps), `${session.id}.${base}.spool`);
    await writeFile(file, '', { flag: 'a' });
    const writer = new SessionLogWriter(deps, session, file, store, base, partBytes, partMs);
    writer.bytes = base;
    writer.full = base >= SESSION_LOG_MAX;
    writer.timedLeft = Math.max(0, LOG_TIMED_PARTS_MAX - parts.length);
    return writer;
  }

  /** Where the log is on this server's disk, with the local driver; null with s3. */
  get localPath(): string | null {
    return this.store ? null : this.file;
  }

  write(line: string): void {
    if (this.full || this.closed) return;
    let text = `${line}\n`;
    if (this.bytes + Buffer.byteLength(text) > SESSION_LOG_MAX) {
      this.full = true;
      text = `${SESSION_LOG_FULL}\n`;
    }
    const length = Buffer.byteLength(text);
    this.bytes += length;
    this.chain = this.chain
      .then(() => appendFile(this.file, text))
      .then(() => {
        this.spooled += length;
        this.schedule();
      })
      .catch((error: unknown) =>
        this.deps.logger.warn(
          { err: error, sessionId: this.session.id },
          'session log not written',
        ),
      );
  }

  /** Stores a part now when enough is waiting, or later when some is. */
  private schedule() {
    if (!this.store || this.closed) return;
    const waiting = this.spooled - this.uploaded;
    if (waiting >= this.partBytes) {
      this.clearTimer();
      this.flush();
    } else if (waiting > 0 && !this.timer && this.timedLeft > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.timedLeft--;
        this.flush();
      }, this.partMs);
      this.timer.unref?.();
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queues storing what is waiting, once: a flush already queued takes it all. */
  private flush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.uploads = this.uploads.then(async () => {
      this.flushQueued = false;
      await this.storeWaiting().catch((error: unknown) =>
        // Kept in the spool: the next part, or the end of the run, tries again.
        this.deps.logger.warn(
          { err: error, sessionId: this.session.id },
          'session log part not stored',
        ),
      );
    });
  }

  /** Stores the spool's bytes past the last part as the next part. */
  private async storeWaiting() {
    const end = this.spooled;
    if (!this.store || end <= this.uploaded) return;
    const bytes = await readRange(this.file, this.uploaded, end - this.uploaded);
    await storePart(this.store, this.session, this.base + this.uploaded, bytes);
    this.uploaded += bytes.byteLength;
  }

  /**
   * Waits for every write. With the s3 driver, stores the rest and removes
   * the spool; a spool that could not be stored stays for the next run on
   * this machine, or the worker's next start here, to store.
   */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    this.clearTimer();
    if (!this.store) return;
    await this.uploads;
    try {
      await this.storeWaiting();
      await rm(this.file, { force: true });
    } catch (error) {
      this.deps.logger.warn(
        { err: error, sessionId: this.session.id },
        'session log kept on this server to store later',
      );
    }
  }
}

/** The last `maxBytes` of a session's log; empty when it has none. */
export async function readSessionLog(
  deps: LogDeps,
  session: LogSession,
  maxBytes: number,
): Promise<string> {
  const store = logStore(deps);
  if (!store) return readLocalTail(sessionLogPath(deps, session.id), maxBytes);
  checkSession(session);
  try {
    return await readStoredTail(deps, store, session, maxBytes);
  } catch (error) {
    throw storageProblem(error);
  }
}

async function readLocalTail(file: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(size, Math.floor(maxBytes)));
    const out = Buffer.alloc(length);
    await handle.read(out, 0, length, size - length);
    return out.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** A run of the log: a stored part, or the part of a spool on this machine past the store. */
interface Piece {
  start: number;
  size: number;
  read(from: number, length: number): Promise<Buffer>;
}

async function readStoredTail(
  deps: LogDeps,
  store: BlobStore,
  session: LogSession,
  maxBytes: number,
): Promise<string> {
  const parts = await listParts(store, session);
  const end = storedEnd(parts);
  const candidates: Piece[] = parts.map((part) => ({
    start: part.offset,
    size: part.size,
    read: async (from, length) => {
      try {
        const ref = { workspaceId: session.workspaceId, storageKey: part.storageKey };
        return await buffer(await store.get(ref, { offset: from, length }));
      } catch (error) {
        // Removed since the listing (Discard): read as nothing.
        if (isStorageError(error, 'not_found')) return Buffer.alloc(0);
        throw error;
      }
    },
  }));
  // The writer's machine (or one with a log from before the s3 driver) has more.
  for (const spool of await localSpools(deps, session.id)) {
    const size = await fileSize(spool.file);
    if (spool.base + size <= end) continue;
    const start = Math.max(end, spool.base);
    candidates.push({
      start,
      size: spool.base + size - start,
      read: (from, length) =>
        readRange(spool.file, start - spool.base + from, length).catch(() => Buffer.alloc(0)),
    });
  }
  // In order, each byte from the first piece that has it: overlaps (a part
  // stored again after an unclear failure) are read once, gaps (a machine
  // lost) are skipped.
  candidates.sort((a, b) => a.start - b.start);
  const pieces: { piece: Piece; skip: number; size: number }[] = [];
  let cursor = 0;
  for (const piece of candidates) {
    const from = Math.max(cursor, piece.start);
    const size = piece.start + piece.size - from;
    if (size <= 0) continue;
    pieces.push({ piece, skip: from - piece.start, size });
    cursor = from + size;
  }
  // The newest pieces that hold the last `maxBytes`.
  let wanted = Math.max(0, Math.floor(maxBytes));
  const reads: Promise<Buffer>[] = [];
  for (let i = pieces.length - 1; i >= 0 && wanted > 0 && reads.length < LOG_READ_PARTS_MAX; i--) {
    const { piece, skip, size } = pieces[i]!;
    const take = Math.min(size, wanted);
    wanted -= take;
    reads.unshift(piece.read(skip + size - take, take));
  }
  return Buffer.concat(await Promise.all(reads)).toString('utf8');
}

/** Removes a session's log: its parts in the store and its files on this server. */
export async function removeSessionLog(deps: LogDeps, session: LogSession): Promise<void> {
  const store = logStore(deps);
  if (!store) {
    await rm(sessionLogPath(deps, session.id), { force: true });
    return;
  }
  checkSession(session);
  for (const spool of await localSpools(deps, session.id)) await rm(spool.file, { force: true });
  for (const part of await listParts(store, session)) {
    await store.delete({ workspaceId: session.workspaceId, storageKey: part.storageKey });
  }
}

/**
 * At a worker's start with the s3 driver: stores the spools this machine
 * holds of sessions that are not running (a process that ended mid-run left
 * them), then removes them. One of a session still marked running is left
 * for its next run, or the next start, to store. Runs in an organization's
 * scope; spools of other organizations' sessions are left for their pass.
 */
export async function storeLeftoverSpools(
  deps: SweepDeps,
  running: (sessionId: string) => boolean = () => false,
): Promise<number> {
  const store = logStore(deps);
  const workspaceId = currentWorkspace();
  if (!store || !workspaceId) return 0;
  const names = await readdir(codersDir(deps)).catch(() => [] as string[]);
  const ids = [
    ...new Set(
      names
        .map((name) => /^([0-9a-f-]{36})\.\d{1,12}\.spool$/.exec(name)?.[1])
        .filter((id): id is string => !!id && SESSION_ID.test(id)),
    ),
  ];
  if (!ids.length) return 0;
  const rows = await deps.db
    .select({ id: schema.codingSessions.id, status: schema.codingSessions.status })
    .from(schema.codingSessions)
    .where(inArray(schema.codingSessions.id, ids));
  let stored = 0;
  for (const row of rows) {
    if (running(row.id) || ['starting', 'running', 'waiting'].includes(row.status)) continue;
    try {
      stored += await storeSpools(deps, store, { id: row.id, workspaceId });
    } catch (error) {
      deps.logger.warn({ err: error, sessionId: row.id }, 'session log spool not stored');
    }
  }
  return stored;
}

/**
 * Removes logs whose `coding_sessions` row is gone, in the current
 * organization's scope: files under `<filesDir>/coders/` on this server
 * (a log there is removed only when no organization has its session) and,
 * with the s3 driver, the organization's stored parts.
 */
export async function removeOrphanLogs(deps: SweepDeps): Promise<number> {
  let removed = 0;
  const dir = codersDir(deps);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = new Map<string, string[]>();
  for (const name of names) {
    const id = /^([0-9a-f-]{36})(?:\.log|\.\d{1,12}\.spool)$/i.exec(name)?.[1];
    if (id) files.set(id, [...(files.get(id) ?? []), name]);
  }
  if (files.size) {
    const here = await knownSessions(deps, [...files.keys()]);
    const unknown = [...files.keys()].filter((id) => !here.has(id));
    // A log of another organization's session is not this one's to judge.
    const elsewhere = unknown.length ? await knownAnywhere(deps, unknown) : new Set<string>();
    for (const id of unknown) {
      if (elsewhere.has(id)) continue;
      for (const name of files.get(id)!) await rm(path.join(dir, name), { force: true });
      removed++;
    }
  }
  const store = logStore(deps);
  const workspaceId = currentWorkspace();
  if (store && workspaceId) {
    const parts = await store.list(workspaceId, PART_PREFIX);
    const bySession = new Map<string, string[]>();
    for (const part of parts) {
      const id = PART_KEY.exec(part.storageKey.slice(workspaceId.length + 1))?.[1];
      if (id) bySession.set(id, [...(bySession.get(id) ?? []), part.storageKey]);
    }
    if (bySession.size) {
      const known = await knownSessions(deps, [...bySession.keys()]);
      for (const [id, keys] of bySession) {
        if (known.has(id)) continue;
        for (const storageKey of keys) await store.delete({ workspaceId, storageKey });
        removed++;
      }
    }
  }
  return removed;
}

async function knownSessions(deps: SweepDeps, ids: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await deps.db
      .select({ id: schema.codingSessions.id })
      .from(schema.codingSessions)
      .where(inArray(schema.codingSessions.id, ids.slice(i, i + 500)));
    for (const row of rows) known.add(row.id);
  }
  return known;
}

/** Which of `ids` any organization has, each looked for in that organization's scope. */
async function knownAnywhere(deps: SweepDeps, ids: string[]): Promise<Set<string>> {
  const found = await forEachWorkspace(deps.db, () => knownSessions(deps, ids));
  return new Set(found.flatMap((set) => [...set]));
}

/**
 * `openbots storage copy`: stores the logs this server keeps under
 * `<filesDir>/coders/` of one organization's sessions, each as the first
 * part of its log, unless the store has parts of it already. Never deletes.
 */
export async function copySessionLog(
  deps: { config: Pick<AppDeps['config'], 'filesDir'> },
  store: BlobStore,
  session: LogSession,
  dryRun: boolean,
): Promise<'copied' | 'present' | 'none'> {
  checkSession(session);
  const file = sessionLogPath(deps, session.id);
  const size = await fileSize(file);
  if (!size) return 'none';
  if ((await listParts(store, session)).length) return 'present';
  if (dryRun) return 'copied';
  await storePart(store, session, 0, await readRange(file, 0, size));
  return 'copied';
}
