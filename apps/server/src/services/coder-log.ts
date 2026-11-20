import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { currentWorkspace, forEachWorkspace } from '../db/scope.js';
import { blobStore, isStorageError, type BlobStore, type ListedBlob } from '../storage/index.js';
import type { S3Options } from '../storage/s3.js';
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
// object cannot be appended to. Each run of a session has a writer id the
// server makes (12 hex digits). It appends to a spool file on its own disk,
// `<filesDir>/coders/<session id>.<offset>.<writer>.spool` (the offset in the
// log where the spool starts), and stores what it holds as parts, each
// written once under the session's organization:
// `<organization>/coderlog_<session id>_<offset, 12 digits>_<writer>`. Two
// writers that start at the same offset (a leftover spool stored on one
// machine while a new run starts on another) store two parts and neither
// overwrites the other; a reader orders parts by offset and takes each byte
// from the first that has it (the longer first at the same offset). Parts
// named `coderlog_<session id>_<offset>` from before the writer id still
// read. A part is stored once LOG_PART_BYTES are waiting, or LOG_PART_MS
// after the first byte that is waiting (for the first LOG_TIMED_PARTS_MAX
// parts of a session; after that only by size), and at the end of the run,
// when the spool is removed.
//
// The log is diagnostic, so the store is never in a run's way. Opening
// waits on it at most LOG_OPEN_MS: when it does not answer, the writer
// spools to `<session id>.pending.<writer>.spool` and finds its offset (and
// so the cap) once the store is back. A failure waits LOG_RETRY_MS before
// the next try, doubling to LOG_RETRY_MAX_MS, so a store that is down for a
// whole run is asked a few times, not once a part; warnings are at most one
// per LOG_WARN_MS. Closing tries once, for at most LOG_CLOSE_MS; a spool it
// could not store stays on disk for the next run of the session here or
// the worker's next start here (`storeLeftoverSpools`). So:
//
// - a reader on any machine sees the log up to the last stored part, and
//   the reader on the writer's machine sees the spool after it too;
// - a machine whose disk is lost mid-session loses what its spool held
//   that was not stored: under LOG_PART_BYTES, and for a session's first
//   LOG_TIMED_PARTS_MAX parts under LOG_PART_MS of output too, while the
//   store answers; everything since the store stopped answering (at most
//   the 8 MB cap) when it did not. A disk that survives loses nothing;
// - Discard removes the parts and this machine's spools and records the
//   time on the session (`log_discarded_at`); a spool another machine
//   last wrote before then is dropped, not stored;
// - a read lists the session's parts (one request a thousand parts) and
//   reads only those that hold the last bytes asked for, at most
//   LOG_READ_PARTS_MAX of them; memory is the bytes returned;
// - the sweep of parts whose session is gone reads at most LOG_SWEEP_PAGES
//   pages of an organization's parts at each worker start, from a random
//   place in them, so every start does a bounded amount and over starts it
//   reaches them all.
//
// Keys and paths are made from the session's id and organization and the
// writer id, never from anything a person typed, and no log line names the
// log's content. Storage calls are never made inside a database transaction.

/** The most a session log grows to; the writer writes SESSION_LOG_FULL once and stops. */
export const SESSION_LOG_MAX = 8 * 1024 * 1024;
export const SESSION_LOG_FULL = '[openbots] The session log reached 8 MB; later output is not kept';
const FULL_LINE = Buffer.from(`${SESSION_LOG_FULL}\n`);

/** A part is stored once this much is waiting in the spool. */
export const LOG_PART_BYTES = 1024 * 1024;
/** ... or this long after the first byte that is waiting. */
export const LOG_PART_MS = 30_000;
/** Parts stored by time, per session; after these, only by size and at the end of a run. */
export const LOG_TIMED_PARTS_MAX = 64;
/** The most parts one read fetches; older output past these is left out. */
export const LOG_READ_PARTS_MAX = 128;
/** The longest opening a log waits on the store before the run goes on without it. */
export const LOG_OPEN_MS = 5_000;
/** The longest the end of a run waits on the store for the rest of its log. */
export const LOG_CLOSE_MS = 5_000;
/** After the store fails, the wait before the writer asks it again; it doubles from here. */
export const LOG_RETRY_MS = 30_000;
/** ... up to this. */
export const LOG_RETRY_MAX_MS = 5 * 60_000;
/** At most one warning that the store failed the log in this long (per logger, so per process). */
export const LOG_WARN_MS = 60_000;
/** Pages of an organization's parts the sweep reads at one worker start. */
export const LOG_SWEEP_PAGES = 4;

