import type { ComputerRef } from '@openbots/computer';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { inEveryOrganization } from '../workers.js';
import {
  held,
  holdOnce,
  spritesWorld,
  until,
  type SpritesWorld,
} from './__fixtures__/sprites-members.js';
import {
  destroyComputer,
  provisionComputer,
  provisionTimings,
  recoverStaleComputers,
  resetMachine,
  restartComputer,
  stopComputer,
  STOPPING_TAKEOVER_MS,
  stopGiveUp,
  stopTimings,
  type ComputerRow,
} from './computer.js';
import { isFenced } from './computer-fence.js';

// Who holds a computer, on Sprites (plan 9.5): a stop or a reset claims it
// (`stopping`, a new generation) and holds the claim through what it does,
// refreshing it; a claim its holder can no longer refresh ends its provider
// call before anyone may take it over; a stop left by a dead process is
// taken over within `STOPPING_TAKEOVER_MS`; and a provisioning job writes
// only while the row is still its own. Clocks and timers are the test's own.

describe('who holds a computer', () => {
  let w: SpritesWorld;

  beforeAll(async () => {
    w = await spritesWorld();
  });
  afterAll(() => w.close());

  describe('a member is never kept from resetting', () => {
    it(`a stop that a dead process left refuses a reset for at most ${STOPPING_TAKEOVER_MS / 60_000} minutes, then the reset takes it over`, async () => {
      const m = await w.member('stuck-stop@example.com');
      const before = await m.row();
      // A stop began and its process died: the row reads `stopping` and nothing finishes it.
      await w.t.db
        .update(schema.computers)
        .set({ status: 'stopping' })
        .where(eq(schema.computers.id, before.id));
      const refused = await w.t
        .inOrganization(async () => destroyComputer(w.t.deps, await m.row(), { signIns: true }))
        .then(
          () => null,
          (error: unknown) => error as { status?: number; code?: string },
        );
      expect(refused).toMatchObject({ status: 409, code: 'COMPUTER_BUSY' });
      // As old as the bound: the reset goes through, and the old machine is deleted.
      await w.t.db
        .update(schema.computers)
        .set({ statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1) })
        .where(eq(schema.computers.id, before.id));
      const reset = await w.t.inOrganization(async () =>
        destroyComputer(w.t.deps, await m.row(), { signIns: true }),
      );
      expect(reset).toMatchObject({ status: 'stopped', containerId: null });
      expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect(STOPPING_TAKEOVER_MS).toBeLessThanOrEqual(2 * 60_000);
    });

    it('a start takes over a stop that a dead process left', async () => {
      const m = await w.member('stuck-start@example.com');
      const before = await m.row();
      await w.t.db
        .update(schema.computers)
        .set({ status: 'stopping', statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1) })
        .where(eq(schema.computers.id, before.id));
      expect(await m.start()).toMatchObject({
        status: 'running',
        containerId: before.containerId,
      });
    });

    it('the sweep recovers busy states a dead process left, once among several workers', async () => {
      /** A member's computer row only, with no machine made: for states that need none. */
      const bare = async (email: string, status: string) => {
        await w.t.signUp(email);
        const [row] = await w.t.db
          .insert(schema.computers)
          .values({
            workspaceId: w.workspaceId,
            ownerId: await w.t.userId(email),
            provider: 'sprites',
            status,
          })
          .returning();
        return row!;
      };
      const get = async (row: ComputerRow) =>
        (await w.t.db.select().from(schema.computers).where(eq(schema.computers.id, row.id)))[0]!;
      const set = (row: ComputerRow, values: Partial<ComputerRow>) =>
        w.t.db.update(schema.computers).set(values).where(eq(schema.computers.id, row.id));
      const old = new Date(Date.now() - 60 * 60_000);
      // A stop cut short on a machine; one with no machine left (a reset cut
      // short); a stop still under way; and a provisioning whose job was lost
      // (made last: the test agent answers the newest machine's token).
      const a = await w.member('sweep-a@example.com');
      const ra = await a.row();
      await set(ra, { status: 'stopping', statusAt: old });
      const rb = await bare('sweep-b@example.com', 'stopping');
      await set(rb, { statusAt: old });
      const rd = await bare('sweep-d@example.com', 'stopping');
      const c = await w.member('sweep-c@example.com');
      const rc = await c.row();
      await set(rc, {
        status: 'starting',
        statusAt: old,
        spec: { ...(rc.spec as object), provision: { attempt: 'lost', at: old.toISOString() } },
      });
      const recovered = await Promise.all([
        inEveryOrganization(w.t.deps, () => recoverStaleComputers(w.t.deps)),
        inEveryOrganization(w.t.deps, () => recoverStaleComputers(w.t.deps)),
      ]);
      expect(recovered[0] + recovered[1]).toBe(3);
      expect(await get(ra)).toMatchObject({ status: 'stopped', containerId: ra.containerId });
      expect(await get(rb)).toMatchObject({ status: 'stopped' });
      expect(await get(rd)).toMatchObject({ status: 'stopping' });
      // The lost job is queued again under a new attempt, which the worker runs.
      await until(async () => expect(await get(rc)).toMatchObject({ status: 'running' }));
      expect((await get(rc)).spec).not.toMatchObject({ provision: { attempt: 'lost' } });
      await set(rd, { status: 'stopped' });
    });
  });

  describe('a reset holds its claim through what it destroys', () => {
    it('a start during a soft reset’s home clearing waits, and the reset finishes', async () => {
      const m = await w.member('soft-start@example.com');
      const before = await m.row();
      const clearing = holdOnce(w.machines(), 'destroy');
      const reset = w.t
        .inOrganization(() => destroyComputer(w.t.deps, before, { signIns: false }))
        .then(
          (computer) => ({ computer }),
          (error: unknown) => ({ error: error as { status?: number; code?: string } }),
        );
      try {
        await clearing.inside;
        // The reset still holds the computer: it reads `stopping`.
        expect((await m.row()).status).toBe('stopping');
        expect(await m.tryStart()).not.toBe(200);
        expect((await m.row()).status).toBe('stopping');
        expect(await inEveryOrganization(w.t.deps, () => recoverStaleComputers(w.t.deps))).toBe(0);
        clearing.go();
        // The Sprite stays, its home cleared, and the row still names it.
        expect(await reset).toMatchObject({
          computer: { status: 'stopped', containerId: before.containerId, agentUrl: null },
        });
      } finally {
        clearing.restore();
      }
      // Its token is refused now: it was taken out of service by a write that landed.
      expect(isFenced(before)).toBe(true);
    });

    it('a reset that lost the computer before it destroys anything destroys nothing and fences nothing', async () => {
      const m = await w.member('soft-lost@example.com');
      const before = await m.row();
      const sprite = w.sprites.api.sprites.get(before.containerId!)!;
      sprite.files.set('/home/bot/notes.txt', new TextEncoder().encode('mine'));
      const stopping = holdOnce(w.machines(), 'stop');
      const reset = w.t
        .inOrganization(() => destroyComputer(w.t.deps, before, { signIns: false }))
        .then(
          (computer) => ({ computer }),
          (error: unknown) => ({ error: error as { status?: number; code?: string } }),
        );
      try {
        await stopping.inside;
        // This process stalled past the takeover (no heartbeat): a start takes the computer.
        await w.t.db
          .update(schema.computers)
          .set({ statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1_000) })
          .where(eq(schema.computers.id, before.id));
        expect([200, 202]).toContain((await m.call('POST', '/computer/start')).status);
        await until(async () => expect((await m.row()).status).toBe('running'));
        stopping.go();
        expect(await reset).toMatchObject({ error: { status: 409, code: 'COMPUTER_CHANGED' } });
      } finally {
        stopping.restore();
      }
      // The home is as it was, and the running computer's token works.
      expect(sprite.files.has('/home/bot/notes.txt')).toBe(true);
      const running = await m.row();
      expect(running).toMatchObject({ status: 'running', containerId: before.containerId });
      expect(isFenced(running)).toBe(false);
    });

    it('a reset that lost the computer while it cleared the home says so and fences nothing', async () => {
      const m = await w.member('soft-lost-mid@example.com');
      const before = await m.row();
      const clearing = holdOnce(w.machines(), 'destroy');
      const reset = w.t.inOrganization(() => resetMachine(w.t.deps, before, { signIns: false }));
      let running: ComputerRow;
      try {
        await clearing.inside;
        await w.t.db
          .update(schema.computers)
          .set({ statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1_000) })
          .where(eq(schema.computers.id, before.id));
        expect([200, 202]).toContain((await m.call('POST', '/computer/start')).status);
        await until(async () => expect((await m.row()).status).toBe('running'));
        running = await m.row();
        clearing.go();
        // Not a silent 409: the reset happened, and the caller writes its cleanup and audit.
        expect(await reset).toMatchObject({ retired: null, computer: { status: 'running' } });
      } finally {
        clearing.restore();
      }
      // Whoever took the computer over uses that token: it is not fenced.
      expect(isFenced(running!)).toBe(false);
    });

    it('a stop read before a full reset never lands on it', async () => {
      const m = await w.member('stale-stop@example.com');
      const stale = await m.row();
      expect(stale.status).toBe('running');
      const deleting = holdOnce(w.machines(), 'destroy');
      try {
        const resetting = w.t.inOrganization(() =>
          destroyComputer(w.t.deps, stale, { signIns: true }),
        );
        await deleting.inside;
        const during = await m.row();
        expect(during).toMatchObject({ status: 'stopped', containerId: null });
        const calls = w.sprites.api.calls.length;
        const out = await w.t.inOrganization(() => stopComputer(w.t.deps, stale));
        // Nothing written, nothing asked of the old machine.
        expect(out).toMatchObject({ status: 'stopped', generation: during.generation });
        expect(await m.row()).toMatchObject({ status: 'stopped', generation: during.generation });
        expect(w.sprites.api.calls.slice(calls)).toEqual([]);
        deleting.go();
        expect(await resetting).toMatchObject({ status: 'stopped', containerId: null });
      } finally {
        deleting.restore();
      }
    });

    it('a reset that cannot refresh its claim ends its home clearing before it can be taken over', async () => {
      const m = await w.member('claim-unheard@example.com');
      const before = await m.row();
      const notes = '/home/bot/notes.md';
      w.sprites.api.sprites.get(before.containerId!)!.files.set(notes, new Uint8Array([1]));
      const provider = w.machines();
      const destroy = provider.destroy;
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let down = false;
      let aborted = false;
      provider.destroy = async (ref, options) => {
        entered();
        // The home clearing runs until its signal ends it.
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            down = false;
            reject(options.signal!.reason as Error);
          });
        });
        return destroy.call(provider, ref, options);
      };
      // The database goes out of reach for this process's refreshes.
      const db = w.t.deps.db;
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
      // The give-up's clock and timer are the test's: it fires when the test says.
      const timings = { ...stopTimings };
      const armed: { fire: () => void; disarmed: boolean }[] = [];
      stopTimings.heartbeatMs = 20;
      stopTimings.setTimer = (fire) => {
        const timer = { fire, disarmed: false };
        armed.push(timer);
        return () => (timer.disarmed = true);
      };
      let answer: unknown;
      try {
        const reset = w.t
          .inOrganization(() =>
            destroyComputer({ ...w.t.deps, db: unreachable }, before, { signIns: false }),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        await inside;
        down = true;
        await until(() => expect(armed.some((a) => !a.disarmed)).toBe(true));
        armed
          .filter((a) => !a.disarmed)
          .at(-1)!
          .fire();
        answer = await reset;
      } finally {
        provider.destroy = destroy;
        Object.assign(stopTimings, timings);
      }
      expect(aborted).toBe(true);
      expect(answer).toMatchObject({ status: 503, code: 'COMPUTER_UNAVAILABLE' });
      // Nothing was cleared.
      expect(w.sprites.api.sprites.get(before.containerId!)!.files.has(notes)).toBe(true);
    });
  });

  describe('a provisioning job writes only while the row is its own', () => {
    it('a job whose attempt was given back does not write over a reset that keeps the machine key', async () => {
      const m = await w.member('generation@example.com');
      const before = await m.row();
      // A start queued its job (a new attempt, a new generation, as `queueProvision` does).
      await w.t.db
        .update(schema.computers)
        .set({
          status: 'starting',
          generation: sql`${schema.computers.generation} + 1`,
          spec: {
            ...(before.spec as object),
            provision: { attempt: 'given-back', at: new Date().toISOString() },
          },
        })
        .where(eq(schema.computers.id, before.id));
      const read = holdOnce(w.machines(), 'status');
      try {
        const running = w.t.inOrganization(() =>
          provisionComputer(w.t.deps, {
            computerId: before.id,
            workspaceId: w.workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'given-back',
          }),
        );
        await read.inside;
        // The queue's answer was lost: the attempt is given back and the row released.
        await w.t.db
          .update(schema.computers)
          .set({ status: 'stopped', spec: sql`${schema.computers.spec} - 'provision'` })
          .where(eq(schema.computers.id, before.id));
        // A reset that keeps the sign-ins (and the machine key) goes through meanwhile.
        await w.t.inOrganization(async () =>
          destroyComputer(w.t.deps, await m.row(), { signIns: false }),
        );
        read.go();
        await running;
      } finally {
        read.restore();
      }
      // The kept Sprite is still named; the job wrote no agent.
      expect(await m.row()).toMatchObject({
        status: 'stopped',
        containerId: before.containerId,
        agentUrl: null,
      });
    });

    it('one a reset cancelled ends at its next heartbeat, its provisioning command with it', async () => {
      const m = await w.member('cancelled@example.com');
      const before = await m.row();
      const sprite = w.sprites.api.sprites.get(before.containerId!)!;
      // Its next start provisions again (an older version installed).
      sprite.files.set('/opt/openbots/provision.version', new TextEncoder().encode('0\n'));
      await w.t.db
        .update(schema.computers)
        .set({
          status: 'starting',
          generation: sql`${schema.computers.generation} + 1`,
          spec: {
            ...(before.spec as object),
            provision: { attempt: 'a-1', at: new Date().toISOString() },
          },
        })
        .where(eq(schema.computers.id, before.id));
      const exec = w.sprites.api.exec;
      const h = held();
      let ended = false;
      w.sprites.api.exec = async (name, argv, options) => {
        if (argv[2]?.includes('read -r OPENBOTS_AGENT_TOKEN')) {
          h.entered();
          await new Promise<void>((_, reject) =>
            options?.signal?.addEventListener('abort', () => {
              ended = true;
              reject(new Error('exec was ended by its caller'));
            }),
          );
        }
        return exec.call(w.sprites.api, name, argv, options);
      };
      const beat = provisionTimings.heartbeatMs;
      provisionTimings.heartbeatMs = 20;
      try {
        const running = w.t.inOrganization(() =>
          provisionComputer(w.t.deps, {
            computerId: before.id,
            workspaceId: w.workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'a-1',
          }),
        );
        await h.inside;
        // A reset cancels it (its generation moves on).
        const reset = await w.t.inOrganization(async () =>
          destroyComputer(w.t.deps, await m.row(), { signIns: false }),
        );
        expect(reset).toMatchObject({ status: 'stopped' });
        await running;
        expect(ended).toBe(true);
      } finally {
        provisionTimings.heartbeatMs = beat;
        w.sprites.api.exec = exec;
      }
      // The kept Sprite is still named; the cancelled job wrote no agent.
      expect(await m.row()).toMatchObject({
        status: 'stopped',
        containerId: before.containerId,
        agentUrl: null,
      });
    });
  });

  describe('a stop', () => {
    it('that lost the computer releases no hold of the use that took it over', async () => {
      const m = await w.member('stop-takeover@example.com');
      const row = await m.row();
      const provider = w.machines();
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
        await w.t.db
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
        await expect(w.t.inOrganization(() => stopComputer(w.t.deps, row))).rejects.toMatchObject({
          status: 503,
        });
      } finally {
        provider.stop = stop;
        Object.assign(stopTimings, timings);
      }
      expect([...w.sprites.api.sprites.get(row.containerId!)!.tasks.keys()]).toContain(
        'openbots-new-use',
      );
    });

    it('whose refresh is slow to answer gives up counting from when it was sent', async () => {
      const m = await w.member('slow-refresh@example.com');
      const row = await m.row();
      const giveUp = 1_000;
      // The stop's clock and give-up timer are the test's own: the deadline
      // it arms is read, not timed, so a slow machine changes nothing.
      let clock = 0;
      const armed: { at: number; fire: () => void; disarmed: boolean }[] = [];
      // Refreshes of the stop's claim (a write of `status_at` alone): the
      // first lands and answers at once, at 0; the second is sent at 100 and
      // lands at once, but its answer comes at 900; the rest never answer
      // (the database is gone).
      let refreshes = 0;
      let answerLate: (() => void) | undefined;
      const pending: (() => void)[] = [];
      const db = w.t.deps.db;
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
                if (n === 0) {
                  return landed.then((v) => {
                    clock = 100;
                    return ok(v);
                  }, fail);
                }
                return landed.then(
                  (v) =>
                    new Promise<void>((resolve) => {
                      const answer = () => resolve(ok(v));
                      if (n === 1) {
                        answerLate = () => {
                          clock = 900;
                          answer();
                        };
                      } else pending.push(answer);
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
      const provider = w.machines();
      const stop = provider.stop;
      provider.stop = async (_ref, options) => {
        const signal = options?.signal;
        if (!signal) return;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw signal.reason as Error;
      };
      const timings = { ...stopTimings };
      stopTimings.heartbeatMs = 20;
      stopTimings.giveUpMs = giveUp;
      stopTimings.now = () => clock;
      stopTimings.setTimer = (fire, ms) => {
        const timer = { at: clock + ms, fire, disarmed: false };
        armed.push(timer);
        return () => (timer.disarmed = true);
      };
      const stopping = w.t
        .inOrganization(() => stopComputer({ ...w.t.deps, db: slow as typeof db }, row))
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        await until(() => expect(answerLate).toBeDefined());
        answerLate!();
        await until(() => expect(armed).toHaveLength(2));
        // From each refresh's sending: 0 + giveUp, then 100 + giveUp. Never
        // from the late answer (that would be 900 + giveUp), and only later.
        expect(armed.map((a) => a.at)).toEqual([giveUp, 100 + giveUp]);
        expect(armed.map((a) => a.disarmed)).toEqual([true, false]);
        // The give-up comes: the provider's call ends, and the stop with it.
        armed[1]!.fire();
        expect(await stopping).toMatchObject({ status: 503 });
      } finally {
        for (const timer of armed) if (!timer.disarmed) timer.fire();
        await stopping;
        provider.stop = stop;
        Object.assign(stopTimings, timings);
        for (const answer of pending) answer();
      }
    });

    it('a refresh sent earlier that lands later never moves the give-up back', () => {
      const timings = { ...stopTimings };
      let clock = 0;
      const armed: number[] = [];
      stopTimings.giveUpMs = 1_000;
      stopTimings.now = () => clock;
      stopTimings.setTimer = (_fire, ms) => {
        armed.push(clock + ms);
        return () => {};
      };
      try {
        const giveUp = stopGiveUp(() => {});
        clock = 400;
        expect(giveUp.heard(300)).toBe(1_300);
        // Sent at 200, answered after the one sent at 300: the deadline stays.
        clock = 700;
        expect(giveUp.heard(200)).toBe(1_300);
        expect(giveUp.heard(300)).toBe(1_300);
        clock = 900;
        expect(giveUp.heard(500)).toBe(1_500);
        expect(armed).toEqual([1_300, 1_500]);
      } finally {
        Object.assign(stopTimings, timings);
      }
    });

    it('that loses its claim to a start that finished stops the computer as it now is', async () => {
      const m = await w.member('stop-race@example.com');
      const running = await m.row();
      expect(running.status).toBe('running');
      // The stop read the computer while it was starting; the start finished
      // first, and its guarded write kept the generation the stop read.
      const read: ComputerRow = { ...running, status: 'starting' };
      const out = await w.t.inOrganization(() => stopComputer(w.t.deps, read));
      expect(out.status).toBe('stopped');
      expect(await m.row()).toMatchObject({ status: 'stopped' });
    });

    it('a restart from a stale read restarts', async () => {
      const m = await w.member('restart-race@example.com');
      const running = await m.row();
      const read: ComputerRow = { ...running, status: 'starting' };
      const started = await w.t.inOrganization(() =>
        restartComputer(w.t.deps, { id: m.ownerId, workspaceId: w.workspaceId }, read),
      );
      // Stopped first, so this call started it again.
      expect(started.computer.status).toBe('running');
      expect(started.durationMs).not.toBeNull();
    });
  });
});
