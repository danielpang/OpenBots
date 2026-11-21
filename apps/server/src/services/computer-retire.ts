import { randomUUID } from 'node:crypto';
import { type ComputerProvider, type ComputerRef } from '@openbots/computer';
import { wsEvent, type JobHandler } from '@openbots/shared';
import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { bestEffort } from './best-effort.js';
import { fenceComputer, fenceOf } from './computer-fence.js';
import { RETIRED_LEASE_MS, RETIRED_RECHECK_MS } from './computer-timing.js';

// The old machine of a full reset, until it is deleted (plan 9.5; the
// owner's decision: a full reset deletes the old machine, and nothing keeps
// or restores it).
//
// Where the provider names a machine by the computer's key
// (`ComputerProvider.machineKeyed`, Sprites), a full reset does not wait for
// the deletion. One transaction takes the machine off the member's computer
// (a new `machine_key`, no agent, `stopped`), records it here (`deleting`,
// with the fence of its old agent token), runs the reset's cleanup and
// writes its audit. From that commit the member can start a new machine, and
// every process refuses the old token (computer-fence.ts), whatever it
// missed on the bus. Then the reset deletes the old machine (`destroy`, home
// and state). A deletion that fails, or a process that dies first, leaves
// the record to the retired-computers job; a machine is never left running
// and forgotten.
//
// The job: `sweepRetiredComputers` runs in every worker, at start and every
// `RETIRED_SWEEP_MS`, in each organization. It claims what is due (one
// UPDATE moves `next_attempt_at` on by a lease, so of several workers one
// takes a row) and queues a job on `RETIRED_COMPUTERS_QUEUE`, which deletes
// the machine. A machine already gone counts as deleted, and two deletions
// at once do no harm. A failure is retried with backoff
// (`retiredRetryDelayMs`) up to `RETIRED_MAX_ATTEMPTS`; then the row records
// that the job gave up (`gave_up_at`, an error in the log) and waits for an
// operator (`openbots computers retired --gave-up`, `openbots computers
// retry`). A machine the member's computer names again is never deleted.
//
// A record reads `deleted` only once a deletion succeeded at least
// `RETIRED_RECHECK_MS` after the reset: a provisioning the reset cancelled,
// cut off from the database, can still make the old machine again until
// then. An earlier success leaves the record due again at that time, and
// the deletion then finds the machine gone, or deletes what came back.

export const RETIRED_COMPUTERS_QUEUE = 'retired-computers';
/** How often each worker looks for old machines to delete. */
export const RETIRED_SWEEP_MS = 5 * 60_000;
// The claim's time bound, and when a deletion is final (computer-timing.ts).
export { RETIRED_LEASE_MS, RETIRED_RECHECK_MS };
/** The longest wait between two attempts. */
export const RETIRED_RETRY_MAX_MS = 6 * 60 * 60_000;
/** Attempts before the job gives up and leaves the row to an operator. */
export const RETIRED_MAX_ATTEMPTS = 12;

/** The wait after a deletion's `attempts`th failure. */
export function retiredRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), RETIRED_RETRY_MAX_MS);
}

export type RetiredRow = typeof schema.retiredComputers.$inferSelect;
type ComputerRow = typeof schema.computers.$inferSelect;
/** The bus is all a reset needs; the worker's queue runs the job. */
type Deps = Pick<AppDeps, 'db' | 'logger'> & { infra: Pick<AppDeps['infra'], 'bus'> };
type SweepDeps = Pick<AppDeps, 'db' | 'logger' | 'infra'>;

/** The member's computer is being made, started or stopped (409). */
export const computerBusy = (status: string) =>
  new DomainError(409, 'COMPUTER_BUSY', `The computer is ${status}; try again once it settles`);

/** The member's computer changed while this ran (409). */
export const computerChanged = () =>
  new DomainError(409, 'COMPUTER_CHANGED', 'The computer changed meanwhile; try again');

/** Enough of a ref for the provider to delete a machine by name: no agent token is needed. */
function machineRef(row: RetiredRow): ComputerRef {
  return {
    provider: row.provider,
    containerId: row.providerRef,
    agentUrl: '',
    agentToken: '',
    volumeName: null,
  };
}

/** Plain text of a failure for the row, clipped. Provider errors carry no secret. */
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/**
 * When a claim's lease ends, on the database's clock: the sweep reads it on
 * that clock too (`clockAt`), so two processes whose own clocks differ never
 * cut a lease short. A caller that names the time (a test, a sweep run for a
 * given moment) gets it from that time instead.
 */
const leaseEnd = (ms: number, at?: Date): Date | SQL =>
  at ? new Date(at.getTime() + ms) : sql`clock_timestamp() + ${ms} * interval '1 millisecond'`;