/** The writer's store: a request is tried twice, and given up on sooner, than a file's. */
const WRITER_STORE: S3Options = { attempts: 2, maxBackoffMs: 1_000, timeoutMs: 10_000 };

type LogDeps = Pick<AppDeps, 'config' | 'logger'>;
type SweepDeps = Pick<AppDeps, 'config' | 'logger' | 'db'>;

/** The session a log belongs to: its id and its organization, and when Discard removed its log. */
export interface LogSession {
  id: string;
  workspaceId: string;
  logDiscardedAt?: Date | null;
}

export interface LogWriterOptions {
  partBytes?: number;
  partMs?: number;
  openMs?: number;
  closeMs?: number;
  /** The first wait after a failure (LOG_RETRY_MS). */
  retryMs?: number;
  /** How a line is appended to the file; tests make it fail part way. */
  append?: (file: string, text: string) => Promise<void>;
}

const PART_PREFIX = 'coderlog_';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A part: `coderlog_<session>_<offset>_<writer>`, or without the writer from before it. */
const PART_KEY = /^coderlog_([0-9a-f-]{36})_(\d{12})(?:_([0-9a-f]{12}))?$/;
/** A spool: `<session>.<offset>.<writer>.spool`, `<session>.pending.<writer>.spool`, or `<session>.<offset>.spool` from before. */
const SPOOL = /^([0-9a-f-]{36})\.(?:(\d{1,12})|pending)(?:\.([0-9a-f]{12}))?\.spool$/;

const codersDir = (deps: LogDeps) => path.join(deps.config.filesDir, 'coders');

/** A writer's id, which only the server makes. */
const newWriter = () => randomBytes(6).toString('hex');

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
function logStore(deps: LogDeps, options?: S3Options): BlobStore | null {
  return deps.config.storage.driver === 's3' ? blobStore(deps.config, options) : null;
}

const partPrefix = (sessionId: string) => `${PART_PREFIX}${sessionId}_`;

const partRef = (session: LogSession, offset: number, writer: string) => ({
  workspaceId: session.workspaceId,
  storageKey: `${session.workspaceId}/${partPrefix(session.id)}${String(offset).padStart(12, '0')}_${writer}`,
});

interface Part {
  offset: number;
  size: number;
  storageKey: string;
}

/** By offset; at the same offset the longer first, then by key: the order a reader takes them in. */
const byPlace = (a: Part, b: Part) =>
  a.offset - b.offset || b.size - a.size || (a.storageKey < b.storageKey ? -1 : 1);

/** The session's stored parts, in reading order. */
async function listParts(store: BlobStore, session: LogSession): Promise<Part[]> {
  const listed = await store.list(session.workspaceId, partPrefix(session.id));
  const parts: Part[] = [];
  for (const blob of listed) {
    const match = PART_KEY.exec(blob.storageKey.slice(session.workspaceId.length + 1));
    if (match && match[1] === session.id) {
      parts.push({ offset: Number(match[2]), size: blob.size, storageKey: blob.storageKey });
    }
  }
  return parts.sort(byPlace);
}

const storedEnd = (parts: Part[]) => parts.reduce((end, p) => Math.max(end, p.offset + p.size), 0);

