import { randomUUID } from 'node:crypto';
import type { ComputerProvider, ComputerRef } from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  wsEvent,
  type CoderControl,
  type JobHandler,
} from '@openbots/shared';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { MCP_CONTROL_CHANNEL, type McpControl } from './mcp-control.js';

// Retired computers (plan 9.5; the owner's decision). A reset that also
// forgets the sign-ins used to delete the member's machine, and on Sprites
// its checkpoints went with it. Where the provider can retire a machine
// (`ComputerProvider.retire`, Sprites), it is now kept for
// `RETIRED_COMPUTER_DAYS` so support can restore it, then deleted for good.
//
// A Sprite's checkpoints live inside the Sprite: the API has no export, no
// copy to another Sprite and no Sprite made from another's checkpoint. So the
// old Sprite itself is kept, out of service, and the member gets a new one:
//
// 1. A final checkpoint of the old Sprite (computer-reset.ts), with the same
//    unique comment scheme as a reset that keeps the sign-ins.
// 2. One transaction records the retired machine (`retiring`, deleted after
//    seven days) and takes it off the member's computer row, which gets a new
//    `machineKey`, so its next machine is a new Sprite under a new name.
// 3. The provider retires it: agent and token gone, URL private, holds
//    dropped so it pauses, egress denied. Then the row reads `retired`.
// 4. The next start makes the new Sprite (computer.ts, the provisioning job).
//
// A crash before 2 leaves everything as it was, and the reset can be done
// again. A crash between 2 and 3 leaves a `retiring` row the sweep finishes.
// The new Sprite is only made after 2, under a name fixed in 2, so a
// provisioning retried after a crash finds the same one: never two.
//
// The retired-computers job: `sweepRetiredComputers` runs in every worker,
// at start and every `RETIRED_SWEEP_MS`, in each organization. It claims
// rows (one UPDATE each, so of several workers one wins) and queues a job on
// `RETIRED_COMPUTERS_QUEUE`, which retires again what is still `retiring` and
// deletes what is past `delete_after`. A claim is a lease
// (`RETIRED_LEASE_MS`): a job lost with its process is claimed again once it
// runs out. A failure is retried with backoff (`retiredRetryDelayMs`). A
// machine that is a member's current computer is never deleted. A Sprite
// already gone counts as deleted. Retire, restore and deletion are audited.
//
// Restore is for support only (`openbots computers restore`, cli/computers.ts),
// never a route: the member's current machine is retired in turn (so nothing
// is lost), the retired one's checkpoint is restored, it is put back in
// service, and it becomes the member's computer again. The next start
// provisions it with a new agent token.

/** How long a retired machine is kept before it is deleted for good. */
export const RETIRED_COMPUTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
export const RETIRED_COMPUTERS_QUEUE = 'retired-computers';
/** How often each worker looks for retired machines to delete or finish retiring. */
export const RETIRED_SWEEP_MS = 60 * 60_000;
/** How long a claim lasts before another worker may take the row again. */
export const RETIRED_LEASE_MS = 30 * 60_000;
/** The longest wait between two attempts. */
export const RETIRED_RETRY_MAX_MS = 6 * 60 * 60_000;

export function retiredRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), RETIRED_RETRY_MAX_MS);
}

export type RetiredRow = typeof schema.retiredComputers.$inferSelect;
type ComputerRow = typeof schema.computers.$inferSelect;
/** The bus is all the retiring and restoring need; the sweep queues jobs too. */
type Deps = Pick<AppDeps, 'db' | 'logger'> & { infra: Pick<AppDeps['infra'], 'bus'> };
type SweepDeps = Pick<AppDeps, 'db' | 'logger' | 'infra'>;

/** Statuses of a machine that still exists and is not the member's. */
const LIVE = ['retiring', 'retired', 'deleting', 'restoring'];
/** Computer statuses a restore waits out: a job is making, starting or stopping it. */
const BUSY = ['creating', 'updating', 'starting', 'stopping'];

/** Whether a full reset on this provider keeps the old machine for a while. */
export function retainsOnReset(machines: ComputerProvider | null): boolean {
  return typeof machines?.retire === 'function';
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

const machineKeyOf = (row: ComputerRow) =>
  ((row.spec ?? {}) as { machineKey?: string }).machineKey ?? null;

/** Plain text of a failure for the row, clipped. Provider errors carry no secret. */
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function publishStatus(deps: Deps, row: ComputerRow, status: string) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'computer.status',
      { computerId: row.id, status, error: null },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  );
}

