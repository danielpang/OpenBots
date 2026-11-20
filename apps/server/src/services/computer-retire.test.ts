import {
  SPRITES_AGENT_SERVICE,
  SPRITES_AGENT_TOKEN_FILES,
  SPRITES_DENY_ALL,
  SPRITES_RETIRED_LABEL,
  spriteName,
  type ComputerProvider,
} from '@openbots/computer';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runComputers } from '../cli/computers.js';
import type { CliContext } from '../cli/context.js';
import { schema } from '../db/client.js';
import { endMembershipAccess } from '../membership.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import {
  agentFor,
  beginComputerUse,
  computerProvider,
  destroyComputer,
  provisionComputer,
  setComputerProvider,
  type ComputerRow,
} from './computer.js';
import {
  purgeRetiredComputers,
  RETIRED_COMPUTER_DAYS,
  RETIRED_COMPUTERS_QUEUE,
  RETIRE_LEASE_MS,
  RETIRED_LEASE_MS,
  RETIRED_RECHECK_MS,
  RETIRED_MAX_ATTEMPTS,
  RETIRED_SWEEP_MS,
  retiredComputerHandler,
  retireMachine,
  runRetiredComputerJob,
  sweepRetiredComputers,
  type RetiredComputerJob,
} from './computer-retire.js';
import { settleComputerUses, useTimings } from './computer-use.js';
import { runRescueJob } from './repos-rescue.js';

// A reset that also forgets the sign-ins, on Sprites (the owner's decision):
// the old Sprite is retired and kept seven days, not deleted, and the member
// gets a new one; the retired-computers job deletes it after; support can
// restore it with `openbots computers restore`.

const DAY = 24 * 60 * 60_000;
const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

