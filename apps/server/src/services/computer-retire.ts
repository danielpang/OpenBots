import { randomUUID } from 'node:crypto';
import type { ComputerProvider, ComputerRef } from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  wsEvent,
  type CoderControl,
  type JobHandler,
} from '@openbots/shared';
import { and, desc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace, rowsOf } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { fenceComputer } from './computer-fence.js';
import { endStartWork } from './computer-start-work.js';
import { MCP_CONTROL_CHANNEL, type McpControl } from './mcp-control.js';

// Retired computers (plan 9.5; the owner's decision). A reset that also
// forgets the sign-ins used to delete the member's machine, and on Sprites
// its checkpoints went with it. Where the provider can retire a machine
// (`ComputerProvider.retire`, Sprites), it is now kept for
// `RETIRED_COMPUTER_DAYS` so support can restore it, then deleted for good.
// A member who wants it gone at once (someone else got into it) asks the
// reset to delete it instead (computer.ts `destroyComputer`).
//
// A Sprite's checkpoints live inside the Sprite: the API has no export, no
// copy to another Sprite and no Sprite made from another's checkpoint. So the
// old Sprite itself is kept, out of service, and the member gets a new one.
// It still holds the member's old sign-ins, so it must be out of reach from
// the moment the reset answers:
//
// 1. A final checkpoint of the old Sprite (computer-reset.ts).
// 2. One transaction records the retired machine (`retiring`, deleted after
//    seven days) and takes it off the member's computer row, which gets a new
//    `machine_key` (so its next machine is a new Sprite under a new name) and
//    reads `stopping` meanwhile, so no start begins.
// 3. Inline, before the reset answers: the provider cuts off its reach
//    (`retire`: label, URL private, egress denied; metadata calls that need
//    no command inside it and do not wake it). Then the row is sealed
//    (`sealed_at`), the member's computer reads `stopped`, and every process
//    fences the old agent token (computer-fence.ts) and closes what it has
//    open on that machine.
//    If the cut fails, the reset is undone: the provider puts back what it
//    did (`unretire`), the member's computer gets its machine back as it was,
//    the record goes, and the reset answers 503 saying nothing changed. A
//    reset never answers success with the old machine still in reach.
// 4. In the background, retried within seconds and then with backoff
//    (`retireRetryDelayMs`): the provider's steps inside the machine
//    (`retireInside`: holds dropped, agent and token removed). Then `retired`.
// 5. The next start makes the new Sprite (computer.ts, the provisioning job).
//
// A crash between 2 and 3 leaves a `retiring` row that is not sealed: its
// claim (`RETIRE_LEASE_MS`) runs out and the sweep, every `RETIRED_SWEEP_MS`,
// queues its job, which cuts the reach, puts the member's computer back to
// `stopped` and goes on with 4. The new Sprite is only made after 2, under a
// name fixed in 2, so a provisioning retried after a crash finds the same
// one: never two.
//
// The retired-computers job: `sweepRetiredComputers` runs in every worker,
// at start and every `RETIRED_SWEEP_MS`, in each organization. It claims
// rows (one UPDATE each, so of several workers one wins) and queues a job on
// `RETIRED_COMPUTERS_QUEUE`, which retires again what is still `retiring`,
// deletes what is past `delete_after` (a `retiring` one too: deleting is the
// surest way out of reach), and takes back a `restoring` one whose lease ran
// out. A claim is a lease: a job lost with its process is claimed again once
// it runs out. A failure is retried with backoff, up to
// `RETIRED_MAX_ATTEMPTS`; then the row records that the job gave up
// (`gave_up_at`, an error in the log) and waits for an operator
// (`openbots computers retry`). A machine that is a member's current
// computer, in any organization, is never deleted. A Sprite already gone
// counts as deleted. Retire, restore and deletion are audited.
//
// Restore is for support only (`openbots computers restore`, cli/computers.ts),
// never a route: the member's current machine is retired in turn (so nothing
// is lost), the retired one's checkpoint is restored, it is put back in
// service, and it becomes the member's computer again, unless the member is
// no longer an active member or their computer changed meanwhile. The next
// start provisions it with a new agent token. A restore holds a lease
// (`RESTORE_LEASE_MS`); one cut short is retired again by the sweep.

/** How long a retired machine is kept before it is deleted for good. */
export const RETIRED_COMPUTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
export const RETIRED_COMPUTERS_QUEUE = 'retired-computers';
/** How often each worker looks for retired machines to retire, delete or take back. */
export const RETIRED_SWEEP_MS = 5 * 60_000;
/** How long a deletion's claim lasts before another worker may take the row again. */
export const RETIRED_LEASE_MS = 30 * 60_000;
/** How long a retire's claim lasts: a retire is a few quick calls. */
export const RETIRE_LEASE_MS = 2 * 60_000;
/** How long an operator's restore may take before the sweep takes the machine back. */
export const RESTORE_LEASE_MS = 30 * 60_000;
/** The longest wait between two attempts. */
export const RETIRED_RETRY_MAX_MS = 6 * 60 * 60_000;
/** Attempts before the job gives up and leaves the row to an operator. */
export const RETIRED_MAX_ATTEMPTS = 12;

