import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema } from '../db/client.js';
import { rowsOf } from '../db/scope.js';
import { coderWorld, defaultGit, gitArgs, type CoderWorld } from './__fixtures__/coders/setup.js';
import { computerProvider } from './computer.js';
import { reconcileComputer } from './repos-refresh.js';

// One checkout operation at a time across processes (repos-checkout.ts
// `withCheckoutLock`): a computer start's reconcile job and a coding
// session's checkout, in two processes, never run git on the same path at
// once. Two processes here are two module graphs (each with the memory a
// process has of its own) over one database: only real Postgres locks
// across them, so this runs where DATABASE_URL names one.

describe.runIf(process.env.DATABASE_URL)('checkout lock across processes', () => {
  let w: CoderWorld;
  let computerId: string;

  beforeAll(async () => {
    w = await coderWorld('checkout-lock@example.com');
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    expect(
      (
        await w.call('POST', '/connectors', {
          catalogId: 'github_builtin',
          secrets: { GITHUB_TOKEN: 'ghp-clone-token' },
        })
      ).status,
    ).toBe(201);
  });
  afterAll(() => w.close());

  it("a start's reconcile and a session's checkout in two processes clone once, and both see it ready", async () => {
    await w.t.db.delete(schema.repoCheckouts);
    await w.t.db
      .update(schema.repos)
      .set({ keepCloned: true })
      .where(eq(schema.repos.id, w.repoId));
    // The second process: its own modules, so its own memory, on the same database and computer.
    const provider = computerProvider(w.t.ownerDeps);
    vi.resetModules();
    const otherComputer = await import('./computer.js');
    otherComputer.setComputerProvider(w.t.ownerDeps, provider);
    const other = await import('./repos-checkout.js');
    // And its own connections to the database, as another process has: each
    // process queues its own operations on a key in front of the database
    // (db/client.ts), so only another pool's lock waits in Postgres.
    const [{ name }] = rowsOf<{ name: string }>(
      await w.t.db.execute(sql`select current_database() as name`),
    ) as [{ name: string }];
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const pool = createDb(url.toString());
    const otherDeps = {
      ...w.t.deps,
      db: Object.assign(Object.create(w.t.deps.db) as typeof w.t.deps.db, {
        withSessionLock: pool.withSessionLock,
      }),
    };
    // The disk: the path is empty until a clone finishes; a second clone there fails.
    let cloned = false;
    w.coder.git = (args) => {
      if (args.includes('--show-toplevel')) {
        return cloned
          ? { code: 0, stdout: `${args[args.indexOf('-C') + 1]}\n` }
          : { code: 128, stderr: 'fatal: not a git repository' };
      }
      if (args[0] === 'clone') {
        if (cloned) return { code: 128, stderr: 'fatal: destination path already exists' };
        cloned = true;
        return { code: 0 };
      }
      return defaultGit(args);
    };
    // The first clone is held until the test lets it go.
    const coder = w.coder.coder;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    let held = false;
    w.coder.coder = async (launch, handlers) => {
      if (!held && launch.command === 'git' && gitArgs(launch.args)[0] === 'clone') {
        held = true;
        entered();
        await gate;
      }
      return coder(launch, handlers);
    };
    try {
      const reconcile = w.t.inOrganization(() => reconcileComputer(w.t.deps, computerId));
      await inside;
      // The session's checkout, in the other process, while the clone runs.
      const session = w.t.inOrganization(() =>
        other.ensureCheckout(otherDeps, w.repoId, computerId, 'update'),
      );
      // It waits on the lock, which the reconcile holds in Postgres (or, with
      // no lock across processes, it clones meanwhile and finishes first).
      const waiting = vi.waitFor(
        async () => {
          const rows = rowsOf<{ n: number }>(
            await w.t.db.execute(
              sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
            ),
          );
          expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5_000, interval: 10 },
      );
      await Promise.race([waiting, session.catch(() => undefined)]);
      go();
      const [result, checkout] = await Promise.all([reconcile, session]);
      expect(result).toMatchObject({ cloned: ['acme/relay'], failed: [] });
      expect(checkout.state).not.toBe('error');
    } finally {
      w.coder.coder = coder;
      w.coder.git = defaultGit;
      go();
      await pool.close();
    }
    const clones = w.coder.gitCalls().filter((args) => args[0] === 'clone');
    expect(clones).toHaveLength(1);
    const [row] = await w.t.db
      .select()
      .from(schema.repoCheckouts)
      .where(eq(schema.repoCheckouts.repoId, w.repoId));
    expect(row).toMatchObject({ state: expect.stringMatching(/^(ready|behind|dirty)$/) });
  });
});
