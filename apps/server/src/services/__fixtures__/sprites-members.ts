import type { ComputerProvider } from '@openbots/computer';
import { and, eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { runComputers } from '../../cli/computers.js';
import type { CliContext } from '../../cli/context.js';
import { schema } from '../../db/client.js';
import { createTestApp, type TestApp } from '../../test-app.js';
import { useTestSprites, type TestSprites } from '../../test-computer.js';
import { inEveryOrganization } from '../../workers.js';
import { computerProvider, provisionTimings, type ComputerRow } from '../computer.js';
import { runRetiredComputerJob, sweepRetiredComputers } from '../computer-retire.js';
import { runRescueJob } from '../repos-rescue.js';

// Members with a started computer on the sprites provider (a fake Sprites
// API, packages/computer testing.ts), for the tests of a reset, a stop and
// the deletion of a full reset's old machine. Every member shares one
// organization; `isolate` keeps a sweep's count to one member's records.

export const until = <T>(fn: () => Promise<T> | T) =>
  vi.waitFor(fn, { timeout: 5_000, interval: 10 });

/** A call held until the test lets it go, or fails it. */
export function held() {
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

/** Holds the provider's `op` once (its first call), letting later calls through. */
export function holdOnce<K extends 'create' | 'destroy' | 'start' | 'status' | 'stop'>(
  provider: ComputerProvider,
  op: K,
) {
  const real = provider[op] as (...args: unknown[]) => Promise<unknown>;
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

export interface SpritesWorld {
  t: TestApp;
  sprites: TestSprites;
  workspaceId: string;
  member(email: string): Promise<Member>;
  machines(): ComputerProvider;
  /** The member's records of old machines, oldest first. */
  retiredOf(ownerId: string): Promise<(typeof schema.retiredComputers.$inferSelect)[]>;
  /** Every worker's sweep, at `now` (the database's clock without one). */
  sweep(now?: Date): Promise<number>;
  /** The deletion job of one record, as the queue runs it, at `now`. */
  job(retiredId: string, now?: Date, deps?: TestApp['deps']): Promise<void>;
  /** Leaves only this member's records due, so a sweep's count is theirs. */
  isolate(ownerId: string): Promise<unknown>;
  audits(action: string, retiredId?: string): Promise<(typeof schema.auditLog.$inferSelect)[]>;
  /** `openbots computers ...` in the organization; returns the exit code and lines. */
  cli(args: string[], org?: string): Promise<{ code: number; out: string }>;
  close(): Promise<void>;
}

export interface Member {
  ownerId: string;
  cookie: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    auth?: Record<string, string>,
  ): Response | Promise<Response>;
  row(): Promise<ComputerRow>;
  start(): Promise<ComputerRow>;
  /** A start that answers at once while the computer is busy, as the apps see it. */
  tryStart(): Promise<number>;
  /** A prepared reset whose rescue is done; confirm it with `confirm`. */
  prepare(): Promise<string>;
  confirm(
    requestId: string,
    body: object,
    auth?: Record<string, string>,
  ): Response | Promise<Response>;
  /** What the member has on the computer: a coding agent signed in, a checkout ready. */
  signedIn(): Promise<void>;
  /** That sign-in and checkout as they now are. */
  kept(): Promise<{ authKind?: string; checkout?: string }>;
}

export async function spritesWorld(): Promise<SpritesWorld> {
  const t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
  const sprites = await useTestSprites(t.ownerDeps);
  const workspaceId = await t.defaultOrganization();

  async function member(email: string): Promise<Member> {
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
    const tryStart = async () => {
      const wait = provisionTimings.waitMs;
      provisionTimings.waitMs = 0;
      try {
        return (await call('POST', '/computer/start')).status;
      } finally {
        provisionTimings.waitMs = wait;
      }
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
    const confirm = (requestId: string, body: object, auth?: Record<string, string>) =>
      call('POST', '/computer/reset', { requestId, confirm: true, ...body }, auth);
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
    await start();
    return { ownerId, cookie, call, row, start, tryStart, prepare, confirm, signedIn, kept };
  }

  const machines = () => computerProvider(t.ownerDeps)!;
  return {
    t,
    sprites,
    workspaceId,
    member,
    machines,
    retiredOf: (ownerId) =>
      t.db
        .select()
        .from(schema.retiredComputers)
        .where(eq(schema.retiredComputers.ownerId, ownerId))
        .orderBy(schema.retiredComputers.retiredAt),
    sweep: (now) => inEveryOrganization(t.deps, () => sweepRetiredComputers(t.deps, now)),
    job: (retiredId, now, deps = t.deps) =>
      t.inOrganization(() => runRetiredComputerJob(deps, machines(), { retiredId }, now)),
    isolate: (ownerId) =>
      t.db
        .update(schema.retiredComputers)
        .set({ status: 'deleted' })
        .where(sql`owner_id <> ${ownerId} and status = 'deleting'`),
    audits: (action, retiredId) =>
      t.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, action),
            retiredId ? sql`${schema.auditLog.metadata} ->> 'retiredId' = ${retiredId}` : undefined,
          ),
        ),
    async cli(args, org = workspaceId) {
      const lines: string[] = [];
      const ctx: CliContext = {
        config: t.deps.config,
        db: t.deps.db,
        infra: t.deps.infra,
        write: (line) => lines.push(line),
      };
      const code = await runComputers([...args, '--org', org], ctx);
      return { code, out: lines.join('\n') };
    },
    async close() {
      await sprites.close();
      await t.close();
    },
  };
}