/** The wait after a deletion's `attempts`th failure. */
export function retiredRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), RETIRED_RETRY_MAX_MS);
}

/** The wait after a retire's `attempts`th failure: soon, since it still holds old sign-ins. */
export function retireRetryDelayMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), RETIRED_RETRY_MAX_MS);
}

export type RetiredRow = typeof schema.retiredComputers.$inferSelect;
type ComputerRow = typeof schema.computers.$inferSelect;
/** The bus is all most of this needs; the queue, where there is one, runs the rest soon. */
type Deps = Pick<AppDeps, 'db' | 'logger'> & {
  infra: Pick<AppDeps['infra'], 'bus'> & Partial<Pick<AppDeps['infra'], 'queue'>>;
};
type SweepDeps = Pick<AppDeps, 'db' | 'logger' | 'infra'>;

/** Statuses of a machine that still exists and is not the member's. */
const LIVE = ['retiring', 'retired', 'deleting', 'restoring'];
/** Computer statuses a reset or a restore waits out: a job is making, starting or stopping it. */
export const BUSY = ['creating', 'updating', 'starting', 'stopping'];

/** The member's computer is being made, started or stopped (409). */
export const computerBusy = (status: string) =>
  new DomainError(409, 'COMPUTER_BUSY', `The computer is ${status}; try again once it settles`);

/** The member's computer changed while this ran (409). */
export const computerChanged = () =>
  new DomainError(409, 'COMPUTER_CHANGED', 'The computer changed meanwhile; try again');

/** Whether a full reset on this provider keeps the old machine for a while. */
export function retainsOnReset(machines: ComputerProvider | null): boolean {
  return (
    typeof machines?.retire === 'function' &&
    typeof machines.retireInside === 'function' &&
    typeof machines.unretire === 'function'
  );
}

/** The days a full reset keeps the old machine, or null where it is deleted at once. */
export function retainedDays(machines: ComputerProvider | null): number | null {
  return retainsOnReset(machines) ? RETIRED_COMPUTER_DAYS : null;
}

/**
 * Enough of a ref for the provider to find a machine by name: retire, restore,
 * unretire and destroy never talk to the agent, so no token is needed (and a
 * retired machine's was forgotten).
 */
function machineRef(row: {
  provider: ComputerRef['provider'];
  containerId?: string | null;
  providerRef?: string;
  agentUrl: string | null;
}): ComputerRef {
  return {
    provider: row.provider,
    containerId: row.providerRef ?? row.containerId ?? null,
    agentUrl: row.agentUrl ?? '',
    agentToken: '',
    volumeName: null,
  };
}

/** Plain text of a failure for the row, clipped. Provider errors carry no secret. */
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined; e;) {
    if (e.code === '23505') return true;
    e = e.cause as typeof e;
  }
  return false;
}

function publishStatus(deps: Deps, row: ComputerRow, status: string, error: string | null = null) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'computer.status',
      { computerId: row.id, status, error },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  );
}

/** Ends what runs on the member's computer in every process: stdio connectors and coding sessions. */
async function endWork(deps: Deps, row: ComputerRow) {
  endStartWork(row.id);
  await deps.infra.bus
    .publish<McpControl>(MCP_CONTROL_CHANNEL, {
      type: 'computer',
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
    })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping stdio connectors failed'),
    );
  await deps.infra.bus
    .publish<CoderControl>(CODER_CONTROL_CHANNEL, { type: 'stop_all', computerId: row.id })
    .catch((error: unknown) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
    );
}

/** A job on `RETIRED_COMPUTERS_QUEUE`. */
export interface RetiredComputerJob {
  retiredId: string;
  workspaceId: string;
  kind: 'retire' | 'delete';
  /**
   * The row's `next_attempt_at` as the one who queued it set it: the job runs
   * only while the row still carries it, so of a delayed retry and the sweep
   * one runs. Absent on a job run directly (the purge).
   */
  claim?: string;
}

/** Queues a retire job for a row already claimed until `claim`; the sweep is the fallback. */
async function queueRetire(deps: Deps, row: RetiredRow, claim: Date, delayMs = 0) {
  if (!deps.infra.queue) return;
  try {
    await deps.infra.queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE).enqueue(
      'retire',
      {
        retiredId: row.id,
        workspaceId: row.workspaceId,
        kind: 'retire',
        claim: claim.toISOString(),
      },
      { groupKey: row.id, ...(delayMs > 0 ? { delayMs } : {}) },
    );
  } catch (error) {
    // The claim runs out and the sweep queues it again.
    deps.logger.error({ err: error, retiredId: row.id }, 'queueing a retired computer failed');
  }
}

