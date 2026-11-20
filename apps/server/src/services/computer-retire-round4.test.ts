import {
  SPRITES_AGENT_TOKEN_FILES,
  SPRITES_DENY_ALL,
  SPRITES_RETIRED_LABEL,
  type ComputerProvider,
} from '@openbots/computer';
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
  destroyComputer,
  provisionTimings,
  recoverStaleComputers,
  stopComputer,
  stopTimings,
  type ComputerRow,
} from './computer.js';
import {
  RETIRED_MAX_ATTEMPTS,
  restoreRetiredComputer,
  runRetiredComputerJob,
} from './computer-retire.js';
import { runRescueJob } from './repos-rescue.js';

// The fourth review of retired computers (plan 9.5): a computer row never
// forgets a machine that may still exist, a stop never lands on a computer a
// reset holds, and a restore that fails never leaves the old agent on a
// retired machine nor cuts off one it made the member's after all.

const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });
const SIGN_IN = '/var/lib/openbots/sign-in';

/** A provider call held until the test lets it go, or fails it. */
function holdOnce(provider: ComputerProvider, op: 'retire' | 'create') {
  const real = provider[op]! as (...args: unknown[]) => Promise<unknown>;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let go!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    go = resolve;
    fail = reject;
  });
  let first = true;
  (provider as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return real.apply(provider, args);
  };
  return {
    inside,
    go,
    fail,
    restore: () => ((provider as unknown as Record<string, unknown>)[op] = real),
  };
}