/** Ends what runs on the member's computer in every process: stdio connectors and coding sessions. */
async function endWork(deps: Deps, row: ComputerRow) {
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

export interface RetireOptions {
  /** The checkpoint taken just before, if one was. */
  checkpointId: string | null;
  by: AuditActor;
  /** What the audit row calls it: a member's reset, or an operator's restore. */
  reason: 'reset' | 'restore';
  now?: Date;
}

/**
 * Steps 2 and 3 above for the machine `row` has now: records it retired,
 * takes it off the row (which gets a new machine key and reads `stopped`
 * with no machine), then retires it through the provider. The row as it now
 * is. 409 `COMPUTER_CHANGED` when the row no longer has that machine (two
 * resets at once: the other one retired it). A failure in the provider does
 * not undo the record: the sweep retries it, and the member's reset is done.
 */
export async function retireMachine(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  { checkpointId, by, reason, now = new Date() }: RetireOptions,
): Promise<{ computer: ComputerRow; retired: RetiredRow }> {
  if (!machines.retire) throw new Error(`The ${machines.name} provider cannot retire a machine`);
  if (!row.containerId) throw new Error('The computer has no machine to retire');
  const ref = machineRef(row);
  const { computer, retired } = await deps.db.transaction(async (tx) => {
    const [retired] = await tx
      .insert(schema.retiredComputers)
      .values({
        workspaceId: row.workspaceId,
        ownerId: row.ownerId,
        computerId: row.id,
        provider: row.provider,
        providerRef: row.containerId!,
        machineKey: machineKeyOf(row),
        agentUrl: row.agentUrl,
        checkpointId,
        status: 'retiring',
        retiredAt: now,
        deleteAfter: new Date(now.getTime() + RETIRED_COMPUTER_DAYS * DAY_MS),
        // Retired right below; the sweep takes it only if this process dies first.
        nextAttemptAt: new Date(now.getTime() + RETIRED_LEASE_MS),
      })
      .returning();
    const [computer] = await tx
      .update(schema.computers)
      .set({
        containerId: null,
        agentUrl: null,
        agentToken: null,
        status: 'stopped',
        spec: sql`jsonb_set(${schema.computers.spec}, '{machineKey}', to_jsonb(${randomUUID()}::text))`,
      })
      .where(
        and(eq(schema.computers.id, row.id), eq(schema.computers.containerId, row.containerId!)),
      )
      .returning();
    if (!computer) {
      throw new DomainError(409, 'COMPUTER_CHANGED', 'The computer changed meanwhile; try again');
    }
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor: by,
      action: 'computer.retire',
      targetType: 'computer',
      targetId: row.id,
      metadata: {
        retiredId: retired!.id,
        reason,
        deleteAfter: retired!.deleteAfter.toISOString(),
        ...(checkpointId ? { checkpoint: checkpointId } : {}),
      },
    });
    return { computer, retired: retired! };
  });
  await publishStatus(deps, computer, 'stopped');
  const finished = await finishRetire(deps, machines, retired, ref, now);
  return { computer, retired: finished };
}

/** Step 3: the provider's retire, then the row `retired`; a failure is retried with backoff. */
async function finishRetire(
  deps: Deps,
  machines: ComputerProvider,
  retired: RetiredRow,
  ref: ComputerRef,
  now = new Date(),
): Promise<RetiredRow> {
  try {
    await machines.retire!(ref);
  } catch (error) {
    const attempts = retired.attempts + 1;
    deps.logger.warn(
      { err: error, retiredId: retired.id, attempts },
      'retiring the old computer failed; the sweep retries it',
    );
    const [failed] = await deps.db
      .update(schema.retiredComputers)
      .set({
        attempts,
        lastAttemptAt: now,
        lastError: errorText(error),
        nextAttemptAt: new Date(now.getTime() + retiredRetryDelayMs(attempts)),
      })
      .where(
        and(
          eq(schema.retiredComputers.id, retired.id),
          eq(schema.retiredComputers.status, 'retiring'),
        ),
      )
      .returning();
    return failed ?? retired;
  }
  const [done] = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'retired', lastAttemptAt: now, lastError: null, nextAttemptAt: null })
    .where(
      and(
        eq(schema.retiredComputers.id, retired.id),
        eq(schema.retiredComputers.status, 'retiring'),
      ),
    )
    .returning();
  return done ?? retired;
}

/** A job on `RETIRED_COMPUTERS_QUEUE`. */
export interface RetiredComputerJob {
  retiredId: string;
  workspaceId: string;
  kind: 'retire' | 'delete';
}

/**
 * Claims what is due in the current organization and queues a job for each:
 * `retiring` rows whose retry is due, `retired` rows past `delete_after`, and
 * `deleting` rows whose claim ran out. Returns how many it queued. Each claim
 * is one UPDATE with the condition in it, so of several workers sweeping at
 * once only one takes a row.
 */
