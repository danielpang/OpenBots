import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export { schema };

/**
 * Any Drizzle database or transaction over this schema: postgres.js in
 * production, PGlite in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Runs `fn` holding the Postgres advisory lock named `key`, across every
 * process on the database (`withSessionLock`). Only a database made by
 * `createDb` has one; PGlite, one process with one connection, does not.
 * `fn`'s signal is aborted when the lock's own connection closes while it
 * runs (the lock went with it): `fn` stops what it can.
 */
export type SessionLock = <T>(key: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** Connections a process holds advisory locks on: one per key held or waited for. */
const LOCK_CONNECTIONS = 8;
/**
 * The longest a lock is waited for, in this process and in the database
 * together: then it fails (`SessionLockTimeout`), and the job that wanted it
 * fails cleanly for the queue to retry, instead of holding a connection.
 */
export const SESSION_LOCK_WAIT_MS = 60_000;

/** The lock's connection was lost while its holder ran: the lock is gone. */
export class SessionLockLost extends Error {
  constructor(key: string) {
    super(`The lock ${key} was lost with its database connection`);
    this.name = 'SessionLockLost';
  }
}

/** A session lock not had within its wait. */
export class SessionLockTimeout extends Error {
  constructor(key: string) {
    super(`Another operation held the lock ${key} for too long; try again`);
    this.name = 'SessionLockTimeout';
  }
}

/**
 * Whether a database URL goes through a transaction-mode pooler (Neon's
 * `-pooler` host, PgBouncer's usual port or flag), where a session advisory
 * lock lands on whichever server connection the pooler hands out: its
 * unlock can miss it, and the lock then leaks.
 */
export function looksPooled(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /-pooler(\.|$)/.test(parsed.hostname) ||
      parsed.port === '6543' ||
      parsed.searchParams.get('pgbouncer') === 'true'
    );
  } catch {
    return false;
  }
}

export interface CreateDbOptions {
  /**
   * A direct (not pooled) URL to the same database for session-level
   * features, the advisory locks; `url` by default (DATABASE_DIRECT_URL).
   */
  sessionUrl?: string;
  /** `SESSION_LOCK_WAIT_MS` unless a test sets it. */
  lockWaitMs?: number;
}

/** Rejects with `SessionLockTimeout` once `deadline` passes, unless `promise` settles first. */
function within<T>(promise: Promise<T>, deadline: number, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SessionLockTimeout(key)),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One connection advisory locks are held on: a client of its own with that
 * one connection, so its closing is heard directly (`onclose`), and the
 * holder it was lent to, whose signal that closing aborts.
 */
interface LockSlot {
  sql: postgres.Sql;
  holder: { key: string; lost: AbortController } | null;
}

