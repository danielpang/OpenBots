import { spriteName } from '@openbots/computer';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import {
  holdOnce,
  spritesWorld,
  until,
  type SpritesWorld,
} from './__fixtures__/sprites-members.js';
import {
  agentFor,
  beginComputerUse,
  computerProvider,
  destroyComputer,
  provisionComputer,
} from './computer.js';
import { forgetFences, isFenced, loadFences } from './computer-fence.js';
import {
  RETIRED_COMPUTERS_QUEUE,
  RETIRED_LEASE_MS,
  RETIRED_MAX_ATTEMPTS,
  RETIRED_RECHECK_MS,
  RETIRED_SWEEP_MS,
  retiredComputerHandler,
  runRetiredComputerJob,
  type RetiredComputerJob,
} from './computer-retire.js';
import { settleComputerUses, useTimings } from './computer-use.js';

// A full reset deletes the old computer (plan 9.5; the owner's decision).
// On Sprites the member's computer gets a new machine key at once and the
// old Sprite is deleted through a record, which the retired-computers job
// retries until it is gone; nothing is kept, restored or undone. Every time
// a test needs is named (`at`), never waited for.

const DAY = 24 * 60 * 60_000;
const SIGN_IN = '/var/lib/openbots/sign-in';
/** The vendor the hosted service runs on, which no member is ever told. */
const VENDOR = /sprite|fly\.io/i;

