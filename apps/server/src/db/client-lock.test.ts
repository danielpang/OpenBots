import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, looksPooled, SessionLockTimeout } from './client.js';

// The session locks (db/client.ts `withSessionLock`, the checkout lock): one
// connection per key in a process, however many wait on it, so a slow holder
// never takes the connections every other key needs; every wait bounded; and
// never on a pooled connection, where a lock can leak.

describe('session lock URLs', () => {
  it('reads a pooler from the URL', () => {
    expect(looksPooled('postgres://u:p@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/db')).toBe(
      true,
    );
    expect(looksPooled('postgres://u:p@db.example.com:6543/db')).toBe(true);
    expect(looksPooled('postgres://u:p@db.example.com/db?pgbouncer=true')).toBe(true);
    expect(looksPooled('postgres://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/db')).toBe(false);
    expect(looksPooled('postgres://openbots:openbots@127.0.0.1:5432/openbots')).toBe(false);
  });

  it('refuses the locks on a pooled URL with no direct one, and says why', async () => {
    const db = createDb('postgres://u:p@ep-x-pooler.example.neon.tech/db');
    expect(db.sessionLockProblem).toMatch(/DATABASE_DIRECT_URL/);
    await expect(db.withSessionLock('k', async () => 1)).rejects.toThrow(/DATABASE_DIRECT_URL/);
    await db.close();
    const direct = createDb(
      'postgres://u:p@ep-x-pooler.example.neon.tech/db',
      {},
      {
        sessionUrl: 'postgres://u:p@ep-x.example.neon.tech/db',
      },
    );
    expect(direct.sessionLockProblem).toBeNull();
    await direct.close();
  });
});

describe.runIf(process.env.DATABASE_URL)('session locks on Postgres', () => {
  const url = process.env.DATABASE_URL!;

  it('a slow holder with more waiters than connections leaves other keys free', async () => {
    const db = createDb(url);
    try {
      const key = `test:lock:${randomUUID()}`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const holder = db.withSessionLock(key, async () => {
        entered();
        await gate;
      });
      await inside;
      // Twelve waiters on the same key: more than the process's lock connections.
      const order: number[] = [];
      const waiters = Array.from({ length: 12 }, (_, i) =>
        db.withSessionLock(key, async () => {
          order.push(i);
        }),
      );
      // A lock on another checkout runs to its end while the first is held.
      let other = false;
      await db.withSessionLock(`test:lock:${randomUUID()}`, async () => {
        other = true;
      });
      expect(other).toBe(true);
      expect(order).toEqual([]);
      release();
      await Promise.all([holder, ...waiters]);
      // One at a time, in the order they asked.
      expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
    } finally {
      await db.close();
    }
  });

  it('a wait past its bound fails cleanly, in the process and across processes', async () => {
    const one = createDb(url, {}, { lockWaitMs: 300 });
    const two = createDb(url, {}, { lockWaitMs: 300 });
    try {
      const key = `test:lock:${randomUUID()}`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const holder = one.withSessionLock(key, async () => {
        entered();
        await gate;
      });
      await inside;
      // Another process: the database's own wait, bounded.
      await expect(two.withSessionLock(key, async () => 1)).rejects.toBeInstanceOf(
        SessionLockTimeout,
      );
      // This process: the queue in front of the database, bounded too.
      await expect(one.withSessionLock(key, async () => 1)).rejects.toBeInstanceOf(
        SessionLockTimeout,
      );
      release();
      await holder;
      // Nothing was left held: both take it now.
      expect(await two.withSessionLock(key, async () => 2)).toBe(2);
      expect(await one.withSessionLock(key, async () => 3)).toBe(3);
    } finally {
      await one.close();
      await two.close();
    }
  });
});