export function createDb(
  url: string,
  options: postgres.Options<Record<string, never>> = {},
  { sessionUrl = url, lockWaitMs = SESSION_LOCK_WAIT_MS }: CreateDbOptions = {},
) {
  const client = postgres(url, { onnotice: () => {}, ...options });
  const db = drizzle(client, { schema });
  // Advisory locks are held on connections of their own, never the pool's
  // that queries run on: a holder's queries never wait for a connection
  // a waiter holds, and the lock is taken outside any transaction, so it
  // never waits on a row lock. A process that dies drops its connections,
  // and with them its locks.
  //
  // In front of the database, one queue per key in this process: of its
  // operations on one key, one holds a connection (and the lock) and the
  // rest wait here, so a slow holder with many waiters takes one
  // connection, never the pool every other key needs. Every wait is bounded.
  //
  // A held lock is lost only with its connection, and the connection says
  // so itself when it closes: the holder is told then, and only then. Nothing
  // asks the database on the side, so a slow pool never reads as a lost lock.
  const refused = looksPooled(sessionUrl)
    ? 'The database URL goes through a connection pooler, where session locks leak; set DATABASE_DIRECT_URL to a direct connection to the same database'
    : null;
  const slots: LockSlot[] = [];
  const free: LockSlot[] = [];
  const waiting: ((slot: LockSlot) => void)[] = [];
  const makeSlot = (): LockSlot => {
    const slot: LockSlot = {
      holder: null,
      sql: postgres(sessionUrl, {
        onnotice: () => {},
        ...options,
        max: 1,
        // Its one connection closed (a restart, a network cut, terminated):
        // a lock held on it is gone. The next query opens a new one.
        onclose: () => {
          const holder = slot.holder;
          if (holder && !holder.lost.signal.aborted) {
            holder.lost.abort(new SessionLockLost(holder.key));
          }
        },
      }),
    };
    slots.push(slot);
    return slot;
  };
  const takeSlot = (): Promise<LockSlot> => {
    const slot = free.pop() ?? (slots.length < LOCK_CONNECTIONS ? makeSlot() : null);
    return slot ? Promise.resolve(slot) : new Promise((resolve) => waiting.push(resolve));
  };
  const giveBack = (slot: LockSlot) => {
    slot.holder = null;
    const next = waiting.shift();
    if (next) next(slot);
    else free.push(slot);
  };
  const queues = new Map<string, Promise<void>>();
  const withSessionLock: SessionLock = async (key, fn) => {
    if (refused) throw new Error(refused);
    const deadline = Date.now() + lockWaitMs;
    const before = queues.get(key) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    // The next one here waits for this one and every one before it.
    const tail = before.then(() => mine);
    queues.set(key, tail);
    try {
      await within(before, deadline, key);
      const taking = takeSlot();
      const slot = await within(taking, deadline, key).catch((error: unknown) => {
        // Had after all, once nobody waits for it: given straight back.
        void taking.then(giveBack);
        throw error;
      });
      const held = slot.sql;
      const lost = new AbortController();
      slot.holder = { key, lost };
      let healthy = true;
      try {
        const wait = Math.max(1, deadline - Date.now());
        await held`select set_config('lock_timeout', ${`${wait}ms`}, false)`;
        try {
          await held`select pg_advisory_lock(hashtextextended(${key}, 0))`;
        } catch (error) {
          if ((error as { code?: string }).code === '55P03') throw new SessionLockTimeout(key);
          throw error;
        }
        await held`select set_config('lock_timeout', '0', false)`;
        try {
          return await fn(lost.signal);
        } finally {
          // A connection that closed took the lock with it: nothing to
          // unlock, and a query now would only open a new session.
          if (!lost.signal.aborted) {
            // An unlock that did not release the lock (it ran on a session
            // that did not hold it): the connection goes, and the lock with it.
            const [row] = await within(
              held<{ ok: boolean }[]>`
                select pg_advisory_unlock(hashtextextended(${key}, 0)) as ok
              `,
              Date.now() + lockWaitMs,
              key,
            ).catch(() => [{ ok: false }]);
            if (row?.ok !== true) healthy = false;
          }
        }
      } finally {
        // Its holder is done: a close from here on aborts nothing.
        slot.holder = null;
        if (!healthy) {
          await within(
            held`select pg_terminate_backend(pg_backend_pid())`,
            Date.now() + lockWaitMs,
            key,
          ).catch(() => undefined);
        }
        giveBack(slot);
      }
    } finally {
      done();
      if (queues.get(key) === tail) queues.delete(key);
    }
  };
  return Object.assign(db, {
    close: async () => {
      await client.end();
      await Promise.all(slots.map((slot) => slot.sql.end()));
    },
    withSessionLock,
    /** Why the session locks are refused here, or null. */
    sessionLockProblem: refused,
  });
}

/** The database's advisory lock across processes, if it has one (`createDb`'s). */
export function sessionLockOf(db: unknown): SessionLock | undefined {
  return (db as { withSessionLock?: SessionLock } | null)?.withSessionLock;
}

/**
 * Reserves the next `messages.seq` for a chat.
 *
 * `seq` is the realtime contract: per chat, strictly increasing, assigned by
 * the database, and carried on every WS event for resync. It comes from the
 * `chats.chat_seq` counter, bumped with `UPDATE ... RETURNING`. The update
 * row-locks the chat until the transaction ends, so call this inside the same
 * transaction that inserts the message: concurrent writers to one chat then
 * commit in seq order, and a rolled-back insert leaves at most a gap, never a
 * duplicate or an out-of-order commit. Writers to different chats do not block
 * each other.
 */
export async function nextSeq(db: Db, chatId: string): Promise<number> {
  const [row] = await db
    .update(schema.chats)
    .set({ chatSeq: sql`${schema.chats.chatSeq} + 1` })
    .where(eq(schema.chats.id, chatId))
    .returning({ seq: schema.chats.chatSeq });
  if (!row) throw new Error(`nextSeq: chat ${chatId} not found`);
  return row.seq;
}