describe('retired computers', () => {
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

  /** A member with a started computer on Sprites. */
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
      (
        await t.db
          .select()
          .from(schema.computers)
          .where(and(eq(schema.computers.ownerId, ownerId)))
      )[0]!;
    const start = async () => {
      const res = await call('POST', '/computer/start');
      expect(res.status, await res.clone().text()).toBe(200);
      return row();
    };
    /** The reset as the web app runs it: prepare, the rescue, then the reset. */
    const reset = async (
      resetSignIns: boolean,
      { finish = true, ...extra }: { finish?: boolean; deleteOldComputer?: boolean } = {},
    ) => {
      const computer = await row();
      const prepare = await call('POST', '/computer/reset/prepare');
      expect(prepare.status, await prepare.clone().text()).toBe(202);
      const { requestId } = (await prepare.json()) as { requestId: string };
      await t.inOrganization(() =>
        runRescueJob(t.deps, { ownerId, computerId: computer.id, requestId }),
      );
      let status: Record<string, unknown> = {};
      await until(async () => {
        status = (await (await call('GET', `/computer/reset/${requestId}`)).json()) as Record<
          string,
          unknown
        >;
        expect(status).toMatchObject({ status: 'done' });
      });
      const res = await call('POST', '/computer/reset', {
        requestId,
        confirm: true,
        resetSignIns,
        ...extra,
      });
      // The steps inside the old Sprite run in the background: here, at once.
      if (finish && res.status === 202) await finishRetires(ownerId);
      return { res, status };
    };
    await start();
    return { cookie, ownerId, call, row, start, reset };
  }

  /** Runs the retire job of each of the member's rows still `retiring`, as the queue would. */
  async function finishRetires(ownerId: string) {
    for (const row of await retiredOf(ownerId)) {
      if (row.status === 'retiring') await job(row.id, 'retire');
    }
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
  /** The row's job as the queue runs it: with the claim it was queued under (the row's now). */
  const claimOf = async (retiredId: string) =>
    (
      await t.db
        .select({ claim: schema.retiredComputers.claim })
        .from(schema.retiredComputers)
        .where(eq(schema.retiredComputers.id, retiredId))
    )[0]?.claim ?? undefined;
  const job = async (retiredId: string, kind: 'retire' | 'delete', now?: Date) => {
    const claim = await claimOf(retiredId);
    return t.inOrganization(() =>
      runRetiredComputerJob(
        t.deps,
        machines(),
        { retiredId, kind, ...(claim ? { claim } : {}) },
        now,
      ),
    );
  };
  /**
   * The sweep's one more run of a retired machine's steps inside, past
   * `RETIRED_RECHECK_MS` (a provisioning the reset cancelled may have put an
   * agent back): queued once, run, and not again.
   */
  const recheck = async (row: { id: string; retiredAt: Date }) => {
    const at = new Date(row.retiredAt.getTime() + RETIRED_RECHECK_MS + 1);
    expect(await sweep(at)).toBe(1);
    await job(row.id, 'retire', at);
    expect(await sweep(at)).toBe(0);
  };
  const callsOn = (name: string, from = 0) =>
    sprites.api.calls.slice(from).filter((c) => c.name === name);
  /**
   * Leaves only this member's retired computers live, so a sweep's count is
   * theirs: the tests share one organization.
   */
  const isolate = (ownerId: string) =>
    t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted' })
      .where(sql`owner_id <> ${ownerId} and status in ('retiring', 'retired', 'deleting')`);
  const audits = (action: string) =>
    t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  it('keeps the old Sprite out of service for seven days and makes a new one', async () => {
    const m = await member('ada@example.com');
    const before = await m.row();
    const oldName = before.containerId!;
    const old = sprites.api.sprites.get(oldName)!;
    old.files.set('/home/bot/notes.md', new Uint8Array([1]));
    old.files.set('/var/lib/openbots/sign-in', new Uint8Array([2]));
    for (const file of SPRITES_AGENT_TOKEN_FILES) old.files.set(file, new Uint8Array([3]));
    const { res, status } = await m.reset(true);
    // The dialog's text comes from this: kept, and for how long.
    expect(status).toMatchObject({ keptDays: RETIRED_COMPUTER_DAYS });
    expect(res.status, await res.clone().text()).toBe(202);

    // The old Sprite is still there, retired: nothing can talk to it.
    expect(sprites.api.sprites.has(oldName)).toBe(true);
    expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
    expect(old.urlAuth).toBe('sprite');
    expect(old.policy).toEqual(SPRITES_DENY_ALL);
    expect([...old.tasks.keys()]).toEqual([]);
    expect(old.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
    for (const file of SPRITES_AGENT_TOKEN_FILES) expect(old.files.has(file)).toBe(false);
    // Its disk, sign-ins included, is kept, and a final checkpoint of it.
    expect(old.files.has('/var/lib/openbots/sign-in')).toBe(true);
    expect(old.checkpoints).toHaveLength(1);
    expect(old.checkpoints[0]!.comment).toMatch(/^OpenBots: before a reset, /);
    expect(old.checkpoints[0]!.files.has('/home/bot/notes.md')).toBe(true);

    // Recorded, in the organization, due in seven days.
    const [retired] = await retiredOf(m.ownerId);
    expect(retired).toMatchObject({
      workspaceId,
      computerId: before.id,
      provider: 'sprites',
      providerRef: oldName,
      checkpointId: old.checkpoints[0]!.id,
      status: 'retired',
      nextAttemptAt: null,
    });
    expect(retired!.deleteAfter.getTime() - retired!.retiredAt.getTime()).toBe(7 * DAY);
    const [audit] = (await audits('computer.retire')).filter((a) => a.targetId === before.id);
    expect(audit?.metadata).toMatchObject({ retiredId: retired!.id, reason: 'reset' });
    const [reset] = (await audits('computer.reset')).filter((a) => a.targetId === before.id);
    expect(reset?.metadata).toMatchObject({ signIns: true, checkpoint: retired!.checkpointId });

    // The member's computer has no machine and a new key; the next start makes a new Sprite.
    const after = await m.row();
    const key = after.machineKey!;
    expect(after).toMatchObject({ status: 'stopped', containerId: null, agentUrl: null });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const fresh = await m.start();
    expect(fresh.containerId).toBe(spriteName(key));
    expect(fresh.containerId).not.toBe(oldName);
    expect(
      sprites.api.sprites.get(fresh.containerId!)!.files.has('/var/lib/openbots/sign-in'),
    ).toBe(false);
    // The retired one was not touched by the start.
    expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
  });

  it('deletes the old Sprite at once on an install whose provider cannot retire one', async () => {
    const m = await member('plain@example.com');
    const name = (await m.row()).containerId!;
    // The same provider without the capability: the server never checks a provider's name.
    const { retire: _, unretire: __, ...plain } = machines();
    const deps = { ...t.ownerDeps, config: { ...t.ownerDeps.config } };
    setComputerProvider(deps, plain as ComputerProvider);
    await t.inOrganization(async () =>
      destroyComputer({ ...deps, db: t.deps.db }, await m.row(), { signIns: true }),
    );
    expect(sprites.api.sprites.has(name)).toBe(false);
    expect(await retiredOf(m.ownerId)).toEqual([]);
  });

  it('keeps the Sprite and clears its home on a reset that keeps the sign-ins, as before', async () => {
    const m = await member('keeps@example.com');
    const name = (await m.row()).containerId!;
    const { res, status } = await m.reset(false);
    expect(res.status).toBe(202);
    expect(status).toMatchObject({ keptDays: RETIRED_COMPUTER_DAYS });
    expect(await retiredOf(m.ownerId)).toEqual([]);
    expect(sprites.api.sprites.get(name)!.labels).toEqual([]);
    expect((await m.start()).containerId).toBe(name);
  });

  describe('a crash part way through', () => {
    it('the record made, the process gone before the cut: the sweep cuts it within minutes', async () => {
      const m = await member('crash1@example.com');
      const before = await m.row();
      const oldName = before.containerId!;
      await isolate(m.ownerId);
      const provider = machines();
      const retire = provider.retire!;
      // The process dies while the provider is being called: the call never returns.
      let called!: () => void;
      const reached = new Promise<void>((resolve) => (called = resolve));
      provider.retire = () => {
        called();
        return new Promise<void>(() => {});
      };
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
          }),
        )
        .catch(() => undefined);
      await reached;
      provider.retire = retire;
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring', providerRef: oldName, sealedAt: null });
      // Claimed by the reset for a short while only, and the sweep runs often.
      expect(row!.nextAttemptAt!.getTime() - row!.retiredAt.getTime()).toBe(RETIRE_LEASE_MS);
      expect(RETIRED_SWEEP_MS).toBeLessThanOrEqual(5 * 60_000);
      // Meanwhile the member's computer waits: no start begins on it.
      expect(await m.row()).toMatchObject({ status: 'stopping', containerId: null });
      expect(await sweep()).toBe(0);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(row!.id, 'retire');
      const old = sprites.api.sprites.get(oldName)!;
      expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(old.urlAuth).toBe('sprite');
      expect(old.policy).toEqual(SPRITES_DENY_ALL);
      expect(old.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired', lastError: null }]);
      // The member's computer is usable again, on a new Sprite.
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
      const fresh = await m.start();
      expect(fresh.containerId).not.toBe(oldName);
    });

    it('two resets of the same machine at once: one retires it, the other is refused as a conflict', async () => {
      const m = await member('twice@example.com');
      const row = await m.row();
      const results = await Promise.allSettled([
        t.inOrganization(() => destroyComputer(t.deps, row, { signIns: true })),
        t.inOrganization(() => destroyComputer(t.deps, row, { signIns: true })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason as { status?: number; code?: string };
      expect(refused.status).toBe(409);
      expect(['COMPUTER_CHANGED', 'COMPUTER_BUSY']).toContain(refused.code);
      expect(await retiredOf(m.ownerId)).toHaveLength(1);
      // The reset that went through stands: not marked failed by the other one.
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });

    it('new Sprite made, its row not yet saved: the retried job finds the same one', async () => {
      const m = await member('crash2@example.com');
      const { res } = await m.reset(true);
      expect(res.status).toBe(202);
      const row = await m.row();
      const key = row.machineKey!;
      // The provisioning job made the Sprite, then its process died before the row was saved.
      await machines().create({
        computerId: row.id,
        ownerId: m.ownerId,
        image: 'unused',
        agentToken: 'from-the-lost-attempt-0000',
        volumeName: 'unused',
        machineKey: key,
      });
      const count = sprites.api.sprites.size;
      await t.db
        .update(schema.computers)
        .set({ status: 'creating' })
        .where(eq(schema.computers.id, row.id));
      await t.inOrganization(() =>
        provisionComputer(t.deps, {
          computerId: row.id,
          workspaceId,
          by: { type: 'user', id: m.ownerId },
        }),
      );
      const after = await m.row();
      expect(after).toMatchObject({ status: 'running', containerId: spriteName(key) });
      expect(sprites.api.sprites.size).toBe(count);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
    });

    it('a reset that finds the machine already recorded (a unique violation) is a conflict, and changes nothing', async () => {
      const m = await member('unique@example.com');
      const row = await m.row();
      // Another reset's record of the same machine, committed first.
      await t.db.insert(schema.retiredComputers).values({
        workspaceId,
        ownerId: m.ownerId,
        computerId: row.id,
        provider: 'sprites',
        providerRef: row.containerId!,
        status: 'retiring',
        retiredAt: new Date(),
        deleteAfter: new Date(Date.now() + DAY),
        nextAttemptAt: new Date(Date.now() + DAY),
      });
      const error = await t
        .inOrganization(() => destroyComputer(t.deps, row, { signIns: true }))
        .then(
          () => null,
          (e: unknown) => e as { status?: number; code?: string },
        );
      expect(error).toMatchObject({ status: 409, code: 'COMPUTER_CHANGED' });
      const after = await m.row();
      expect(after.status).not.toBe('error');
      expect(after.containerId).toBe(row.containerId);
      await t.db
        .delete(schema.retiredComputers)
        .where(eq(schema.retiredComputers.ownerId, m.ownerId));
    });
  });

  describe('out of reach before the reset answers', () => {
    it('cuts off the old Sprite before answering; the steps inside it follow and retry within seconds', async () => {
      const m = await member('sealed@example.com');
      const oldName = (await m.row()).containerId!;
      const old = sprites.api.sprites.get(oldName)!;
      // Commands inside it fail for now.
      sprites.api.execHook = (sprite) => {
        if (sprite.name === oldName) throw new Error('Sprites API: exec failed for it');
        return undefined;
      };
      let answered;
      try {
        answered = await m.reset(true, { finish: false });
        expect(answered.res.status, await answered.res.clone().text()).toBe(202);
        // Out of reach the moment the reset answers.
        expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
        expect(old.urlAuth).toBe('sprite');
        expect(old.policy).toEqual(SPRITES_DENY_ALL);
        const [row] = await retiredOf(m.ownerId);
        expect(row).toMatchObject({ status: 'retiring' });
        expect(row!.sealedAt).not.toBeNull();
        // Queued at once; a failure is retried in seconds, not at the next sweep.
        const at = new Date();
        await job(row!.id, 'retire');
        const [retry] = await retiredOf(m.ownerId);
        expect(retry).toMatchObject({ status: 'retiring', attempts: 1 });
        expect(retry!.nextAttemptAt!.getTime() - retry!.lastAttemptAt!.getTime()).toBe(10_000);
        expect(retry!.nextAttemptAt!.getTime() - at.getTime()).toBeLessThan(60_000);
      } finally {
        sprites.api.execHook = undefined;
      }
      await finishRetires(m.ownerId);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
      expect(old.services.has(SPRITES_AGENT_SERVICE)).toBe(false);
    });

    it('when the old Sprite cannot be cut off, the reset fails, keeps the files and sign-ins, and rotates the agent token', async () => {
      const m = await member('nocut@example.com');
      const before = await m.row();
      const oldName = before.containerId!;
      const provider = machines();
      const setUrlAuth = sprites.api.setUrlAuth;
      // The label goes on, then the API fails: the reset must not stand.
      sprites.api.setUrlAuth = async (name, auth) => {
        if (auth === 'sprite') throw new Error('Sprites API: 503 for it');
        return setUrlAuth.call(sprites.api, name, auth);
      };
      let res;
      try {
        ({ res } = await m.reset(true));
      } finally {
        sprites.api.setUrlAuth = setUrlAuth;
      }
      expect(res.status).toBe(503);
      const body = (await res.json()) as { detail?: string; message?: string };
      // What happened, plainly: stopped, sessions ended, files and sign-ins kept.
      expect(JSON.stringify(body)).toMatch(
        /It was stopped and its coding sessions ended, but its files and sign-ins are as they were/,
      );
      expect(JSON.stringify(body)).not.toMatch(
        /nothing was changed|Sprite|\u2013|\u2014|[\u2013\u2014]/,
      );
      // The member's computer has its machine back, with no agent: the old
      // token was fenced when the reset began, so the next start provisions
      // a new one.
      const after = await m.row();
      expect(after).toMatchObject({
        containerId: oldName,
        agentUrl: null,
        agentToken: null,
        machineKey: before.machineKey,
        status: 'stopped',
      });
      expect(() => agentFor(t.ownerDeps, before)).toThrow(/was reset/);
      expect(await retiredOf(m.ownerId)).toEqual([]);
      const old = sprites.api.sprites.get(oldName)!;
      expect(old.labels).not.toContain(SPRITES_RETIRED_LABEL);
      expect(old.urlAuth).toBe('public');
      // It starts on the same machine, with a new agent token; a reset tried again goes through.
      const tokens = sprites.api.provisions.length;
      const back = await m.start();
      expect(back.containerId).toBe(oldName);
      expect(sprites.api.provisions).toHaveLength(tokens + 1);
      expect(back.agentToken).not.toEqual(before.agentToken);
      expect(provider.retire).toBeTypeOf('function');
      expect((await m.reset(true)).res.status).toBe(202);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
    });

    it('can delete the old Sprite at once instead of keeping it', async () => {
      const m = await member('evict@example.com');
      const oldName = (await m.row()).containerId!;
      const { res } = await m.reset(true, { deleteOldComputer: true });
      expect(res.status, await res.clone().text()).toBe(202);
      expect(sprites.api.sprites.has(oldName)).toBe(false);
      // Deleted through its record: the job's check, retries and audit.
      const [record] = await retiredOf(m.ownerId);
      expect(record).toMatchObject({ providerRef: oldName, status: 'deleted' });
      expect(record!.sealedAt).not.toBeNull();
      expect(
        (await audits('computer.retired_delete')).filter(
          (a) => (a.metadata as { retiredId?: string }).retiredId === record!.id,
        ),
      ).toHaveLength(1);
      const [audit] = (await audits('computer.reset')).filter(
        (a) => (a.metadata as { oldComputer?: string }).oldComputer === 'deleted',
      );
      expect(audit).toBeDefined();
      // No checkpoint is taken of a machine that is deleted.
      expect(
        sprites.api.calls.filter((c) => c.name === oldName && c.op === 'createCheckpoint'),
      ).toEqual([]);
      expect((await m.start()).status).toBe('running');
    });

    it('a reset cancels a start under way: its job writes nothing after, and the old Sprite is retired', async () => {
      const m = await member('busy-reset@example.com');
      const row = await m.row();
      // A start queued its job, as `queueProvision` does: a new attempt, a new generation.
      const [queued] = await t.db
        .update(schema.computers)
        .set({
          status: 'starting',
          generation: sql`${schema.computers.generation} + 1`,
          spec: {
            ...(row.spec as object),
            provision: { attempt: 'attempt-x', at: new Date().toISOString() },
          },
        })
        .where(eq(schema.computers.id, row.id))
        .returning();
      const provider = machines();
      const start = provider.start;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      provider.start = async (ref) => {
        entered();
        await gate;
        return start.call(provider, ref);
      };
      try {
        const running = t.inOrganization(() =>
          provisionComputer(t.deps, {
            computerId: row.id,
            workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'attempt-x',
          }),
        );
        await inside;
        // The member resets meanwhile: not refused, and the old machine is out of reach at once.
        const reset = await t.inOrganization(() =>
          destroyComputer(t.deps, queued!, { signIns: true }),
        );
        expect(reset).toMatchObject({ status: 'stopped', containerId: null });
        const old = sprites.api.sprites.get(row.containerId!)!;
        expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
        release();
        await running;
      } finally {
        provider.start = start;
      }
      // The cancelled job wrote nothing: not `running` on the old machine, not `error`.
      const after = await m.row();
      expect(after).toMatchObject({ status: 'stopped', containerId: null, agentToken: null });
      expect(after.machineKey).not.toBe(row.machineKey);
      expect(await retiredOf(m.ownerId)).toMatchObject([
        { providerRef: row.containerId, status: 'retiring' },
      ]);
      await finishRetires(m.ownerId);
      expect((await m.start()).containerId).not.toBe(row.containerId);
    });

    it('fences the old agent: a row read before the reset no longer reaches it', async () => {
      const m = await member('fence@example.com');
      const stale = await m.row();
      expect(() => agentFor(t.ownerDeps, stale)).not.toThrow();
      expect((await m.reset(true)).res.status).toBe(202);
      expect(() => agentFor(t.ownerDeps, stale)).toThrow(/was reset/);
      // The member's next machine is reached as usual.
      const fresh = await m.start();
      expect(() => agentFor(t.ownerDeps, fresh)).not.toThrow();
    });
  });

  describe('a job that read the row before it moved on', () => {
    it('a stale write of the whole spec does not lose the new machine key', async () => {
      const m = await member('stale-spec@example.com');
      const stale = await m.row();
      expect((await m.reset(true)).res.status).toBe(202);
      // Any path that writes `spec` whole from a row it read before the reset.
      await t.db
        .update(schema.computers)
        .set({ spec: stale.spec })
        .where(eq(schema.computers.id, stale.id));
      const fresh = await m.start();
      expect(fresh.status).toBe('running');
      expect(fresh.containerId).not.toBe(stale.containerId);
      // The retired one is not taken for the member's computer, so it is deleted when due.
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    });

    it('a provisioning job whose attempt was replaced while it ran writes nothing', async () => {
      const m = await member('stale-job@example.com');
      const row = await m.row();
      await t.db
        .update(schema.computers)
        .set({
          status: 'starting',
          spec: {
            ...(row.spec as object),
            provision: { attempt: 'attempt-a', at: new Date().toISOString() },
          },
        })
        .where(eq(schema.computers.id, row.id));
      const provider = machines();
      const start = provider.start;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      provider.start = async (ref) => {
        entered();
        await gate;
        return start.call(provider, ref);
      };
      try {
        const running = t.inOrganization(() =>
          provisionComputer(t.deps, {
            computerId: row.id,
            workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'attempt-a',
          }),
        );
        await inside;
        // Another start gave the row its own attempt meanwhile, as `queueProvision` does.
        await t.db
          .update(schema.computers)
          .set({
            generation: sql`${schema.computers.generation} + 1`,
            spec: {
              ...(row.spec as object),
              provision: { attempt: 'attempt-b', at: new Date().toISOString() },
            },
          })
          .where(eq(schema.computers.id, row.id));
        release();
        await running;
      } finally {
        provider.start = start;
      }
      const after = await m.row();
      expect(after.status).toBe('starting');
      expect((after.spec as { provision?: { attempt: string } }).provision?.attempt).toBe(
        'attempt-b',
      );
      await t.db
        .update(schema.computers)
        .set({ status: 'running', spec: row.spec })
        .where(eq(schema.computers.id, row.id));
    });
  });

  describe('the deletion job', () => {
    it('deletes nothing before delete_after, then deletes for good, once, and audits it', async () => {
      const m = await member('del@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep()).toBe(0);
      await recheck(row!);
      expect(await sweep(new Date(row!.deleteAfter.getTime() - 1))).toBe(0);
      expect(sprites.api.sprites.has(row!.providerRef)).toBe(true);
      // Two workers sweep at once: one claims it.
      const at = new Date(row!.deleteAfter.getTime() + 1);
      const queued = await Promise.all([sweep(at), sweep(at)]);
      expect(queued.reduce((a, b) => a + b, 0)).toBe(1);
      // Two runs of its job at once (a claim taken again while the first ran): one audit.
      await Promise.all([job(row!.id, 'delete'), job(row!.id, 'delete')]);
      expect(sprites.api.sprites.has(row!.providerRef)).toBe(false);
      const [gone] = await retiredOf(m.ownerId);
      expect(gone).toMatchObject({ status: 'deleted', nextAttemptAt: null });
      expect(gone!.deletedAt).not.toBeNull();
      const deleted = (await audits('computer.retired_delete')).filter(
        (a) => (a.metadata as { retiredId?: string }).retiredId === row!.id,
      );
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({ actorType: 'system' });
      // Idempotent: run again, sweep again, nothing more.
      await job(row!.id, 'delete');
      expect(await sweep(new Date(at.getTime() + DAY))).toBe(0);
      // The member's own computer is untouched.
      expect((await m.start()).status).toBe('running');
    });

    it('counts a Sprite already gone as deleted', async () => {
      const m = await member('gone@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      sprites.api.sprites.delete(row!.providerRef);
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    });

    it("never deletes a member's current computer", async () => {
      const m = await member('current@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      // Somehow the member's row points at it again (a restore that skipped its record).
      await t.db
        .update(schema.computers)
        .set({ containerId: row!.providerRef })
        .where(eq(schema.computers.ownerId, m.ownerId));
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(sprites.api.sprites.has(row!.providerRef)).toBe(true);
      const [kept] = await retiredOf(m.ownerId);
      expect(kept).toMatchObject({ status: 'retired' });
      expect(kept!.lastError).toMatch(/current computer/);
    });

    it('retries a failed deletion with backoff, and takes back a claim whose job was lost', async () => {
      const m = await member('retry@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      await t.db
        .update(schema.retiredComputers)
        .set({ deleteAfter: new Date(Date.now() - 1000) })
        .where(eq(schema.retiredComputers.id, row!.id));
      const remove = sprites.api.delete;
      sprites.api.delete = async () => {
        throw new Error('Sprites API: delete failed (503) for it');
      };
      try {
        expect(await sweep()).toBe(1);
        await job(row!.id, 'delete');
      } finally {
        sprites.api.delete = remove;
      }
      const [failed] = await retiredOf(m.ownerId);
      expect(failed).toMatchObject({ status: 'retired', attempts: 1 });
      expect(failed!.lastError).toMatch(/503/);
      const wait = failed!.nextAttemptAt!.getTime() - failed!.lastAttemptAt!.getTime();
      expect(wait).toBe(60_000);
      expect(await sweep()).toBe(0);
      // Due again: claimed, but its job is lost with the worker.
      const later = new Date(failed!.nextAttemptAt!.getTime() + 1);
      expect(await sweep(later)).toBe(1);
      expect(await sweep(later)).toBe(0);
      // The lease runs out: another worker claims it again and deletes it.
      expect(await sweep(new Date(later.getTime() + RETIRED_LEASE_MS + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    });

    it('runs from the queue, in the organization that owns the row', async () => {
      const m = await member('queue@example.com');
      await m.reset(true);
      const [row] = await retiredOf(m.ownerId);
      // The worker works only while this test runs: the queue cannot stop
      // processing, and the later tests run each job themselves. One left
      // working would run the jobs their sweeps queue in the background,
      // leasing rows from the real clock while those tests sweep at a later
      // time of their own, so a row they expect leased reads as due.
      let working = true;
      const handler = retiredComputerHandler(t.deps, () => computerProvider(t.deps));
      await t.deps.infra
        .queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE)
        .process(async (queued) => {
          if (working) await handler(queued);
        });
      try {
        expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBeGreaterThanOrEqual(1);
        await until(async () =>
          expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]),
        );
      } finally {
        working = false;
      }
    });

    it('deletes a removed member’s retired computers at the next sweep', async () => {
      const m = await member('removed@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      await endMembershipAccess(t.deps, { userId: m.ownerId, workspaceId, removed: true });
      const [row] = await retiredOf(m.ownerId);
      expect(row!.deleteAfter.getTime()).toBeLessThanOrEqual(Date.now());
      // The next sweep takes it, and its job deletes it.
      expect(await sweep()).toBe(1);
      await job(row!.id, 'delete');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    });

    it("purges an organization's retired computers at once, for its deletion", async () => {
      const m = await member('purge@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      const left = await purgeRetiredComputers(t.deps, machines(), { workspaceId });
      expect(left).toBe(0);
      expect(sprites.api.sprites.has(row!.providerRef)).toBe(false);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    });

    it('keeps the organization from being deleted while it has a retired computer', async () => {
      const m = await member('fk@example.com');
      await m.reset(true);
      const error = await t.db.execute(sql`delete from workspaces where id = ${workspaceId}`).then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string }; message: string },
      );
      expect(error?.cause?.message ?? error?.message).toMatch(/retired_computers/);
    });
  });

  describe('when retrying stops', () => {
    it('gives up after RETIRED_MAX_ATTEMPTS, says so, and waits for an operator', async () => {
      const m = await member('giveup@example.com');
      const before = await m.row();
      const provider = machines();
      await isolate(m.ownerId);
      // A record whose reach was never cut (a crash), and a provider that keeps failing.
      const retire = provider.retire!;
      provider.retire = () => new Promise<void>(() => {});
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
          }),
        )
        .catch(() => undefined);
      await until(async () => expect(await retiredOf(m.ownerId)).toHaveLength(1));
      provider.retire = async () => {
        throw new Error('Sprites API: 503 for it');
      };
      const errors: string[] = [];
      const logger = {
        ...t.deps.logger,
        error: (_: unknown, message: string) => errors.push(message),
        warn: () => undefined,
      } as unknown as typeof t.deps.logger;
      try {
        for (let i = 0; i < RETIRED_MAX_ATTEMPTS; i++) {
          const [row] = await retiredOf(m.ownerId);
          await t.inOrganization(() =>
            runRetiredComputerJob({ ...t.deps, logger }, provider, {
              retiredId: row!.id,
              kind: 'retire',
              claim: row!.claim!,
            }),
          );
        }
      } finally {
        provider.retire = retire;
      }
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring', attempts: RETIRED_MAX_ATTEMPTS });
      expect(row!.gaveUpAt).not.toBeNull();
      expect(errors).toContain(
        'gave up taking a retired computer out of reach; an operator must retry it',
      );
      expect(JSON.stringify(errors)).not.toMatch(/token/i);
      // The sweep leaves it alone; the operator sees why and retries it.
      expect(await sweep(new Date(Date.now() + 30 * DAY))).toBe(0);
      const lines: string[] = [];
      const ctx: CliContext = {
        config: t.deps.config,
        db: t.deps.db,
        infra: t.deps.infra,
        logger: t.deps.logger,
        write: (line) => lines.push(line),
      };
      const args = ['--org', workspaceId];
      expect(await runComputers(['retired', '--member', 'giveup@example.com', ...args], ctx)).toBe(
        0,
      );
      expect(lines.join('\n')).toMatch(/gave up .*waiting for an operator/);
      expect(lines.join('\n')).toMatch(/last error: Sprites API: 503/);
      expect(await runComputers(['retry', row!.id, '--by', 'Sam from support', ...args], ctx)).toBe(
        0,
      );
      expect(await sweep()).toBe(1);
      await job(row!.id, 'retire');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired', attempts: 0 }]);
      const [retry] = (await audits('computer.retired_retry')).filter(
        (a) => (a.metadata as { retiredId?: string }).retiredId === row!.id,
      );
      expect(retry!.metadata).toMatchObject({ operator: 'Sam from support' });
    });

    it('deletes a row still retiring once it is due: past its days, or its member removed', async () => {
      const m = await member('stuck@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const provider = machines();
      const retire = provider.retire!;
      provider.retire = () => new Promise<void>(() => {});
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
          }),
        )
        .catch(() => undefined);
      await until(async () => expect(await retiredOf(m.ownerId)).toHaveLength(1));
      provider.retire = retire;
      // The member is removed: due now, though it never got past `retiring`.
      await endMembershipAccess(t.deps, { userId: m.ownerId, workspaceId, removed: true });
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring' });
      // Once the dead reset's short claim runs out, the sweep deletes it.
      expect(await sweep()).toBe(0);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
    });

    it("never deletes a machine that is another organization's member's computer", async () => {
      const m = await member('crossorg@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      // The same machine is the current computer of someone in another organization.
      const other = await t.createOrganization('Elsewhere');
      await t.db.insert(schema.computers).values({
        workspaceId: other,
        ownerId: m.ownerId,
        provider: 'sprites',
        status: 'stopped',
        containerId: row!.providerRef,
      });
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      expect(sprites.api.sprites.has(row!.providerRef)).toBe(true);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
      await t.db.delete(schema.computers).where(eq(schema.computers.workspaceId, other));
    });
  });

  describe('usage and waking', () => {
    it('never holds, wakes or counts the retired Sprite: a use that began before the reset moves on', async () => {
      const m = await member('usage@example.com');
      const before = await m.row();
      const oldName = before.containerId!;
      const refresh = useTimings.holdRefreshMs;
      useTimings.holdRefreshMs = 20;
      const use = beginComputerUse(t.ownerDeps, before, 'run');
      try {
        await settleComputerUses();
        await m.reset(true);
        const mark = sprites.api.calls.length;
        sprites.api.sprites.get(oldName)!.status = 'cold';
        // Several hold refreshes go by, and the sweep, with no machine and then a new one.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await sweep();
        const fresh = await m.start();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await settleComputerUses();
        const onOld = callsOn(oldName, mark).map((c) => c.op);
        expect(onOld.filter((op) => op !== 'get')).toEqual([]);
        expect(sprites.api.sprites.get(oldName)!.status).toBe('cold');
        // The use holds the member's new Sprite instead.
        expect([...sprites.api.sprites.get(fresh.containerId!)!.tasks.keys()].length).toBe(1);
      } finally {
        await use.end();
        useTimings.holdRefreshMs = refresh;
      }
      // The awake time on record is the member's computer's, from the use: the
      // retire, the sweep and the deletion open no interval.
      await isolate(m.ownerId);
      const intervals = await t.db
        .select()
        .from(schema.computerUsageIntervals)
        .where(eq(schema.computerUsageIntervals.ownerId, m.ownerId));
      expect(intervals.map((i) => i.reason)).toEqual(['run']);
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBe(1);
      await job(row!.id, 'delete');
      const after = await t.db
        .select()
        .from(schema.computerUsageIntervals)
        .where(eq(schema.computerUsageIntervals.ownerId, m.ownerId));
      expect(after).toHaveLength(1);
    });
  });

  describe('restore (support only)', () => {
    let lines: string[];
    const cli = (args: string[]) => {
      lines = [];
      const ctx: CliContext = {
        config: t.deps.config,
        db: t.deps.db,
        infra: t.deps.infra,
        logger: t.deps.logger,
        write: (line) => lines.push(line),
      };
      // The managed service names the organization; a self-hosted install has one.
      const org = args.includes('--org') ? args : [...args, '--org', workspaceId];
      // A restore or a retry names its operator.
      const by = ['restore', 'retry'].includes(args[0]!) && !args.includes('--by');
      return runComputers(by ? [...org, '--by', 'Sam from support'] : org, ctx);
    };

    it('lists a member’s retired computers and swaps one back, retiring the current one', async () => {
      const m = await member('restore@example.com');
      const first = await m.row();
      const oldName = first.containerId!;
      sprites.api.sprites.get(oldName)!.files.set('/home/bot/thesis.md', new Uint8Array([7]));
      await m.reset(true);
      const fresh = await m.start();
      // The retired disk changed after its checkpoint; the restore puts the checkpoint back.
      sprites.api.sprites.get(oldName)!.files.delete('/home/bot/thesis.md');

      expect(await cli(['retired', '--member', 'restore@example.com'])).toBe(0);
      const [retired] = await retiredOf(m.ownerId);
      expect(lines.join('\n')).toContain(retired!.id);
      expect(lines.join('\n')).toContain('retired  retired');

      expect(await cli(['restore', retired!.id])).toBe(0);
      expect(lines.join('\n')).toMatch(/Restored .*: it is the member's computer again/);
      // The member's computer is the old Sprite again, stopped until its next use.
      const row = await m.row();
      expect(row).toMatchObject({ containerId: oldName, agentUrl: null, status: 'stopped' });
      // The one they had is retired in turn, not lost (its steps inside it run in the background).
      await finishRetires(m.ownerId);
      const all = await retiredOf(m.ownerId);
      expect(all.map((r) => [r.providerRef, r.status])).toEqual([
        [oldName, 'restored'],
        [fresh.containerId, 'retired'],
      ]);
      expect(sprites.api.sprites.get(fresh.containerId!)!.labels).toContain(SPRITES_RETIRED_LABEL);
      const old = sprites.api.sprites.get(oldName)!;
      expect(old.labels).not.toContain(SPRITES_RETIRED_LABEL);
      expect(old.files.has('/home/bot/thesis.md')).toBe(true);
      // The next start provisions it with a new agent token.
      const tokens = sprites.api.provisions.length;
      const back = await m.start();
      expect(back.containerId).toBe(oldName);
      expect(sprites.api.provisions).toHaveLength(tokens + 1);
      expect(sprites.api.provisions.at(-1)!.name).toBe(oldName);
      const [audit] = (await audits('computer.restore')).filter((a) => a.targetId === first.id);
      expect(audit).toMatchObject({ actorType: 'system' });
      expect(audit!.metadata).toMatchObject({
        retiredId: retired!.id,
        checkpoint: retired!.checkpointId,
        operator: 'Sam from support',
      });
      // Restored: not again, and never deleted by the job.
      expect(await cli(['restore', retired!.id])).toBe(1);
      expect(lines.join('\n')).toMatch(/is restored, so it cannot be restored/);
      expect(await sweep(new Date(Date.now() + 30 * DAY))).toBeGreaterThanOrEqual(1);
      expect(sprites.api.sprites.has(oldName)).toBe(true);
    });

    it('gives the machine back to the job when a restore fails part way, and can run again', async () => {
      const m = await member('restore-fail@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      const provider = machines();
      const restore = provider.restore!;
      provider.restore = async () => {
        throw new Error('Sprites API: restore failed for it: fetch failed');
      };
      try {
        expect(await cli(['restore', retired!.id]).catch(() => 1)).toBe(1);
      } finally {
        provider.restore = restore;
      }
      // Not left `restoring`, which the deletion job would never take.
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ id: retired!.id, status: 'retired' });
      expect(sprites.api.sprites.get(retired!.providerRef)!.labels).toContain(
        SPRITES_RETIRED_LABEL,
      );
      expect(await cli(['restore', retired!.id])).toBe(0);
      expect((await m.row()).containerId).toBe(retired!.providerRef);
    });

    it('refuses while the member’s computer is being made, and for another organization', async () => {
      const m = await member('busy@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      await t.db
        .update(schema.computers)
        .set({ status: 'creating' })
        .where(eq(schema.computers.ownerId, m.ownerId));
      expect(await cli(['restore', retired!.id])).toBe(1);
      expect(lines.join('\n')).toMatch(/computer is creating/);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
      const other = await t.createOrganization('Other');
      expect(await cli(['restore', retired!.id, '--org', other])).toBe(1);
      expect(lines.join('\n')).toMatch(/No such retired computer/);
      expect(await cli(['retired', '--member', 'nobody@example.com'])).toBe(1);
      expect(await cli(['restore'])).toBe(2);
      lines = [];
      expect(
        await runComputers(['retired', '--member', 'busy@example.com'], {
          config: t.deps.config,
          db: t.deps.db,
          infra: t.deps.infra,
          write: (line) => lines.push(line),
        }),
      ).toBe(2);
      expect(lines.join('\n')).toMatch(/--org on the managed service/);
    });

    it('needs the operator named with --by', async () => {
      const m = await member('by@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      lines = [];
      const ctx: CliContext = {
        config: t.deps.config,
        db: t.deps.db,
        infra: t.deps.infra,
        logger: t.deps.logger,
        write: (line) => lines.push(line),
      };
      expect(await runComputers(['restore', retired!.id, '--org', workspaceId], ctx)).toBe(2);
      expect(lines.join('\n')).toMatch(/--by/);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
    });

    it("a member's start during a restore wins: the restored Sprite is retired again and nothing is lost", async () => {
      const m = await member('race@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      const provider = machines();
      const unretire = provider.unretire!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      provider.unretire = async (ref) => {
        entered();
        await gate;
        return unretire.call(provider, ref);
      };
      let code: number;
      try {
        const restoring = cli(['restore', retired!.id]).catch(() => 1);
        await inside;
        // The member starts their computer meanwhile: a new Sprite, theirs.
        const fresh = await m.start();
        expect(fresh.containerId).not.toBe(retired!.providerRef);
        release();
        code = await restoring;
      } finally {
        provider.unretire = unretire;
      }
      expect(code).toBe(1);
      const row = await m.row();
      expect(row.status).toBe('running');
      expect(row.containerId).not.toBe(retired!.providerRef);
      // Every Sprite of the member is recorded: their computer's, and the retired one, out of reach.
      const old = sprites.api.sprites.get(retired!.providerRef)!;
      expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(old.urlAuth).toBe('sprite');
      expect(old.policy).toEqual(SPRITES_DENY_ALL);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ id: retired!.id, status: 'retired' }]);
    });

    it('a restore cut short by its process is taken back by the sweep, out of reach again', async () => {
      const m = await member('lease@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [retired] = await retiredOf(m.ownerId);
      const provider = machines();
      const unretire = provider.unretire!;
      // The process dies right after the Sprite is put back in service.
      let died!: () => void;
      const dead = new Promise<void>((resolve) => (died = resolve));
      provider.unretire = async (ref) => {
        await unretire.call(provider, ref);
        died();
        await new Promise<void>(() => {});
      };
      void cli(['restore', retired!.id]).catch(() => 1);
      await dead;
      provider.unretire = unretire;
      const [restoring] = await retiredOf(m.ownerId);
      expect(restoring).toMatchObject({ status: 'restoring' });
      const old = sprites.api.sprites.get(retired!.providerRef)!;
      expect(old.urlAuth).toBe('public');
      // Not while the restore's lease lasts; then the sweep retires it again.
      expect(await sweep()).toBe(0);
      const later = new Date(restoring!.nextAttemptAt!.getTime() + 1);
      expect(await sweep(later)).toBe(1);
      expect(await sweep(later)).toBe(0);
      await finishRetires(m.ownerId);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
      expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
      expect(old.urlAuth).toBe('sprite');
      expect(old.policy).toEqual(SPRITES_DENY_ALL);
      // Idempotent past its one more run inside, and it can still be deleted when due, or restored.
      await recheck((await retiredOf(m.ownerId))[0]!);
      expect(await sweep(later)).toBe(0);
      expect((await m.row()).containerId).toBeNull();
    });

    it("refuses a removed member's computer, and a removal during a restore wins", async () => {
      const m = await member('gone-member@example.com');
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      // Removed during the restore: the restore's last step sees it.
      const provider = machines();
      const unretire = provider.unretire!;
      provider.unretire = async (ref) => {
        await unretire.call(provider, ref);
        await t.db
          .delete(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.userId, m.ownerId));
        await endMembershipAccess(t.deps, { userId: m.ownerId, workspaceId, removed: true });
      };
      try {
        expect(await cli(['restore', retired!.id]).catch(() => 1)).toBe(1);
      } finally {
        provider.unretire = unretire;
      }
      expect((await m.row()).containerId).toBeNull();
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ status: 'retired' });
      expect(after!.deleteAfter.getTime()).toBeLessThanOrEqual(Date.now());
      expect(sprites.api.sprites.get(retired!.providerRef)!.labels).toContain(
        SPRITES_RETIRED_LABEL,
      );
      // Refused up front from now on.
      expect(await cli(['restore', retired!.id])).toBe(1);
      expect(lines.join('\n')).toMatch(/not an active member/);
    });

    it('restores into a computer row made anew, by the name recorded, without leaking a Sprite', async () => {
      const m = await member('remade@example.com');
      const first = await m.row();
      await m.reset(true);
      const [retired] = await retiredOf(m.ownerId);
      expect(retired!.machineKey).toBeNull();
      // The member's computer row was made anew (a new id) since.
      await t.db.delete(schema.computers).where(eq(schema.computers.id, first.id));
      const again = await m.start();
      expect(again.id).not.toBe(first.id);
      const count = sprites.api.sprites.size;
      expect(await cli(['restore', retired!.id]), lines.join('\n')).toBe(0);
      const back = await m.start();
      expect(back.containerId).toBe(retired!.providerRef);
      // The retired one made ready again, and the one the new row had retired in turn: no new Sprite.
      expect(sprites.api.sprites.size).toBe(count);
    });
  });
});
