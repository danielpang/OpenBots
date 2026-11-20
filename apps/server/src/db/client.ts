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
 */
export type SessionLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** Connections a process holds advisory locks on: one per lock held or waited for. */
const LOCK_CONNECTIONS = 8;

export function createDb(url: string, options: postgres.Options<Record<string, never>> = {}) {
  const client = postgres(url, { onnotice: () => {}, ...options });
  const db = drizzle(client, { schema });
  // Advisory locks are held on connections of their own, never the pool's
  // that queries run on: a holder's queries never wait for a connection
  // a waiter holds, and the lock is taken outside any transaction, so it
  // never waits on a row lock. A process that dies drops its connections,
  // and with them its locks.
  let locks: postgres.Sql | undefined;
  const withSessionLock: SessionLock = async (key, fn) => {
    locks ??= postgres(url, { onnotice: () => {}, ...options, max: LOCK_CONNECTIONS });
    const held = await locks.reserve();
    try {
      await held`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      try {
        return await fn();
      } finally {
        await held`select pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() =>
          held`select pg_advisory_unlock_all()`.catch(() => undefined),
        );
      }
    } finally {
      held.release();
    }
  };
  return Object.assign(db, {
    close: async () => {
      await client.end();
      await locks?.end();
    },
    withSessionLock,
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
