import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODERS_QUEUE } from '@openbots/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { runStorage } from '../cli/storage.js';
import { loadConfig } from '../config.js';
import { generateMasterKey } from '../secrets.js';
import { schema } from '../db/client.js';
import { startTestS3, type TestS3 } from '../storage/test-s3.js';
import { coderWorld, type CoderWorld } from './__fixtures__/coders/setup.js';
import { enqueueCoderJob, type CoderJob } from './coder-jobs.js';
import {
  readSessionLog,
  removeOrphanLogs,
  sessionLogPath,
  storeLeftoverSpools,
} from './coder-log.js';
import { createCoderWorker, type CoderRunnerOptions } from './coder-runner.js';
import { discardWorktree } from './coding-sessions.js';

// Coding session logs with the s3 driver end to end: the runner on one
// machine writes, `GET /coding-sessions/{id}/log` on another (the same
// database and store, its own disk) reads, while the session runs and after.
// Parts are stored with no transaction open; Discard and the sweep remove
// them; a spool a stopped process left is stored at the worker's start.
// Then, with the local driver, the sweep leaves another organization's log.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/coders');

async function worldWithRunner(env: Record<string, string>, options: CoderRunnerOptions) {
  const w = await coderWorld('log-owner@example.com', { env });
  await w.t.deps.infra
    .queue<CoderJob>(CODERS_QUEUE)
    .process(createCoderWorker(w.t.deps, options), { concurrency: 2 });
  // Publishing would wait on the owner's approval; these sessions only write.
  await w.t.db
    .update(schema.bots)
    .set({ toolPolicy: { coder: { actions: { push: 'deny', pr: 'deny' } } } })
    .where(eq(schema.bots.id, w.bot.id));
  const res = await w.call('POST', '/connectors', {
    catalogId: 'github_builtin',
    secrets: { GITHUB_TOKEN: 'ghp-runner-token' },
  });
  expect(res.status).toBe(201);
  return w;
}