export interface RetireOptions {
  /** The checkpoint taken just before, if one was. */
  checkpointId: string | null;
  by: AuditActor;
  /** What the audit row calls it: a member's reset, or an operator's restore. */
  reason: 'reset' | 'restore';
  now?: Date;
}

/**
 * Steps 2 to 4 above for the machine `row` has now: records it retired,
 * takes it off the row (which gets a new machine key and reads `stopped`
 * with no machine), cuts off its reach through the provider, fences its
 * agent token everywhere, and queues the steps inside it. The row as it now
 * is. 409 `COMPUTER_BUSY` while a job is making, starting or stopping the
 * computer; 409 `COMPUTER_CHANGED` when the row no longer has that machine
 * (two resets at once: the other one retired it). When the reach cannot be
 * cut, the reset is undone and this throws 503 (`undoRetire`).
 */
export async function retireMachine(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  { checkpointId, by, reason, now = new Date() }: RetireOptions,
): Promise<{ computer: ComputerRow; retired: RetiredRow }> {
  if (!retainsOnReset(machines)) {
    throw new Error(`The ${machines.name} provider cannot retire a machine`);
  }
  if (!row.containerId) throw new Error('The computer has no machine to retire');
  if (BUSY.includes(row.status)) throw computerBusy(row.status);
  const ref = machineRef(row);
  const key = randomUUID();
  let switched: { computer: ComputerRow; retired: RetiredRow };
  try {
    switched = await deps.db.transaction(async (tx) => {
      // The row first: a second reset waits on its lock, then finds no machine.
      const [computer] = await tx
        .update(schema.computers)
        .set({
          containerId: null,
          agentUrl: null,
          agentToken: null,
          machineKey: key,
          status: 'stopping',
          spec: sql`${schema.computers.spec} - 'provision'`,
        })
        .where(
          and(
            eq(schema.computers.id, row.id),
            eq(schema.computers.containerId, row.containerId!),
            notInArray(schema.computers.status, BUSY),
          ),
        )
        .returning();
      if (!computer) {
        const [now] = await tx
          .select({ status: schema.computers.status })
          .from(schema.computers)
          .where(eq(schema.computers.id, row.id));
        throw now && BUSY.includes(now.status) ? computerBusy(now.status) : computerChanged();
      }
      const [retired] = await tx
        .insert(schema.retiredComputers)
        .values({
          workspaceId: row.workspaceId,
          ownerId: row.ownerId,
          computerId: row.id,
          provider: row.provider,
          providerRef: row.containerId!,
          machineKey: row.machineKey,
          agentUrl: row.agentUrl,
          checkpointId,
          status: 'retiring',
          retiredAt: now,
          deleteAfter: new Date(now.getTime() + RETIRED_COMPUTER_DAYS * DAY_MS),
          // Claimed by this call; the sweep takes it only if this process dies first.
          nextAttemptAt: new Date(now.getTime() + RETIRE_LEASE_MS),
        })
        .returning();
      return { computer, retired: retired! };
    });
  } catch (error) {
    // Two resets of one machine at once: the record's unique index refused the second.
    if (isUniqueViolation(error)) throw computerChanged();
    throw error;
  }
  await publishStatus(deps, switched.computer, 'stopping');
  endStartWork(row.id);
  try {
    await machines.retire!(ref);
  } catch (error) {
    return undoRetire(deps, machines, row, switched, key, error, now);
  }
  const sealed = new Date();
  const claim = new Date(sealed.getTime() + RETIRE_LEASE_MS);
  const { computer, retired } = await deps.db.transaction(async (tx) => {
    const [retired] = await tx
      .update(schema.retiredComputers)
      .set({ sealedAt: sealed, nextAttemptAt: claim, lastError: null })
      .where(eq(schema.retiredComputers.id, switched.retired.id))
      .returning();
    const [computer] = await tx
      .update(schema.computers)
      .set({ status: 'stopped' })
      .where(
        and(
          eq(schema.computers.id, row.id),
          eq(schema.computers.machineKey, key),
          eq(schema.computers.status, 'stopping'),
        ),
      )
      .returning();
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor: by,
      action: 'computer.retire',
      targetType: 'computer',
      targetId: row.id,
      metadata: {
        retiredId: switched.retired.id,
        reason,
        deleteAfter: switched.retired.deleteAfter.toISOString(),
        ...(checkpointId ? { checkpoint: checkpointId } : {}),
      },
    });
    return { computer: computer ?? switched.computer, retired: retired ?? switched.retired };
  });
  // Out of reach: nothing in any process talks to its agent again.
  await fenceComputer(deps, row);
  if (computer.status === 'stopped') await publishStatus(deps, computer, 'stopped');
  await queueRetire(deps, retired, claim);
  return { computer, retired };
}

