import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import type { AppDeps } from '../context.js';
import { generateMasterKey } from '../secrets.js';
import { DomainError } from '../errors.js';
import { blobStore } from '../storage/index.js';
import { startTestS3, type TestS3 } from '../storage/test-s3.js';
import {
  copySessionLog,
  LOG_TIMED_PARTS_MAX,
  readSessionLog,
  removeSessionLog,
  SESSION_LOG_FULL,
  SESSION_LOG_MAX,
  SessionLogWriter,
} from './coder-log.js';

// A coding session's log through each storage driver (coder-log.ts): what
// the runner writes, `GET /coding-sessions/{id}/log` reads. With the s3
// driver a second machine, sharing the store but not the disk, reads it as
// it is written, and a machine that stops mid-session loses at most its
// unstored tail. The runner and the routes end to end are in
// coder-log-runner.test.ts.

type Logger = AppDeps['logger'] & { calls: unknown[] };
type Deps = { config: Config; logger: Logger };

/** A logger that keeps what it was asked to log, to check no log content reaches it. */
function spyLogger(): Logger {
  const calls: unknown[] = [];
  const record = (...args: unknown[]) => void calls.push(args);
  return { calls, warn: record, info: record, error: record, debug: record } as unknown as Logger;
}

const machine = async (env: Record<string, string>): Promise<Deps & { dir: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openbots-coder-log-'));
  const config = loadConfig({
    OPENBOTS_MASTER_KEY: generateMasterKey(),
    DATABASE_URL: 'postgres://unused',
    OPENBOTS_FILES_DIR: dir,
    ...env,
  });
  return { config, logger: spyLogger(), dir };
};

const newSession = () => ({ id: randomUUID(), workspaceId: randomUUID() });

const drivers: [string, () => Promise<{ env: Record<string, string>; close(): Promise<void> }>][] =
  [
    ['local', async () => ({ env: {}, close: async () => {} })],
    [
      's3',
      async () => {
        const s3 = await startTestS3();
        return { env: s3.env(), close: () => s3.close() };
      },
    ],
  ];

describe.each(drivers)('a session log through the %s driver', (driver, make) => {
  let deps: Deps & { dir: string };
  let close: () => Promise<void>;

  beforeAll(async () => {
    const made = await make();
    close = made.close;
    deps = await machine(made.env);
    expect(deps.config.storage.driver).toBe(driver);
  });
  afterAll(async () => {
    await close();
    await rm(deps.dir, { recursive: true, force: true });
  });

  it('writes lines and reads back their tail; a session with none reads empty', async () => {
    const session = newSession();
    expect(await readSessionLog(deps, session, 100)).toBe('');
    const writer = await SessionLogWriter.open(deps, session);
    writer.write('first line');
    writer.write('second line');
    await writer.close();
    expect(await readSessionLog(deps, session, 12)).toBe('second line\n');
    expect(await readSessionLog(deps, session, 1_000)).toBe('first line\nsecond line\n');
  });

  it('continues the log where the last run left it, counting it toward the cap', async () => {
    const session = newSession();
    const first = await SessionLogWriter.open(deps, session);
    first.write('run one');
    await first.close();
    const second = await SessionLogWriter.open(deps, session);
    expect(second.bytes).toBe('run one\n'.length);
    second.write('run two');
    await second.close();
    expect(await readSessionLog(deps, session, 1_000)).toBe('run one\nrun two\n');
  });

  it('caps the log with one marker line', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(deps, session);
    const line = 'x'.repeat(1024 * 1024 - 1);
    for (let i = 0; i < 9; i++) writer.write(line);
    writer.write('never kept');
    await writer.close();
    const tail = await readSessionLog(deps, session, 2_000);
    expect(tail.endsWith(`${SESSION_LOG_FULL}\n`)).toBe(true);
    expect(tail.split(SESSION_LOG_FULL)).toHaveLength(2);
    const whole = await readSessionLog(deps, session, SESSION_LOG_MAX * 2);
    expect(Buffer.byteLength(whole)).toBe(8 * 1024 * 1024 + SESSION_LOG_FULL.length + 1);
    expect(whole).not.toContain('never kept');
    // A later run adds nothing.
    const again = await SessionLogWriter.open(deps, session);
    expect(again.full).toBe(true);
    again.write('after the cap');
    await again.close();
    expect(await readSessionLog(deps, session, 2_000)).toBe(tail);
  });

  it('removes the log, leaving nothing on disk', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(deps, session);
    writer.write('short lived');
    await writer.close();
    await removeSessionLog(deps, session);
    expect(await readSessionLog(deps, session, 100)).toBe('');
    const left = await readdir(path.join(deps.dir, 'coders'));
    expect(left.filter((name) => name.startsWith(session.id))).toEqual([]);
  });

  it('reads a log an older server left on its disk', async () => {
    const session = newSession();
    const file = path.join(deps.dir, 'coders', `${session.id}.log`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'from before\n');
    expect(await readSessionLog(deps, session, 100)).toBe('from before\n');
    // Continued: the run appends after it, and the whole log reads.
    const writer = await SessionLogWriter.open(deps, session);
    writer.write('continued');
    await writer.close();
    expect(await readSessionLog(deps, session, 100)).toBe('from before\ncontinued\n');
  });

  it('keeps the on-disk layout of the local driver exactly', async () => {
    if (driver !== 'local') return;
    const session = newSession();
    const writer = await SessionLogWriter.open(deps, session);
    expect(writer.localPath).toBe(path.join(deps.dir, 'coders', `${session.id}.log`));
    writer.write('here');
    await writer.close();
    expect(await readdir(path.join(deps.dir, 'coders'))).toContain(`${session.id}.log`);
  });

  it('refuses an id that is not a session id', async () => {
    const bad = { id: '../../etc/passwd', workspaceId: randomUUID() };
    await expect(SessionLogWriter.open(deps, bad)).rejects.toThrow('Not a session id');
    await expect(readSessionLog(deps, bad, 10)).rejects.toThrow('Not a session id');
  });
});