describe('coding session logs on several machines (s3 driver)', () => {
  let s3: TestS3;
  let w: CoderWorld;
  let otherDisk: string;
  let second: ReturnType<typeof createApp>;
  const options: CoderRunnerOptions = { runWaitMs: 0, touchMs: 60_000, stopGraceMs: 20 };

  beforeAll(async () => {
    s3 = await startTestS3();
    w = await worldWithRunner(s3.env(), options);
    otherDisk = await mkdtemp(path.join(tmpdir(), 'openbots-second-machine-'));
    // A second server: the same database and store, its own disk.
    second = createApp(
      { ...w.t.deps, config: { ...w.t.deps.config, filesDir: otherDisk } },
      { webDist: '' },
    );
  });
  afterAll(async () => {
    await w.close();
    await s3.close();
    await rm(otherDisk, { recursive: true, force: true });
  });

  const start = (sessionId: string) =>
    w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId }));
  const readOn = async (app: ReturnType<typeof createApp>, sessionId: string) => {
    const res = await app.request(`/api/v1/coding-sessions/${sessionId}/log`, {
      headers: { cookie: w.cookie },
    });
    expect(res.status).toBe(200);
    return res.text();
  };
  const parts = (sessionId: string) =>
    [...s3.objects.keys()].filter((key) => key.includes(`coderlog_${sessionId}_`));
  const codersOn = async (dir: string) =>
    readdir(path.join(dir, 'coders')).catch(() => [] as string[]);

  it('reads a running and a finished session from another machine', async () => {
    options.logPartBytes = 64;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    w.coder.agent = async (io) => {
      const lines = readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8').split('\n');
      const result = lines.findIndex((l) => l.includes('"type":"result"'));
      io.stdout(`${lines.slice(0, result).join('\n')}\n`);
      await released;
      io.stdout(`${lines.slice(result).join('\n')}`);
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    await start(sessionId);
    // Running: the other machine reads what is stored so far.
    const running = await w.until(async () => {
      expect((await w.session(sessionId)).status).toBe('running');
      const text = await readOn(second, sessionId);
      expect(text).toContain('"type":"system"');
      return text;
    });
    expect(running).not.toContain('"type":"result"');
    expect(parts(sessionId).length).toBeGreaterThan(0);
    // Its log is in the store, not on the second machine's disk.
    expect(await codersOn(otherDisk)).toEqual([]);
    release();
    await w.until(async () => expect((await w.session(sessionId)).status).toBe('settled'));
    const finished = await readOn(second, sessionId);
    expect(finished).toContain('"type":"result"');
    expect(finished.startsWith(running)).toBe(true);
    expect(await readOn(w.t.app, sessionId)).toBe(finished);
    // Nothing left on the writer's disk either, and the row names no local path.
    expect(
      (await codersOn(w.t.deps.config.filesDir)).filter((n) => n.startsWith(sessionId)),
    ).toEqual([]);
    expect((await w.session(sessionId)).logPath).toBeNull();
    delete options.logPartBytes;
  });

  it('stores the last part with no transaction open and no row locked', async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    const put = s3.hold('PUT');
    await start(sessionId);
    await put.reached;
    // The session's row can be locked at once from another connection.
    const lock = w.t.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, sessionId))
        .for('update', { noWait: true });
    });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      lock.then(
        () => 'locked',
        (error: unknown) => `refused: ${(error as Error).message}`,
      ),
      new Promise<string>((resolve) => (timer = setTimeout(() => resolve('waiting'), 5_000))),
    ]);
    clearTimeout(timer);
    if (w.t.testDb.kind === 'postgres') {
      const rows = (await w.t.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and state like 'idle in transaction%'`,
      )) as unknown as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    }
    put.release();
    expect(outcome).toBe('locked');
    await w.until(async () => expect((await w.session(sessionId)).status).toBe('settled'));
    expect(await readOn(second, sessionId)).toContain('"type":"result"');
  });

  it('deletes the parts when the session is discarded', async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    await w.runToEnd(sessionId);
    expect(parts(sessionId).length).toBeGreaterThan(0);
    const row = await w.session(sessionId);
    await w.t.inOrganization(() => discardWorktree(w.t.deps, row));
    expect(parts(sessionId)).toEqual([]);
    expect(await readOn(second, sessionId)).toBe('');
  });

  it("removes the parts of sessions that are gone, and keeps the others'", async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    await w.runToEnd(sessionId);
    const kept = parts(sessionId);
    const gone = randomUUID();
    const orphan = `orgs/${w.workspaceId}/coderlog_${gone}_000000000000`;
    s3.objects.set(orphan, Buffer.from('left behind\n'));
    // Another organization's part is not this organization's sweep's to see.
    const elsewhere = `orgs/${randomUUID()}/coderlog_${randomUUID()}_000000000000`;
    s3.objects.set(elsewhere, Buffer.from('not ours\n'));
    expect(await w.t.inOrganization(() => removeOrphanLogs(w.t.deps))).toBe(1);
    expect(s3.objects.has(orphan)).toBe(false);
    expect(s3.objects.has(elsewhere)).toBe(true);
    expect(parts(sessionId)).toEqual(kept);
  });

  it('stores a spool a stopped process left on this machine at the next start', async () => {
    const { sessionId } = await w.newSession();
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'failed' })
      .where(eq(schema.codingSessions.id, sessionId));
    const spool = path.join(w.t.deps.config.filesDir, 'coders', `${sessionId}.0.spool`);
    await mkdir(path.dirname(spool), { recursive: true });
    await writeFile(spool, 'the unstored tail\n');
    // A running session's spool is its runner's: left alone.
    const live = await w.newSession();
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'running' })
      .where(eq(schema.codingSessions.id, live.sessionId));
    const liveSpool = path.join(w.t.deps.config.filesDir, 'coders', `${live.sessionId}.0.spool`);
    await writeFile(liveSpool, 'still being written\n');

    expect(await w.t.inOrganization(() => storeLeftoverSpools(w.t.deps))).toBe(1);
    await expect(stat(spool)).rejects.toThrow();
    expect(await readOn(second, sessionId)).toBe('the unstored tail\n');
    expect((await stat(liveSpool)).size).toBeGreaterThan(0);
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'failed' })
      .where(eq(schema.codingSessions.id, live.sessionId));
  });
});

describe('the local sweep of coding session logs', () => {
  let w: CoderWorld;

  beforeAll(async () => {
    w = await coderWorld('local-log-owner@example.com');
    expect(w.t.storage).toBe('local');
  });
  afterAll(() => w.close());

  it("removes a log whose session is gone, and keeps another organization's", async () => {
    const { sessionId } = await w.newSession();
    const ours = sessionLogPath(w.t.deps, sessionId);
    const orphan = sessionLogPath(w.t.deps, randomUUID());
    await mkdir(path.dirname(ours), { recursive: true });
    await writeFile(ours, 'kept\n');
    await writeFile(orphan, 'left behind\n');
    // The sweep runs in every organization's scope in turn; in one that is
    // not the session's, the session is not to be seen.
    const other = await w.t.createOrganization('Other');
    await w.t.inOrganization(() => removeOrphanLogs(w.t.deps), other);
    expect((await stat(ours)).size).toBe(5);
    await expect(stat(orphan)).rejects.toThrow();
    await w.t.inOrganization(() => removeOrphanLogs(w.t.deps));
    expect((await stat(ours)).size).toBe(5);
    await rm(ours);
  });

  it('is copied to the object store by `openbots storage copy`, and reads from there', async () => {
    const s3 = await startTestS3();
    try {
      const { sessionId } = await w.newSession();
      const file = sessionLogPath(w.t.deps, sessionId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'an old session\n');
      const config = loadConfig({
        OPENBOTS_MASTER_KEY: generateMasterKey(),
        DATABASE_URL: 'postgres://unused',
        OPENBOTS_FILES_DIR: w.t.deps.config.filesDir,
        ...s3.env('prod'),
      });
      const lines: string[] = [];
      const ctx = {
        config,
        db: w.t.deps.db,
        infra: w.t.deps.infra,
        write: (l: string) => lines.push(l),
      };
      expect(await runStorage(['copy', '--dry-run'], ctx)).toBe(0);
      expect(lines).toContain(
        'Would copy 1 of 1 coding session log; 0 already in the object store, 0 failed.',
      );
      expect(s3.objects.size).toBe(0);
      expect(await runStorage(['copy'], ctx)).toBe(0);
      expect(lines).toContain(
        'Copied 1 of 1 coding session log; 0 already in the object store, 0 failed.',
      );
      expect(
        s3.objects.get(`prod/orgs/${w.workspaceId}/coderlog_${sessionId}_000000000000`),
      ).toEqual(Buffer.from('an old session\n'));
      // Nothing deleted, and a second run copies nothing.
      expect((await stat(file)).size).toBe(15);
      lines.length = 0;
      expect(await runStorage(['copy'], ctx)).toBe(0);
      expect(lines).toContain(
        'Copied 0 of 1 coding session log; 1 already in the object store, 0 failed.',
      );
      // Another machine on the s3 driver reads it.
      const elsewhere = await mkdtemp(path.join(tmpdir(), 'openbots-after-copy-'));
      const reader = { config: { ...config, filesDir: elsewhere }, logger: w.t.deps.logger };
      expect(await readSessionLog(reader, { id: sessionId, workspaceId: w.workspaceId }, 100)).toBe(
        'an old session\n',
      );
      await rm(elsewhere, { recursive: true, force: true });
    } finally {
      await s3.close();
    }
  });
});