describe('a full reset deletes the old computer', () => {
  let w: SpritesWorld;

  beforeAll(async () => {
    w = await spritesWorld();
  });
  afterAll(() => w.close());

  /** When a deletion of the record's machine counts as final. */
  const final = (row: { retiredAt: Date }) =>
    new Date(row.retiredAt.getTime() + RETIRED_RECHECK_MS + 1);
  const failDeletes = () => {
    const remove = w.sprites.api.delete;
    w.sprites.api.delete = async () => {
      throw new Error('Sprites API: delete failed (503) for it');
    };
    return () => (w.sprites.api.delete = remove);
  };

  it('deletes the old Sprite at once and lets the member start a new one', async () => {
    const m = await w.member('ada@example.com');
    await w.isolate(m.ownerId);
    await m.signedIn();
    const before = await m.row();
    const oldName = before.containerId!;
    w.sprites.api.sprites.get(oldName)!.files.set(SIGN_IN, new Uint8Array([1]));
    const requestId = await m.prepare();
    const res = await m.confirm(requestId, { resetSignIns: true });
    expect(res.status, await res.clone().text()).toBe(202);
    // What the member is told never names the vendor.
    expect(await res.text()).not.toMatch(VENDOR);

    // Gone before the reset answered, with no checkpoint taken of it first.
    expect(w.sprites.api.sprites.has(oldName)).toBe(false);
    expect(
      w.sprites.api.calls.filter((c) => c.name === oldName && c.op === 'createCheckpoint'),
    ).toEqual([]);
    // The member's computer: no machine, a new key, the reset's cleanup done.
    const after = await m.row();
    expect(after).toMatchObject({ status: 'stopped', containerId: null, agentUrl: null });
    expect(after.machineKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(after.machineKey).not.toBe(before.machineKey);
    expect(await m.kept()).toEqual({ authKind: 'none', checkout: 'missing' });
    const [reset] = (await w.audits('computer.reset')).filter((a) => a.targetId === before.id);
    expect(reset!.metadata).toMatchObject({ requestId, signIns: true, checkouts: 1 });
    expect(reset!.metadata).not.toHaveProperty('checkpoint');

    // A record of it, until no provisioning the reset cancelled could make it again.
    const [record] = await w.retiredOf(m.ownerId);
    expect(record).toMatchObject({
      computerId: before.id,
      provider: 'sprites',
      providerRef: oldName,
      status: 'deleting',
      attempts: 0,
      lastError: null,
      gaveUpAt: null,
    });
    expect(record!.nextAttemptAt!.getTime()).toBe(final(record!).getTime() - 1);

    // The member starts a new Sprite at once, without the old sign-ins.
    const fresh = await m.start();
    expect(fresh.containerId).toBe(spriteName(after.machineKey!));
    expect(w.sprites.api.sprites.get(fresh.containerId!)!.files.has(SIGN_IN)).toBe(false);

    // Then deleted for good, once: two workers sweep, its job runs twice.
    expect(await w.sweep()).toBe(0);
    const at = final(record!);
    expect((await Promise.all([w.sweep(at), w.sweep(at)])).reduce((a, b) => a + b)).toBe(1);
    await Promise.all([w.job(record!.id, at), w.job(record!.id, at)]);
    const [gone] = await w.retiredOf(m.ownerId);
    expect(gone).toMatchObject({ status: 'deleted', nextAttemptAt: null });
    expect(gone!.deletedAt).not.toBeNull();
    const deleted = await w.audits('computer.retired_delete', record!.id);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ actorType: 'system' });
    expect(await w.sweep(new Date(at.getTime() + DAY))).toBe(0);
    // The member's new computer is untouched.
    expect(w.sprites.api.sprites.has(fresh.containerId!)).toBe(true);
  });

  it('retries a deletion that failed with backoff, and claims again one whose job was lost', async () => {
    const m = await w.member('retry@example.com');
    await w.isolate(m.ownerId);
    const before = await m.row();
    const requestId = await m.prepare();
    const restore = failDeletes();
    let res: Response;
    try {
      res = await m.confirm(requestId, { resetSignIns: true });
    } finally {
      restore();
    }
    // The reset stands: the member's computer is a new one, and the old token is refused.
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    expect(() => agentFor(w.t.ownerDeps, before)).toThrow(/was reset/);
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(true);
    const [failed] = await w.retiredOf(m.ownerId);
    expect(failed).toMatchObject({ status: 'deleting', attempts: 1 });
    expect(failed!.lastError).toMatch(/503/);
    expect(failed!.nextAttemptAt!.getTime() - failed!.lastAttemptAt!.getTime()).toBe(60_000);

    expect(await w.sweep()).toBe(0);
    const later = new Date(failed!.nextAttemptAt!.getTime() + 1);
    expect(await w.sweep(later)).toBe(1);
    expect(await w.sweep(later)).toBe(0);
    // Its job is lost with the worker; once the lease runs out another claims it.
    const again = new Date(later.getTime() + RETIRED_LEASE_MS + 1);
    expect(await w.sweep(again)).toBe(1);
    await w.job(failed!.id, again);
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleting', lastError: null }]);
    expect(await w.sweep(final(failed!))).toBe(1);
    await w.job(failed!.id, final(failed!));
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
  });

  it('a process that dies between the switch and the deletion still ends in deletion', async () => {
    const m = await w.member('crash@example.com');
    await w.isolate(m.ownerId);
    const before = await m.row();
    const provider = w.machines();
    // The process dies inside the provider's delete: the call never comes back.
    const dead = holdOnce(provider, 'destroy');
    void w.t
      .inOrganization(() => destroyComputer(w.t.deps, before, { signIns: true }))
      .catch(() => undefined);
    await dead.inside;
    dead.restore();
    // The switch committed: the member can start a new machine meanwhile.
    expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    const fresh = await m.start();
    expect(fresh.containerId).not.toBe(before.containerId);
    const [record] = await w.retiredOf(m.ownerId);
    expect(record).toMatchObject({ status: 'deleting', attempts: 0 });
    // Held by the dead reset for a short lease only (on the database's clock).
    const lease = record!.nextAttemptAt!.getTime() - record!.retiredAt.getTime();
    expect(Math.abs(lease - RETIRED_LEASE_MS)).toBeLessThan(1_000);
    expect(RETIRED_SWEEP_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(await w.sweep()).toBe(0);
    const due = new Date(record!.nextAttemptAt!.getTime() + 1);
    expect(await w.sweep(due)).toBe(1);
    await w.job(record!.id, due);
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    expect(await w.sweep(final(record!))).toBe(1);
    await w.job(record!.id, final(record!));
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
    // The member's new Sprite was never touched.
    expect(w.sprites.api.sprites.has(fresh.containerId!)).toBe(true);
  });

  it('gives up after its attempts, is listed for an operator, and retry starts it again', async () => {
    const m = await w.member('giveup@example.com');
    await w.isolate(m.ownerId);
    const before = await m.row();
    const errors: string[] = [];
    const logger = {
      ...w.t.deps.logger,
      error: (_: unknown, message: string) => errors.push(message),
      warn: () => undefined,
    } as unknown as typeof w.t.deps.logger;
    const restore = failDeletes();
    try {
      await w.t.inOrganization(() => destroyComputer(w.t.deps, before, { signIns: true }));
      const [record] = await w.retiredOf(m.ownerId);
      for (let i = 1; i < RETIRED_MAX_ATTEMPTS; i++) {
        await w.job(record!.id, undefined, { ...w.t.deps, logger });
      }
    } finally {
      restore();
    }
    const [record] = await w.retiredOf(m.ownerId);
    expect(record).toMatchObject({ status: 'deleting', attempts: RETIRED_MAX_ATTEMPTS });
    expect(record!.gaveUpAt).not.toBeNull();
    expect(record!.nextAttemptAt).toBeNull();
    expect(errors).toContain('gave up deleting an old computer; an operator must retry it');
    // The sweep and the job leave it alone, however late.
    expect(await w.sweep(new Date(Date.now() + 30 * DAY))).toBe(0);
    await w.job(record!.id);
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(true);

    // An operator lists what waits for one, in this organization only.
    const listed = await w.cli(['retired', '--gave-up']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(record!.id);
    expect(listed.out).toContain(`member ${m.ownerId}`);
    expect(listed.out).toMatch(/waiting for an operator/);
    expect(listed.out).toMatch(/last error: Sprites API: delete failed \(503\)/);
    expect((await w.cli(['retired'])).out).toContain(record!.id);
    const elsewhere = await w.t.createOrganization('Elsewhere gave up');
    expect((await w.cli(['retired', '--gave-up'], elsewhere)).out).not.toContain(record!.id);

    // A retry names its operator, is audited, and is due at once.
    expect((await w.cli(['retry', record!.id])).code).toBe(2);
    expect((await w.cli(['retry', record!.id, '--by', 'Sam from support'])).code).toBe(0);
    expect((await w.cli(['retry', record!.id, '--by', 'Sam from support'])).code).toBe(1);
    const [retry] = await w.audits('computer.retired_retry', record!.id);
    expect(retry!.metadata).toMatchObject({ operator: 'Sam from support' });
    expect(await w.sweep()).toBe(1);
    await w.job(record!.id, final(record!));
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted', attempts: 0 }]);
  });

  it('counts the attempts of an install that has not the provider, and gives up', async () => {
    const m = await w.member('no-provider@example.com');
    await w.isolate(m.ownerId);
    const restore = failDeletes();
    try {
      await w.t.inOrganization(async () =>
        destroyComputer(w.t.deps, await m.row(), { signIns: true }),
      );
    } finally {
      restore();
    }
    const [record] = await w.retiredOf(m.ownerId);
    for (let i = 1; i < RETIRED_MAX_ATTEMPTS; i++) {
      await w.t.inOrganization(() =>
        runRetiredComputerJob(w.t.deps, null, { retiredId: record!.id }),
      );
    }
    const [after] = await w.retiredOf(m.ownerId);
    expect(after).toMatchObject({ attempts: RETIRED_MAX_ATTEMPTS, status: 'deleting' });
    expect(after!.gaveUpAt).not.toBeNull();
    expect(after!.lastError).toMatch(/no sprites provider/);
  });

  it("never deletes a machine the member's computer names again", async () => {
    const m = await w.member('current@example.com');
    await w.isolate(m.ownerId);
    const restore = failDeletes();
    try {
      await w.t.inOrganization(async () =>
        destroyComputer(w.t.deps, await m.row(), { signIns: true }),
      );
    } finally {
      restore();
    }
    const [record] = await w.retiredOf(m.ownerId);
    await w.t.db
      .update(schema.computers)
      .set({ containerId: record!.providerRef })
      .where(eq(schema.computers.ownerId, m.ownerId));
    await w.job(record!.id);
    expect(w.sprites.api.sprites.has(record!.providerRef)).toBe(true);
    const [kept] = await w.retiredOf(m.ownerId);
    expect(kept).toMatchObject({ status: 'deleting', attempts: 2 });
    expect(kept!.lastError).toMatch(/current computer/);
  });

  it('deletes the old Sprite again if a provisioning the reset cancelled made it anew', async () => {
    const m = await w.member('late-make@example.com');
    await w.isolate(m.ownerId);
    const before = await m.row();
    await w.t.inOrganization(() => destroyComputer(w.t.deps, before, { signIns: true }));
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    // A provisioning cut off from the database made the Sprite again after the reset.
    await w.sprites.api.create(before.containerId!, { urlAuth: 'public' });
    const [record] = await w.retiredOf(m.ownerId);
    expect(record).toMatchObject({ status: 'deleting' });
    expect(await w.sweep(final(record!))).toBe(1);
    await w.job(record!.id, final(record!));
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
  });

  it('only a person may fully reset: an API key is refused, a paired device and a session are not', async () => {
    const m = await w.member('person@example.com');
    const issued = await m.call('POST', '/api-keys', { name: 'script' });
    expect(issued.status).toBe(201);
    const { key, id } = (await issued.json()) as { key: string; id: string };
    const script = { authorization: `Bearer ${key}` };
    const before = await m.row();
    const requestId = await m.prepare();
    const refused = await m.confirm(requestId, { resetSignIns: true }, script);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe('PERSON_REQUIRED');
    // Nothing happened, and the prepare is still the member's to confirm.
    expect(await m.row()).toMatchObject({ containerId: before.containerId, status: 'running' });
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(true);
    expect(await w.retiredOf(m.ownerId)).toEqual([]);
    // A reset that keeps the computer is still a script's to ask for.
    expect((await m.confirm(requestId, {}, script)).status).toBe(202);
    // The member's own paired device counts as a person.
    await w.t.db.insert(schema.devices).values({
      workspaceId: w.workspaceId,
      ownerId: m.ownerId,
      name: 'Phone',
      platform: 'ios',
      publicKey: Buffer.alloc(32, 7),
      apiKeyId: id,
    });
    await m.start();
    const device = await m.confirm(await m.prepare(), { resetSignIns: true }, script);
    expect(device.status, await device.clone().text()).toBe(202);
    // And a session.
    await m.start();
    expect((await m.confirm(await m.prepare(), { resetSignIns: true })).status).toBe(202);
  });

  it('takes the request shapes of the released apps', async () => {
    const m = await w.member('released@example.com');
    // As main's API has it: requestId and confirm, resetSignIns optional.
    const status = (await (
      await m.call('GET', `/computer/reset/${await m.prepare()}`)
    ).json()) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual(
      ['error', 'expiresAt', 'results', 'runningSessions', 'status', 'unsaved'].sort(),
    );
    const soft = await m.call('POST', '/computer/reset', {
      requestId: await m.prepare(),
      confirm: true,
    });
    expect(soft.status, await soft.clone().text()).toBe(202);
    await m.start();
    const full = await m.call('POST', '/computer/reset', {
      requestId: await m.prepare(),
      confirm: true,
      resetSignIns: true,
    });
    expect(full.status, await full.clone().text()).toBe(202);
    expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
  });

  it('refuses the old agent token in any process, a process that missed the bus too', async () => {
    const m = await w.member('fence@example.com');
    const stale = await m.row();
    expect(() => agentFor(w.t.ownerDeps, stale)).not.toThrow();
    // The deletion is slow: the old machine still exists while the token is refused.
    const provider = w.machines();
    const slow = holdOnce(provider, 'destroy');
    const resetting = w.t.inOrganization(() => destroyComputer(w.t.deps, stale, { signIns: true }));
    try {
      await slow.inside;
      expect(w.sprites.api.sprites.has(stale.containerId!)).toBe(true);
      expect(() => agentFor(w.t.ownerDeps, stale)).toThrow(/was reset/);
      // A process that started after the reset, or missed the bus, reads it from the record.
      forgetFences();
      expect(isFenced(stale)).toBe(false);
      await loadFences(w.t.deps.db, new Date(0));
      expect(isFenced(stale)).toBe(true);
      expect(() => agentFor(w.t.ownerDeps, stale)).toThrow(/was reset/);
      slow.go();
      await resetting;
    } finally {
      slow.restore();
    }
    // The member's next machine is reached as usual.
    const fresh = await m.start();
    expect(() => agentFor(w.t.ownerDeps, fresh)).not.toThrow();
  });

  it('answers a full reset as one with every publish on the bus failing', async () => {
    const m = await w.member('bus-down@example.com');
    await m.signedIn();
    const before = await m.row();
    const requestId = await m.prepare();
    const bus = w.t.deps.infra.bus;
    const publish = bus.publish;
    bus.publish = (async () => {
      throw new Error('redis down');
    }) as typeof bus.publish;
    let res: Response;
    try {
      res = await m.confirm(requestId, { resetSignIns: true });
    } finally {
      bus.publish = publish;
    }
    expect(res.status, await res.clone().text()).toBe(202);
    expect(w.sprites.api.sprites.has(before.containerId!)).toBe(false);
    expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    expect(await m.kept()).toEqual({ authKind: 'none', checkout: 'missing' });
  });

  it('runs from the queue, in the organization that owns the record', async () => {
    const m = await w.member('queue@example.com');
    await w.isolate(m.ownerId);
    await w.t.inOrganization(async () =>
      destroyComputer(w.t.deps, await m.row(), { signIns: true }),
    );
    const [record] = await w.retiredOf(m.ownerId);
    // As if the reset was long ago: the queue's job runs on the real clock.
    await w.t.db
      .update(schema.retiredComputers)
      .set({ retiredAt: new Date(Date.now() - RETIRED_RECHECK_MS - 60_000), nextAttemptAt: null })
      .where(eq(schema.retiredComputers.id, record!.id));
    // The worker works only while this test runs: later tests run each job themselves.
    let working = true;
    const handler = retiredComputerHandler(w.t.deps, () => computerProvider(w.t.deps));
    await w.t.deps.infra
      .queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE)
      .process(async (queued) => {
        if (working) await handler(queued);
      });
    try {
      expect(await w.sweep()).toBe(1);
      await until(async () =>
        expect(await w.retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]),
      );
    } finally {
      working = false;
    }
  });

  it('two resets of the same machine at once: one goes through, the other is a conflict', async () => {
    const m = await w.member('twice@example.com');
    const row = await m.row();
    const results = await Promise.allSettled([
      w.t.inOrganization(() => destroyComputer(w.t.deps, row, { signIns: true })),
      w.t.inOrganization(() => destroyComputer(w.t.deps, row, { signIns: true })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
      .reason as { status?: number; code?: string };
    expect(refused.status).toBe(409);
    expect(['COMPUTER_CHANGED', 'COMPUTER_BUSY']).toContain(refused.code);
    expect(await w.retiredOf(m.ownerId)).toHaveLength(1);
    expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
  });

  it('cancels a start under way: its job writes nothing after, and the old Sprite is deleted', async () => {
    const m = await w.member('busy-reset@example.com');
    const row = await m.row();
    // A start queued its job, as `queueProvision` does: a new attempt, a new generation.
    const [queued] = await w.t.db
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
    const provider = w.machines();
    const starting = holdOnce(provider, 'start');
    try {
      const running = w.t.inOrganization(() =>
        provisionComputer(w.t.deps, {
          computerId: row.id,
          workspaceId: w.workspaceId,
          by: { type: 'user', id: m.ownerId },
          attempt: 'attempt-x',
        }),
      );
      await starting.inside;
      const reset = await w.t.inOrganization(() =>
        destroyComputer(w.t.deps, queued!, { signIns: true }),
      );
      expect(reset).toMatchObject({ status: 'stopped', containerId: null });
      expect(w.sprites.api.sprites.has(row.containerId!)).toBe(false);
      starting.go();
      await running;
    } finally {
      starting.restore();
    }
    const after = await m.row();
    expect(after).toMatchObject({ status: 'stopped', containerId: null, agentToken: null });
    expect(after.machineKey).not.toBe(row.machineKey);
    expect((await m.start()).containerId).toBe(spriteName(after.machineKey!));
  });

  it('a stale write of the whole spec does not lose the new machine key', async () => {
    const m = await w.member('stale-spec@example.com');
    const stale = await m.row();
    expect((await m.confirm(await m.prepare(), { resetSignIns: true })).status).toBe(202);
    // Any path that writes `spec` whole from a row it read before the reset.
    await w.t.db
      .update(schema.computers)
      .set({ spec: stale.spec })
      .where(eq(schema.computers.id, stale.id));
    const fresh = await m.start();
    expect(fresh.status).toBe('running');
    expect(fresh.containerId).not.toBe(stale.containerId);
  });

  it('a new Sprite made whose row was not saved is found again by the retried job', async () => {
    const m = await w.member('crash-make@example.com');
    expect((await m.confirm(await m.prepare(), { resetSignIns: true })).status).toBe(202);
    const row = await m.row();
    const key = row.machineKey!;
    // The provisioning job made the Sprite, then its process died before the row was saved.
    await w.machines().create({
      computerId: row.id,
      ownerId: m.ownerId,
      image: 'unused',
      agentToken: 'from-the-lost-attempt-0000',
      volumeName: 'unused',
      machineKey: key,
    });
    const count = w.sprites.api.sprites.size;
    await w.t.db
      .update(schema.computers)
      .set({ status: 'creating' })
      .where(eq(schema.computers.id, row.id));
    await w.t.inOrganization(() =>
      provisionComputer(w.t.deps, {
        computerId: row.id,
        workspaceId: w.workspaceId,
        by: { type: 'user', id: m.ownerId },
      }),
    );
    expect(await m.row()).toMatchObject({ status: 'running', containerId: spriteName(key) });
    expect(w.sprites.api.sprites.size).toBe(count);
  });

  it('never holds or wakes the old Sprite: a use that began before the reset moves on', async () => {
    const m = await w.member('usage@example.com');
    const before = await m.row();
    const oldName = before.containerId!;
    // The deletion is held, so the old Sprite still exists while the use refreshes.
    const provider = w.machines();
    const deleting = holdOnce(provider, 'destroy');
    const refresh = useTimings.holdRefreshMs;
    useTimings.holdRefreshMs = 20;
    const use = beginComputerUse(w.t.ownerDeps, before, 'run');
    try {
      await settleComputerUses();
      const resetting = w.t.inOrganization(() =>
        destroyComputer(w.t.deps, before, { signIns: true }),
      );
      await deleting.inside;
      const mark = w.sprites.api.calls.length;
      w.sprites.api.sprites.get(oldName)!.status = 'cold';
      const fresh = await m.start();
      // The use's next refresh holds the member's new Sprite instead.
      await until(() =>
        expect([...w.sprites.api.sprites.get(fresh.containerId!)!.tasks.keys()]).toHaveLength(1),
      );
      const onOld = w.sprites.api.calls.slice(mark).filter((c) => c.name === oldName);
      expect(onOld.map((c) => c.op).filter((op) => op !== 'get')).toEqual([]);
      expect(w.sprites.api.sprites.get(oldName)!.status).toBe('cold');
      deleting.go();
      await resetting;
    } finally {
      deleting.restore();
      await use.end();
      useTimings.holdRefreshMs = refresh;
    }
    expect(w.sprites.api.sprites.has(oldName)).toBe(false);
    // The awake time on record is the use's: the deletion opens no interval.
    const intervals = await w.t.db
      .select()
      .from(schema.computerUsageIntervals)
      .where(eq(schema.computerUsageIntervals.ownerId, m.ownerId));
    expect(intervals.map((i) => i.reason)).toEqual(['run']);
  });

  it('a full reset after one that kept the sign-ins deletes the kept Sprite', async () => {
    const m = await w.member('soft-then-full@example.com');
    const name = (await m.row()).containerId!;
    w.sprites.api.sprites.get(name)!.files.set(SIGN_IN, new Uint8Array([1]));
    // A reset that keeps the sign-ins clears the home in place: the same Sprite stays.
    expect((await m.confirm(await m.prepare(), {})).status).toBe(202);
    expect(w.sprites.api.sprites.get(name)!.files.has(SIGN_IN)).toBe(true);
    // The next reset's rescue cannot start the computer: it is left `error`.
    const provider = w.machines();
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
    expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
    // The Sprite with the old sign-ins is gone, through a record of it.
    expect(w.sprites.api.sprites.has(name)).toBe(false);
    expect(await w.retiredOf(m.ownerId)).toMatchObject([{ providerRef: name }]);
    const after = await m.start();
    expect(after.containerId).not.toBe(name);
    expect(w.sprites.api.sprites.get(after.containerId!)!.files.has(SIGN_IN)).toBe(false);
  });

  it('a full reset while the kept Sprite is being made again deletes that Sprite', async () => {
    const m = await w.member('creating-after-soft@example.com');
    const name = (await m.row()).containerId!;
    expect((await m.confirm(await m.prepare(), {})).status).toBe(202);
    const made = holdOnce(w.machines(), 'create');
    try {
      expect(await m.tryStart()).not.toBe(200);
      await made.inside;
      const creating = await m.row();
      expect(creating.status).toBe('creating');
      await w.t.inOrganization(() => destroyComputer(w.t.deps, creating, { signIns: true }));
      expect(w.sprites.api.sprites.has(name)).toBe(false);
      made.fail(new Error('the make was cancelled'));
    } finally {
      made.restore();
    }
    await until(async () => expect((await m.row()).status).toBe('stopped'));
    expect((await m.start()).containerId).not.toBe(name);
  });

  it('keeps the organization from being deleted while it has a record', async () => {
    const m = await w.member('fk@example.com');
    await w.t.inOrganization(async () =>
      destroyComputer(w.t.deps, await m.row(), { signIns: true }),
    );
    const error = await w.t.db
      .execute(sql`delete from workspaces where id = ${w.workspaceId}`)
      .then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string }; message: string },
      );
    expect(error?.cause?.message ?? error?.message).toMatch(/retired_computers/);
  });

  // On PGlite the database's clock is this process's, so only real Postgres
  // can run a worker whose clock differs from the database's.
  it.runIf(process.env.DATABASE_URL)(
    'a lease taken by a worker whose clock runs behind is not cut short',
    async () => {
      const m = await w.member('slow-clock@example.com');
      await w.isolate(m.ownerId);
      const restore = failDeletes();
      try {
        await w.t.inOrganization(async () =>
          destroyComputer(w.t.deps, await m.row(), { signIns: true }),
        );
      } finally {
        restore();
      }
      const [record] = await w.retiredOf(m.ownerId);
      await w.t.db
        .update(schema.retiredComputers)
        .set({ nextAttemptAt: null })
        .where(eq(schema.retiredComputers.id, record!.id));
      // This worker's clock runs six minutes behind the database's: it claims the record.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 6 * 60_000);
      try {
        expect(await w.sweep()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      // A worker on time leaves the claim alone: its lease has not run out.
      expect(await w.sweep()).toBe(0);
    },
  );
});
