import { PROVISION_VERSION_FILE, SPRITES_RETIRED_LABEL, spriteName } from '@openbots/computer';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import {
  beginComputerUse,
  computerProvider,
  computerServices,
  computerUseScope,
  COMPUTERS_QUEUE,
  destroyComputer,
  ensureScreen,
  HOSTED_FAILURE,
  agentFor,
  provisionComputer,
  provisionHandler,
  provisionTimings,
  recoverProvisioning,
  sweepIdleComputers,
  type ComputerRow,
  type ProvisionJob,
} from './computer.js';
import { runRescueJob } from './repos-rescue.js';
import {
  endAllComputerUses,
  settleComputerUses,
  USE_HOLD_NAME,
  useTimings,
} from './computer-use.js';

// The server on the sprites provider (the hosted service), with a fake
// Sprites API: making and provisioning a Sprite is a `computers` job off the
// request path, a paused Sprite still counts as running and the idle sweep
// leaves it alone, work holds it awake, a screen is checked after a gap, and
// a reset takes a checkpoint first, then deletes the Sprite or clears its home.

describe('computers on Sprites', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let cookie: string;
  let ownerId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    sprites = await useTestSprites(t.ownerDeps);
    cookie = (await t.signUp('sprite@example.com')).cookie!;
    ownerId = await t.userId('sprite@example.com');
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(async () => {
    await sprites.close();
    await t.close();
  });

  const call = (method: string, path: string) =>
    t.app.request(`/api/v1${path}`, { method, headers: { cookie } });
  const start = () => call('POST', '/computer/start');
  const row = async () =>
    (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;
  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });
  const holds = (computer: ComputerRow) => [
    ...sprites.api.sprites.get(computer.containerId!)!.tasks.keys(),
  ];

  it('makes and provisions a Sprite on first start, in a job', async () => {
    const res = await start();
    expect(res.status, await res.clone().text()).toBe(200);
    // The API does not name the sandbox vendor: a hosted computer reads `remote`.
    expect(await res.json()).toMatchObject({
      provider: 'remote',
      status: 'running',
      idleSettings: false,
    });
    const computer = await row();
    const name = spriteName(computer.id);
    expect(computer).toMatchObject({ provider: 'sprites', containerId: name, volumeName: null });
    expect(computer.spec).toMatchObject({ provisionVersion: '1' });
    expect(sprites.api.sprites.get(name)?.policy?.rules[0]).toEqual({ include: 'defaults' });
    expect(sprites.api.provisions).toHaveLength(1);
    // The token the server sealed is the one provisioned.
    expect(sprites.agent.token).toBe(sprites.api.provisions[0]!.token);
    const statuses = events
      .filter((e) => e.type === 'computer.status')
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses[0]).toBe('creating');
    expect(statuses.at(-1)).toBe('running');
  });

  it('treats a paused Sprite as running: a start only marks it used', async () => {
    const name = (await row()).containerId!;
    sprites.api.sprites.get(name)!.status = 'cold';
    const res = await start();
    expect(res.status).toBe(200);
    expect(sprites.api.provisions).toHaveLength(1);
  });

  it('is never stopped for idleness, and a new release provisions it once idle', async () => {
    const computer = await row();
    await t.db
      .update(schema.computers)
      .set({
        lastUsedAt: new Date(0),
        spec: { ...(computer.spec as object), provisionVersion: '0' },
      })
      .where(eq(schema.computers.id, computer.id));
    const sprite = sprites.api.sprites.get(computer.containerId!)!;
    sprite.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('0'));
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    expect(sprites.api.calls.some((c) => c.op === 'delete')).toBe(false);
    // Not stopped: updated in the background, and running again.
    await until(async () => expect((await row()).status).toBe('running'));
    expect((await row()).spec).toMatchObject({ provisionVersion: '1' });
    expect(sprites.api.provisions).toHaveLength(2);

    // A recent use keeps an out-of-date Sprite as it is.
    await t.db
      .update(schema.computers)
      .set({ spec: { provisionVersion: '0' }, lastUsedAt: new Date() })
      .where(eq(schema.computers.id, computer.id));
    await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps));
    expect((await row()).status).toBe('running');
    expect(sprites.api.provisions).toHaveLength(2);
    await t.db
      .update(schema.computers)
      .set({ spec: { provisionVersion: '1' } })
      .where(eq(schema.computers.id, computer.id));
  });

  it('holds the Sprite awake for a run, refreshes the hold, and releases it at the end', async () => {
    const computer = await row();
    const refresh = useTimings.holdRefreshMs;
    useTimings.holdRefreshMs = 20;
    try {
      const run = computerUseScope(t.deps, 'run');
      run.begin(computer);
      run.begin(computer);
      await until(() => expect(holds(computer)).toEqual([`openbots-${USE_HOLD_NAME}`]));
      const puts = () =>
        sprites.api.calls.filter(
          (c) => c.op === 'exec' && JSON.stringify(c.args[0]).includes('"PUT"'),
        ).length;
      const before = puts();
      await until(() => expect(puts()).toBeGreaterThan(before + 1));
      await run.end();
      expect(holds(computer)).toEqual([]);
      // Ended twice, or after its end, it does nothing.
      await run.end();
      run.begin(computer);
      await settleComputerUses();
      expect(holds(computer)).toEqual([]);
    } finally {
      useTimings.holdRefreshMs = refresh;
    }
  });

  it('keeps the hold while another use lasts, and while a command runs', async () => {
    const computer = await row();
    const session = beginComputerUse(t.deps, computer, 'coding_session');
    const run = computerUseScope(t.deps, 'run');
    run.begin(computer);
    await settleComputerUses();
    // A run cancelled or failed ends its use in the worker's `finally`.
    await run.end();
    expect(holds(computer)).toHaveLength(1);
    await session.end();
    expect(holds(computer)).toEqual([]);

    // A command run through a run's tools is held while it runs.
    let seen: string[] = [];
    const echo = sprites.agent.exec;
    sprites.agent.exec = () => {
      seen = holds(computer);
      return { stdout: 'ok', exitCode: 0 };
    };
    const scope = computerUseScope(t.deps, 'run');
    const services = computerServices(t.deps, {
      bot: { id: crypto.randomUUID(), ownerId, workspaceId: computer.workspaceId },
      runId: crypto.randomUUID(),
      recordStep: async () => {},
      use: scope,
    });
    await t.inOrganization(async () => {
      const agent = await services.agent();
      await agent.exec({ command: 'sleep 1', cwd: '/home/bot' });
    });
    sprites.agent.exec = echo;
    expect(seen).toHaveLength(1);
    await scope.end();
    expect(holds(computer)).toEqual([]);
  });

  it('starts a screen again that a cold wake took away', async () => {
    const computer = await row();
    const bot = { id: crypto.randomUUID(), ownerId, workspaceId: computer.workspaceId };
    await t.db.insert(schema.bots).values({
      id: bot.id,
      workspaceId: bot.workspaceId,
      ownerId,
      name: 'Screens',
      handle: `screens${Date.now()}`,
    });
    const agent = agentFor(t.deps, computer);
    const first = await t.inOrganization(() => ensureScreen(t.deps, bot, computer, agent));
    expect(first.status).toBe('running');
    const n = first.displayNumber - 10;
    expect(sprites.agent.screens.has(n)).toBe(true);
    // A cold wake: the agent came back with no screens; the row still says running.
    sprites.agent.screens.clear();
    const again = await t.inOrganization(() => ensureScreen(t.deps, bot, computer, agent));
    expect(again.status).toBe('running');
    expect(sprites.agent.screens.has(n)).toBe(true);
    // While a use lasts it is not asked again.
    const use = beginComputerUse(t.deps, computer, 'run');
    await t.inOrganization(() => ensureScreen(t.deps, bot, computer, agent));
    const healths = sprites.agent.calls.filter((c) => c.path === '/healthz').length;
    await t.inOrganization(() => ensureScreen(t.deps, bot, computer, agent));
    expect(sprites.agent.calls.filter((c) => c.path === '/healthz')).toHaveLength(healths);
    await use.end();
    await t.db.delete(schema.bots).where(eq(schema.bots.id, bot.id));
  });

  it('records the usage of a stretch of use, with the pause tail', async () => {
    const computer = await row();
    // Earlier tests' uses close first, so this one opens its own interval.
    await endAllComputerUses();
    // Their tails would cover this one's seconds (counted once per computer).
    await t.db
      .delete(schema.computerUsageIntervals)
      .where(eq(schema.computerUsageIntervals.computerId, computer.id));
    const before = Date.now();
    const use = beginComputerUse(t.deps, computer, 'terminal', { touchMs: null, hold: false });
    await settleComputerUses();
    const [open] = await t.db
      .select()
      .from(schema.computerUsageIntervals)
      .where(
        and(
          eq(schema.computerUsageIntervals.computerId, computer.id),
          eq(schema.computerUsageIntervals.reason, 'terminal'),
        ),
      );
    expect(open).toMatchObject({ provider: 'sprites', ownerId, endedAt: null, seconds: null });
    await use.end();
    // Closed after the 30 second tail, which the test does not wait for: it ends at the tail.
    await endAllComputerUses();
    const [closed] = await t.db
      .select()
      .from(schema.computerUsageIntervals)
      .where(eq(schema.computerUsageIntervals.id, open!.id));
    expect(new Date(closed!.endedAt!).getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(closed!.seconds).toBeGreaterThanOrEqual(30);
  });

  it('resets keeping the sign-ins: a checkpoint first, then the home cleared in place', async () => {
    const computer = await row();
    const sprite = sprites.api.sprites.get(computer.containerId!)!;
    sprite.files.set('/home/bot/notes.md', new Uint8Array([1]));
    sprite.files.set('/var/lib/openbots/sign-in', new Uint8Array([1]));
    // The rescue flow as the route runs it: prepare, the rescue job, then the reset.
    const prepare = await call('POST', '/computer/reset/prepare');
    expect(prepare.status, await prepare.clone().text()).toBe(202);
    const { requestId } = (await prepare.json()) as { requestId: string };
    await t.inOrganization(() =>
      runRescueJob(t.deps, { ownerId, computerId: computer.id, requestId }),
    );
    await until(async () => {
      const status = await call('GET', `/computer/reset/${requestId}`);
      expect(await status.json()).toMatchObject({ status: 'done', error: null });
    });
    const res = await t.app.request('/api/v1/computer/reset', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, confirm: true }),
    });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await row()).toMatchObject({ status: 'stopped', agentUrl: null, containerId: null });
    expect(sprite.files.has('/home/bot/notes.md')).toBe(false);
    expect(sprite.files.has('/var/lib/openbots/sign-in')).toBe(true);
    // The checkpoint came before the home was cleared, and the audit names it.
    expect(sprite.checkpoints).toHaveLength(1);
    expect(sprite.checkpoints[0]!.files.has('/home/bot/notes.md')).toBe(true);
    const [audit] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'computer.reset'));
    expect(audit?.metadata).toMatchObject({ checkpoint: sprite.checkpoints[0]!.id });
    // The next start provisions the same Sprite with a new token.
    expect((await start()).status).toBe(200);
    expect(sprites.api.sprites.size).toBe(1);
    expect(sprites.api.provisions).toHaveLength(3);
    expect(sprites.api.provisions[2]!.token).not.toBe(sprites.api.provisions[1]!.token);
  });

  it('resets with the sign-ins by retiring the Sprite for seven days; the next start makes a new one', async () => {
    const computer = await row();
    const old = sprites.api.sprites.get(computer.containerId!)!;
    old.files.set('/var/lib/openbots/x', new Uint8Array([1]));
    await t.inOrganization(() => destroyComputer(t.deps, computer, { signIns: true }));
    // Kept, out of service (computer-retire.test.ts covers the rest).
    expect(sprites.api.sprites.size).toBe(1);
    expect(old.labels).toContain(SPRITES_RETIRED_LABEL);
    expect((await start()).status).toBe(200);
    const key = ((await row()).spec as { machineKey: string }).machineKey;
    const fresh = sprites.api.sprites.get(spriteName(key))!;
    expect(fresh.files.has('/var/lib/openbots/x')).toBe(false);
    expect(sprites.api.sprites.size).toBe(2);
  });

  it('makes a Sprite for a remote row on a loopback agent instead of adopting it into Docker', async () => {
    const computer = await row();
    await t.db
      .update(schema.computers)
      .set({
        provider: 'remote',
        status: 'stopped',
        containerId: null,
        agentUrl: 'http://127.0.0.1:7070',
        agentToken: encryptSecret('standalone token', keyringFromConfig(t.deps.config)),
      })
      .where(eq(schema.computers.id, computer.id));
    expect((await start()).status).toBe(200);
    // Named from the row's machine key, which the reset above gave it.
    const { machineKey } = computer.spec as { machineKey?: string };
    expect(await row()).toMatchObject({
      provider: 'sprites',
      containerId: spriteName(machineKey ?? computer.id),
    });
  });
});