/** The moment a claim is compared with: the database's, or the caller's. */
const clockAt = (at?: Date) =>
  at ? sql`${at.toISOString()}::timestamptz` : sql`clock_timestamp()`;

/** A job on `RETIRED_COMPUTERS_QUEUE`. */
export interface RetiredComputerJob {
  retiredId: string;
  workspaceId: string;
}

/** What a member's reset recorded, for its audit row and its cleanup (computer-reset.ts). */
export interface ResetRecord {
  requestId: string;
  signIns: boolean;
  unsaved: number;
  rescueFailed: boolean;
  /** The checkpoint taken before a reset that keeps the machine (Sprites). */
  checkpoint?: string | null;
  /** How many checkouts it marked `missing`; set by its cleanup. */
  checkouts?: number;
}

/**
 * A reset's cleanup: every checkout of the computer becomes `missing`, the
 * member's sessions lose their worktrees, and, with the sign-ins, the coding
 * agents' sign-ins are forgotten. Returns how many checkouts it marked.
 */
export async function cleanupAfterReset(
  tx: Db,
  computer: { id: string | null; workspaceId: string; ownerId: string },
  signIns: boolean,
): Promise<number> {
  const checkouts = computer.id
    ? await tx
        .update(schema.repoCheckouts)
        .set({ state: 'missing', error: null, updatedAt: new Date() })
        .where(eq(schema.repoCheckouts.computerId, computer.id))
        .returning({ id: schema.repoCheckouts.id })
    : [];
  await tx
    .update(schema.codingSessions)
    .set({ worktreePath: null })
    .where(
      and(
        eq(schema.codingSessions.ownerId, computer.ownerId),
        eq(schema.codingSessions.workspaceId, computer.workspaceId),
      ),
    );
  if (signIns) {
    // Sign-ins the CLIs held on the state volume are gone; a Settings > Models key is not.
    await tx
      .update(schema.coderAccounts)
      .set({
        authKind: 'none',
        accountLabel: null,
        signedInAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.coderAccounts.ownerId, computer.ownerId),
          eq(schema.coderAccounts.workspaceId, computer.workspaceId),
          isNull(schema.coderAccounts.providerId),
        ),
      );
  }
  return checkouts.length;
}

/** A reset's audit row (`computer.reset`). */
export async function auditReset(
  tx: Db,
  computer: { id: string; workspaceId: string },
  by: AuditActor,
  reset: ResetRecord,
): Promise<void> {
  await recordAudit(tx, {
    workspaceId: computer.workspaceId,
    actor: by,
    action: 'computer.reset',
    targetType: 'computer',
    targetId: computer.id,
    metadata: {
      requestId: reset.requestId,
      signIns: reset.signIns,
      checkouts: reset.checkouts ?? 0,
      unsaved: reset.unsaved,
      rescueFailed: reset.rescueFailed,
      // The disk as it was before a reset that kept the machine (Sprites).
      ...(reset.checkpoint ? { checkpoint: reset.checkpoint } : {}),
    },
  });
}

export interface RetireOptions {
  by: AuditActor;
  /** The member's reset: its cleanup and audit go in the transaction that takes the machine. */
  reset?: ResetRecord;
  /** The time the record is made at; a test names its own. */
  now?: Date;
}

/**
 * A full reset's end on a provider that names machines by key: `row` is the
 * computer as the reset claimed it (`stopping`, its generation). One
 * transaction gives the computer a new machine key with no machine and no
 * agent, `stopped`, records the old machine for deletion with the fence of
 * its agent token, and runs the reset's cleanup and audit. Then every
 * process is told the fence, the member's apps the status, and the old
 * machine is deleted here once; what fails is left to the job. 409
 * `COMPUTER_CHANGED` when the reset no longer holds the computer (nothing
 * changed then).
 */