describe('a session log on several machines (s3 driver)', () => {
  let s3: TestS3;
  let writerMachine: Deps & { dir: string };
  let readerMachine: Deps & { dir: string };

  beforeAll(async () => {
    s3 = await startTestS3();
    writerMachine = await machine(s3.env('prod'));
    readerMachine = await machine(s3.env('prod'));
  });
  afterAll(async () => {
    await s3.close();
    await rm(writerMachine.dir, { recursive: true, force: true });
    await rm(readerMachine.dir, { recursive: true, force: true });
  });

  const puts = (session: { id: string }) =>
    s3.requests.filter((r) => r.method === 'PUT' && r.key.includes(session.id));
  const spools = async (deps: { dir: string }, session: { id: string }) =>
    (await readdir(path.join(deps.dir, 'coders')).catch(() => [] as string[])).filter((n) =>
      n.startsWith(session.id),
    );

  it('stores a part once enough is waiting; a second machine reads the running and the finished log', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 20,
      partMs: 60_000,
    });
    writer.write('line one is long enough');
    await vi.waitFor(() => expect(puts(session)).toHaveLength(1));
    writer.write('two');
    // The part is under the session's organization, named by the server alone
    // (its offset, then the writer's id).
    expect(puts(session)[0]!.key).toMatch(
      new RegExp(
        `^prod/orgs/${session.workspaceId}/coderlog_${session.id}_000000000000_[0-9a-f]{12}$`,
      ),
    );
    // Another machine sees what is stored; the writer's own sees its spool too.
    await vi.waitFor(async () =>
      expect(await readSessionLog(readerMachine, session, 1_000)).toMatch(
        /^line one is long enough\n/,
      ),
    );
    await vi.waitFor(async () =>
      expect(await readSessionLog(writerMachine, session, 1_000)).toBe(
        'line one is long enough\ntwo\n',
      ),
    );
    writer.write('three and the rest of it');
    await writer.close();
    expect(await readSessionLog(readerMachine, session, 1_000)).toBe(
      'line one is long enough\ntwo\nthree and the rest of it\n',
    );
    expect(await readSessionLog(readerMachine, session, 10)).toBe('est of it\n');
    // Every part written once, under its own key; the spool is gone.
    const keys = puts(session).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(await spools(writerMachine, session)).toEqual([]);
    expect(await spools(readerMachine, session)).toEqual([]);
  });

  it('stores what is waiting after a while, and stops doing so by time after LOG_TIMED_PARTS_MAX parts', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 1024 * 1024,
      partMs: 20,
    });
    writer.write('a quiet line');
    await vi.waitFor(() => expect(puts(session)).toHaveLength(1));
    expect(await readSessionLog(readerMachine, session, 100)).toBe('a quiet line\n');
    await writer.close();

    // A session with its timed parts used up: only size and the end store parts.
    const busy = newSession();
    for (let i = 0; i < LOG_TIMED_PARTS_MAX; i++) {
      const key = `prod/orgs/${busy.workspaceId}/coderlog_${busy.id}_${String(i * 3).padStart(12, '0')}`;
      s3.objects.set(key, Buffer.from(`${String(i).padStart(2, '0')}\n`));
    }
    const late = await SessionLogWriter.open(writerMachine, busy, {
      partBytes: 1024 * 1024,
      partMs: 5,
    });
    const before = puts(busy).length;
    late.write('waits for the end');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(puts(busy)).toHaveLength(before);
    await late.close();
    expect(puts(busy)).toHaveLength(before + 1);
    expect((await readSessionLog(readerMachine, busy, 18)).endsWith('waits for the end\n')).toBe(
      true,
    );
  });

  it('loses at most the unstored tail when a machine stops mid-session, and stores its spool on the next run there', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 16,
      partMs: 60_000,
    });
    writer.write('stored before the crash');
    await vi.waitFor(() => expect(puts(session)).toHaveLength(1));
    writer.write('tail');
    // The process ends here: no close. The spool holds the tail.
    await vi.waitFor(async () =>
      expect(await readSessionLog(writerMachine, session, 100)).toBe(
        'stored before the crash\ntail\n',
      ),
    );
    expect(await readSessionLog(readerMachine, session, 100)).toBe('stored before the crash\n');
    expect(await spools(writerMachine, session)).toHaveLength(1);
    // The session runs again on that machine: the tail is stored first.
    const next = await SessionLogWriter.open(writerMachine, session);
    expect(next.bytes).toBe('stored before the crash\ntail\n'.length);
    expect(await readSessionLog(readerMachine, session, 100)).toBe(
      'stored before the crash\ntail\n',
    );
    next.write('after');
    await next.close();
    expect(await readSessionLog(readerMachine, session, 100)).toBe(
      'stored before the crash\ntail\nafter\n',
    );
    expect(await spools(writerMachine, session)).toEqual([]);
  });

  it('keeps the spool when the store fails at the end, logging no content, and stores it later', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session);
    writer.write('secret looking output sk-ant-should-not-be-logged');
    s3.fail(4, { status: 503, code: 'SlowDown' }, 'PUT');
    await writer.close();
    expect(await spools(writerMachine, session)).toHaveLength(1);
    const logged = JSON.stringify(writerMachine.logger.calls);
    expect(logged).toContain('session log kept on this server to store later');
    expect(logged).not.toContain('sk-ant-should-not-be-logged');
    expect(logged).not.toContain(s3.bucket);
    expect(await readSessionLog(readerMachine, session, 100)).toBe('');
    const next = await SessionLogWriter.open(writerMachine, session);
    await next.close();
    expect(await readSessionLog(readerMachine, session, 100)).toContain('should-not-be-logged');
  });

  it('answers a read the store cannot serve as storage unavailable, naming nothing', async () => {
    const session = newSession();
    s3.fail(4, { status: 503, code: 'SlowDown' }, 'GET');
    const error = await readSessionLog(readerMachine, session, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    const text = `${(error as Error).message}`;
    for (const secret of [s3.bucket, s3.endpoint, session.workspaceId, session.id]) {
      expect(text).not.toContain(secret);
    }
  });

  it('removes every part and the spool', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, { partBytes: 4 });
    for (const line of ['one', 'two', 'three']) writer.write(line);
    await writer.close();
    expect([...s3.objects.keys()].filter((k) => k.includes(session.id)).length).toBeGreaterThan(1);
    await removeSessionLog(readerMachine, session);
    expect([...s3.objects.keys()].filter((k) => k.includes(session.id))).toEqual([]);
    expect(await readSessionLog(writerMachine, session, 100)).toBe('');
  });
});