/**
 * The reach of the old machine could not be cut: undoes the reset. The
 * provider puts back what it did, the member's computer gets its machine back
 * as it was (`error` if the provider could not put it back, so the member
 * resets again), and the record goes. Always throws 503. If the member's
 * computer moved on meanwhile (a worker that restarted queued its start),
 * the record stays, retried soon like a crash's, and the reset still answers
 * that it did not finish.
 */
async function undoRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  switched: { computer: ComputerRow; retired: RetiredRow },
  key: string,
  error: unknown,
  now: Date,
): Promise<never> {
  deps.logger.error(
    { err: error, computerId: row.id, retiredId: switched.retired.id },
    'cutting off the old computer failed; the reset is undone',
  );
  let putBack = true;
  try {
    await machines.unretire!(machineRef(row));
  } catch (again) {
    putBack = false;
    deps.logger.error(
      { err: again, computerId: row.id },
      'putting the computer back after a failed reset failed',
    );
  }
  const status = putBack ? row.status : 'error';
  const back = await deps.db.transaction(async (tx) => {
    const [computer] = await tx
      .update(schema.computers)
      .set({
        containerId: row.containerId,
        agentUrl: row.agentUrl,
        agentToken: row.agentToken,
        machineKey: row.machineKey,
        status,
        spec: row.spec,
      })
      .where(
        and(
          eq(schema.computers.id, row.id),
          eq(schema.computers.machineKey, key),
          eq(schema.computers.status, 'stopping'),
          isNull(schema.computers.containerId),
        ),
      )
      .returning();
    if (!computer) return null;
    await tx
      .delete(schema.retiredComputers)
      .where(
        and(
          eq(schema.retiredComputers.id, switched.retired.id),
          eq(schema.retiredComputers.status, 'retiring'),
          isNull(schema.retiredComputers.sealedAt),
        ),
      );
    return computer;
  });
  if (!back) {
    const due = new Date();
    const [retired] = await deps.db
      .update(schema.retiredComputers)
      .set({
        attempts: 1,
        lastAttemptAt: now,
        lastError: errorText(error),
        nextAttemptAt: due,
      })
      .where(eq(schema.retiredComputers.id, switched.retired.id))
      .returning();
    if (retired) await queueRetire(deps, retired, due);
    throw new DomainError(
      503,
      'COMPUTER_UNAVAILABLE',
      'The reset did not finish shutting off the old computer. It is retried in the background.',
    );
  }
  await publishStatus(
    deps,
    back,
    status,
    putBack ? null : 'The reset did not finish. Reset the computer again.',
  );
  throw new DomainError(
    503,
    'COMPUTER_UNAVAILABLE',
    putBack
      ? 'The computer could not be reset, so nothing was changed. Try again in a few minutes.'
      : 'The computer could not be reset. Reset it again in a few minutes.',
  );
}

/**
 * Claims what is due in the current organization and queues a job for each:
 * rows past `delete_after` (and `deleting` rows whose claim ran out) to
 * delete, `restoring` rows whose lease ran out to retire again, and
 * `retiring` rows whose retry is due. Returns how many it queued. Each claim
 * is one UPDATE with the condition in it, so of several workers sweeping at
 * once only one takes a row. Rows the job gave up on are left to an operator.
 */
export async function sweepRetiredComputers(deps: SweepDeps, now = new Date()): Promise<number> {
  const lease = new Date(now.getTime() + RETIRED_LEASE_MS);
  const retireLease = new Date(now.getTime() + RETIRE_LEASE_MS);
  const due = or(
    isNull(schema.retiredComputers.nextAttemptAt),
    lte(schema.retiredComputers.nextAttemptAt, now),
  );
  const tried = isNull(schema.retiredComputers.gaveUpAt);
  const deleting = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'deleting', nextAttemptAt: lease })
    .where(
      and(
        tried,
        or(
          // Kept long enough, or made due by the member's removal: a
          // `retiring` one too, which deleting takes out of reach for good.
          and(
            inArray(schema.retiredComputers.status, ['retired', 'retiring']),
            lte(schema.retiredComputers.deleteAfter, now),
            due,
          ),
          // A claim whose job never finished (lost with its process).
          and(
            eq(schema.retiredComputers.status, 'deleting'),
            lte(schema.retiredComputers.nextAttemptAt, now),
          ),
        ),
      ),
    )
    .returning();
  // A restore cut short (its process died): retired again from the start.
  const recovered = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'retiring', sealedAt: null, nextAttemptAt: retireLease })
    .where(and(tried, eq(schema.retiredComputers.status, 'restoring'), due))
    .returning();
  for (const row of recovered) {
    deps.logger.warn(
      { retiredId: row.id },
      'a restore was cut short; the computer is retired again',
    );
  }
  const retiring = await deps.db
    .update(schema.retiredComputers)
    .set({ nextAttemptAt: retireLease })
    .where(and(tried, eq(schema.retiredComputers.status, 'retiring'), due))
    .returning();
  const queue = deps.infra.queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE);
  let queued = 0;
  for (const [rows, kind] of [
    [deleting, 'delete'],
    [[...recovered, ...retiring], 'retire'],
  ] as const) {
    for (const row of rows) {
      try {
        await queue.enqueue(
          kind,
          {
            retiredId: row.id,
            workspaceId: row.workspaceId,
            kind,
            ...(kind === 'retire' ? { claim: row.nextAttemptAt!.toISOString() } : {}),
          },
          { groupKey: row.id },
        );
        queued++;
      } catch (error) {
        // The claim runs out and a later sweep queues it again.
        deps.logger.error({ err: error, retiredId: row.id }, 'queueing a retired computer failed');
      }
    }
  }
  return queued;
}

