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
  RETIRED_LEASE_MS,
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
    const reset = async (resetSignIns: boolean) => {
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
      const res = await call('POST', '/computer/reset', { requestId, confirm: true, resetSignIns });
      return { res, status };
    };
    await start();
    return { cookie, ownerId, call, row, start, reset };
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
  const job = (retiredId: string, kind: 'retire' | 'delete') =>
    t.inOrganization(() => runRetiredComputerJob(t.deps, machines(), { retiredId, kind }));
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
    const key = (after.spec as { machineKey?: string }).machineKey!;
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
    it('retire recorded, the provider not done: the reset stands and the sweep finishes it', async () => {
      const m = await member('crash1@example.com');
      const oldName = (await m.row()).containerId!;
      const provider = machines();
      const retire = provider.retire!;
      provider.retire = async () => {
        throw new Error('the process died here');
      };
      try {
        const { res } = await m.reset(true);
        expect(res.status, await res.clone().text()).toBe(202);
      } finally {
        provider.retire = retire;
      }
      const [row] = await retiredOf(m.ownerId);
      expect(row).toMatchObject({ status: 'retiring', providerRef: oldName, attempts: 1 });
      expect(row!.lastError).toMatch(/the process died here/);
      expect(sprites.api.sprites.get(oldName)!.labels).not.toContain(SPRITES_RETIRED_LABEL);
      // The member's next start makes the new Sprite meanwhile.
      const fresh = await m.start();
      expect(fresh.containerId).not.toBe(oldName);
      // Not before its backoff; then the sweep queues it and the job retires it.
      expect(await sweep()).toBe(0);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(row!.id, 'retire');
      const [done] = await retiredOf(m.ownerId);
      expect(done).toMatchObject({ status: 'retired', lastError: null, nextAttemptAt: null });
      expect(sprites.api.sprites.get(oldName)!.labels).toContain(SPRITES_RETIRED_LABEL);
      // Two Sprites for this member: the retired one and the new one, never a third.
      const mine = [...sprites.api.sprites.keys()].filter(
        (n) => n === oldName || n === fresh.containerId,
      );
      expect(mine).toHaveLength(2);
    });

    it('new Sprite made, its row not yet saved: the retried job finds the same one', async () => {
      const m = await member('crash2@example.com');
      const { res } = await m.reset(true);
      expect(res.status).toBe(202);
      const row = await m.row();
      const key = (row.spec as { machineKey: string }).machineKey;
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

    it('two resets of the same machine at once record it once', async () => {
      const m = await member('twice@example.com');
      const row = await m.row();
      const by = { type: 'user' as const, id: m.ownerId };
      const results = await Promise.allSettled([
        t.inOrganization(() =>
          retireMachine(t.deps, machines(), row, { checkpointId: null, by, reason: 'reset' }),
        ),
        t.inOrganization(() =>
          retireMachine(t.deps, machines(), row, { checkpointId: null, by, reason: 'reset' }),
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      const reason = refused.reason as { message: string; cause?: { message?: string } };
      // The unique index on a live machine, or the row no longer having it.
      expect(reason.cause?.message ?? reason.message).toMatch(
        /changed meanwhile|retired_computers_live_ref/,
      );
      expect(await retiredOf(m.ownerId)).toHaveLength(1);
      const after = await m.row();
      expect(after.containerId).toBeNull();
    });
  });

  describe('the deletion job', () => {
    it('deletes nothing before delete_after, then deletes for good, once, and audits it', async () => {
      const m = await member('del@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep()).toBe(0);
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
      await t.deps.infra
        .queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE)
        .process(retiredComputerHandler(t.deps, () => computerProvider(t.deps)));
      expect(await sweep(new Date(row!.deleteAfter.getTime() + 1))).toBeGreaterThanOrEqual(1);
      await until(async () =>
        expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]),
      );
    });

    it('deletes a removed member’s retired computers at the next sweep', async () => {
      const m = await member('removed@example.com');
      await m.reset(true);
      await isolate(m.ownerId);
      await endMembershipAccess(t.deps, { userId: m.ownerId, workspaceId, removed: true });
      const [row] = await retiredOf(m.ownerId);
      expect(row!.deleteAfter.getTime()).toBeLessThanOrEqual(Date.now());
      await until(async () => {
        await sweep();
        expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
      });
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
      return runComputers(args.includes('--org') ? args : [...args, '--org', workspaceId], ctx);
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
      // The one they had is retired in turn, not lost.
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
  });
});