export async function sweepRetiredComputers(deps: SweepDeps, now = new Date()): Promise<number> {
  const lease = new Date(now.getTime() + RETIRED_LEASE_MS);
  const due = or(
    isNull(schema.retiredComputers.nextAttemptAt),
    lte(schema.retiredComputers.nextAttemptAt, now),
  );
  const retiring = await deps.db
    .update(schema.retiredComputers)
    .set({ nextAttemptAt: lease })
    .where(and(eq(schema.retiredComputers.status, 'retiring'), due))
    .returning();
  const deleting = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'deleting', nextAttemptAt: lease })
    .where(
      or(
        and(
          eq(schema.retiredComputers.status, 'retired'),
          lte(schema.retiredComputers.deleteAfter, now),
          due,
        ),
        // A claim whose job never finished (lost with its process).
        and(
          eq(schema.retiredComputers.status, 'deleting'),
          lte(schema.retiredComputers.nextAttemptAt, now),
        ),
      ),
    )
    .returning();
  const queue = deps.infra.queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE);
  let queued = 0;
  for (const [rows, kind] of [
    [retiring, 'retire'],
    [deleting, 'delete'],
  ] as const) {
    for (const row of rows) {
      try {
        await queue.enqueue(
          kind,
          { retiredId: row.id, workspaceId: row.workspaceId, kind },
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

/** Whether `retired` is, or is about to be made, some member's current computer. */
async function isCurrent(db: Db, retired: RetiredRow): Promise<boolean> {
  const machineKey = sql`${schema.computers.spec} ->> 'machineKey'`;
  const [current] = await db
    .select({ id: schema.computers.id })
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.provider, retired.provider),
        or(
          eq(schema.computers.containerId, retired.providerRef),
          retired.machineKey
            ? sql`${machineKey} = ${retired.machineKey}`
            : retired.computerId
              ? and(eq(schema.computers.id, retired.computerId), sql`${machineKey} is null`)
              : sql`false`,
        ),
      ),
    )
    .limit(1);
  return !!current;
}

/**
 * The job: finishes retiring a `retiring` row, or deletes a `deleting` one
 * for good. Does nothing for a row in any other status (another worker
 * finished it, or an operator restored it meanwhile), or when the provider
 * is not the row's (the claim runs out and it is tried again later).
 */
export async function runRetiredComputerJob(
  deps: Deps,
  machines: ComputerProvider | null,
  job: Pick<RetiredComputerJob, 'retiredId' | 'kind'>,
  now = new Date(),
): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(eq(schema.retiredComputers.id, job.retiredId));
  if (!row) return;
  if (!machines || machines.name !== row.provider) {
    deps.logger.warn(
      { retiredId: row.id, provider: row.provider },
      'a retired computer is on a provider this install no longer has; left for later',
    );
    return;
  }
  const ref = machineRef(row);
  if (job.kind === 'retire') {
    if (row.status === 'retiring') await finishRetire(deps, machines, row, ref, now);
    return;
  }
  if (row.status !== 'deleting') return;
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
    const attempts = row.attempts + 1;
    const retryAt = new Date(now.getTime() + retiredRetryDelayMs(attempts));
    deps.logger.warn(
      { err: error, retiredId: row.id, attempts, retryAt },
      'deleting a retired computer failed',
    );
    await deps.db
      .update(schema.retiredComputers)
      .set({
        status: 'retired',
        attempts,
        lastAttemptAt: now,
        lastError: errorText(error),
        nextAttemptAt: retryAt,
      })
      .where(
        and(eq(schema.retiredComputers.id, row.id), eq(schema.retiredComputers.status, 'deleting')),
      );
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
 * due for deletion now: a member removed from the organization
 * (membership.ts), and the organization's own deletion. The sweep then
 * deletes them; `purgeRetiredComputers` does it at once.
 */
export async function expireRetiredComputers(
  db: Db,
  scope: { workspaceId: string; ownerId?: string },
  now = new Date(),
): Promise<number> {
  const rows = await db
    .update(schema.retiredComputers)
    .set({ deleteAfter: now, nextAttemptAt: null })
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        scope.ownerId ? eq(schema.retiredComputers.ownerId, scope.ownerId) : undefined,
        inArray(schema.retiredComputers.status, ['retiring', 'retired']),
      ),
    )
    .returning({ id: schema.retiredComputers.id });
  return rows.length;
}

/**
 * Deletes every retired machine of an organization (or one member) now, for
 * the organization's deletion, which must call this before it deletes the
 * organization (the table's foreign key refuses otherwise). One still
 * `retiring` is retired first. Returns how many are left (failures, which
 * stay due and are retried by the sweep).
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
    const retiring = await deps.db
      .select()
      .from(schema.retiredComputers)
      .where(and(owned, eq(schema.retiredComputers.status, 'retiring')));
    for (const row of retiring) {
      await runRetiredComputerJob(deps, machines, { retiredId: row.id, kind: 'retire' }, now);
    }
    const claimed = await deps.db
      .update(schema.retiredComputers)
      .set({ status: 'deleting', nextAttemptAt: new Date(now.getTime() + RETIRED_LEASE_MS) })
      .where(and(owned, inArray(schema.retiredComputers.status, ['retired', 'deleting'])))
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

export interface Restored {
  restored: RetiredRow;
  /** The machine the member had, retired in turn; null when there was none. */
  replaced: RetiredRow | null;
  computer: ComputerRow;
}