/**
 * Whether `retired` is, or is about to be made, some member's current
 * computer in any organization (openbots_machine_in_use(), drizzle/0045): a
 * computer row with that machine, or with the key the machine was named by.
 */
async function isCurrent(db: Db, retired: RetiredRow): Promise<boolean> {
  const key = retired.machineKey ?? retired.computerId ?? null;
  const result = await db.execute<{ used: boolean }>(
    sql`select openbots_machine_in_use(${retired.provider}::computer_provider, ${retired.providerRef}, ${key}) as used`,
  );
  return rowsOf<{ used: boolean }>(result)[0]?.used === true;
}

/** Records a failed attempt: retried with backoff, or given up after `RETIRED_MAX_ATTEMPTS`. */
async function failed(
  deps: Deps,
  row: RetiredRow,
  from: 'retiring' | 'deleting',
  error: unknown,
  now: Date,
) {
  const attempts = row.attempts + 1;
  const giveUp = attempts >= RETIRED_MAX_ATTEMPTS;
  const sealed = row.sealedAt !== null;
  // A deletion that fails puts the row back where the sweep finds it.
  const status = from === 'deleting' ? (sealed ? 'retired' : 'retiring') : 'retiring';
  const delay = from === 'deleting' ? retiredRetryDelayMs(attempts) : retireRetryDelayMs(attempts);
  const retryAt = new Date(now.getTime() + delay);
  // The steps inside a machine already out of reach are not worth an
  // operator's time: it is deleted when due all the same.
  const insideOnly = from === 'retiring' && sealed;
  const set = giveUp
    ? insideOnly
      ? {
          status: 'retired',
          nextAttemptAt: null,
          lastError: `Gave up the steps inside it after ${attempts} attempts: ${errorText(error)}`,
        }
      : { status, gaveUpAt: now, nextAttemptAt: null, lastError: errorText(error) }
    : { status, nextAttemptAt: retryAt, lastError: errorText(error) };
  const [updated] = await deps.db
    .update(schema.retiredComputers)
    .set({ ...set, attempts, lastAttemptAt: now })
    .where(and(eq(schema.retiredComputers.id, row.id), eq(schema.retiredComputers.status, from)))
    .returning();
  if (!updated) return;
  if (giveUp) {
    deps.logger.error(
      { err: error, retiredId: row.id, attempts, sealed },
      insideOnly
        ? 'gave up the steps inside a retired computer; it is out of reach and deleted when due'
        : from === 'deleting'
          ? 'gave up deleting a retired computer; an operator must retry it'
          : 'gave up taking a retired computer out of reach; an operator must retry it',
    );
    return;
  }
  deps.logger.warn(
    { err: error, retiredId: row.id, attempts, retryAt },
    from === 'deleting' ? 'deleting a retired computer failed' : 'retiring the old computer failed',
  );
  if (from === 'retiring') await queueRetire(deps, updated, retryAt, delay);
}

/**
 * The retire job: cuts off the reach of a machine whose reset was cut short
 * (and puts the member's computer back to `stopped`), then the steps inside
 * it, then `retired`.
 */
async function finishRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: RetiredRow,
  now: Date,
): Promise<void> {
  const ref = machineRef(row);
  try {
    if (!row.sealedAt) {
      await machines.retire!(ref);
      const [sealed] = await deps.db
        .update(schema.retiredComputers)
        .set({ sealedAt: now })
        .where(
          and(
            eq(schema.retiredComputers.id, row.id),
            eq(schema.retiredComputers.status, 'retiring'),
          ),
        )
        .returning();
      if (!sealed) return;
      row = sealed;
      // The reset that recorded it never got this far: its computer waits in `stopping`.
      if (row.computerId) {
        await deps.db
          .update(schema.computers)
          .set({ status: 'stopped' })
          .where(
            and(
              eq(schema.computers.id, row.computerId),
              eq(schema.computers.status, 'stopping'),
              isNull(schema.computers.containerId),
            ),
          );
      }
    }
    await machines.retireInside!(ref);
  } catch (error) {
    await failed(deps, row, 'retiring', error, now);
    return;
  }
  await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'retired', lastAttemptAt: now, lastError: null, nextAttemptAt: null })
    .where(
      and(eq(schema.retiredComputers.id, row.id), eq(schema.retiredComputers.status, 'retiring')),
    );
}

