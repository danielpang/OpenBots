import type { ComputerRef } from '@openbots/computer';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runComputers } from '../cli/computers.js';
import type { CliContext } from '../cli/context.js';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import {
  computerProvider,
  recoverStaleComputers,
  restartComputer,
  stopComputer,
  STOPPING_TAKEOVER_MS,
  stopTimings,
  type ComputerRow,
} from './computer.js';
import {
  RETIRED_MAX_ATTEMPTS,
  runRetiredComputerJob,
  sweepRetiredComputers,
} from './computer-retire.js';
import { runRescueJob } from './repos-rescue.js';

// The fifth review of retired computers (plan 9.5): a reset's cleanup and
// audit land once, while the reset still holds the member's computer, and
// never later on what the member did since.

const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

describe('retired computers, fifth review', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    sprites = await useTestSprites(t.ownerDeps);
    workspaceId = await t.defaultOrganization();
  });
  afterAll(async () => {
    await sprites.close();
    await t.close();
  });

  async function member(email: string) {
    const signed = await t.signUp(email);
    if (!signed.cookie) throw new Error(`${signed.res.status} ${await signed.res.text()}`);
    const cookie = signed.cookie;
    const ownerId = await t.userId(email);
    const call = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const row = async (): Promise<ComputerRow> =>
      (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;
    const start = async () => {
      const res = await call('POST', '/computer/start');
      expect(res.status, await res.clone().text()).toBe(200);
      return row();
    };
    const prepare = async () => {
      const computer = await row();
      const res = await call('POST', '/computer/reset/prepare');
      expect(res.status, await res.clone().text()).toBe(202);
      const { requestId } = (await res.json()) as { requestId: string };
      await t.inOrganization(() =>
        runRescueJob(t.deps, { ownerId, computerId: computer.id, requestId }),
      );
      await until(async () => {
        const status = (await (await call('GET', `/computer/reset/${requestId}`)).json()) as {
          status: string;
        };
        expect(status.status).toBe('done');
      });
      return requestId;
    };
    const [bot] = await t.db
      .insert(schema.bots)
      .values({ workspaceId, ownerId, handle: `b${ownerId.slice(0, 8)}`, name: 'Builder' })
      .returning();
    /** What the member does on a computer: a coding agent signed in, a checkout, a session. */
    const work = async (label: string) => {
      const computer = await row();
      await t.db
        .insert(schema.coderAccounts)
        .values({
          workspaceId,
          ownerId,
          agent: 'claude',
          authKind: 'subscription',
          accountLabel: label,
          signedInAt: new Date(),
        })
        .onConflictDoNothing();
      await t.db
        .update(schema.coderAccounts)
        .set({ authKind: 'subscription', accountLabel: label, signedInAt: new Date() })
        .where(eq(schema.coderAccounts.ownerId, ownerId));
      const [repo] = await t.db
        .insert(schema.repos)
        .values({
          workspaceId,
          ownerId,
          fullName: `acme/${label}`,
          remoteUrl: `https://github.com/acme/${label}.git`,
          defaultBranch: 'main',
        })
        .returning();
      await t.db.insert(schema.repoCheckouts).values({
        workspaceId,
        repoId: repo!.id,
        computerId: computer.id,
        path: `/home/bot/repos/acme/${label}`,
        state: 'ready',
      });
      const [session] = await t.db
        .insert(schema.codingSessions)
        .values({
          workspaceId,
          ownerId,
          botId: bot!.id,
          agent: 'claude',
          mode: 'edit',
          prompt: 'Fix the build',
          status: 'running',
          repoId: repo!.id,
          worktreePath: `/home/bot/worktrees/${label}`,
        })
        .returning();
      return { repoId: repo!.id, sessionId: session!.id };
    };
    /** That work as it now stands. */
    const state = async (done: { repoId: string; sessionId: string }) => {
      const [account] = await t.db
        .select()
        .from(schema.coderAccounts)
        .where(eq(schema.coderAccounts.ownerId, ownerId));
      const [checkout] = await t.db
        .select()
        .from(schema.repoCheckouts)
        .where(eq(schema.repoCheckouts.repoId, done.repoId));
      const [session] = await t.db
        .select()
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, done.sessionId));
      return {
        authKind: account?.authKind,
        checkout: checkout?.state,
        worktree: session?.worktreePath ?? null,
      };
    };
    await start();
    return { ownerId, call, row, start, prepare, work, state };
  }

  const retiredOf = (ownerId: string) =>
    t.db
      .select()
      .from(schema.retiredComputers)
      .where(eq(schema.retiredComputers.ownerId, ownerId))
      .orderBy(schema.retiredComputers.retiredAt);
  const machines = () => computerProvider(t.ownerDeps)!;
  const isolate = (ownerId: string) =>
    t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted' })
      .where(sql`owner_id <> ${ownerId} and status in ('retiring', 'retired', 'deleting')`);
  const resetAudits = (requestId: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'computer.reset'),
          sql`${schema.auditLog.metadata} ->> 'requestId' = ${requestId}`,
        ),
      );
  let lines: string[] = [];
  const cli = (args: string[]) => {
    lines = [];
    const ctx: CliContext = {
      config: t.deps.config,
      db: t.deps.db,
      infra: t.deps.infra,
      logger: t.deps.logger,
      write: (line) => lines.push(line),
    };
    return runComputers([...args, '--org', workspaceId, '--by', 'Sam from support'], ctx);
  };

  /**
   * A reset whose cut and undo both fail, left to a job on an install that
   * has not the record's provider: its record is never settled, and the job
   * gives up. Returns the reset's request id.
   */
  async function resetGivenUp(m: Awaited<ReturnType<typeof member>>) {
    const provider = machines();
    const retire = provider.retire!;
    const unretire = provider.unretire!;
    const requestId = await m.prepare();
    provider.retire = async () => {
      throw new Error('Sprites API: update failed (500) for it');
    };
    provider.unretire = async () => {
      throw new Error('Sprites API: update failed (500) for it');
    };
    try {
      const res = await m.call('POST', '/computer/reset', {
        requestId,
        confirm: true,
        resetSignIns: true,
      });
      expect(res.status, await res.clone().text()).toBe(503);
    } finally {
      provider.retire = retire;
      provider.unretire = unretire;
    }
    for (let i = 0; i < RETIRED_MAX_ATTEMPTS; i++) {
      const [now] = await retiredOf(m.ownerId);
      await t.inOrganization(() =>
        runRetiredComputerJob(t.deps, null, {
          retiredId: now!.id,
          kind: 'retire',
          claim: now!.claim ?? undefined,
        }),
      );
    }
    const [record] = await retiredOf(m.ownerId);
    expect(record!.gaveUpAt).not.toBeNull();
    return { requestId, record: record! };
  }

  describe('1. a give-up settles the reset, once', () => {
    it('honours the member’s choice and lets the computer go when the job gives up', async () => {
      const m = await member('give-up-settles@example.com');
      await isolate(m.ownerId);
      const before = await m.work('before-give-up');
      const { requestId, record } = await resetGivenUp(m);
      // The member asked for the sign-ins to go: they are gone, and the
      // computer is let go, at once, with one audit of the reset.
      expect(record.auditedAt).not.toBeNull();
      expect(await m.state(before)).toEqual({
        authKind: 'none',
        checkout: 'missing',
        worktree: null,
      });
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
      expect(await resetAudits(requestId)).toHaveLength(1);
    });

    it('a retry after the member started again clears nothing of theirs', async () => {
      const m = await member('late-settle@example.com');
      await isolate(m.ownerId);
      const { requestId, record } = await resetGivenUp(m);
      // However long the computer was held, the sweep lets it go by now.
      const later = new Date(Date.now() + STOPPING_TAKEOVER_MS + 60_000);
      await inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps, later));
      expect((await m.row()).status).toBe('stopped');
      // The member starts again on a new machine and works there.
      const fresh = await m.start();
      expect(fresh.containerId).not.toBe(record.providerRef);
      const since = await m.work('after-give-up');
      const audits = (await resetAudits(requestId)).length;
      // Days later an operator retries the record, and the job finishes it.
      expect(await cli(['retry', record.id]), lines.join('\n')).toBe(0);
      expect(await inEveryOrganization(t.deps, () => sweepRetiredComputers(t.deps))).toBe(1);
      const [claimed] = await retiredOf(m.ownerId);
      await t.inOrganization(() =>
        runRetiredComputerJob(t.deps, machines(), {
          retiredId: claimed!.id,
          kind: 'retire',
          claim: claimed!.claim ?? undefined,
        }),
      );
      await until(async () =>
        expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'retired' }),
      );
      // What the member did since is as they left it, and the reset is audited once.
      expect(await m.state(since)).toEqual({
        authKind: 'subscription',
        checkout: 'ready',
        worktree: '/home/bot/worktrees/after-give-up',
      });
      expect(await m.row()).toMatchObject({ status: 'running', containerId: fresh.containerId });
      expect(await resetAudits(requestId)).toHaveLength(audits);
      expect(audits).toBeLessThanOrEqual(1);
    });
  });

  describe('4. a stop that lost the computer', () => {
    it('releases no hold of the use that took it over', async () => {
      const m = await member('stop-takeover@example.com');
      const row = await m.row();
      const provider = machines();
      const ref: ComputerRef = {
        provider: 'sprites',
        containerId: row.containerId,
        agentUrl: row.agentUrl!,
        agentToken: '',
        volumeName: null,
      };
      const stop = provider.stop;
      provider.stop = async (target, options) => {
        // Taken over while the stop runs: the row moves on, and a new use holds the Sprite.
        await t.db
          .update(schema.computers)
          .set({ status: 'running', generation: sql`${schema.computers.generation} + 1` })
          .where(eq(schema.computers.id, row.id));
        await provider.hold!(ref, 'new-use', 600);
        // The stop hears of the takeover at its next refresh, through its signal.
        const signal = options?.signal;
        if (signal) await until(() => expect(signal.aborted).toBe(true));
        return stop.call(provider, target, options);
      };
      const timings = { ...stopTimings };
      stopTimings.heartbeatMs = 20;
      try {
        await expect(t.inOrganization(() => stopComputer(t.deps, row))).rejects.toMatchObject({
          status: 503,
        });
      } finally {
        provider.stop = stop;
        Object.assign(stopTimings, timings);
      }
      expect([...sprites.api.sprites.get(row.containerId!)!.tasks.keys()]).toContain(
        'openbots-new-use',
      );
    });
  });

  describe('6. a stop whose refresh is slow to answer', () => {
    it('gives up counting from when the refresh was sent, not from its answer', async () => {
      const m = await member('slow-refresh@example.com');
      const row = await m.row();
      const giveUp = 1_000;
      const late = 800;
      // Refreshes of the stop's claim (a write of `status_at` alone): the
      // first lands and answers at once, the second lands at once but its
      // answer comes `late`, and the rest never answer (the database is gone).
      let refreshes = 0;
      let sentLate = 0;
      const pending: (() => void)[] = [];
      const db = t.deps.db;
      const wrap = (target: object, refresh: boolean): unknown =>
        new Proxy(target, {
          get(inner, prop) {
            const value = Reflect.get(inner, prop) as unknown;
            if (prop === 'then' && refresh && typeof value === 'function') {
              return (ok: (v: unknown) => void, fail: (e: unknown) => void) => {
                const n = refreshes++;
                const landed = (value as (a: unknown, b: unknown) => Promise<unknown>).call(
                  inner,
                  (v: unknown) => v,
                  (e: unknown) => Promise.reject(e),
                );
                if (n === 0) return landed.then(ok, fail);
                if (n === 1) sentLate = Date.now();
                return landed.then(
                  (v) =>
                    new Promise<void>((resolve) => {
                      const answer = () => resolve(ok(v));
                      if (n === 1) setTimeout(answer, late);
                      else pending.push(answer);
                    }),
                  fail,
                );
              };
            }
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              const out = (value as (...a: unknown[]) => unknown).apply(inner, args);
              const isRefresh =
                refresh || (prop === 'set' && Object.keys(args[0] as object).join() === 'statusAt');
              return out && typeof out === 'object' ? wrap(out, isRefresh) : out;
            };
          },
        });
      const slow = new Proxy(db, {
        get(target, prop) {
          if (prop === 'update') {
            return (table: unknown) => wrap(target.update(table as typeof schema.computers), false);
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      const provider = machines();
      const stop = provider.stop;
      let abortedAt = 0;
      provider.stop = async (_ref, options) => {
        const signal = options?.signal;
        if (!signal) return;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        abortedAt = Date.now();
        throw signal.reason as Error;
      };
      const timings = { ...stopTimings };
      stopTimings.heartbeatMs = 20;
      stopTimings.giveUpMs = giveUp;
      try {
        await expect(
          t.inOrganization(() => stopComputer({ ...t.deps, db: slow as typeof db }, row)),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        provider.stop = stop;
        Object.assign(stopTimings, timings);
        for (const answer of pending) answer();
      }
      expect(sentLate).toBeGreaterThan(0);
      // From the late refresh's sending, its give-up: never pushed back by how
      // long its answer took (that would be `giveUp + late`).
      expect(abortedAt - sentLate).toBeLessThan(giveUp + late / 2);
    });
  });

  describe('5. a stop that loses its claim to a start that finished', () => {
    it('stops the computer as it now is, rather than answer stopped while it runs', async () => {
      const m = await member('stop-race@example.com');
      const running = await m.row();
      expect(running.status).toBe('running');
      // The stop read the computer while it was starting; the start finished
      // first, and its guarded write kept the generation the stop read.
      const read: ComputerRow = { ...running, status: 'starting' };
      const out = await t.inOrganization(() => stopComputer(t.deps, read));
      expect(out.status).toBe('stopped');
      expect(await m.row()).toMatchObject({ status: 'stopped' });
    });

    it('a restart restarts', async () => {
      const m = await member('restart-race@example.com');
      const running = await m.row();
      const read: ComputerRow = { ...running, status: 'starting' };
      const started = await t.inOrganization(() =>
        restartComputer(t.deps, { id: m.ownerId, workspaceId }, read),
      );
      // Stopped first, so this call started it again.
      expect(started.computer.status).toBe('running');
      expect(started.durationMs).not.toBeNull();
    });
  });
});