describe('a session log while object storage is unavailable (s3 driver)', () => {
  let s3: TestS3;
  let writerMachine: Deps & { dir: string };
  let readerMachine: Deps & { dir: string };

  beforeAll(async () => {
    s3 = await startTestS3();
    writerMachine = await machine(s3.env());
    readerMachine = await machine(s3.env());
  });
  afterAll(async () => {
    await s3.close();
    await rm(writerMachine.dir, { recursive: true, force: true });
    await rm(readerMachine.dir, { recursive: true, force: true });
  });

  const down = () => s3.fail(1_000_000, { status: 503, code: 'SlowDown' });
  const up = () => s3.recover();
  const requestsFor = (session: { id: string }) =>
    s3.requests.filter((r) => r.key.includes(session.id) || r.key === '').length;
  const spools = async (session: { id: string }) =>
    (await readdir(path.join(writerMachine.dir, 'coders')).catch(() => [] as string[])).filter(
      (n) => n.startsWith(session.id),
    );

  afterEach(() => up());

  it('opens, writes and closes without waiting on the store, and stores the log in order once it is back', async () => {
    const session = newSession();
    const first = await SessionLogWriter.open(writerMachine, session);
    first.write('stored before the outage');
    await first.close();
    down();
    const started = Date.now();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      openMs: 200,
      closeMs: 200,
      retryMs: 60_000,
    });
    writer.write('written while the store is down');
    await writer.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await spools(session)).toHaveLength(1);
    up();
    // Read on its own machine, the log is whole and in order.
    expect(await readSessionLog(writerMachine, session, 1_000)).toBe(
      'stored before the outage\nwritten while the store is down\n',
    );
    // The next run here stores it first, after what was stored before.
    const next = await SessionLogWriter.open(writerMachine, session);
    expect(next.bytes).toBe('stored before the outage\nwritten while the store is down\n'.length);
    next.write('after');
    await next.close();
    expect(await readSessionLog(readerMachine, session, 1_000)).toBe(
      'stored before the outage\nwritten while the store is down\nafter\n',
    );
    expect(await spools(session)).toEqual([]);
  });

  it('keeps the 8 MB cap for output spooled while the store was down', async () => {
    const session = newSession();
    const line = 'y'.repeat(1024 * 1024 - 1);
    const first = await SessionLogWriter.open(writerMachine, session);
    for (let i = 0; i < 6; i++) first.write(line);
    await first.close();
    down();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      openMs: 100,
      closeMs: 100,
      retryMs: 60_000,
    });
    // Its base is not known yet: this machine spools all four lines.
    for (let i = 0; i < 4; i++) writer.write(line);
    await writer.close();
    up();
    const next = await SessionLogWriter.open(writerMachine, session);
    expect(next.full).toBe(true);
    await next.close();
    const whole = await readSessionLog(readerMachine, session, SESSION_LOG_MAX * 2);
    expect(Buffer.byteLength(whole)).toBeLessThanOrEqual(
      SESSION_LOG_MAX + SESSION_LOG_FULL.length + 1,
    );
    expect(whole.endsWith(`${SESSION_LOG_FULL}\n`)).toBe(true);
    expect(whole.split(SESSION_LOG_FULL)).toHaveLength(2);
    expect(whole.startsWith(`${line}\n`.repeat(6))).toBe(true);
  });

  it('asks the store a bounded number of times while it is down for a whole run, warning at a bounded rate with no content', async () => {
    const session = newSession();
    down();
    const before = requestsFor(session);
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 64,
      partMs: 5,
      openMs: 100,
      closeMs: 100,
      retryMs: 60_000,
    });
    for (let i = 0; i < 100; i++) {
      writer.write(`output line ${i} sk-ant-never-logged`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await writer.close();
    // The open's try, at most one more, and the close's: each at most two requests.
    expect(requestsFor(session) - before).toBeLessThanOrEqual(8);
    const logged = JSON.stringify(writerMachine.logger.calls);
    expect(logged).not.toContain('sk-ant-never-logged');
    expect(logged).not.toContain(s3.bucket);
    const warnings = writerMachine.logger.calls.filter((c) =>
      JSON.stringify(c).includes(session.id),
    );
    expect(warnings.length).toBeLessThanOrEqual(2);
    up();
    expect(await readSessionLog(writerMachine, session, 100_000)).toContain('output line 99');
  });

  it('stores parts again once the store is back during the run', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 16,
      partMs: 60_000,
      retryMs: 50,
    });
    down();
    writer.write('while the store is down');
    await new Promise((resolve) => setTimeout(resolve, 100));
    up();
    writer.write('and after it is back');
    await vi.waitFor(async () =>
      expect(await readSessionLog(readerMachine, session, 1_000)).toBe(
        'while the store is down\nand after it is back\n',
      ),
    );
    await writer.close();
  });

  it('does not hold the end of a run for a store that does not answer', async () => {
    const session = newSession();
    const writer = await SessionLogWriter.open(writerMachine, session, { closeMs: 200 });
    writer.write('the last line');
    const held = s3.hold('PUT');
    const started = Date.now();
    await writer.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    held.release();
    // The attempt that was cut short finishes on its own and removes the spool.
    await vi.waitFor(async () => expect(await spools(session)).toEqual([]));
    expect(await readSessionLog(readerMachine, session, 100)).toBe('the last line\n');
  });

  it('keeps later parts at their place after a write that failed part way', async () => {
    const session = newSession();
    let fail = true;
    const writer = await SessionLogWriter.open(writerMachine, session, {
      partBytes: 8,
      append: async (file, text) => {
        if (fail && text.startsWith('half')) {
          fail = false;
          // Some of the line reached the disk before it filled up.
          await appendFile(file, text.slice(0, 6));
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        }
        await appendFile(file, text);
      },
    });
    writer.write('first');
    writer.write('half of this line');
    writer.write('last');
    await writer.close();
    expect(await readSessionLog(readerMachine, session, 1_000)).toBe('first\nhalf olast\n');
  });
});