describe('retired computers, fourth review', () => {
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
    /** A prepared reset whose rescue is done (it starts the computer first). */
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
    const confirm = async (requestId: string, extra: object) => {
      const res = await call('POST', '/computer/reset', { requestId, confirm: true, ...extra });
      if (res.status === 202) await finishRetires(ownerId);
      return res;
    };
    const reset = async (resetSignIns: boolean, extra: object = {}) => {
      const res = await confirm(await prepare(), { resetSignIns, ...extra });
      expect(res.status, await res.clone().text()).toBe(202);
    };
    await start();
    return { ownerId, call, row, start, prepare, confirm, reset };
  }

  const retiredOf = (ownerId: string) =>
    t.db
      .select()
      .from(schema.retiredComputers)
      .where(eq(schema.retiredComputers.ownerId, ownerId))
      .orderBy(schema.retiredComputers.retiredAt);
  const machines = () => computerProvider(t.ownerDeps)!;
  const job = async (retiredId: string, kind: 'retire' | 'delete') => {
    const [row] = await t.db
      .select()
      .from(schema.retiredComputers)
      .where(eq(schema.retiredComputers.id, retiredId));
    const claim = row?.claim ?? undefined;
    return t.inOrganization(() =>
      runRetiredComputerJob(t.deps, machines(), { retiredId, kind, ...(claim ? { claim } : {}) }),
    );
  };
  async function finishRetires(ownerId: string) {
    for (const row of await retiredOf(ownerId)) {
      if (row.status === 'retiring') await job(row.id, 'retire');
    }
  }
  const isolate = (ownerId: string) =>
    t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted' })
      .where(sql`owner_id <> ${ownerId} and status in ('retiring', 'retired', 'deleting')`);
  const outOfReach = (name: string) => {
    const sprite = sprites.api.sprites.get(name)!;
    expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
    expect(sprite.urlAuth).toBe('sprite');
    expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
  };
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

  describe('1. a row never forgets a machine that may exist', () => {
    it('deleting the old computer after a reset that kept the sign-ins deletes that Sprite', async () => {
      const m = await member('soft-then-delete@example.com');
      const name = (await m.row()).containerId!;
      sprites.api.sprites.get(name)!.files.set(SIGN_IN, new Uint8Array([1]));
      // A reset that keeps the sign-ins clears the home in place: the same Sprite stays.
      await m.reset(false);
      expect(sprites.api.sprites.get(name)!.files.has(SIGN_IN)).toBe(true);
      // The next reset's rescue cannot start the computer: it is left `error`.
      const provider = machines();
      const create = provider.create;
      provider.create = async () => {
        throw new Error('Sprites API: create failed (500) for it');
      };
      let requestId: string;
      try {
        requestId = await m.prepare();
      } finally {
        provider.create = create;
      }
      expect((await m.row()).status).toBe('error');
      const res = await m.confirm(requestId, { resetSignIns: true, deleteOldComputer: true });
      expect(res.status, await res.clone().text()).toBe(202);
      // The Sprite with the old sign-ins is gone, through a record of it.
      expect(sprites.api.sprites.has(name)).toBe(false);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ providerRef: name, status: 'deleted' }]);
      const after = await m.start();
      expect(after.containerId).not.toBe(name);
      expect(sprites.api.sprites.get(after.containerId!)!.files.has(SIGN_IN)).toBe(false);
    });

    it('a full reset while the kept Sprite is being made again retires that Sprite', async () => {
      const m = await member('creating-after-soft@example.com');
      const name = (await m.row()).containerId!;
      sprites.api.sprites.get(name)!.files.set(SIGN_IN, new Uint8Array([1]));
      await m.reset(false);
      const provider = machines();
      const made = holdOnce(provider, 'create');
      const wait = provisionTimings.waitMs;
      provisionTimings.waitMs = 0;
      try {
        await m.call('POST', '/computer/start');
        await made.inside;
        const creating = await m.row();
        expect(creating.status).toBe('creating');
        await t.inOrganization(() =>
          destroyComputer(t.deps, creating, { signIns: true, deleteOld: true }),
        );
        expect(sprites.api.sprites.has(name)).toBe(false);
        expect(await retiredOf(m.ownerId)).toMatchObject([
          { providerRef: name, status: 'deleted' },
        ]);
        made.fail(new Error('the make was cancelled'));
      } finally {
        made.restore();
        provisionTimings.waitMs = wait;
      }
      await until(async () => expect((await m.row()).status).toBe('stopped'));
      const after = await m.start();
      expect(after.containerId).not.toBe(name);
      expect(sprites.api.sprites.get(after.containerId!)!.files.has(SIGN_IN)).toBe(false);
    });
  });

  describe('2. a restore retires the machine the member has, whatever its home', () => {
    it('after a reset that kept the sign-ins, the member’s Sprite is retired, not orphaned', async () => {
      const m = await member('restore-after-soft@example.com');
      await m.reset(true);
      const [first] = await retiredOf(m.ownerId);
      const current = (await m.start()).containerId!;
      sprites.api.sprites.get(current)!.files.set(SIGN_IN, new Uint8Array([1]));
      await m.reset(false);
      expect(await cli(['restore', first!.id]), lines.join('\n')).toBe(0);
      expect(await m.row()).toMatchObject({ containerId: first!.providerRef, status: 'stopped' });
      // The Sprite the member had is on a record of its own, out of reach.
      const replaced = (await retiredOf(m.ownerId)).find((r) => r.providerRef === current);
      expect(replaced).toBeDefined();
      outOfReach(current);
    });
  });

  describe('3. a stop read before a reset never lands on it', () => {
    it('a stop from a stale read leaves a computer a reset is retiring alone', async () => {
      const m = await member('stale-stop@example.com');
      const stale = await m.row();
      expect(stale.status).toBe('running');
      await isolate(m.ownerId);
      const provider = machines();
      const cut = holdOnce(provider, 'retire');
      let answer: unknown;
      try {
        const resetting = t
          .inOrganization(() => destroyComputer(t.deps, stale, { signIns: true }))
          .then(
            () => null,
            (error: unknown) => error,
          );
        await cut.inside;
        const during = await m.row();
        expect(during).toMatchObject({ status: 'stopping', containerId: null });
        const calls = sprites.api.calls.length;
        const out = await t.inOrganization(() => stopComputer(t.deps, stale));
        // Nothing written, nothing asked of the old machine.
        expect(out).toMatchObject({ status: 'stopping', generation: during.generation });
        expect(await m.row()).toMatchObject({ status: 'stopping', generation: during.generation });
        expect(sprites.api.calls.slice(calls)).toEqual([]);
        cut.go();
        answer = await resetting;
      } finally {
        cut.restore();
      }
      expect(answer).toBeNull();
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });
  });

  describe('4. a restore that fails at the checkpoint', () => {
    it('cuts the machine off and clears it inside again', async () => {
      const m = await member('restore-checkpoint-fails@example.com');
      const name = (await m.row()).containerId!;
      const old = sprites.api.sprites.get(name)!;
      for (const file of SPRITES_AGENT_TOKEN_FILES) old.files.set(file, new Uint8Array([3]));
      await m.reset(true);
      for (const file of SPRITES_AGENT_TOKEN_FILES) expect(old.files.has(file)).toBe(false);
      const [retired] = await retiredOf(m.ownerId);
      expect(retired!.checkpointId).toBeTruthy();
      const provider = machines();
      const restore = provider.restore!;
      // The checkpoint is put back, then its answer is lost.
      provider.restore = async (ref, id) => {
        await restore.call(provider, ref, id);
        throw new Error('Sprites API: restore failed for it: the stream ended');
      };
      try {
        expect(await cli(['restore', retired!.id]).catch(() => 1)).toBe(1);
      } finally {
        provider.restore = restore;
      }
      // The checkpoint's agent token is gone again, and the machine is out of reach.
      for (const file of SPRITES_AGENT_TOKEN_FILES) expect(old.files.has(file)).toBe(false);
      outOfReach(name);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
      expect((await m.row()).containerId).toBeNull();
    });
  });

  describe('5. a restore whose last step committed though its answer was lost', () => {
    it('stands: the machine is the member’s and is not cut off again', async () => {
      const m = await member('restore-commit-lost@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      // The database commits the restore's last transaction, then the connection drops.
      const db = t.deps.db;
      const lost = new Proxy(db, {
        get(target, prop) {
          if (prop === 'transaction') {
            return async (...args: Parameters<typeof db.transaction>) => {
              await target.transaction(...args);
              throw new Error('Connection terminated unexpectedly');
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      const out = await t.inOrganization(() =>
        restoreRetiredComputer(
          { ...t.deps, db: lost },
          machines(),
          { workspaceId, retiredId: retired!.id },
          'Sam from support',
        ),
      );
      expect(out.restored).toMatchObject({ status: 'restored' });
      expect(out.computer).toMatchObject({ containerId: retired!.providerRef });
      const sprite = sprites.api.sprites.get(retired!.providerRef)!;
      expect(sprite.labels).not.toContain(SPRITES_RETIRED_LABEL);
      // And it starts.
      expect(await m.start()).toMatchObject({
        status: 'running',
        containerId: retired!.providerRef,
      });
      expect(
        await t.db
          .select()
          .from(schema.retiredComputers)
          .where(
            and(
              eq(schema.retiredComputers.id, retired!.id),
              eq(schema.retiredComputers.status, 'restored'),
            ),
          ),
      ).toHaveLength(1);
    });
  });

  describe('6. a reset that cannot refresh its claim', () => {
    it('ends its home clearing before the claim can be taken over', async () => {
      const m = await member('claim-unheard@example.com');
      const before = await m.row();
      const notes = '/home/bot/notes.md';
      sprites.api.sprites.get(before.containerId!)!.files.set(notes, new Uint8Array([1]));
      const provider = machines();
      const destroy = provider.destroy;
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let down = false;
      let aborted = false;
      provider.destroy = async (ref, options) => {
        entered();
        // The home clearing runs long, until its signal ends it.
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 3_000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            aborted = true;
            down = false;
            reject(options.signal!.reason as Error);
          });
        });
        return destroy.call(provider, ref, options);
      };
      // The database goes out of reach for this process's refreshes.
      const db = t.deps.db;
      const unreachable = new Proxy(db, {
        get(target, prop) {
          if (prop === 'update' && down) {
            return () => {
              throw new Error('Connection terminated unexpectedly');
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      const timings = { ...stopTimings };
      stopTimings.heartbeatMs = 20;
      stopTimings.giveUpMs = 200;
      let answer: unknown;
      try {
        const reset = t
          .inOrganization(() =>
            destroyComputer({ ...t.deps, db: unreachable }, before, { signIns: false }),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        await inside;
        down = true;
        answer = await reset;
      } finally {
        provider.destroy = destroy;
        Object.assign(stopTimings, timings);
      }
      expect(aborted).toBe(true);
      expect(answer).toMatchObject({ status: 503, code: 'COMPUTER_UNAVAILABLE' });
      // Nothing was cleared.
      expect(sprites.api.sprites.get(before.containerId!)!.files.has(notes)).toBe(true);
    });
  });

  describe('7. a record on a provider this install does not have', () => {
    it('counts its attempts, gives up for an operator, and lets the computer go', async () => {
      const m = await member('no-provider@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [record] = await retiredOf(m.ownerId);
      // As a reset that died before it settled: the record open, the computer held `stopping`.
      await t.db
        .update(schema.retiredComputers)
        .set({
          status: 'retiring',
          sealedAt: null,
          auditedAt: null,
          claim: crypto.randomUUID(),
          nextAttemptAt: null,
        })
        .where(eq(schema.retiredComputers.id, record!.id));
      await t.db
        .update(schema.computers)
        .set({ status: 'stopping', statusAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.computers.ownerId, m.ownerId));
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
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ attempts: RETIRED_MAX_ATTEMPTS, status: 'retiring' });
      expect(after!.gaveUpAt).not.toBeNull();
      expect(after!.lastError).toMatch(/no sprites provider/);
      // Given up, it no longer holds the member's computer.
      await inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps));
      expect((await m.row()).status).toBe('stopped');
    });
  });
});
