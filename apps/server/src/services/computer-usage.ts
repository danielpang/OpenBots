import type { ComputerProviderName } from '@openbots/shared';
import { and, asc, eq, gt, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import type { ComputerUsageEvent } from '../extensions.js';

// The awake-time ledger (plan 9.5): `computer_usage_intervals`, one row per
// stretch of use of a member's computer that a server process saw, for usage
// billing later. services/computer-use.ts opens a row when the computer's
// first use in the process begins and closes it when its last use ends (plus
// the pause tail on a Sprite); a row still open is heartbeated every minute,
// so one that a crashed process left open is closed at its last heartbeat by
// the next sweep or start-up. Each close calls the managed build's
// `onComputerUsage` once. Recorded for every provider, so it is the same on
// Docker as on Sprites.

/**
 * How long a Sprite stays awake, and billing, after its last activity before
 * it pauses itself (the Sprites docs say about 30 seconds; not configurable).
 * Added to the end of a use on a provider that pauses itself.
 */
export const SPRITE_PAUSE_TAIL_MS = 30_000;
/** How often an open interval is heartbeated while its computer is in use. */
export const USAGE_HEARTBEAT_MS = 60_000;
/** An open interval not heartbeated for this long was left by a process that died. */
export const USAGE_DANGLING_MS = 3 * USAGE_HEARTBEAT_MS;

type Deps = Pick<AppDeps, 'db' | 'logger' | 'extensions' | 'config' | 'infra'>;

/** Whose computer an interval is for. */
export interface UsageTarget {
  workspaceId: string;
  ownerId: string;
  computerId: string;
  provider: ComputerProviderName;
}

export async function openUsageInterval(
  deps: Pick<AppDeps, 'db'>,
  target: UsageTarget,
  reason: string,
  at = new Date(),
): Promise<string> {
  const [row] = await deps.db
    .insert(schema.computerUsageIntervals)
    .values({ ...target, reason, startedAt: at, seenAt: at })
    .returning({ id: schema.computerUsageIntervals.id });
  return row!.id;
}

/** Marks an open interval alive now. */
export async function heartbeatUsageInterval(
  deps: Pick<AppDeps, 'db'>,
  id: string,
  at = new Date(),
): Promise<void> {
  await deps.db
    .update(schema.computerUsageIntervals)
    .set({ seenAt: at })
    .where(
      and(eq(schema.computerUsageIntervals.id, id), isNull(schema.computerUsageIntervals.endedAt)),
    );
}

/** Seconds of [start, end] that none of `covered` overlaps. */
export function uncoveredSeconds(
  start: Date,
  end: Date,
  covered: { startedAt: Date; endedAt: Date | null }[],
): number {
  let at = start.getTime();
  const stop = end.getTime();
  let free = 0;
  const spans = covered
    .map((c) => [new Date(c.startedAt).getTime(), new Date(c.endedAt ?? c.startedAt).getTime()])
    .filter(([s, e]) => e! > at && s! < stop)
    .sort((a, b) => a[0]! - b[0]!);
  for (const [s, e] of spans) {
    if (s! > at) free += Math.min(s!, stop) - at;
    at = Math.max(at, e!);
    if (at >= stop) break;
  }
  if (at < stop) free += stop - at;
  return Math.round(free / 1000);
}

/**
 * Closes the interval at `endedAt` (never before its start) and calls the
 * `onComputerUsage` extension once; null when it was closed already. The
 * computer's closes take turns, so the seconds two processes' overlapping
 * intervals share are counted by whichever closes first.
 */
export async function closeUsageInterval(
  deps: Deps,
  id: string,
  endedAt: Date,
): Promise<ComputerUsageEvent | null> {
  const event = await deps.db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(schema.computerUsageIntervals)
      .where(
        and(
          eq(schema.computerUsageIntervals.id, id),
          isNull(schema.computerUsageIntervals.endedAt),
        ),
      );
    if (!open) return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`openbots:usage:${open.computerId}`}))`,
    );
    const end = new Date(Math.max(endedAt.getTime(), new Date(open.startedAt).getTime()));
    const others = await tx
      .select({
        startedAt: schema.computerUsageIntervals.startedAt,
        endedAt: schema.computerUsageIntervals.endedAt,
      })
      .from(schema.computerUsageIntervals)
      .where(
        and(
          eq(schema.computerUsageIntervals.computerId, open.computerId),
          ne(schema.computerUsageIntervals.id, open.id),
          isNotNull(schema.computerUsageIntervals.endedAt),
          gt(schema.computerUsageIntervals.endedAt, open.startedAt),
          lt(schema.computerUsageIntervals.startedAt, end),
        ),
      );
    const seconds = uncoveredSeconds(open.startedAt, end, others);
    const [closed] = await tx
      .update(schema.computerUsageIntervals)
      .set({ endedAt: end, seenAt: end, seconds })
      .where(
        and(
          eq(schema.computerUsageIntervals.id, id),
          isNull(schema.computerUsageIntervals.endedAt),
        ),
      )
      .returning();
    if (!closed) return null;
    return {
      intervalId: closed.id,
      workspaceId: closed.workspaceId,
      ownerId: closed.ownerId,
      computerId: closed.computerId,
      provider: closed.provider,
      startedAt: new Date(closed.startedAt),
      endedAt: end,
      seconds,
    } satisfies ComputerUsageEvent;
  });
  if (event) await reportUsage(deps, event);
  return event;
}

async function reportUsage(deps: Deps, event: ComputerUsageEvent) {
  try {
    const { config, db, logger, infra } = deps;
    await deps.extensions?.onComputerUsage?.(event, { config, db, logger, infra });
  } catch (error) {
    deps.logger.warn(
      { err: error, computerId: event.computerId },
      'the computer usage extension failed',
    );
  }
}

/**
 * Closes the intervals of the scope's organization that no process has
 * heartbeated for `USAGE_DANGLING_MS`, at their last heartbeat: a process
 * died, or stopped without closing them. Returns how many.
 */
export async function closeDanglingUsage(deps: Deps, now = new Date()): Promise<number> {
  const dangling = await deps.db
    .select({
      id: schema.computerUsageIntervals.id,
      seenAt: schema.computerUsageIntervals.seenAt,
    })
    .from(schema.computerUsageIntervals)
    .where(
      and(
        isNull(schema.computerUsageIntervals.endedAt),
        lt(schema.computerUsageIntervals.seenAt, new Date(now.getTime() - USAGE_DANGLING_MS)),
      ),
    )
    .orderBy(asc(schema.computerUsageIntervals.startedAt));
  let closed = 0;
  for (const row of dangling) {
    if (await closeUsageInterval(deps, row.id, new Date(row.seenAt))) closed++;
  }
  return closed;
}