/**
 * The job: finishes retiring a `retiring` row, or deletes a `deleting` one
 * for good. Does nothing for a row in any other status (another worker
 * finished it, or an operator restored it meanwhile), for a retire whose
 * claim another took, or when the provider is not the row's (the claim runs
 * out and it is tried again later).
 */
export async function runRetiredComputerJob(
  deps: Deps,
  machines: ComputerProvider | null,
  job: Pick<RetiredComputerJob, 'retiredId' | 'kind' | 'claim'>,
  now = new Date(),
): Promise<void> {
  let [row] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(eq(schema.retiredComputers.id, job.retiredId));
  if (!row) return;
  if (!machines || machines.name !== row.provider || !retainsOnReset(machines)) {
    deps.logger.warn(
      { retiredId: row.id, provider: row.provider },
      'a retired computer is on a provider this install no longer has; left for later',
    );
    return;
  }
  if (job.kind === 'retire') {
    if (row.status !== 'retiring' || row.gaveUpAt) return;
    if (job.claim) {
      // Still this job's: take the claim for the time it runs.
      [row] = await deps.db
        .update(schema.retiredComputers)
        .set({ nextAttemptAt: new Date(now.getTime() + RETIRE_LEASE_MS) })
        .where(
          and(
            eq(schema.retiredComputers.id, row.id),
            eq(schema.retiredComputers.status, 'retiring'),
            eq(schema.retiredComputers.nextAttemptAt, new Date(job.claim)),
          ),
        )
        .returning();
      if (!row) return;
    }
    await finishRetire(deps, machines, row, now);
    return;
  }
  if (row.status !== 'deleting') return;
  const ref = machineRef(row);
  if (await isCurrent(deps.db, row)) {
    deps.logger.error(
      { retiredId: row.id },
      "a retired computer is a member's current computer; it is not deleted",
    );
    await deps.db
      .update(schema.retiredComputers)
      .set({
        status: 'retired',
        lastAttemptAt: now,
        lastError: "It is a member's current computer, so it was not deleted",
        nextAttemptAt: new Date(now.getTime() + RETIRED_RETRY_MAX_MS),
      })
      .where(
        and(eq(schema.retiredComputers.id, row.id), eq(schema.retiredComputers.status, 'deleting')),
      );
    return;
  }
  try {
    // Deleting a machine already gone is not an error (the provider's destroy).
    await machines.destroy(ref, { computerId: row.computerId ?? row.id, home: true, state: true });
  } catch (error) {
    await failed(deps, row, 'deleting', error, now);
    return;
  }
  await deps.db.transaction(async (tx) => {
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
    // Another worker that held a stale claim finished first: one audit row.
    if (!deleted) return;
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor: SYSTEM_ACTOR,
      action: 'computer.retired_delete',
      targetType: 'computer',
      targetId: row.computerId ?? row.id,
      metadata: { retiredId: row.id, retiredAt: row.retiredAt.toISOString() },
    });
  });
}

/** The queue's handler; `machines` is the install's provider, looked up per job. */
export function retiredComputerHandler(
  deps: Deps,
  machines: () => ComputerProvider | null,
): JobHandler<RetiredComputerJob> {
  return (job) => runRetiredComputerJob(deps, machines(), job.data);
}

/**
 * Makes every retired machine of an organization, or of one member there,
 * due for deletion now, including one still being retired or restored, and
 * one the job gave up on: a member removed from the organization
 * (membership.ts), and the organization's own deletion. The sweep then
 * deletes them; `purgeRetiredComputers` does it at once. A restore under way
 * fails at its end once the member is gone, and its machine is then deleted.
 */
export async function expireRetiredComputers(
  db: Db,
  scope: { workspaceId: string; ownerId?: string },
  now = new Date(),
): Promise<number> {
  const rows = await db
    .update(schema.retiredComputers)
    .set({ deleteAfter: now, gaveUpAt: null })
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        scope.ownerId ? eq(schema.retiredComputers.ownerId, scope.ownerId) : undefined,
        inArray(schema.retiredComputers.status, ['retiring', 'retired', 'restoring']),
      ),
    )
    .returning({ id: schema.retiredComputers.id });
  // Due now, unless a claim is running (a retire, a restore): the sweep takes it after.
  await db
    .update(schema.retiredComputers)
    .set({ nextAttemptAt: null })
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        scope.ownerId ? eq(schema.retiredComputers.ownerId, scope.ownerId) : undefined,
        eq(schema.retiredComputers.status, 'retired'),
      ),
    );
  return rows.length;
}

