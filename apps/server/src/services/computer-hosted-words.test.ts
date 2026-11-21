import { AgentError, SpritesApiError, type ComputerAgentClient } from '@openbots/computer';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer, useTestSprites, type TestSprites } from '../test-computer.js';
import { listAudit } from './audit.js';
import { agentFor, HOSTED_FAILURE, shownFailure } from './computer.js';
import { refreshStates } from './repos-refresh.js';
import { runRescueJob } from './repos-rescue.js';

// The hosted service does not tell its members which sandbox vendor runs
// their computer (routes/computer.ts reports it as `remote`). With the
// provider failing and the computer's agent unreachable by its host name,
// every computer route, the reset check, a checkout's error, the status
// events and the organization's audit log read in plain words; the real
// failure goes to the server log only.

/** What would name the vendor: its name, its API's own errors, its hosts. */
const VENDOR = /sprite|fly\.io|fly\.dev|flyctl/i;

const apiError = () =>
  new SpritesApiError(
    502,
    'Sprites API: get failed (502) for openbots-0a1b2c: upstream at fly.io did not answer',
  );
const unreachable = () =>
  new AgentError(
    502,
    'The computer is unreachable: getaddrinfo ENOTFOUND openbots-0a1b2c-abc123.sprites.app',
    'CODER_UNREACHABLE',
  );

/** A client for the computer's agent whose every call fails to reach its host. */
function unreachableAgent(): ComputerAgentClient {
  const fail = () => Promise.reject(unreachable());
  return {
    url: 'https://openbots-0a1b2c-abc123.sprites.app',
    health: fail,
    exec: fail,
    readFile: fail,
    openFile: fail,
    writeFile: fail,
    deleteFile: fail,
    list: fail,
    startScreen: fail,
    stopScreen: fail,
    screenshot: fail,
    input: fail,
    browser: fail,
    setWallpaper: fail,
    syncCookies: fail,
    mcpStdio: fail,
    coder: fail,
    socket: (path) => ({ url: `wss://openbots-0a1b2c-abc123.sprites.app${path}`, headers: {} }),
  } as ComputerAgentClient;
}