export async function retireMachine(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  { by, reset, now: at }: RetireOptions,
): Promise<{ computer: ComputerRow; retired: RetiredRow }> {
  if (!row.containerId) throw new Error('The computer has no machine to delete');
  const now = at ?? new Date();
  const switched = await deps.db.transaction(async (tx) => {
    const [computer] = await tx
      .update(schema.computers)
      .set({
        containerId: null,
        agentUrl: null,
        agentToken: null,
        machineKey: randomUUID(),
        status: 'stopped',
        generation: sql`${schema.computers.generation} + 1`,
        spec: sql`${schema.computers.spec} - 'provision'`,
      })
      .where(
        and(
          eq(schema.computers.id, row.id),
          eq(schema.computers.containerId, row.containerId!),
          eq(schema.computers.status, 'stopping'),
          eq(schema.computers.generation, row.generation),
        ),
      )
      .returning();
    if (!computer) throw computerChanged();
    const [retired] = await tx
      .insert(schema.retiredComputers)
      .values({
        workspaceId: row.workspaceId,
        ownerId: row.ownerId,
        computerId: row.id,
        provider: row.provider,
        providerRef: row.containerId!,
        status: 'deleting',
        retiredAt: now,
        // Held by this reset while it deletes; the sweep takes it after.
        nextAttemptAt: leaseEnd(RETIRED_LEASE_MS, at),
        fence: fenceOf(row.agentToken),
      })
      .returning();
    if (reset) {
      const checkouts = await cleanupAfterReset(tx as unknown as Db, row, reset.signIns);
      await auditReset(tx as unknown as Db, row, by, { ...reset, checkouts });
    }
    return { computer: computer, retired: retired! };
  });
  await fenceComputer(deps, {
    id: row.id,
    fence: switched.retired.fence,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
  });
  await bestEffort(
    publishEvent(
      deps.infra.bus,
      wsEvent(
        'computer.status',
        { computerId: row.id, status: 'stopped', error: null },
        { user_id: row.ownerId, workspace_id: row.workspaceId },
      ),
    ),
    (failure) =>
      deps.logger.warn({ err: failure, computerId: row.id }, 'publishing a status failed'),
  );
  // The reset is done: a deletion that fails is the job's from here.
  const retired = await deleteRetired(deps, machines, switched.retired, at).catch(
    (error: unknown) => {
      deps.logger.error(
        { err: error, retiredId: switched.retired.id },
        'deleting the old computer failed; the job retries it',
      );
      return switched.retired;
    },
  );
  return { computer: switched.computer, retired };
}

/** The row while the job still has to delete it: not deleted, and not given up. */
const pending = (id: string) =>
  and(
    eq(schema.retiredComputers.id, id),
    eq(schema.retiredComputers.status, 'deleting'),
    isNull(schema.retiredComputers.gaveUpAt),
  );

/** Whether the member's computer names this machine again: then it is not deleted. */
async function isCurrent(db: Db, row: RetiredRow): Promise<boolean> {
  const [current] = await db
    .select({ id: schema.computers.id })
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.workspaceId, row.workspaceId),
        eq(schema.computers.provider, row.provider),
        eq(schema.computers.containerId, row.providerRef),
      ),
    );
  return current !== undefined;
}

/** Records a failed attempt: retried with backoff, or given up after `RETIRED_MAX_ATTEMPTS`. */
async function failed(deps: Deps, row: RetiredRow, error: unknown, now: Date) {
  const attempts = row.attempts + 1;
  const giveUp = attempts >= RETIRED_MAX_ATTEMPTS;
  const [updated] = await deps.db
    .update(schema.retiredComputers)
    .set({
      attempts,
      lastAttemptAt: now,
      lastError: errorText(error),
      ...(giveUp
        ? { gaveUpAt: now, nextAttemptAt: null }
        : { nextAttemptAt: new Date(now.getTime() + retiredRetryDelayMs(attempts)) }),
    })
    .where(pending(row.id))
    .returning();
  if (giveUp) {
    deps.logger.error(
      { err: error, retiredId: row.id, attempts },
      'gave up deleting an old computer; an operator must retry it',
    );
  } else {
    deps.logger.warn(
      { err: error, retiredId: row.id, attempts },
      'deleting an old computer failed',
    );
  }
  return updated ?? row;
}

/**
 * One attempt at deleting the machine of `row`: the provider's `destroy`,
 * home and state. A success before `RETIRED_RECHECK_MS` leaves the record
 * due again then; one after it marks the record `deleted` and audits it,
 * once. A failure counts toward giving up (`failed`). Returns the row as it
 * now is.
 */
async function deleteRetired(
  deps: Deps,
  machines: ComputerProvider | null,
  row: RetiredRow,
  at?: Date,
): Promise<RetiredRow> {
  const now = at ?? new Date();
  try {
    if (!machines || machines.name !== row.provider) {
      throw new Error(`This install has no ${row.provider} provider to delete it`);
    }
    if (await isCurrent(deps.db, row)) {
      throw new Error("It is a member's current computer, so it was not deleted");
    }
    // Deleting a machine already gone is not an error (the provider's destroy).
    await machines.destroy(machineRef(row), {
      computerId: row.computerId ?? row.id,
      home: true,
      state: true,
    });
  } catch (error) {
    return failed(deps, row, error, now);
  }
  const final = row.retiredAt.getTime() + RETIRED_RECHECK_MS;
  if (now.getTime() < final) {
    const [again] = await deps.db
      .update(schema.retiredComputers)
      .set({ nextAttemptAt: new Date(final), lastAttemptAt: now, lastError: null })
      .where(pending(row.id))
      .returning();
    return again ?? row;
  }
  return deps.db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(schema.retiredComputers)
      .set({
        status: 'deleted',
        deletedAt: now,
        lastAttemptAt: now,
        lastError: null,
        nextAttemptAt: null,
      })
      .where(
        and(eq(schema.retiredComputers.id, row.id), eq(schema.retiredComputers.status, 'deleting')),
      )
      .returning();
    // Another run finished first: one audit row.
    if (!deleted) return row;
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor: SYSTEM_ACTOR,
      action: 'computer.retired_delete',
      targetType: 'computer',
      targetId: row.computerId ?? row.id,
      metadata: { retiredId: row.id, retiredAt: row.retiredAt.toISOString() },
    });
    return deleted;
  });
}