describe('session log parts written by two machines at once (s3 driver)', () => {
  let s3: TestS3;
  let a: Deps & { dir: string };
  let b: Deps & { dir: string };

  beforeAll(async () => {
    s3 = await startTestS3();
    a = await machine(s3.env());
    b = await machine(s3.env());
  });
  afterAll(async () => {
    await s3.close();
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  });

  it('never overwrites a part another writer stored at the same place, and reads the same everywhere', async () => {
    const session = newSession();
    const first = await SessionLogWriter.open(a, session);
    const second = await SessionLogWriter.open(b, session);
    first.write('from machine a');
    second.write('from machine b, longer');
    await first.close();
    await second.close();
    const keys = [...s3.objects.keys()].filter((k) => k.includes(session.id));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.split('/').pop()).toMatch(
        new RegExp(`^coderlog_${session.id}_000000000000_[0-9a-f]{12}$`),
      );
    }
    const onA = await readSessionLog(a, session, 1_000);
    expect(await readSessionLog(b, session, 1_000)).toBe(onA);
    expect(onA).toBe('from machine b, longer\n');
  });

  it('reads parts stored under the keys from before', async () => {
    const session = newSession();
    s3.objects.set(
      `orgs/${session.workspaceId}/coderlog_${session.id}_000000000000`,
      Buffer.from('an older part\n'),
    );
    const writer = await SessionLogWriter.open(a, session);
    writer.write('a newer one');
    await writer.close();
    expect(await readSessionLog(b, session, 1_000)).toBe('an older part\na newer one\n');
  });
});

describe('`openbots storage copy` of a session log (s3 driver)', () => {
  it('stores what was appended after a first copy, and only then says present', async () => {
    const s3 = await startTestS3();
    const old = await machine(s3.env());
    const other = await machine(s3.env());
    try {
      const session = newSession();
      const file = path.join(old.dir, 'coders', `${session.id}.log`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'first copy\n');
      const store = blobStore(old.config);
      expect(await copySessionLog(old, store, session, false)).toBe('copied');
      await appendFile(file, 'written before the server stopped\n');
      expect(await copySessionLog(old, store, session, true)).toBe('copied');
      expect(await copySessionLog(old, store, session, false)).toBe('copied');
      expect(await copySessionLog(old, store, session, false)).toBe('present');
      expect(await readSessionLog(other, session, 1_000)).toBe(
        'first copy\nwritten before the server stopped\n',
      );
    } finally {
      await s3.close();
      await rm(old.dir, { recursive: true, force: true });
      await rm(other.dir, { recursive: true, force: true });
    }
  });
});
