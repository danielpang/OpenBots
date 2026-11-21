import { SPRITES_DENY_ALL, SPRITES_RETIRED_LABEL, type ComputerProvider } from '@openbots/computer';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import {
  computerProvider,
  destroyComputer,
  provisionComputer,
  provisionTimings,
  recoverStaleComputers,
  resetMachine,
  STOPPING_TAKEOVER_MS,
  type ComputerRow,
} from './computer.js';
import { isFenced } from './computer-fence.js';
import {
  RESTORE_LEASE_MS,
  RETIRE_LEASE_MS,
  RETIRED_RECHECK_MS,
  restoreRetiredComputer,
  retireMachine,
  runRetiredComputerJob,
  sweepRetiredComputers,
} from './computer-retire.js';
import { runRescueJob } from './repos-rescue.js';

// Retired computers, forward only (the third review). Nothing of the
// member's changes before the reset's point of no return, so an undo has
// nothing of theirs to put back; the member's choice to delete the old
// computer now is on the record and every actor honours it; a bus that is
// down changes neither what a reset did nor what it answers; and a reset
// holds its claim on the computer through what it destroys.

const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

/** A call held until the test lets it go, or fails it. */
function held() {
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let go!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    go = resolve;
    fail = reject;
  });
  return { entered, inside, gate, go, fail };
}

const UNDONE =
  'The computer could not be reset. It was stopped and its coding sessions ended, but its files and sign-ins are as they were. Try the reset again in a few minutes.';
const BACKGROUND =
  'The reset did not finish shutting off the old computer. It is retried in the background.';