describe('the hosted provider is never named to members', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let cookie: string;
  let ownerId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    sprites = await useTestSprites(t.ownerDeps);
    cookie = (await t.signUp('vendor@example.com')).cookie!;
    ownerId = await t.userId('vendor@example.com');
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    const res = await call('POST', '/computer/start');
    expect(res.status, await res.clone().text()).toBe(200);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await sprites.close();
    await t.close();
  });

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
  const row = async () =>
    (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;
  const setStatus = (status: string) =>
    t.db.update(schema.computers).set({ status }).where(eq(schema.computers.ownerId, ownerId));

  /** Every provider call fails as the vendor's API says it. */
  const providerDown = () => {
    for (const name of ['status', 'start', 'stop', 'destroy', 'checkpoint'] as const) {
      if (sprites.provider[name]) {
        vi.spyOn(sprites.provider, name).mockRejectedValue(apiError());
      }
    }
  };
  /** The provider answers, but the agent's host cannot be reached. */
  const agentDown = () => vi.spyOn(sprites.provider, 'agent').mockReturnValue(unreachableAgent());
  const logged = () => {
    const warn = vi.spyOn(t.deps.logger, 'warn');
    const error = vi.spyOn(t.deps.logger, 'error');
    return () =>
      [...warn.mock.calls, ...error.mock.calls].some((args) =>
        VENDOR.test(JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? v.message : v))),
      );
  };

  /** A finished rescue's reset check, as the member reads it. */
  const resetCheck = async () => {
    const prepare = await call('POST', '/computer/reset/prepare');
    expect(prepare.status, await prepare.clone().text()).toBe(202);
    const { requestId } = (await prepare.json()) as { requestId: string };
    const computer = await row();
    await t.inOrganization(() =>
      runRescueJob(t.deps, { ownerId, computerId: computer.id, requestId }),
    );
    let text = '';
    await vi.waitFor(
      async () => {
        const res = await call('GET', `/computer/reset/${requestId}`);
        text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ status: 'done' });
      },
      { timeout: 5_000, interval: 10 },
    );
    return { requestId, text };
  };

  const checkout = async () => {
    const computer = await row();
    const [repo] = await t.db
      .insert(schema.repos)
      .values({
        workspaceId: computer.workspaceId,
        ownerId,
        fullName: 'acme/relay',
        remoteUrl: 'https://github.com/acme/relay.git',
        defaultBranch: 'main',
      })
      .returning();
    await t.db.insert(schema.repoCheckouts).values({
      workspaceId: computer.workspaceId,
      repoId: repo!.id,
      computerId: computer.id,
      path: '/home/bot/repos/acme/relay',
      state: 'ready',
    });
    return repo!.id;
  };

  interface Case {
    name: string;
    act(): Promise<string>;
  }

  const cases: Case[] = [
    {
      name: 'POST /computer/start, the provider down',
      async act() {
        await setStatus('stopped');
        providerDown();
        return (await call('POST', '/computer/start')).text();
      },
    },
    {
      name: 'POST /computer/restart, the provider down',
      async act() {
        providerDown();
        return (await call('POST', '/computer/restart')).text();
      },
    },
    {
      name: 'POST /computer/stop, the provider down',
      async act() {
        await setStatus('running');
        providerDown();
        return (await call('POST', '/computer/stop')).text();
      },
    },
    {
      name: 'GET /computer after a failure',
      async act() {
        await t.db
          .update(schema.computers)
          .set({ status: 'error' })
          .where(eq(schema.computers.ownerId, ownerId));
        return (await call('GET', '/computer')).text();
      },
    },
    {
      name: 'POST /computer/wake, the provider down',
      async act() {
        await setStatus('stopped');
        providerDown();
        return (await call('POST', '/computer/wake')).text();
      },
    },
    {
      name: 'GET /computer/files, the agent unreachable',
      async act() {
        await setStatus('running');
        agentDown();
        return (await call('GET', '/computer/files?path=~')).text();
      },
    },
    {
      name: 'GET /computer/files/{path}, the agent unreachable',
      async act() {
        agentDown();
        return (await call('GET', '/computer/files/notes.md')).text();
      },
    },
    {
      name: 'PUT /computer/files/{path}, the agent unreachable',
      async act() {
        agentDown();
        return (await call('PUT', '/computer/files/notes.md', 'hello')).text();
      },
    },
    {
      name: 'the reset check, its rescue unable to start the computer',
      async act() {
        await setStatus('stopped');
        const read = logged();
        providerDown();
        const { text } = await resetCheck();
        expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
        // The real reason is in the server's log.
        expect(read()).toBe(true);
        return text;
      },
    },
    {
      name: "the reset check, its rescue unable to reach a checkout's computer",
      async act() {
        await setStatus('running');
        await checkout();
        agentDown();
        const { text } = await resetCheck();
        const status = JSON.parse(text) as { unsaved: { note: string }[] };
        expect(status.unsaved).toHaveLength(1);
        expect(status.unsaved[0]!.note.toLowerCase()).toBe(
          `Could not reach the computer: ${HOSTED_FAILURE}`.toLowerCase(),
        );
        return text;
      },
    },
    {
      name: "a checkout's error after a refresh that could not reach the computer",
      async act() {
        agentDown();
        const computer = await row();
        await t.inOrganization(() => refreshStates(t.deps, computer.id));
        const rows = await t.db
          .select({ state: schema.repoCheckouts.state, error: schema.repoCheckouts.error })
          .from(schema.repoCheckouts)
          .where(eq(schema.repoCheckouts.computerId, computer.id));
        expect(rows).toEqual([{ state: 'error', error: expect.any(String) }]);
        return JSON.stringify(rows);
      },
    },
    {
      name: "a Bot's computer tool, the agent unreachable",
      async act() {
        agentDown();
        const computer = await row();
        const failed = await agentFor(t.deps, computer)
          .exec({ command: 'ls' })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(failed).toBeInstanceOf(AgentError);
        expect(failed).toMatchObject({ status: 502, code: 'CODER_UNREACHABLE' });
        return (failed as Error).message;
      },
    },
    {
      name: 'POST /computer/reset, the provider down',
      async act() {
        await t.db.delete(schema.repoCheckouts);
        await setStatus('running');
        const { requestId } = await resetCheck();
        providerDown();
        const res = await call('POST', '/computer/reset', { requestId, confirm: true });
        return res.text();
      },
    },
    {
      name: 'POST /computer/reset with the sign-ins, the provider down',
      async act() {
        await setStatus('running');
        const { requestId } = await resetCheck();
        providerDown();
        const res = await call('POST', '/computer/reset', {
          requestId,
          confirm: true,
          resetSignIns: true,
        });
        return res.text();
      },
    },
  ];

  it.each(cases)('$name', async ({ act }) => {
    const text = await act();
    expect(text).not.toMatch(VENDOR);
  });

  it('nor in the status events, the stored computer or checkouts', async () => {
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(VENDOR);
    const computers = await t.db.select().from(schema.computers);
    expect(JSON.stringify(computers.map((c) => c.spec))).not.toMatch(VENDOR);
    expect(JSON.stringify(await t.db.select().from(schema.repoCheckouts))).not.toMatch(VENDOR);
  });

  it("nor in the organization's audit log, rows written before included", async () => {
    const computer = await row();
    await t.db.insert(schema.auditLog).values({
      workspaceId: computer.workspaceId,
      actorType: 'user',
      actorId: ownerId,
      action: 'computer.create',
      targetType: 'computer',
      targetId: computer.id,
      metadata: { provider: 'sprites' },
    });
    const page = await t.inOrganization(() =>
      listAudit(t.db, computer.workspaceId, { limit: 200 }),
    );
    const created = page.items.filter((i) => i.action === 'computer.create');
    expect(created.length).toBeGreaterThan(1);
    for (const entry of created) expect(entry.metadata).toMatchObject({ provider: 'remote' });
    expect(JSON.stringify(page.items)).not.toMatch(VENDOR);
  });
});

describe('a self-hosted computer reads its real failures', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await useTestComputer(t.ownerDeps);
  });
  afterAll(() => t.close());

  it('keeps the text as it is', () => {
    expect(shownFailure(t.deps, apiError())).toBe(apiError().message);
    expect(shownFailure(t.deps, unreachable())).toBe(unreachable().message);
  });
});