/**
 * Deletes every retired machine of an organization (or one member) now, for
 * the organization's deletion, which must call this before it deletes the
 * organization (the table's foreign key refuses otherwise). Returns how many
 * are left (failures, and a restore under way, which the sweep finishes).
 */
export async function purgeRetiredComputers(
  deps: Deps,
  machines: ComputerProvider | null,
  scope: { workspaceId: string; ownerId?: string },
): Promise<number> {
  return inWorkspace(scope.workspaceId, async () => {
    const now = new Date();
    await expireRetiredComputers(deps.db, scope, now);
    const owned = and(
      eq(schema.retiredComputers.workspaceId, scope.workspaceId),
      scope.ownerId ? eq(schema.retiredComputers.ownerId, scope.ownerId) : undefined,
    );
    const claimed = await deps.db
      .update(schema.retiredComputers)
      .set({ status: 'deleting', nextAttemptAt: new Date(now.getTime() + RETIRED_LEASE_MS) })
      .where(
        and(owned, inArray(schema.retiredComputers.status, ['retiring', 'retired', 'deleting'])),
      )
      .returning();
    for (const row of claimed) {
      await runRetiredComputerJob(deps, machines, { retiredId: row.id, kind: 'delete' }, now);
    }
    const left = await deps.db
      .select({ id: schema.retiredComputers.id })
      .from(schema.retiredComputers)
      .where(and(owned, inArray(schema.retiredComputers.status, LIVE)));
    return left.length;
  });
}

/** A member's retired machines in an organization, newest first (the operator's list). */
export async function listRetiredComputers(
  db: Db,
  scope: { workspaceId: string; ownerId: string },
): Promise<RetiredRow[]> {
  return db
    .select()
    .from(schema.retiredComputers)
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        eq(schema.retiredComputers.ownerId, scope.ownerId),
      ),
    )
    .orderBy(desc(schema.retiredComputers.retiredAt));
}

/**
 * An operator's retry of a row the job gave up on (`openbots computers
 * retry`): due now, with its attempts counted afresh. 409 for a row the job
 * has not given up on.
 */
export async function retryRetiredComputer(
  deps: Deps,
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
          sql`${schema.retiredComputers.gaveUpAt} is not null`,
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

export interface Restored {
  restored: RetiredRow;
  /** The machine the member had, retired in turn; null when there was none. */
  replaced: RetiredRow | null;
  computer: ComputerRow;
}

/** Whether the owner is an active member of the organization (membership.ts `ownerActive`). */
async function activeMember(db: Db, row: { ownerId: string; workspaceId: string }) {
  const [member] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, row.workspaceId),
        eq(schema.workspaceMembers.userId, row.ownerId),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    )
    .for('share');
  return member !== undefined;
}

const notRestorable = (message: string) => new DomainError(409, 'NOT_RESTORABLE', message);

/**
 * Support's restore (`openbots computers restore`): makes a retired machine
 * the member's computer again. The member's current machine, if there is
 * one, is checkpointed and retired in turn (kept seven days, like any
 * retired one), the retired machine's checkpoint is restored, it is put back
 * in service, and the member's computer row points at it, `stopped` with no
 * agent, so the next start provisions it with a new agent token. Refused
 * while the member's computer is being made, started or stopped (409
 * `COMPUTER_BUSY`), for an owner who is no longer an active member, and for a
 * machine already deleted, restored or being restored (409 `NOT_RESTORABLE`).
 * Its last step checks again, in one transaction, that the owner is an active
 * member and that the computer is as the restore left it; otherwise
 * (`COMPUTER_CHANGED`, `NOT_RESTORABLE`) the machine is retired again and
 * nothing else changes. `operator` names who ran it, for the audit log.
 */