/**
 * Claims the rows due in the current organization (`deleting`, not given
 * up, `next_attempt_at` reached) and queues a job for each. Returns how many
 * it queued. The claim is one UPDATE that moves `next_attempt_at` on by
 * `RETIRED_LEASE_MS`, so of several workers sweeping at once one takes a
 * row, and a job lost with its worker is claimed again once that runs out.
 */
export async function sweepRetiredComputers(deps: SweepDeps, at?: Date): Promise<number> {
  const due = await deps.db
    .update(schema.retiredComputers)
    .set({ nextAttemptAt: leaseEnd(RETIRED_LEASE_MS, at) })
    .where(
      and(
        eq(schema.retiredComputers.status, 'deleting'),
        isNull(schema.retiredComputers.gaveUpAt),
        or(
          isNull(schema.retiredComputers.nextAttemptAt),
          sql`${schema.retiredComputers.nextAttemptAt} <= ${clockAt(at)}`,
        ),
      ),
    )
    .returning();
  const queue = deps.infra.queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE);
  let queued = 0;
  for (const row of due) {
    try {
      await queue.enqueue(
        'delete',
        { retiredId: row.id, workspaceId: row.workspaceId },
        { groupKey: row.id },
      );
      queued++;
    } catch (error) {
      // The lease runs out and a later sweep queues it again.
      deps.logger.error({ err: error, retiredId: row.id }, 'queueing an old computer failed');
    }
  }
  return queued;
}

/**
 * The job: one attempt at deleting the row's machine, for a row still to be
 * deleted. Where the install has not the row's provider, the attempt fails
 * and counts toward giving up.
 */
export async function runRetiredComputerJob(
  deps: Deps,
  machines: ComputerProvider | null,
  job: Pick<RetiredComputerJob, 'retiredId'>,
  at?: Date,
): Promise<void> {
  const [row] = await deps.db.select().from(schema.retiredComputers).where(pending(job.retiredId));
  if (!row) return;
  await deleteRetired(deps, machines, row, at);
}

/** The queue's handler; `machines` is the install's provider, looked up per job. */
export function retiredComputerHandler(
  deps: Deps,
  machines: () => ComputerProvider | null,
): JobHandler<RetiredComputerJob> {
  return (job) => runRetiredComputerJob(deps, machines(), job.data);
}

/**
 * The old machines of an organization not yet deleted, oldest first (the
 * operator's list); with `gaveUp`, only those the job gave up on.
 */
export async function listRetiredComputers(
  db: Db,
  scope: { workspaceId: string; gaveUp?: boolean },
): Promise<RetiredRow[]> {
  return db
    .select()
    .from(schema.retiredComputers)
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        eq(schema.retiredComputers.status, 'deleting'),
        scope.gaveUp ? isNotNull(schema.retiredComputers.gaveUpAt) : undefined,
      ),
    )
    .orderBy(desc(schema.retiredComputers.gaveUpAt), schema.retiredComputers.retiredAt);
}

/**
 * An operator's retry of a row the job gave up on (`openbots computers
 * retry`): due now, with its attempts counted afresh. 409 for a row the job
 * has not given up on.
 */
export async function retryRetiredComputer(
  deps: Pick<Deps, 'db'>,
  scope: { workspaceId: string; retiredId: string },
  operator: string,
): Promise<RetiredRow> {
  const [row] = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.retiredComputers)
      .set({ gaveUpAt: null, attempts: 0, nextAttemptAt: null })
      .where(
        and(
          eq(schema.retiredComputers.id, scope.retiredId),
          eq(schema.retiredComputers.workspaceId, scope.workspaceId),
          eq(schema.retiredComputers.status, 'deleting'),
          isNotNull(schema.retiredComputers.gaveUpAt),
        ),
      )
      .returning();
    if (rows[0]) {
      await recordAudit(tx, {
        workspaceId: scope.workspaceId,
        actor: SYSTEM_ACTOR,
        action: 'computer.retired_retry',
        targetType: 'computer',
        targetId: rows[0].computerId ?? rows[0].id,
        metadata: { retiredId: rows[0].id, operator },
      });
    }
    return rows;
  });
  if (!row) {
    throw new DomainError(409, 'NOT_GIVEN_UP', 'That computer is not waiting for an operator');
  }
  return row;
}