async function storePart(
  store: BlobStore,
  session: LogSession,
  offset: number,
  writer: string,
  bytes: Buffer,
) {
  await store.put(partRef(session, offset, writer), bytes, {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/**
 * `bytes` that go at `from` in the log, cut at the cap as the writer cuts a
 * log: at the last whole line that fits, then the marker line. A run that
 * reached the cap already wrote its marker, which is let through.
 */
function capped(bytes: Buffer, from: number): Buffer {
  if (from + bytes.byteLength <= SESSION_LOG_MAX + FULL_LINE.byteLength) return bytes;
  const room = SESSION_LOG_MAX - from;
  if (room <= 0) return Buffer.alloc(0);
  const cut = bytes.subarray(0, room).lastIndexOf(0x0a) + 1;
  return Buffer.concat([bytes.subarray(0, cut), FULL_LINE]);
}

interface Spool {
  file: string;
  /** Where in the log the file starts; null for a spool whose place was not known yet. */
  base: number | null;
  /** The writer that made it; null for one from before writer ids. */
  writer: string | null;
  /** When it was last written. */
  mtimeMs: number;
}

/**
 * The session's spools on this machine, in log order: those whose place is
 * known by offset, and `<id>.log`, a log from before the s3 driver, which
 * starts the log; then those whose place was not known, oldest first.
 */
async function localSpools(deps: LogDeps, sessionId: string): Promise<Spool[]> {
  const dir = codersDir(deps);
  const names = await readdir(dir).catch(() => [] as string[]);
  const spools: Spool[] = [];
  for (const name of names) {
    let base: number | null;
    let writer: string | null = null;
    if (name === `${sessionId}.log`) {
      base = 0;
    } else {
      const match = SPOOL.exec(name);
      if (!match || match[1] !== sessionId) continue;
      base = match[2] === undefined ? null : Number(match[2]);
      writer = match[3] ?? null;
      if (base === null && !writer) continue;
    }
    const info = await lstat(path.join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    spools.push({ file: path.join(dir, name), base, writer, mtimeMs: info.mtimeMs });
  }
  return spools.sort((a, b) =>
    a.base === null || b.base === null
      ? (a.base === null ? 1 : 0) - (b.base === null ? 1 : 0) || a.mtimeMs - b.mtimeMs
      : a.base - b.base || a.mtimeMs - b.mtimeMs,
  );
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
 * before its last part was stored, or the store did not answer), or a log
 * from before the s3 driver. A spool last written before the session's log
 * was discarded is removed without being stored. `skip` is the file of the
 * writer asking, which is its own.
 */
async function storeSpools(
  deps: LogDeps,
  store: BlobStore,
  session: LogSession,
  skip?: string,
): Promise<number> {
  const discardedAt = session.logDiscardedAt?.getTime() ?? null;
  let stored = 0;
  for (const spool of await localSpools(deps, session.id)) {
    if (spool.file === skip) continue;
    if (discardedAt !== null && spool.mtimeMs <= discardedAt) {
      await rm(spool.file, { force: true });
      continue;
    }
    const end = storedEnd(await listParts(store, session));
    const size = await fileSize(spool.file);
    // A spool whose place was never known goes after what is stored.
    const start = spool.base ?? end;
    if (start + size > end) {
      const from = Math.max(end, start);
      const bytes = capped(await readRange(spool.file, from - start, start + size - from), from);
      if (bytes.byteLength) {
        await storePart(store, session, from, spool.writer ?? newWriter(), bytes);
        stored++;
      }
    }
    await rm(spool.file, { force: true });
  }
  return stored;
}

/** Settles true when `work` does within `ms`, false when it does not (it goes on). Never rejects. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const warned = new WeakMap<object, { at: number; suppressed: number }>();

/**
 * Warns about the log's storage at most once per LOG_WARN_MS for each
 * logger, saying how many were left out. The error is named by its storage
 * error message (which names no bucket, key or content) or its errno.
 */
function warnRarely(logger: LogDeps['logger'], error: unknown, sessionId: string, message: string) {
  const now = Date.now();
  const last = warned.get(logger);
  if (last && now - last.at < LOG_WARN_MS) {
    last.suppressed++;
    return;
  }
  const code = (error as { code?: unknown })?.code;
  logger.warn(
    {
      ...(isStorageError(error) ? { err: error } : typeof code === 'string' ? { code } : {}),
      sessionId,
      ...(last?.suppressed ? { suppressed: last.suppressed } : {}),
    },
    message,
  );
  warned.set(logger, { at: now, suppressed: 0 });
}

interface WriterSettings {
  partBytes: number;
  partMs: number;
  openMs: number;
  closeMs: number;
  retryMs: number;
  append: (file: string, text: string) => Promise<void>;
}

/**
 * Appends a session's log for one run of it. `open` makes one, `write`
 * adds a line (at SESSION_LOG_MAX, one marker line and nothing more), and
 * `close` waits for every write and, with the s3 driver, tries once,
 * briefly, to store the rest.
 */
export class SessionLogWriter {
  /** The log's size, all runs together, as far as it is known: what the cap counts. */
  bytes = 0;
  full = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bytes in the file, and how many of them are stored (s3 only). */
  private spooled = 0;
  private uploaded = 0;
  private uploads: Promise<unknown> = Promise.resolve();
  private flushQueued = false;
  private timer: NodeJS.Timeout | null = null;
  private timedLeft = LOG_TIMED_PARTS_MAX;
  private closed = false;
  /** The file could not be appended to or measured: nothing more is written. */
  private broken = false;
  private resolving: Promise<void> | null = null;
  /** No store request before this (after a failure), and the wait that set it. */
  private retryAt = 0;
  private backoff = 0;

  private constructor(
    private readonly deps: LogDeps,
    private readonly session: LogSession,
    /** The file appended: the log itself (local), or the spool (s3). */
    private path: string,
    private readonly store: BlobStore | null,
    /** Where the spool starts in the log; null (s3) until the store has said. */
    private base: number | null,
    private readonly settings: WriterSettings,
    private readonly writer: string,
  ) {}

  static async open(
    deps: LogDeps,
    session: LogSession,
    options: LogWriterOptions = {},
  ): Promise<SessionLogWriter> {
    checkSession(session);
    await mkdir(codersDir(deps), { recursive: true });
    const settings: WriterSettings = {
      partBytes: options.partBytes ?? LOG_PART_BYTES,
      partMs: options.partMs ?? LOG_PART_MS,
      openMs: options.openMs ?? LOG_OPEN_MS,
      closeMs: options.closeMs ?? LOG_CLOSE_MS,
      retryMs: options.retryMs ?? LOG_RETRY_MS,
      append: options.append ?? ((file, text) => appendFile(file, text)),
    };
    const store = logStore(deps, WRITER_STORE);
    if (!store) {
      const file = sessionLogPath(deps, session.id);
      const writer = new SessionLogWriter(deps, session, file, null, 0, settings, '');
      writer.spooled = await fileSize(file);
      writer.bytes = writer.spooled;
      writer.full = writer.bytes >= SESSION_LOG_MAX;
      return writer;
    }
    const id = newWriter();
    const file = path.join(codersDir(deps), `${session.id}.pending.${id}.spool`);
    await writeFile(file, '', { flag: 'a' });
    const writer = new SessionLogWriter(deps, session, file, store, null, settings, id);
    // Earlier runs' spools here first, then the log's end; the run goes on
    // without them when the store fails or is slow, and they follow later.
    const opening = writer.resolveBase().catch((error: unknown) => {
      writer.failed();
      warnRarely(
        deps.logger,
        error,
        session.id,
        'session log spooled on this server until storage answers',
      );
    });
    await within(opening, settings.openMs);
    return writer;
  }

  /** Where the log is on this server's disk, with the local driver; null with s3. */
  get localPath(): string | null {
    return this.store ? null : this.path;
  }

  /** The file appended. */
  get file(): string {
    return this.path;
  }

  write(line: string): void {
    if (this.full || this.closed || this.broken) return;
    void this.enqueue(() => this.append(line)).catch(() => {});
  }

  /** Runs `step` after every append before it, and before any after. */
  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.chain.then(step);
    this.chain = run.catch(() => {});
    return run;
  }

  private async append(line: string) {
    if (this.full || this.broken) return;
    let text = `${line}\n`;
    if ((this.base ?? 0) + this.spooled + Buffer.byteLength(text) > SESSION_LOG_MAX) {
      this.full = true;
      text = `${SESSION_LOG_FULL}\n`;
    }
    try {
      await this.settings.append(this.path, text);
      this.spooled += Buffer.byteLength(text);
    } catch (error) {
      // Some of it may be on disk (a full disk): the file's length is what counts.
      const size = await stat(this.path).then(
        (info) => info.size,
        () => null,
      );
      if (size === null) this.broken = true;
      else this.spooled = size;
      warnRarely(this.deps.logger, error, this.session.id, 'session log not written');
    }
    this.bytes = (this.base ?? 0) + this.spooled;
    this.schedule();
  }

  /** Finds where the spool goes in the log, once: earlier spools here stored, then the stored end. */
  private resolveBase(): Promise<void> {
    if (this.base !== null || !this.store) return Promise.resolve();
    this.resolving ??= this.findBase().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  private async findBase() {
    const store = this.store!;
    await storeSpools(this.deps, store, this.session, this.path);
    const parts = await listParts(store, this.session);
    const base = storedEnd(parts);
    await this.enqueue(() => this.placeAt(base, parts.length));
  }

  /** The spool's place is `base`: named for it, and cut at the cap if it ran past. */
  private async placeAt(base: number, partCount: number) {
    if (this.base !== null) return;
    const target = path.join(
      codersDir(this.deps),
      `${this.session.id}.${base}.${this.writer}.spool`,
    );
    await rename(this.path, target);
    this.path = target;
    this.base = base;
    this.timedLeft = Math.max(0, Math.min(this.timedLeft, LOG_TIMED_PARTS_MAX - partCount));
    if (base >= SESSION_LOG_MAX || base + this.spooled > SESSION_LOG_MAX + FULL_LINE.byteLength) {
      // Spooled before the place was known, past the cap: kept as a write would have kept it.
      const kept =
        base >= SESSION_LOG_MAX
          ? Buffer.alloc(0)
          : capped(await readRange(this.path, 0, this.spooled), base);
      await writeFile(this.path, kept);
      this.spooled = kept.byteLength;
      this.full = true;
    }
    this.bytes = base + this.spooled;
  }

  /** Stores a part now when enough is waiting, or later when some is; after a failure, not before the wait. */
  private schedule() {
    if (!this.store || this.closed) return;
    const waiting = this.spooled - this.uploaded;
    if (waiting <= 0) return;
    const wait = Math.max(0, this.retryAt - Date.now());
    if (waiting >= this.settings.partBytes) {
      if (!wait) {
        this.clearTimer();
        this.flush();
      } else if (!this.timer) {
        this.setTimer(wait, false);
      }
    } else if (!this.timer && this.timedLeft > 0) {
      this.setTimer(Math.max(wait, this.settings.partMs), true);
    }
  }

  private setTimer(ms: number, timed: boolean) {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (timed) this.timedLeft--;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queues storing what is waiting, once: a flush already queued takes it all. */
  private flush() {
    if (this.flushQueued || this.closed) return;
    this.flushQueued = true;
    this.uploads = this.uploads.then(async () => {
      this.flushQueued = false;
      // The end of the run stores the rest itself.
      if (this.closed) return;
      if (Date.now() < this.retryAt) return this.schedule();
      try {
        await this.storeWaiting();
        this.backoff = 0;
        this.retryAt = 0;
      } catch (error) {
        // Kept in the spool: a later part, or the end of the run, tries again.
        this.failed();
        warnRarely(this.deps.logger, error, this.session.id, 'session log part not stored');
      }
      this.schedule();
    });
  }

  /** A store request failed: none before a wait that doubles each time. */
  private failed() {
    const longest = Math.max(this.settings.retryMs, LOG_RETRY_MAX_MS);
    this.backoff = this.backoff ? Math.min(this.backoff * 2, longest) : this.settings.retryMs;
    this.retryAt = Date.now() + this.backoff;
  }

  /** Stores the spool's bytes past the last part as the next part. */
  private async storeWaiting() {
    if (!this.store) return;
    await this.resolveBase();
    const end = this.spooled;
    if (end <= this.uploaded) return;
    const bytes = await readRange(this.path, this.uploaded, end - this.uploaded);
    await storePart(this.store, this.session, this.base! + this.uploaded, this.writer, bytes);
    this.uploaded += bytes.byteLength;
  }

  /**
   * Waits for every write. With the s3 driver, tries once to store the
   * rest and remove the spool, for at most `closeMs`: the end of a run is
   * not held for the store. A try still on its way goes on and removes the
   * spool when it is done; a spool it could not store stays for the next
   * run on this machine, or the worker's next start here, to store.
   */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    this.clearTimer();
    if (!this.store) return;
    const finishing = this.uploads.then(() => this.finish());
    if (!(await within(finishing, this.settings.closeMs))) {
      warnRarely(
        this.deps.logger,
        null,
        this.session.id,
        'session log kept on this server to store later',
      );
    }
  }

  private async finish() {
    try {
      await this.storeWaiting();
      await rm(this.path, { force: true });
    } catch (error) {
      warnRarely(
        this.deps.logger,
        error,
        this.session.id,
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
    const base = spool.base ?? end;
    if (base + size <= end) continue;
    const start = Math.max(end, base);
    candidates.push({
      start,
      size: base + size - start,
      read: (from, length) =>
        readRange(spool.file, start - base + from, length).catch(() => Buffer.alloc(0)),
    });
  }
  // In order, each byte from the first piece that has it: overlaps (a part
  // stored again after an unclear failure, or two writers that started at
  // the same place) are read once, the longer piece at an offset first;
  // gaps (a machine lost) are skipped.
  const order = candidates.map((piece, i) => ({ piece, i }));
  order.sort((a, b) => a.piece.start - b.piece.start || b.piece.size - a.piece.size || a.i - b.i);
  const pieces: { piece: Piece; skip: number; size: number }[] = [];
  let cursor = 0;
  for (const { piece } of order) {
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

/**
 * Removes a session's log: its parts in the store and its files on this
 * server. Discard records the time on the session first, so a spool
 * another machine holds is dropped there rather than stored.
 */
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

/** The session ids of spools on this machine. */
async function spooledSessions(deps: LogDeps): Promise<string[]> {
  const names = await readdir(codersDir(deps)).catch(() => [] as string[]);
  return [
    ...new Set(
      names
        .map((name) => SPOOL.exec(name)?.[1])
        .filter((id): id is string => !!id && SESSION_ID.test(id)),
    ),
  ];
}

/**
 * At a worker's start with the s3 driver: stores the spools this machine
 * holds of sessions that are not running (a process that ended mid-run, or
 * a store that did not answer, left them), then removes them; those last
 * written before the session's log was discarded are removed unstored. One
 * of a session still marked running is left for its next run, or the next
 * start, to store. Runs in an organization's scope; spools of other
 * organizations' sessions are left for their pass.
 */
export async function storeLeftoverSpools(
  deps: SweepDeps,
  running: (sessionId: string) => boolean = () => false,
): Promise<number> {
  const store = logStore(deps);
  const workspaceId = currentWorkspace();
  if (!store || !workspaceId) return 0;
  const ids = await spooledSessions(deps);
  if (!ids.length) return 0;
  const rows = await deps.db
    .select({
      id: schema.codingSessions.id,
      status: schema.codingSessions.status,
      logDiscardedAt: schema.codingSessions.logDiscardedAt,
    })
    .from(schema.codingSessions)
    .where(inArray(schema.codingSessions.id, ids));
  let stored = 0;
  for (const row of rows) {
    if (running(row.id) || ['starting', 'running', 'waiting'].includes(row.status)) continue;
    try {
      stored += await storeSpools(deps, store, {
        id: row.id,
        workspaceId,
        logDiscardedAt: row.logDiscardedAt,
      });
    } catch (error) {
      warnRarely(deps.logger, error, row.id, 'session log spool not stored');
    }
  }
  return stored;
}

/**
 * One sweep of session logs over every organization (a worker's start):
 * the files on this server's disk are judged once in it, whichever
 * organization's pass comes first, not once per organization.
 */
export interface LogSweep {
  local: Promise<number> | null;
}

export const newLogSweep = (): LogSweep => ({ local: null });

export interface OrphanSweepOptions {
  sweep?: LogSweep;
  /** Pages of the organization's parts read in this pass (LOG_SWEEP_PAGES). */
  pages?: number;
  pageSize?: number;
}

/**
 * Removes logs whose `coding_sessions` row is gone: files under
 * `<filesDir>/coders/` on this server, once per sweep (a log there is
 * removed only when no organization has its session) and, with the s3
 * driver, the current organization's stored parts, at most `pages` pages
 * of them.
 */
export async function removeOrphanLogs(
  deps: SweepDeps,
  options: OrphanSweepOptions = {},
): Promise<number> {
  const sweep = options.sweep ?? newLogSweep();
  let removed = 0;
  if (!sweep.local) {
    sweep.local = removeOrphanLocalLogs(deps);
    removed += await sweep.local;
  }
  const store = logStore(deps);
  const workspaceId = currentWorkspace();
  if (store && workspaceId) {
    removed += await removeOrphanParts(
      deps,
      store,
      workspaceId,
      options.pages ?? LOG_SWEEP_PAGES,
      options.pageSize,
    );
  }
  return removed;
}

async function removeOrphanLocalLogs(deps: SweepDeps): Promise<number> {
  const dir = codersDir(deps);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = new Map<string, string[]>();
  for (const name of names) {
    const id = /^([0-9a-f-]{36})\.log$/.exec(name)?.[1] ?? SPOOL.exec(name)?.[1];
    if (id) files.set(id, [...(files.get(id) ?? []), name]);
  }
  if (!files.size) return 0;
  // A log of another organization's session is not to be removed.
  const known = await knownAnywhere(deps, [...files.keys()]);
  let removed = 0;
  for (const [id, list] of files) {
    if (known.has(id)) continue;
    for (const name of list) await rm(path.join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

/**
 * The organization's parts of sessions that are gone, removed a page at a
 * time: from a random place among the keys to their end, then from their
 * start back to that place, stopping after `pages` pages. Memory is a page.
 */
async function removeOrphanParts(
  deps: SweepDeps,
  store: BlobStore,
  workspaceId: string,
  pages: number,
  pageSize?: number,
): Promise<number> {
  const from = `${PART_PREFIX}${randomBytes(4).toString('hex')}`;
  const own = (blob: ListedBlob) => blob.storageKey.slice(workspaceId.length + 1);
  const gone = new Set<string>();
  const sweepPage = async (page: ListedBlob[]) => {
    const bySession = new Map<string, string[]>();
    for (const part of page) {
      const id = PART_KEY.exec(own(part))?.[1];
      if (id) bySession.set(id, [...(bySession.get(id) ?? []), part.storageKey]);
    }
    if (!bySession.size) return;
    const known = await knownSessions(deps, [...bySession.keys()]);
    for (const [id, keys] of bySession) {
      if (known.has(id)) continue;
      for (const storageKey of keys) await store.delete({ workspaceId, storageKey });
      gone.add(id);
    }
  };
  let left = Math.max(1, pages);
  const options = pageSize ? { pageSize } : {};
  for await (const page of store.listPages(workspaceId, PART_PREFIX, {
    ...options,
    startAfter: from,
  })) {
    await sweepPage(page);
    if (--left <= 0) return gone.size;
  }
  for await (const page of store.listPages(workspaceId, PART_PREFIX, options)) {
    const before = page.filter((blob) => own(blob) <= from);
    await sweepPage(before);
    if (before.length < page.length || --left <= 0) break;
  }
  return gone.size;
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
 * `openbots storage copy`: stores the log this server keeps under
 * `<filesDir>/coders/` of one of an organization's sessions: what the file
 * holds past what the store has of it, as a further part, so a copy run
 * again after the log grew (copy while running, stop, copy again) stores
 * the rest. `present` only when the store has all of it. Never deletes.
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
  const end = storedEnd(await listParts(store, session));
  if (end >= size) return 'present';
  if (dryRun) return 'copied';
  await storePart(store, session, end, newWriter(), await readRange(file, end, size - end));
  return 'copied';
}