describe('retired computers, forward only', () => {
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
    const confirm = (requestId: string, extra: object) =>
      call('POST', '/computer/reset', { requestId, confirm: true, ...extra });
    const res = await call('POST', '/computer/start');
    expect(res.status, await res.clone().text()).toBe(200);
    /** What the member had on the computer: a coding agent signed in, a checkout ready. */
    const signedIn = async () => {
      const computer = await row();
      await t.db.insert(schema.coderAccounts).values({
        workspaceId,
        ownerId,
        agent: 'claude',
        authKind: 'subscription',
        accountLabel: 'me@example.com',
        signedInAt: new Date(),
      });
      const [repo] = await t.db
        .insert(schema.repos)
        .values({
          workspaceId,
          ownerId,
          fullName: `acme/${ownerId.slice(0, 8)}`,
          remoteUrl: `https://github.com/acme/${ownerId.slice(0, 8)}.git`,
          defaultBranch: 'main',
        })
        .returning();
      await t.db.insert(schema.repoCheckouts).values({
        workspaceId,
        repoId: repo!.id,
        computerId: computer.id,
        path: `/home/bot/repos/acme/${ownerId.slice(0, 8)}`,
        state: 'ready',
      });
    };
    /** The member's sign-in and checkout as they now are. */
    const kept = async () => {
      const [account] = await t.db
        .select()
        .from(schema.coderAccounts)
        .where(eq(schema.coderAccounts.ownerId, ownerId));
      const [checkout] = await t.db
        .select({ state: schema.repoCheckouts.state })
        .from(schema.repoCheckouts)
        .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
        .where(eq(schema.repos.ownerId, ownerId));
      return { authKind: account?.authKind, checkout: checkout?.state };
    };
    /** A start that answers at once while the computer is busy, as the apps see it. */
    const tryStart = async () => {
      const wait = provisionTimings.waitMs;
      provisionTimings.waitMs = 0;
      try {
        return (await call('POST', '/computer/start')).status;
      } finally {
        provisionTimings.waitMs = wait;
      }
    };
    return { ownerId, call, row, prepare, confirm, signedIn, kept, tryStart };
  }

  const retiredOf = (ownerId: string) =>
    t.db
      .select()
      .from(schema.retiredComputers)
      .where(eq(schema.retiredComputers.ownerId, ownerId))
      .orderBy(schema.retiredComputers.retiredAt);
  const machines = () => computerProvider(t.ownerDeps)!;
  const sweep = (now?: Date) =>
    inEveryOrganization(t.deps, () => sweepRetiredComputers(t.deps, now));
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
  const outOfReach = (name: string) => {
    const sprite = sprites.api.sprites.get(name)!;
    expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
    expect(sprite.urlAuth).toBe('sprite');
    expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
  };
  const inService = (name: string) => {
    const sprite = sprites.api.sprites.get(name)!;
    expect(sprite.labels).not.toContain(SPRITES_RETIRED_LABEL);
    expect(sprite.urlAuth).toBe('public');
  };
  /** Holds the provider's `op` once (the first call), letting later calls through. */
  function holdOnce<K extends 'retire' | 'stop' | 'destroy' | 'restore'>(
    provider: ComputerProvider,
    op: K,
  ) {
    const real = provider[op]! as (...args: unknown[]) => Promise<unknown>;
    const h = held();
    let first = true;
    (provider as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
      if (first) {
        first = false;
        h.entered();
        await h.gate;
      }
      return real.apply(provider, args);
    };
    return { ...h, restore: () => ((provider as unknown as Record<string, unknown>)[op] = real) };
  }
  /** Every URL change to `auth` fails while it is set. */
  const failUrlAuth = (auth?: 'sprite' | 'public') => {
    const real = sprites.api.setUrlAuth;
    sprites.api.setUrlAuth = async (name, to, options) => {
      if (!auth || to === auth) throw new Error('Sprites API: URL settings failed (503)');
      return real.call(sprites.api, name, to, options);
    };
    return () => (sprites.api.setUrlAuth = real);
  };
  /** Every publish on the bus fails while it is set (Redis down). */
  const busDown = () => {
    const bus = t.deps.infra.bus;
    const real = bus.publish;
    bus.publish = (async () => {
      throw new Error('redis down');
    }) as typeof bus.publish;
    return () => (bus.publish = real);
  };

  describe('1. an undone reset changes nothing of the member', () => {
    it('leaves the sign-ins, checkouts and audit as they were, as its 503 says', async () => {
      const m = await member('undo-nothing@example.com');
      await isolate(m.ownerId);
      await m.signedIn();
      const before = await m.row();
      const requestId = await m.prepare();
      // The cut fails at its URL step; putting it back (a public URL) works.
      const restore = failUrlAuth('sprite');
      let res: Response;
      try {
        res = await m.confirm(requestId, { resetSignIns: true });
      } finally {
        restore();
      }
      expect(res.status).toBe(503);
      expect(((await res.json()) as { title: string }).title).toBe(UNDONE);
      // Exactly true: the computer has its machine, and nothing of the member's moved.
      expect(await m.row()).toMatchObject({
        status: 'stopped',
        containerId: before.containerId,
        machineKey: before.machineKey,
      });
      expect(await m.kept()).toEqual({ authKind: 'subscription', checkout: 'ready' });
      expect(await resetAudits(requestId)).toHaveLength(0);
      expect(await retiredOf(m.ownerId)).toHaveLength(0);
      inService(before.containerId!);
    });

    it('settles the reset once a reset is past its point of no return, exactly once', async () => {
      const m = await member('settle-once@example.com');
      await isolate(m.ownerId);
      await m.signedIn();
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      expect(await m.kept()).toEqual({ authKind: 'none', checkout: 'missing' });
      const [row] = await retiredOf(m.ownerId);
      // The job after it finds it settled: no second cleanup, no second audit.
      await t.db
        .update(schema.coderAccounts)
        .set({ authKind: 'subscription' })
        .where(eq(schema.coderAccounts.ownerId, m.ownerId));
      await job(row!.id, 'retire');
      expect((await m.kept()).authKind).toBe('subscription');
      expect(await resetAudits(requestId)).toHaveLength(1);
    });
  });

  describe("2. the member's choice to delete the old computer now", () => {
    it('is on the record from the start, honoured by the job, and never restorable', async () => {
      const m = await member('delnow-job@example.com');
      await isolate(m.ownerId);
      await m.signedIn();
      const before = await m.row();
      const requestId = await m.prepare();
      // The cut fails, and so does putting it back: the reset hands it to the job.
      const restore = failUrlAuth();
      let res: Response;
      try {
        res = await m.confirm(requestId, { resetSignIns: true, deleteOldComputer: true });
      } finally {
        restore();
      }
      expect(res.status).toBe(503);
      expect(((await res.json()) as { title: string }).title).toBe(BACKGROUND);
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring', deleteNow: true, sealedAt: null });
      expect(row!.deleteAfter.getTime()).toBe(row!.retiredAt.getTime());
      // Never restorable, whatever state it is in.
      await expect(
        t.inOrganization(() =>
          restoreRetiredComputer(t.deps, machines(), { workspaceId, retiredId: row!.id }, 'op'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_RESTORABLE' });
      await job(row!.id, 'retire');
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'deleted' });
      // The job settled the reset: the member's computer is free for its new machine.
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
      expect(await m.kept()).toEqual({ authKind: 'none', checkout: 'missing' });
      expect(await resetAudits(requestId)).toHaveLength(1);
    });

    it('is honoured after a crash between the record and the cut', async () => {
      const m = await member('delnow-crash@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const provider = machines();
      // The reset's process dies inside the cut: it never comes back.
      const dead = holdOnce(provider, 'retire');
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
            deleteNow: true,
          }),
        )
        .catch(() => undefined);
      await dead.inside;
      dead.restore();
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring', deleteNow: true });
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'deleting' });
      await job(row!.id, 'delete');
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'deleted' });
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });

    it('is honoured when the sweep took the record past the reset’s lease', async () => {
      const m = await member('delnow-lease@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const provider = machines();
      const slow = holdOnce(provider, 'retire');
      const resetting = t.inOrganization(() =>
        retireMachine(t.deps, provider, before, {
          checkpointId: null,
          by: { type: 'user', id: m.ownerId },
          reason: 'reset',
          deleteNow: true,
        }),
      );
      try {
        await slow.inside;
        const [row] = await retiredOf(m.ownerId);
        // The reset ran past its lease: the sweep takes the record.
        expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
        slow.go();
        // Its own cut went through, so it answers; the record is no longer its.
        await resetting;
      } finally {
        slow.restore();
      }
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'deleting', deleteNow: true });
      await job(row!.id, 'delete');
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'deleted' });
    });

    it('stays unrestorable when its deletion fails and the record waits for a retry', async () => {
      const m = await member('delnow-retry@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const provider = machines();
      const destroy = provider.destroy;
      provider.destroy = async () => {
        throw new Error('Sprites API: delete failed (503)');
      };
      try {
        await t.inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
            deleteNow: true,
          }),
        );
      } finally {
        provider.destroy = destroy;
      }
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retired', deleteNow: true });
      outOfReach(before.containerId!);
      await expect(
        t.inOrganization(() =>
          restoreRetiredComputer(t.deps, provider, { workspaceId, retiredId: row!.id }, 'op'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_RESTORABLE' });
      // Due as soon as its retry is: deleted, never kept.
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
    });
  });

  describe('3. a bus that is down changes nothing a reset does or answers', () => {
    it('a full reset with every publish failing answers as one, sealed and out of reach', async () => {
      const m = await member('bus-reset@example.com');
      await isolate(m.ownerId);
      await m.signedIn();
      const before = await m.row();
      const requestId = await m.prepare();
      const up = busDown();
      let res: Response;
      try {
        res = await m.confirm(requestId, { resetSignIns: true });
      } finally {
        up();
      }
      expect(res.status, await res.clone().text()).toBe(202);
      outOfReach(before.containerId!);
      const [row] = await retiredOf(m.ownerId);
      expect(row!.sealedAt).not.toBeNull();
      expect(row!.auditedAt).not.toBeNull();
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
      expect(await m.kept()).toEqual({ authKind: 'none', checkout: 'missing' });
    });

    it('a delete-now reset with the bus down deletes the old computer at once', async () => {
      const m = await member('bus-delnow@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      const up = busDown();
      let res: Response;
      try {
        res = await m.confirm(requestId, { resetSignIns: true, deleteOldComputer: true });
      } finally {
        up();
      }
      expect(res.status, await res.clone().text()).toBe(202);
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'deleted' });
    });

    it('an undone reset with the bus down still answers that nothing changed', async () => {
      const m = await member('bus-undo@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      const up = busDown();
      const restore = failUrlAuth('sprite');
      let res: Response;
      try {
        res = await m.confirm(requestId, { resetSignIns: true });
      } finally {
        restore();
        up();
      }
      expect(res.status).toBe(503);
      expect(((await res.json()) as { title: string }).title).toBe(UNDONE);
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: before.containerId });
      expect(await retiredOf(m.ownerId)).toHaveLength(0);
    });
  });

  describe('4. a reset holds its claim through what it destroys', () => {
    it('a start during a soft reset’s home clearing waits, and the reset finishes', async () => {
      const m = await member('soft-start@example.com');
      const before = await m.row();
      const provider = machines();
      const clearing = holdOnce(provider, 'destroy');
      const reset = t
        .inOrganization(() => destroyComputer(t.deps, before, { signIns: false }))
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
        expect(await inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps))).toBe(0);
        clearing.go();
        const out = await reset;
        expect(out).toMatchObject({ computer: { status: 'stopped', containerId: null } });
      } finally {
        clearing.restore();
      }
      // Its token is refused now: it was taken out of service by a write that landed.
      expect(isFenced(before)).toBe(true);
    });

    it('a reset that lost the computer before it destroys anything destroys nothing and fences nothing', async () => {
      const m = await member('soft-lost@example.com');
      const before = await m.row();
      const sprite = sprites.api.sprites.get(before.containerId!)!;
      sprite.files.set('/home/bot/notes.txt', new TextEncoder().encode('mine'));
      const provider = machines();
      const stopping = holdOnce(provider, 'stop');
      const reset = t
        .inOrganization(() => destroyComputer(t.deps, before, { signIns: false }))
        .then(
          (computer) => ({ computer }),
          (error: unknown) => ({ error: error as { status?: number; code?: string } }),
        );
      try {
        await stopping.inside;
        // This process stalled past the takeover (no heartbeat): a start takes the computer.
        await t.db
          .update(schema.computers)
          .set({ statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1_000) })
          .where(eq(schema.computers.id, before.id));
        const started = await m.call('POST', '/computer/start');
        expect([200, 202]).toContain(started.status);
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
      const m = await member('soft-lost-mid@example.com');
      const before = await m.row();
      const provider = machines();
      const clearing = holdOnce(provider, 'destroy');
      const reset = t.inOrganization(() => resetMachine(t.deps, before, { signIns: false }));
      let running: ComputerRow;
      try {
        await clearing.inside;
        await t.db
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
  });

  describe('5. an open retirement holds the computer, whatever its age', () => {
    it('no start, sweep or reset takes over a computer whose reset is not settled', async () => {
      const m = await member('open-retire@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const provider = machines();
      const dead = holdOnce(provider, 'retire');
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
          }),
        )
        .catch(() => undefined);
      await dead.inside;
      dead.restore();
      // Long past the takeover bound, and the record's lease not yet out.
      await t.db
        .update(schema.computers)
        .set({ statusAt: new Date(Date.now() - 10 * STOPPING_TAKEOVER_MS) })
        .where(eq(schema.computers.id, before.id));
      const stuck = await m.row();
      expect(stuck).toMatchObject({ status: 'stopping', containerId: null });
      expect(await m.tryStart()).not.toBe(200);
      expect(await inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps))).toBe(0);
      await expect(
        t.inOrganization(() => resetMachine(t.deps, stuck, { signIns: true })),
      ).rejects.toMatchObject({ code: 'COMPUTER_BUSY' });
      expect(await m.row()).toMatchObject({ status: 'stopping', generation: stuck.generation });
      // The job takes it from the sweep and settles it first.
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(row!.id, 'retire');
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
      outOfReach(before.containerId!);
      expect(RETIRE_LEASE_MS).toBeGreaterThan(STOPPING_TAKEOVER_MS);
    });
  });

  describe('6. restore', () => {
    it('re-checks its claim before it puts the machine back', async () => {
      const m = await member('restore-claim@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      const [row] = await retiredOf(m.ownerId);
      await job(row!.id, 'retire');
      // Give it a checkpoint to restore, so the restore has a call to hold.
      const checkpoint = await sprites.api.createCheckpoint(before.containerId!, 'held');
      await t.db
        .update(schema.retiredComputers)
        .set({ checkpointId: checkpoint })
        .where(eq(schema.retiredComputers.id, row!.id));
      const provider = machines();
      const restoring = holdOnce(provider, 'restore');
      const real = provider.restore!;
      const calls = sprites.api.calls.length;
      const restored = t
        .inOrganization(() =>
          restoreRetiredComputer(t.deps, provider, { workspaceId, retiredId: row!.id }, 'op'),
        )
        .then(
          () => null,
          (error: unknown) => error as { code?: string },
        );
      try {
        await restoring.inside;
        // The restore ran past its lease: the sweep takes the machine back.
        const [leased] = await retiredOf(m.ownerId);
        expect(await sweep(new Date(leased!.nextAttemptAt!.getTime() + 1))).toBeGreaterThanOrEqual(
          1,
        );
        restoring.go();
        expect(await restored).toMatchObject({ code: 'COMPUTER_CHANGED' });
      } finally {
        restoring.restore();
        provider.restore = real;
      }
      // Nothing put the machine back in service.
      expect(
        sprites.api.calls
          .slice(calls)
          .filter((c) => c.op === 'setLabels' && c.name === before.containerId),
      ).toHaveLength(0);
      expect(sprites.api.sprites.get(before.containerId!)!.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(RESTORE_LEASE_MS).toBeGreaterThan(0);
    });
  });

  describe('7. a job that lost its claim changes nothing on the machine', () => {
    it('checks its claim before the steps inside, after a slow cut', async () => {
      const m = await member('stale-job@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      const [row] = await retiredOf(m.ownerId);
      expect(row!.sealedAt).not.toBeNull();
      // Its job's cut is slow, past its lease: the sweep queues another.
      const provider = machines();
      const slow = holdOnce(provider, 'retire');
      const first = job(row!.id, 'retire');
      try {
        await slow.inside;
        const [leased] = await retiredOf(m.ownerId);
        expect(await sweep(new Date(leased!.nextAttemptAt!.getTime() + 1))).toBe(1);
        const marks = sprites.api.calls.length;
        slow.go();
        await first;
        // The first job made no call inside the machine once it lost the record.
        expect(
          sprites.api.calls
            .slice(marks)
            .filter((c) => c.op === 'exec' && c.name === before.containerId),
        ).toHaveLength(0);
      } finally {
        slow.restore();
      }
      await job(row!.id, 'retire');
      expect((await retiredOf(m.ownerId))[0]).toMatchObject({ status: 'retired' });
    });
  });

  describe('8. out of reach is read back whole', () => {
    it('a machine whose egress is open is not given up as out of reach', async () => {
      const m = await member('policy-open@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      const provider = machines();
      const retireInside = provider.retireInside!;
      provider.retireInside = async () => {
        throw new Error('Sprites API: exec failed for it');
      };
      const setPolicy = sprites.api.setNetworkPolicy;
      try {
        expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
        const [row] = await retiredOf(m.ownerId);
        // Something opened its egress; label and URL are still as the cut left them.
        sprites.api.sprites.get(before.containerId!)!.policy = {
          rules: [{ domain: '*', action: 'allow' }],
        };
        sprites.api.setNetworkPolicy = async () => {
          throw new Error('Sprites API: network policy failed (503)');
        };
        for (let i = 0; i < 12; i++) await job(row!.id, 'retire');
      } finally {
        provider.retireInside = retireInside;
        sprites.api.setNetworkPolicy = setPolicy;
      }
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ status: 'retiring', sealedAt: null });
      expect(after!.gaveUpAt).not.toBeNull();
    });
  });

  describe('10. a provisioning the reset cancelled', () => {
    it('ends at its next heartbeat, its provisioning command with it', async () => {
      const m = await member('cancelled@example.com');
      const before = await m.row();
      const sprite = sprites.api.sprites.get(before.containerId!)!;
      // Its next start provisions again (an older version installed).
      sprite.files.set('/opt/openbots/provision.version', new TextEncoder().encode('0\n'));
      await t.db
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
      const exec = sprites.api.exec;
      const h = held();
      let ended = false;
      sprites.api.exec = async (name, argv, options) => {
        if (argv[2]?.includes('read -r OPENBOTS_AGENT_TOKEN')) {
          h.entered();
          await new Promise<void>((_, reject) =>
            options?.signal?.addEventListener('abort', () => {
              ended = true;
              reject(new Error('exec was ended by its caller'));
            }),
          );
        }
        return exec.call(sprites.api, name, argv, options);
      };
      const beat = provisionTimings.heartbeatMs;
      provisionTimings.heartbeatMs = 20;
      try {
        const running = t.inOrganization(() =>
          provisionComputer(t.deps, {
            computerId: before.id,
            workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'a-1',
          }),
        );
        await h.inside;
        // A reset cancels it (its generation moves on).
        const reset = await t.inOrganization(async () =>
          destroyComputer(t.deps, await m.row(), { signIns: false }),
        );
        expect(reset).toMatchObject({ status: 'stopped' });
        await running;
        expect(ended).toBe(true);
      } finally {
        provisionTimings.heartbeatMs = beat;
        sprites.api.exec = exec;
      }
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });
  });

  describe('12. an agent a cancelled provisioning installed after all', () => {
    it('is removed when the sweep runs the steps inside once more', async () => {
      const m = await member('late-agent@example.com');
      await isolate(m.ownerId);
      const before = await m.row();
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      const [row] = await retiredOf(m.ownerId);
      await job(row!.id, 'retire');
      const sprite = sprites.api.sprites.get(before.containerId!)!;
      expect(sprite.services.has('openbots-agent')).toBe(false);
      // A provisioning the reset cancelled, cut off from the database, finished anyway.
      sprite.services.add('openbots-agent');
      const at = new Date(row!.retiredAt.getTime() + RETIRED_RECHECK_MS + 1);
      expect(await sweep(at)).toBe(1);
      await t.inOrganization(async () => {
        const [claimed] = await retiredOf(m.ownerId);
        await runRetiredComputerJob(
          t.deps,
          machines(),
          { retiredId: row!.id, kind: 'retire', claim: claimed!.claim! },
          at,
        );
      });
      expect(sprite.services.has('openbots-agent')).toBe(false);
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ status: 'retired' });
      expect(after!.checkedAt).not.toBeNull();
      // Once only.
      expect(await sweep(at)).toBe(0);
    });
  });
});