export async function restoreRetiredComputer(
  deps: Deps,
  machines: ComputerProvider,
  scope: { workspaceId: string; retiredId: string },
  operator: string,
  now = new Date(),
): Promise<Restored> {
  const by = SYSTEM_ACTOR;
  const [found] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(
      and(
        eq(schema.retiredComputers.id, scope.retiredId),
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
      ),
    );
  if (!found) throw notFound('No such retired computer in this organization');
  if (found.provider !== machines.name || !retainsOnReset(machines)) {
    throw notRestorable('This install cannot restore that computer');
  }
  if (!(await activeMember(deps.db, found))) {
    throw notRestorable('Its owner is not an active member of this organization');
  }
  // The machine's own name becomes the computer's key, so every later make
  // of it (a start, a reset that keeps the sign-ins) finds exactly this one,
  // whatever the computer row's id is now.
  const machineKey = found.providerRef;
  // Claimed, with a lease: the deletion job leaves it alone, and the sweep
  // takes it back if this process dies before the end.
  const lease = new Date(now.getTime() + RESTORE_LEASE_MS);
  const [retired] = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'restoring', nextAttemptAt: lease })
    .where(
      and(
        eq(schema.retiredComputers.id, found.id),
        isNull(schema.retiredComputers.gaveUpAt),
        sql`${schema.retiredComputers.sealedAt} is not null`,
        eq(schema.retiredComputers.status, 'retired'),
      ),
    )
    .returning();
  if (!retired) {
    throw notRestorable(
      found.gaveUpAt
        ? 'That computer is waiting for an operator to retry it, so it cannot be restored'
        : `That computer is ${found.status}, so it cannot be restored`,
    );
  }
  const ours = and(
    eq(schema.retiredComputers.id, retired.id),
    eq(schema.retiredComputers.status, 'restoring'),
    eq(schema.retiredComputers.nextAttemptAt, lease),
  );
  /** Gives the claim back: `retired`, or `retiring` (due now) when it is not out of reach. */
  const release = (sealed: boolean) =>
    deps.db
      .update(schema.retiredComputers)
      .set(
        sealed
          ? { status: 'retired', nextAttemptAt: null }
          : { status: 'retiring', sealedAt: null, nextAttemptAt: null },
      )
      .where(ours);
  const [current] = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.workspaceId, retired.workspaceId),
        eq(schema.computers.ownerId, retired.ownerId),
      ),
    );
  if (!current) {
    await release(true);
    throw notFound('The member has no computer in this organization any more');
  }
  if (BUSY.includes(current.status)) {
    await release(true);
    throw computerBusy(current.status);
  }
  let unretired = false;
  const ref = machineRef(retired);
  try {
    let replaced: RetiredRow | null = null;
    let row = current;
    if (row.containerId) {
      await endWork(deps, row);
      let checkpointId: string | null = null;
      if (machines.checkpoint && row.agentUrl) {
        checkpointId = await machines
          .checkpoint(
            machineRef(row),
            `OpenBots: before a restore, ${new Date().toISOString()} ${randomUUID()}`,
          )
          .catch((error: unknown) => {
            deps.logger.warn(
              { err: error, computerId: row.id },
              'the checkpoint before a restore failed',
            );
            return null;
          });
      }
      const out = await retireMachine(deps, machines, row, {
        checkpointId,
        by,
        reason: 'restore',
      });
      replaced = out.retired;
      row = out.computer;
    }
    if (retired.checkpointId) await machines.restore?.(ref, retired.checkpointId);
    await machines.unretire!(ref);
    unretired = true;
    const result = await deps.db.transaction(async (tx) => {
      // Checked again where it counts: a removal waits for this to commit, or this sees it.
      if (!(await activeMember(tx as unknown as Db, retired))) {
        throw notRestorable('Its owner is not an active member of this organization');
      }
      const [computer] = await tx
        .update(schema.computers)
        .set({
          containerId: retired.providerRef,
          agentUrl: null,
          agentToken: null,
          status: 'stopped',
          machineKey,
        })
        .where(
          and(
            eq(schema.computers.id, row.id),
            isNull(schema.computers.containerId),
            notInArray(schema.computers.status, BUSY),
            row.machineKey === null
              ? isNull(schema.computers.machineKey)
              : eq(schema.computers.machineKey, row.machineKey),
          ),
        )
        .returning();
      if (!computer) throw computerChanged();
      const [restored] = await tx
        .update(schema.retiredComputers)
        .set({ status: 'restored', restoredAt: new Date(), nextAttemptAt: null })
        .where(ours)
        .returning();
      // The sweep took it back (this ran past its lease): nothing changes.
      if (!restored) throw computerChanged();
      await recordAudit(tx, {
        workspaceId: retired.workspaceId,
        actor: by,
        action: 'computer.restore',
        targetType: 'computer',
        targetId: row.id,
        metadata: {
          retiredId: retired.id,
          operator,
          ...(retired.checkpointId ? { checkpoint: retired.checkpointId } : {}),
          ...(replaced ? { replacedBy: replaced.id } : {}),
        },
      });
      return { computer, restored };
    });
    await publishStatus(deps, result.computer, 'stopped');
    return { ...result, replaced };
  } catch (error) {
    // Put back in service but not recorded as the member's: out of service again.
    let sealed = true;
    if (unretired) {
      try {
        await machines.retire!(ref);
        await machines.retireInside!(ref);
      } catch (again) {
        // The job finishes it, soon.
        sealed = false;
        deps.logger.error({ err: again, retiredId: retired.id }, 'retiring it again failed');
      }
    }
    await release(sealed);
    throw error;
  }
}