describe('Sprite provisioning off the request path', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let cookie: string;
  let ownerId: string;
  const wait = provisionTimings.waitMs;

  beforeAll(async () => {
    t = await createTestApp();
    // No worker: the test runs the queued jobs when it chooses.
    sprites = await useTestSprites(t.ownerDeps, { noWorker: true });
    cookie = (await t.signUp('queued@example.com')).cookie!;
    ownerId = await t.userId('queued@example.com');
    provisionTimings.waitMs = 50;
  });
  afterAll(async () => {
    provisionTimings.waitMs = wait;
    await sprites.close();
    await t.close();
  });

  const start = () =>
    t.app.request('/api/v1/computer/start', { method: 'POST', headers: { cookie } });
  const row = async () =>
    (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;
  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  it('answers at once while the job runs, fails to `error` with the reason, and retries', async () => {
    const res = await start();
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'creating', error: null });
    // A second start while it is queued queues nothing more.
    expect((await start()).status).toBe(202);

    // The first provisioning fails: the row is `error` with the script's output.
    const ok = sprites.api.provisionScript;
    sprites.api.provisionScript = () => ({ exitCode: 1, stdout: '', stderr: 'no network' });
    const jobs: ProvisionJob[] = [];
    const handler = provisionHandler(t.deps);
    await t.deps.infra.queue<ProvisionJob>(COMPUTERS_QUEUE).process(async (job) => {
      jobs.push(job.data);
      await handler(job);
    });
    await until(async () => expect((await row()).status).toBe('error'));
    expect(jobs).toHaveLength(1);
    const state = (await (
      await t.app.request('/api/v1/computer', { headers: { cookie } })
    ).json()) as { computer: { status: string; error: string; provider: string } };
    // The owner reads that it failed, not the vendor's name or its script's
    // output: those stay in the server's log.
    expect(state.computer).toMatchObject({ status: 'error', provider: 'remote' });
    expect(state.computer.error).toBe(HOSTED_FAILURE);
    expect(JSON.stringify(state)).not.toMatch(/sprite|no network/i);

    // The next start queues it again, and this time it works.
    sprites.api.provisionScript = ok;
    const retry = await start();
    expect([200, 202]).toContain(retry.status);
    await until(async () => expect((await row()).status).toBe('running'));
    expect(jobs).toHaveLength(2);
    expect((await row()).spec).not.toHaveProperty('error');
  });

  it('a run gets COMPUTER_STARTING instead of waiting minutes', async () => {
    await t.db
      .update(schema.computers)
      .set({ status: 'starting' })
      .where(eq(schema.computers.ownerId, ownerId));
    const computer = await row();
    const services = computerServices(t.deps, {
      bot: { id: crypto.randomUUID(), ownerId, workspaceId: computer.workspaceId },
      runId: crypto.randomUUID(),
      recordStep: async () => {},
    });
    await expect(t.inOrganization(() => services.agent())).rejects.toMatchObject({
      code: 'COMPUTER_STARTING',
    });
  });

  it('starts again after a restart cut a provisioning short', async () => {
    // The row is `starting` with its job lost (an in-process queue, a crash).
    expect((await row()).status).toBe('starting');
    expect(await inEveryOrganization(t.deps, () => recoverProvisioning(t.deps))).toBe(1);
    await until(async () => expect((await row()).status).toBe('running'));
    // Nothing to recover once it runs.
    expect(await inEveryOrganization(t.deps, () => recoverProvisioning(t.deps))).toBe(0);
  });

  it('starts again after a restart cut a stop short', async () => {
    // A stop (a restart, a reset) died between `stopping` and `stopped`. A
    // start only waits on `stopping`, and the idle sweep skips Sprites.
    await t.db
      .update(schema.computers)
      .set({ status: 'stopping' })
      .where(eq(schema.computers.ownerId, ownerId));
    expect((await start()).status).toBe(202);
    expect(await inEveryOrganization(t.deps, () => recoverProvisioning(t.deps))).toBe(1);
    await until(async () => expect((await row()).status).toBe('running'));
    expect((await start()).status).toBe(200);
  });

  describe('when queueing the job goes wrong', () => {
    const queue = () => t.deps.infra.queue<ProvisionJob>(COMPUTERS_QUEUE);
    const stopped = () =>
      t.db
        .update(schema.computers)
        .set({ status: 'stopped' })
        .where(eq(schema.computers.ownerId, ownerId));
    /** How many times a job really provisioned: each one starts the machine once. */
    const provisions = () => vi.spyOn(computerProvider(t.deps)!, 'start');

    afterEach(() => vi.restoreAllMocks());

    it('gives the row back when the queue refuses, so the next start queues again', async () => {
      await stopped();
      const starts = provisions();
      const enqueue = vi.spyOn(queue(), 'enqueue').mockRejectedValueOnce(new Error('queue down'));

      const refused = await start();
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
      // Not left `starting` for a job that was never queued.
      expect(await row()).toMatchObject({ status: 'stopped' });
      expect((await row()).spec).not.toHaveProperty('provision');

      // The queue is back: the same click now queues the job, once.
      expect([200, 202]).toContain((await start()).status);
      await until(async () => expect((await row()).status).toBe('running'));
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(starts).toHaveBeenCalledTimes(1);
      expect((await row()).spec).not.toHaveProperty('provision');
    });

    it('provisions once when the queue took the job but its answer was lost', async () => {
      await stopped();
      const starts = provisions();
      const real = queue().enqueue.bind(queue());
      // The job is queued, then the caller is told it was not.
      vi.spyOn(queue(), 'enqueue').mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new Error('connection reset');
      });

      expect((await start()).status).toBe(503);
      expect([200, 202]).toContain((await start()).status);
      await until(async () => expect((await row()).status).toBe('running'));
      // Whichever of the two jobs got to the row first, one provisioned it.
      expect(starts).toHaveBeenCalledTimes(1);
      expect((await row()).spec).not.toHaveProperty('provision');
    });

    it("a job that is not the row's attempt does nothing", async () => {
      const attempt = crypto.randomUUID();
      await t.db
        .update(schema.computers)
        .set({ status: 'starting', spec: { provision: { attempt, at: new Date().toISOString() } } })
        .where(eq(schema.computers.ownerId, ownerId));
      const computer = await row();
      const starts = provisions();
      const job = (attempt: string) =>
        inEveryOrganization(t.deps, async () => {
          await provisionComputer(t.deps, {
            computerId: computer.id,
            workspaceId: computer.workspaceId,
            by: { type: 'user', id: ownerId },
            attempt,
          });
          return 1;
        });

      // The job a refused enqueue left behind, or one a retry replaced.
      await job(crypto.randomUUID());
      expect(starts).not.toHaveBeenCalled();
      expect((await row()).status).toBe('starting');

      await job(attempt);
      expect(starts).toHaveBeenCalledTimes(1);
      expect((await row()).status).toBe('running');
    });

    it('queues again for a row whose job was lost long ago, and not for one still waiting', async () => {
      const waiting = (at: Date) =>
        t.db
          .update(schema.computers)
          .set({
            status: 'starting',
            spec: { provision: { attempt: crypto.randomUUID(), at: at.toISOString() } },
          })
          .where(eq(schema.computers.ownerId, ownerId));
      const enqueue = vi.spyOn(queue(), 'enqueue');

      // Queued a moment ago: the start waits on that job and queues nothing.
      await waiting(new Date());
      expect((await start()).status).toBe(202);
      expect(enqueue).not.toHaveBeenCalled();
      expect((await row()).status).toBe('starting');

      // Queued longer ago than any provisioning takes: its job is gone.
      const starts = provisions();
      await waiting(new Date(Date.now() - provisionTimings.staleMs - 1));
      expect([200, 202]).toContain((await start()).status);
      await until(async () => expect((await row()).status).toBe('running'));
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(starts).toHaveBeenCalledTimes(1);
    });
  });
});