/**
 * Support's restore (`openbots computers restore`): makes a retired machine
 * the member's computer again. The member's current machine, if there is
 * one, is checkpointed and retired in turn (kept seven days, like any
 * retired one), the retired machine's checkpoint is restored, it is put back
 * in service, and the member's computer row points at it, `stopped` with no
 * agent, so the next start provisions it with a new agent token. Refused
 * while the member's computer is being made, started or stopped (409
 * `COMPUTER_BUSY`), and for a machine already deleted or restored (409
 * `NOT_RESTORABLE`). Run again after a failure part way, it carries on.
 */
export async function restoreRetiredComputer(
  deps: Deps,
  machines: ComputerProvider,
  scope: { workspaceId: string; retiredId: string },
  by: AuditActor = SYSTEM_ACTOR,
): Promise<Restored> {
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
  if (found.provider !== machines.name || !machines.retire || !machines.unretire) {
    throw new DomainError(409, 'NOT_RESTORABLE', 'This install cannot restore that computer');
  }
  // Claimed, so the deletion job leaves it alone from here on.
  const [retired] = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'restoring', nextAttemptAt: null })
    .where(
      and(
        eq(schema.retiredComputers.id, found.id),
        inArray(schema.retiredComputers.status, ['retired', 'restoring']),
      ),
    )
    .returning();
  if (!retired) {
    throw new DomainError(
      409,
      'NOT_RESTORABLE',
      `That computer is ${found.status}, so it cannot be restored`,
    );
  }
  const release = () =>
    deps.db
      .update(schema.retiredComputers)
      .set({ status: found.status === 'restoring' ? 'retired' : found.status })
      .where(
        and(
          eq(schema.retiredComputers.id, retired.id),
          eq(schema.retiredComputers.status, 'restoring'),
        ),
      );
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
    await release();
    throw notFound('The member has no computer in this organization any more');
  }
  if (BUSY.includes(current.status)) {
    await release();
    throw new DomainError(
      409,
      'COMPUTER_BUSY',
      `The member's computer is ${current.status}; try again once it settles`,
    );
  }
  // A failure from here gives the claim back, so the machine is not left
  // `restoring`, which the deletion job never takes; the operator can run
  // the restore again, and it carries on where this one stopped.
  let unretired = false;
  let ref: ComputerRef | null = null;
  try {
    let replaced: RetiredRow | null = null;
    let row = current;
    // The member's current machine (unless it is this one, from a restore cut short).
    if (row.containerId && row.containerId !== retired.providerRef) {
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
    ref = machineRef(retired);
    if (retired.checkpointId) await machines.restore?.(ref, retired.checkpointId);
    await machines.unretire(ref);
    unretired = true;
    const result = await deps.db.transaction(async (tx) => {
      const [computer] = await tx
        .update(schema.computers)
        .set({
          containerId: retired.providerRef,
          agentUrl: null,
          agentToken: null,
          status: 'stopped',
          spec: retired.machineKey
            ? sql`jsonb_set(${schema.computers.spec}, '{machineKey}', to_jsonb(${retired.machineKey}::text))`
            : sql`${schema.computers.spec} - 'machineKey'`,
        })
        .where(eq(schema.computers.id, row.id))
        .returning();
      const [restored] = await tx
        .update(schema.retiredComputers)
        .set({ status: 'restored', restoredAt: new Date() })
        .where(eq(schema.retiredComputers.id, retired.id))
        .returning();
      await recordAudit(tx, {
        workspaceId: retired.workspaceId,
        actor: by,
        action: 'computer.restore',
        targetType: 'computer',
        targetId: row.id,
        metadata: {
          retiredId: retired.id,
          ...(retired.checkpointId ? { checkpoint: retired.checkpointId } : {}),
          ...(replaced ? { replacedBy: replaced.id } : {}),
        },
      });
      return { computer: computer!, restored: restored! };
    });
    await publishStatus(deps, result.computer, 'stopped');
    return { ...result, replaced };
  } catch (error) {
    // Put back in service but not recorded as the member's: out of service again.
    if (unretired && ref) {
      await machines
        .retire(ref)
        .catch((again: unknown) =>
          deps.logger.error({ err: again, retiredId: retired.id }, 'retiring it again failed'),
        );
    }
    await release();
    throw error;
  }
}
