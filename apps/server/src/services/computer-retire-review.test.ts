import {
  createSpritesProvider,
  SPRITES_AGENT_SERVICE,
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
  agentFor,
  computerProvider,
  destroyComputer,
  provisionComputer,
  recoverStaleComputers,
  setComputerProvider,
  STOPPING_TAKEOVER_MS,
  type ComputerRow,
} from './computer.js';
import { forgetFences, isFenced, loadFences } from './computer-fence.js';
import {
  RETIRED_MAX_ATTEMPTS,
  retireMachine,
  runRetiredComputerJob,
  sweepRetiredComputers,
} from './computer-retire.js';
import { runRescueJob } from './repos-rescue.js';

// The second review of retired computers (plan 9.5): races and crashes that
// need their interleaving held, each by a provider call that waits until the
// test lets it go. The database is the record of which machine is a
// member's and which are retired; nothing here rests on one process's memory.

const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

/** A provider call held until the test lets it go, or fails it. */
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

describe('retired computers, second review', () => {
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
    const call = (method: string, path: string, body?: unknown, auth?: Record<string, string>) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: {
          ...(auth ?? { cookie }),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const row = async (): Promise<ComputerRow> =>
      (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;
    const start = async () => {
      const res = await call('POST', '/computer/start');
      expect(res.status, await res.clone().text()).toBe(200);
      return row();
    };
    /** A prepared reset whose rescue is done; confirm it with `confirm`. */
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
    const confirm = (requestId: string, extra: object, auth?: Record<string, string>) =>
      call('POST', '/computer/reset', { requestId, confirm: true, ...extra }, auth);
    await start();
    return { cookie, ownerId, call, row, start, prepare, confirm };
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
  /** The row's job as the queue runs it, with the claim it was queued under. */
  const job = async (retiredId: string, kind: 'retire' | 'delete', deps = t.deps) => {
    const [row] = await t.db
      .select()
      .from(schema.retiredComputers)
      .where(eq(schema.retiredComputers.id, retiredId));
    const claim = (row as { claim?: string | null } | undefined)?.claim ?? undefined;
    return t.inOrganization(() =>
      runRetiredComputerJob(deps, machines(), { retiredId, kind, ...(claim ? { claim } : {}) }),
    );
  };
  const finishRetires = async (ownerId: string) => {
    for (const row of await retiredOf(ownerId)) {
      if (row.status === 'retiring') await job(row.id, 'retire');
    }
  };
  const isolate = (ownerId: string) =>
    t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted' })
      .where(sql`owner_id <> ${ownerId} and status in ('retiring', 'retired', 'deleting')`);
  const audits = (action: string, retiredId: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, action),
          sql`${schema.auditLog.metadata} ->> 'retiredId' = ${retiredId}`,
        ),
      );
  const outOfReach = (name: string) => {
    const sprite = sprites.api.sprites.get(name)!;
    expect(sprite.labels).toContain(SPRITES_RETIRED_LABEL);
    expect(sprite.urlAuth).toBe('sprite');
    expect(sprite.policy).toEqual(SPRITES_DENY_ALL);
  };
  /** Holds the provider's `op` once (the first call), letting later calls through. */
  function holdOnce<K extends 'retire' | 'start' | 'status' | 'retireInside'>(
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

  describe('A. no process remembers a machine as retired', () => {
    it('a computer an operator restored from another process works in the process that retired it', async () => {
      const m = await member('two-procs@example.com');
      const oldName = (await m.row()).containerId!;
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      await finishRetires(m.ownerId);
      const [retired] = await retiredOf(m.ownerId);
      // The operator's CLI is another process: its own provider, over the same Sprites API.
      const cliConfig = { ...t.deps.config };
      setComputerProvider(
        { config: cliConfig },
        createSpritesProvider({ token: 'org-token', api: sprites.api, pollMs: 5 }),
      );
      const lines: string[] = [];
      const ctx: CliContext = {
        config: cliConfig,
        db: t.deps.db,
        infra: t.deps.infra,
        logger: t.deps.logger,
        write: (line) => lines.push(line),
      };
      const code = await runComputers(
        ['restore', retired!.id, '--org', workspaceId, '--by', 'Sam from support'],
        ctx,
      );
      expect(code, lines.join('\n')).toBe(0);
      // Back in the process that retired it: its start provisions it and reaches its agent.
      const back = await m.start();
      expect(back).toMatchObject({ status: 'running', containerId: oldName });
      await expect(agentFor(t.ownerDeps, back).health()).resolves.toBeTruthy();
    });
  });

  describe('B. one owner at a time for a record', () => {
    it('a reset whose slow cut the sweep took over never puts the old machine back', async () => {
      const m = await member('slow-cut@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const provider = machines();
      const cut = holdOnce(provider, 'retire');
      let answer: unknown;
      try {
        const resetting = t
          .inOrganization(() => destroyComputer(t.deps, before, { signIns: true }))
          .then(
            () => null,
            (error: unknown) => error,
          );
        await cut.inside;
        const [row] = await retiredOf(m.ownerId);
        // The API is slow past the reset's lease: the sweep claims the record and its job finishes it.
        expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
        await job(row!.id, 'retire');
        expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'retired' }]);
        // Then the reset's own cut fails at last.
        cut.fail(new Error('Sprites API: labels failed (504) for it'));
        answer = await resetting;
      } finally {
        cut.restore();
      }
      expect(answer).toMatchObject({ status: 503, code: 'COMPUTER_UNAVAILABLE' });
      expect((answer as Error).message).toMatch(/retried in the background/);
      // The record and the machine agree: retired, out of reach, its agent gone.
      outOfReach(before.containerId!);
      expect(
        sprites.api.sprites.get(before.containerId!)!.services.has(SPRITES_AGENT_SERVICE),
      ).toBe(false);
      const [after] = await retiredOf(m.ownerId);
      expect(after).toMatchObject({ status: 'retired', providerRef: before.containerId });
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });

    it('a reset whose cut lands after the sweep sealed the record writes its audit once', async () => {
      const m = await member('late-cut@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const provider = machines();
      const cut = holdOnce(provider, 'retire');
      let answer: unknown;
      try {
        const resetting = t.inOrganization(() =>
          destroyComputer(t.deps, before, { signIns: true }),
        );
        await cut.inside;
        const [row] = await retiredOf(m.ownerId);
        expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
        await job(row!.id, 'retire');
        cut.go();
        answer = await resetting;
      } finally {
        cut.restore();
      }
      expect(answer).toMatchObject({ status: 'stopped', containerId: null });
      const [retired] = await retiredOf(m.ownerId);
      expect(retired).toMatchObject({ status: 'retired' });
      expect(await audits('computer.retire', retired!.id)).toHaveLength(1);
      outOfReach(before.containerId!);
    });

    it('gives up the steps inside a machine only once the provider says it is out of reach', async () => {
      const m = await member('recheck@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const provider = machines();
      const retireInside = provider.retireInside!;
      const retire = provider.retire!;
      const errors: string[] = [];
      const logger = {
        ...t.deps.logger,
        error: (_: unknown, message: string) => errors.push(message),
        warn: () => undefined,
      } as unknown as typeof t.deps.logger;
      provider.retireInside = async () => {
        throw new Error('Sprites API: exec failed for it');
      };
      try {
        const requestId = await m.prepare();
        expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
        const [row] = await retiredOf(m.ownerId);
        expect(row!.sealedAt).not.toBeNull();
        // Something put the machine back in service meanwhile, and now the cut fails too.
        await provider.unretire!({
          provider: 'sprites',
          containerId: before.containerId,
          agentUrl: '',
          agentToken: '',
          volumeName: null,
        });
        provider.retire = async () => {
          throw new Error('Sprites API: labels failed (503)');
        };
        for (let i = 0; i < RETIRED_MAX_ATTEMPTS; i++) {
          await job(row!.id, 'retire', { ...t.deps, logger });
        }
      } finally {
        provider.retireInside = retireInside;
        provider.retire = retire;
      }
      const [after] = await retiredOf(m.ownerId);
      // Not recorded as out of reach, and nothing says it is: an operator must look.
      expect(after!.status).toBe('retiring');
      expect(after!.gaveUpAt).not.toBeNull();
      expect(after!.sealedAt).toBeNull();
      expect(errors).toContain(
        'gave up taking a retired computer out of reach; an operator must retry it',
      );
      expect(errors.join('\n')).not.toMatch(/it is out of reach/);
      // An operator lists every record waiting for one, without knowing the member.
      const lines: string[] = [];
      const ctx: CliContext = {
        config: t.deps.config,
        db: t.deps.db,
        infra: t.deps.infra,
        logger: t.deps.logger,
        write: (line) => lines.push(line),
      };
      expect(await runComputers(['retired', '--gave-up', '--org', workspaceId], ctx)).toBe(0);
      const listed = lines.join('\n');
      expect(listed).toContain(after!.id);
      expect(listed).toContain(`member ${m.ownerId}`);
      expect(listed).toMatch(/waiting for an operator/);
      // Scoped to the organization, as every other command.
      const elsewhere = await t.createOrganization('Elsewhere gave up');
      lines.length = 0;
      expect(await runComputers(['retired', '--gave-up', '--org', elsewhere], ctx)).toBe(0);
      expect(lines.join('\n')).not.toContain(after!.id);
    });
  });

  describe('C. a member is never kept from resetting', () => {
    it(`a stop that a dead process left refuses a reset for at most ${STOPPING_TAKEOVER_MS / 60_000} minutes, then the reset takes it over`, async () => {
      const m = await member('stuck-stop@example.com');
      const before = await m.row();
      // A stop began and its process died: the row reads `stopping` and nothing finishes it.
      await t.db
        .update(schema.computers)
        .set({ status: 'stopping' })
        .where(eq(schema.computers.id, before.id));
      const fresh = await m.row();
      const refused = await t
        .inOrganization(() => destroyComputer(t.deps, fresh, { signIns: true }))
        .then(
          () => null,
          (error: unknown) => error as { status?: number; code?: string },
        );
      expect(refused).toMatchObject({ status: 409, code: 'COMPUTER_BUSY' });
      // As old as the bound: the reset goes through, and the old machine is out of reach.
      await t.db
        .update(schema.computers)
        .set({ statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1) })
        .where(eq(schema.computers.id, before.id));
      const reset = await t.inOrganization(async () =>
        destroyComputer(t.deps, await m.row(), { signIns: true }),
      );
      expect(reset).toMatchObject({ status: 'stopped', containerId: null });
      outOfReach(before.containerId!);
      expect(STOPPING_TAKEOVER_MS).toBeLessThanOrEqual(2 * 60_000);
    });

    it('a start takes over a stop that a dead process left', async () => {
      const m = await member('stuck-start@example.com');
      const before = await m.row();
      await t.db
        .update(schema.computers)
        .set({ status: 'stopping', statusAt: new Date(Date.now() - STOPPING_TAKEOVER_MS - 1) })
        .where(eq(schema.computers.id, before.id));
      expect(await m.start()).toMatchObject({ status: 'running', containerId: before.containerId });
    });

    it('the sweep recovers busy states a dead process left, once among several workers', async () => {
      /** A member's computer row only, with no machine made: for states that need none. */
      const bare = async (email: string, status: string) => {
        await t.signUp(email);
        const [row] = await t.db
          .insert(schema.computers)
          .values({ workspaceId, ownerId: await t.userId(email), provider: 'sprites', status })
          .returning();
        return row!;
      };
      const get = async (row: ComputerRow) =>
        (await t.db.select().from(schema.computers).where(eq(schema.computers.id, row.id)))[0]!;
      const set = (row: ComputerRow, values: Partial<ComputerRow>) =>
        t.db.update(schema.computers).set(values).where(eq(schema.computers.id, row.id));
      const old = new Date(Date.now() - 60 * 60_000);
      // A stop cut short on a machine; one with no machine left (a reset cut
      // short); a stop still under way; and a provisioning whose job was lost
      // (made last: the test agent answers the newest machine's token).
      const a = await member('sweep-a@example.com');
      const ra = await a.row();
      await set(ra, { status: 'stopping', statusAt: old });
      const rb = await bare('sweep-b@example.com', 'stopping');
      await set(rb, { statusAt: old });
      const rd = await bare('sweep-d@example.com', 'stopping');
      const c = await member('sweep-c@example.com');
      const rc = await c.row();
      await set(rc, {
        status: 'starting',
        statusAt: old,
        spec: { ...(rc.spec as object), provision: { attempt: 'lost', at: old.toISOString() } },
      });
      const recovered = await Promise.all([
        inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps)),
        inEveryOrganization(t.deps, () => recoverStaleComputers(t.deps)),
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

    it("the job that finishes a reset cut short gives the member's computer back at once", async () => {
      const m = await member('released@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const provider = machines();
      // The reset's process dies while the provider is being called.
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
      expect(await m.row()).toMatchObject({ status: 'stopping', containerId: null });
      const [row] = await retiredOf(m.ownerId);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      const slow = holdOnce(provider, 'retire');
      try {
        const finishing = job(row!.id, 'retire');
        await slow.inside;
        // Nothing needs it held while the old machine is cut off.
        expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
        slow.go();
        await finishing;
      } finally {
        slow.restore();
      }
      outOfReach(before.containerId!);
    });
  });

  describe('D. deleting the old computer now', () => {
    it('deletes a restored machine that has no agent yet, through its record', async () => {
      const m = await member('restored-delete@example.com');
      const requestId = await m.prepare();
      expect((await m.confirm(requestId, { resetSignIns: true })).status).toBe(202);
      await finishRetires(m.ownerId);
      const [retired] = await retiredOf(m.ownerId);
      const lines: string[] = [];
      const code = await runComputers(
        ['restore', retired!.id, '--org', workspaceId, '--by', 'Sam from support'],
        {
          config: t.deps.config,
          db: t.deps.db,
          infra: t.deps.infra,
          logger: t.deps.logger,
          write: (line) => lines.push(line),
        },
      );
      expect(code, lines.join('\n')).toBe(0);
      // Its next start failed: the row has the machine, and no agent.
      await t.db
        .update(schema.computers)
        .set({ status: 'error' })
        .where(eq(schema.computers.ownerId, m.ownerId));
      const restored = await m.row();
      expect(restored).toMatchObject({ containerId: retired!.providerRef, agentUrl: null });
      await t.inOrganization(() =>
        destroyComputer(t.deps, restored, { signIns: true, deleteOld: true }),
      );
      expect(sprites.api.sprites.has(retired!.providerRef)).toBe(false);
      const records = await retiredOf(m.ownerId);
      expect(records.find((r) => r.id !== retired!.id)).toMatchObject({
        providerRef: retired!.providerRef,
        status: 'deleted',
      });
      expect(await m.row()).toMatchObject({ status: 'stopped', containerId: null });
    });

    it('a deletion that does not finish in time leaves the machine recorded and out of reach, and the job deletes it', async () => {
      const m = await member('slow-delete@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      // The API takes the delete, but the Sprite is still there when the wait ends.
      const remove = sprites.api.delete;
      sprites.api.delete = async () => undefined;
      try {
        await t.inOrganization(() =>
          destroyComputer(t.deps, before, { signIns: true, deleteOld: true }),
        );
      } finally {
        sprites.api.delete = remove;
      }
      const after = await m.row();
      expect(after).toMatchObject({ status: 'stopped', containerId: null, agentToken: null });
      expect(after.machineKey).not.toBe(before.machineKey);
      expect(() => agentFor(t.ownerDeps, before)).toThrow(/was reset/);
      outOfReach(before.containerId!);
      const [record] = await retiredOf(m.ownerId);
      expect(record).toMatchObject({ providerRef: before.containerId, attempts: 1 });
      expect(record!.lastError).toMatch(/not deleted in time/);
      expect(await sweep(new Date(record!.nextAttemptAt!.getTime() + 1))).toBe(1);
      await job(record!.id, 'delete');
      expect(sprites.api.sprites.has(before.containerId!)).toBe(false);
      expect(await retiredOf(m.ownerId)).toMatchObject([{ status: 'deleted' }]);
      expect(await audits('computer.retired_delete', record!.id)).toHaveLength(1);
    });
  });

  describe('E. a crash between the record and the cut', () => {
    it('any process refuses the old token from the record, and the job writes the audits and cleanup once', async () => {
      const m = await member('crash-record@example.com');
      const before = await m.row();
      await isolate(m.ownerId);
      const [repo] = await t.db
        .insert(schema.repos)
        .values({
          workspaceId,
          ownerId: m.ownerId,
          fullName: 'acme/crash',
          remoteUrl: 'https://github.com/acme/crash.git',
          defaultBranch: 'main',
        })
        .returning();
      await t.db.insert(schema.repoCheckouts).values({
        workspaceId,
        repoId: repo!.id,
        computerId: before.id,
        path: '/home/bot/repos/acme/crash',
        state: 'ready',
      });
      const provider = machines();
      const dead = holdOnce(provider, 'retire');
      void t
        .inOrganization(() =>
          retireMachine(t.deps, provider, before, {
            checkpointId: null,
            by: { type: 'user', id: m.ownerId },
            reason: 'reset',
            reset: { requestId: 'r-1', signIns: true, unsaved: 0, rescueFailed: false },
          }),
        )
        .catch(() => undefined);
      await dead.inside;
      dead.restore();
      // A process that started after the reset, or missed the bus, knows the fence from the database.
      forgetFences();
      expect(isFenced(before)).toBe(false);
      await loadFences(t.deps.db, new Date(0));
      expect(isFenced(before)).toBe(true);
      expect(() => agentFor(t.ownerDeps, before)).toThrow(/was reset/);
      // The reset's cleanup waits for its point of no return: the record
      // alone changes nothing of the member's, so an undo would have nothing
      // to put back.
      const checkout = async () =>
        (
          await t.db
            .select()
            .from(schema.repoCheckouts)
            .where(eq(schema.repoCheckouts.repoId, repo!.id))
        )[0];
      expect(await checkout()).toMatchObject({ state: 'ready' });
      const [row] = await retiredOf(m.ownerId);
      expect(await audits('computer.retire', row!.id)).toHaveLength(0);
      expect(await sweep(new Date(row!.nextAttemptAt!.getTime() + 1))).toBe(1);
      // The job never undoes: it settles the reset, once, then cuts and seals.
      await job(row!.id, 'retire');
      await job(row!.id, 'retire');
      outOfReach(before.containerId!);
      expect(await checkout()).toMatchObject({ state: 'missing' });
      expect(await audits('computer.retire', row!.id)).toHaveLength(1);
      const resets = (
        await t.db
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.action, 'computer.reset'),
              eq(schema.auditLog.targetId, before.id),
            ),
          )
      ).map((a) => a.metadata);
      expect(resets).toEqual([
        expect.objectContaining({ requestId: 'r-1', signIns: true, checkouts: 1 }),
      ]);
    });
  });

  describe('F. the generation', () => {
    it('a job whose attempt was given back does not write over a reset that keeps the machine key', async () => {
      const m = await member('generation@example.com');
      const before = await m.row();
      // A start queued its job (a new attempt, a new generation, as `queueProvision` does).
      await t.db
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
      const provider = machines();
      const read = holdOnce(provider, 'status');
      try {
        const running = t.inOrganization(() =>
          provisionComputer(t.deps, {
            computerId: before.id,
            workspaceId,
            by: { type: 'user', id: m.ownerId },
            attempt: 'given-back',
          }),
        );
        await read.inside;
        // The queue's answer was lost: the attempt is given back and the row released.
        await t.db
          .update(schema.computers)
          .set({ status: 'stopped', spec: sql`${schema.computers.spec} - 'provision'` })
          .where(eq(schema.computers.id, before.id));
        // A reset that keeps the sign-ins (and the machine key) goes through meanwhile.
        await t.inOrganization(async () =>
          destroyComputer(t.deps, await m.row(), { signIns: false }),
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
  });

  describe('G. deleting the old computer now needs a person', () => {
    it('refuses an API key, and takes a session or a paired device', async () => {
      const m = await member('person@example.com');
      const issued = await m.call('POST', '/api-keys', { name: 'script' });
      expect(issued.status).toBe(201);
      const { key, id } = (await issued.json()) as { key: string; id: string };
      const script = { authorization: `Bearer ${key}` };
      let requestId = await m.prepare();
      const refused = await m.confirm(
        requestId,
        { resetSignIns: true, deleteOldComputer: true },
        script,
      );
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code?: string }).code).toBe('PERSON_REQUIRED');
      // Nothing happened, and the prepare is still the member's to confirm.
      const kept = await m.row();
      expect(sprites.api.sprites.get(kept.containerId!)!.labels).not.toContain(
        SPRITES_RETIRED_LABEL,
      );
      // An ordinary full reset from the same key keeps its gating.
      expect((await m.confirm(requestId, { resetSignIns: true }, script)).status).toBe(202);
      await finishRetires(m.ownerId);
      await m.start();
      // The member's own paired device counts as a person.
      await t.db.insert(schema.devices).values({
        workspaceId,
        ownerId: m.ownerId,
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.alloc(32, 7),
        apiKeyId: id,
      });
      requestId = await m.prepare();
      const device = await m.confirm(
        requestId,
        { resetSignIns: true, deleteOldComputer: true },
        script,
      );
      expect(device.status, await device.clone().text()).toBe(202);
      // And a session.
      await m.start();
      requestId = await m.prepare();
      expect(
        (await m.confirm(requestId, { resetSignIns: true, deleteOldComputer: true })).status,
      ).toBe(202);
    });
  });
});
