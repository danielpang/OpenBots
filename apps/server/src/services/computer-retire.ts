import { randomUUID } from 'node:crypto';
import { type ComputerProvider, type ComputerRef } from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  wsEvent,
  type CoderControl,
  type JobHandler,
} from '@openbots/shared';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace, rowsOf } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { bestEffort } from './best-effort.js';
import { fenceComputer, fenceHere, fenceOf } from './computer-fence.js';
import { endStartWork } from './computer-start-work.js';
import {
  RESTORE_LEASE_MS,
  RETIRE_LEASE_MS,
  RETIRED_LEASE_MS,
  RETIRED_RECHECK_MS,
} from './computer-timing.js';
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
// 2. One transaction records the retired machine (`retiring`, with the fence
//    of its agent token and the member's choice: kept seven days, or deleted
//    now, `delete_now`) and takes it off the member's computer row, which
//    gets a new `machine_key` (so its next machine is a new Sprite under a
//    new name) and stays `stopping`, so no start begins. From its commit
//    every process refuses the old agent token (computer-fence.ts), whatever
//    it missed on the bus. Nothing of the member's data changes here.
// 3. Inline, before the reset answers, with no I/O in between: the provider
//    cuts off its reach (`retire`: label, URL private, egress denied;
//    metadata calls that need no command inside it and do not wake it).
//    Then the point of no return: one transaction seals the record
//    (`sealed_at`) and settles the reset (`settleRetire`, keyed on
//    `audited_at`, run once): the member's computer reads `stopped`, the
//    reset's cleanup runs (sign-ins signed out, checkouts `missing`,
//    worktrees cleared) and the audit rows are written. Only after that is
//    anything published; a bus that fails changes nothing.
//    If the cut fails, the reset is undone, if the record is still this
//    reset's. Since nothing of the member's changed, the undo only puts the
//    machine back: the provider puts back what it did (`unretire`), and one
//    transaction gives the member's computer its machine back with no agent
//    (its next start provisions it with a new token) and deletes the record.
//    The reset answers 503. Where the undo cannot run (the sweep took the
//    record, the provider would not put it back), the record goes to the job.
//    The job never undoes, so a record it takes is past the point of no
//    return: it settles the reset first (the same `settleRetire`, once), then
//    cuts and seals. A reset never answers success with the old machine still
//    in reach.
//
// One owner at a time: whoever holds a record (the reset that made it, the
// job, an undo, a restore) took it with one conditional UPDATE that set
// `claim` to a token of its own, and every later write of the record carries
// that token and the status it expects. One that lost the record (its lease
// ran out and the sweep took it) writes nothing and puts nothing back; a job
// checks its claim again before each call that changes the machine. The
// leases outlast the longest their holder's calls can take, each of which has
// a limit of its own (computer-timing.ts, checked as the server starts).
// 4. In the background, retried within seconds and then with backoff
//    (`retireRetryDelayMs`): the provider's steps inside the machine
//    (`retireInside`: holds dropped, agent and token removed). Then
//    `retired`. Once more past `RETIRED_RECHECK_MS`, which removes an agent a
//    provisioning the reset cancelled installed after all. A record the
//    member asked to delete is deleted instead, by every actor that finishes
//    it, and is never restorable.
// 5. The next start makes the new Sprite (computer.ts, the provisioning job).
//
// A crash between 2 and 3 leaves a `retiring` row that is not sealed, and the
// member's computer `stopping`, which no start or sweep takes over while the
// record is unsettled (computer.ts `abandonedStop`). The record's claim
// (`RETIRE_LEASE_MS`) runs out and the sweep, every `RETIRED_SWEEP_MS`,
// queues its job, which settles the reset (the member's computer released),
// cuts the reach and seals it (or, for a member who asked, deletes the
// machine), and goes on with 4. The new Sprite is only made after 2, under a name fixed in 2, so a
// provisioning retried after a crash finds the same one: never two.
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
// (`openbots computers retry`). Giving up on a record its reset never
// settled settles it in the same transaction (`settleRetire`): the member's
// computer is let go with the reset's cleanup and audit done, once, and a
// later retry settles nothing again. A machine that is a member's current
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
// The claims' time bounds, and the checks between them (computer-timing.ts).
export { RESTORE_LEASE_MS, RETIRE_LEASE_MS, RETIRED_LEASE_MS, RETIRED_RECHECK_MS };
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

function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined; e;) {
    if (e.code === '23505') return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * Tells the member's apps the computer's status: best effort. The row is
 * what counts, and a bus that is down changes neither what a reset did nor
 * what it answers.
 */
async function publishStatus(
  deps: Deps,
  row: ComputerRow,
  status: string,
  error: string | null = null,
) {
  await bestEffort(
    publishEvent(
      deps.infra.bus,
      wsEvent(
        'computer.status',
        { computerId: row.id, status, error },
        { user_id: row.ownerId, workspace_id: row.workspaceId },
      ),
    ),
    (failure) =>
      deps.logger.warn({ err: failure, computerId: row.id, status }, 'publishing a status failed'),
  );
}

/** Ends what runs on the member's computer in every process: stdio connectors and coding sessions. */
async function endWork(deps: Deps, row: ComputerRow) {
  endStartWork(row.id);
  await bestEffort(
    deps.infra.bus.publish<McpControl>(MCP_CONTROL_CHANNEL, {
      type: 'computer',
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
    }),
    (error) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping stdio connectors failed'),
  );
  await bestEffort(
    deps.infra.bus.publish<CoderControl>(CODER_CONTROL_CHANNEL, {
      type: 'stop_all',
      computerId: row.id,
    }),
    (error) =>
      deps.logger.warn({ err: error, computerId: row.id }, 'stopping coding sessions failed'),
  );
}

/** A job on `RETIRED_COMPUTERS_QUEUE`. */
export interface RetiredComputerJob {
  retiredId: string;
  workspaceId: string;
  kind: 'retire' | 'delete';
  /**
   * The row's `claim` as the one who queued it set it: the job runs only
   * while the row still carries it, and takes a claim of its own then, so of
   * a delayed retry, a job delivered twice and the sweep, one runs.
   */
  claim?: string;
}

/**
 * Queues a retire job for a row already claimed with `claim`; the sweep is
 * the fallback. Best effort and bounded (`bestEffort`): a queue that is down
 * (Redis retries for as long as it takes) never holds up a reset's answer,
 * and the claim runs out and the sweep queues it again. A job that is queued
 * late all the same runs only while the row still carries its claim.
 */
async function queueRetire(deps: Deps, row: RetiredRow, claim: string, delayMs = 0) {
  if (!deps.infra.queue) return;
  let enqueued: Promise<unknown>;
  try {
    enqueued = deps.infra
      .queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE)
      .enqueue(
        'retire',
        { retiredId: row.id, workspaceId: row.workspaceId, kind: 'retire', claim },
        { groupKey: row.id, ...(delayMs > 0 ? { delayMs } : {}) },
      );
  } catch (error) {
    enqueued = Promise.reject(error);
  }
  await bestEffort(enqueued, (error) =>
    deps.logger.error({ err: error, retiredId: row.id }, 'queueing a retired computer failed'),
  );
}

/** What a member's reset recorded, for its audit row and its cleanup (computer-reset.ts). */
export interface ResetRecord {
  requestId: string;
  signIns: boolean;
  unsaved: number;
  rescueFailed: boolean;
  checkpoint?: string | null;
  /** Where a reset with the sign-ins would keep the old computer: kept, or deleted now. */
  oldComputer?: 'kept' | 'deleted';
  /** How many checkouts it marked `missing`; set by its cleanup. */
  checkouts?: number;
}

/** Why a machine was retired and by whom (`retired_computers.context`). */
export interface RetireContext {
  reason: 'reset' | 'restore';
  by: AuditActor;
  /** The member's reset, when one retired it: its audit and cleanup go with the record. */
  reset?: ResetRecord;
}

export interface RetireOptions {
  /** The checkpoint taken just before, if one was. */
  checkpointId: string | null;
  by: AuditActor;
  /** What the audit row calls it: a member's reset, or an operator's restore. */
  reason: 'reset' | 'restore';
  /** The member's reset that asked for it, written with the record (`ResetRecord`). */
  reset?: ResetRecord;
  /**
   * Deletes the machine once it is out of reach, through the deletion job
   * (its retries, its check that the machine is no member's computer, its
   * audit), instead of keeping it: a member who wants it gone now.
   */
  deleteNow?: boolean;
  now?: Date;
}

/**
 * A reset's cleanup: every checkout of the computer becomes `missing`, the
 * member's sessions lose their worktrees, and, with the sign-ins, the coding
 * agents' sign-ins are forgotten. Only once nothing can take the reset back:
 * a reset that removed its machine (computer-reset.ts), or the transaction
 * that sealed a retired one (`settleRetire`). Returns how many checkouts it
 * marked.
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
      ...(reset.oldComputer ? { oldComputer: reset.oldComputer } : {}),
      // The disk as it was, for an operator to restore a mistaken reset (Sprites).
      ...(reset.checkpoint ? { checkpoint: reset.checkpoint } : {}),
    },
  });
}

/**
 * What follows the point of no return of a reset that retired a machine,
 * once, in `tx`, keyed on `audited_at`, by whoever gets there: the reset, in
 * the transaction that seals the record after its own cut, or the job, as it
 * takes a record the reset left (the job never undoes): the member's computer, left `stopping` by the switch, reads
 * `stopped` (its next start makes the new machine), the reset's cleanup
 * runs, and the audit rows are written. Nothing of this runs before: an undo
 * has nothing of the member's to put back. Returns the member's computer as
 * released, or null when this was done already (or it had moved on).
 */
async function settleRetire(tx: Db, row: RetiredRow): Promise<ComputerRow | null> {
  const [mark] = await tx
    .update(schema.retiredComputers)
    .set({ auditedAt: new Date() })
    .where(and(eq(schema.retiredComputers.id, row.id), isNull(schema.retiredComputers.auditedAt)))
    .returning({ id: schema.retiredComputers.id });
  if (!mark) return null;
  const context = (row.context ?? null) as RetireContext | null;
  const by = context?.by ?? SYSTEM_ACTOR;
  const target = row.computerId ?? row.id;
  // Still `stopping` with no machine: the switch left it so, and nothing
  // took it over while the record was open (computer.ts `abandonedStop`).
  const [computer] = row.computerId
    ? await tx
        .update(schema.computers)
        .set({ status: 'stopped', generation: sql`${schema.computers.generation} + 1` })
        .where(
          and(
            eq(schema.computers.id, row.computerId),
            eq(schema.computers.status, 'stopping'),
            isNull(schema.computers.containerId),
          ),
        )
        .returning()
    : [];
  // The reset's cleanup and its audit happen only while it still holds the
  // member's computer: in the transaction that releases it. A computer that
  // moved on (a row from before a give-up settled its record) is the member's
  // new one, and nothing of it is the reset's to clear.
  const holds = row.computerId === null || computer !== undefined;
  const reset =
    context?.reset && holds
      ? {
          ...context.reset,
          checkouts: await cleanupAfterReset(
            tx,
            { id: row.computerId, workspaceId: row.workspaceId, ownerId: row.ownerId },
            context.reset.signIns,
          ),
        }
      : null;
  await recordAudit(tx, {
    workspaceId: row.workspaceId,
    actor: by,
    action: 'computer.retire',
    targetType: 'computer',
    targetId: target,
    metadata: {
      retiredId: row.id,
      reason: context?.reason ?? 'reset',
      deleteAfter: row.deleteAfter.toISOString(),
      ...(row.deleteNow ? { deleteNow: true } : {}),
      ...(row.checkpointId ? { checkpoint: row.checkpointId } : {}),
    },
  });
  if (reset) await auditReset(tx, { id: target, workspaceId: row.workspaceId }, by, reset);
  return computer ?? null;
}

/** After `settleRetire` committed: the member's apps hear it, and every process the fence. */
async function announceSettled(deps: Deps, row: RetiredRow, computer: ComputerRow | null) {
  if (computer) await publishStatus(deps, computer, 'stopped');
  await fenceComputer(deps, {
    id: row.computerId ?? row.id,
    fence: row.fence,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
  });
}

/**
 * Steps 2 to 4 above for the machine `row` has now: one transaction records
 * it retired (with the member's choice to delete it now, `deleteNow`) and
 * takes it off the row, which gets a new machine key and stays `stopping`;
 * the old agent token is fenced here at once (and everywhere from the
 * commit, through the record); the provider cuts off its reach; then the
 * record is sealed and, in the same transaction, the member's computer reads
 * `stopped` and the reset's cleanup and audit are written (`settleRetire`).
 * Only then is anything published, and the steps inside it queued (or, with
 * `deleteNow`, it is deleted). `row` is the computer as the caller read or
 * claimed it: nothing happens unless it still has that machine and that
 * generation. 409 `COMPUTER_BUSY` while a job is making, starting or
 * stopping the computer; 409 `COMPUTER_CHANGED` when the row moved on (two
 * resets at once: the other one retired it). When the reach cannot be cut,
 * the reset is undone and this throws 503 (`undoRetire`); when the record
 * could not be sealed, it is left to the job and this throws 503 too. Never
 * a success with the old machine in reach.
 */
export async function retireMachine(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  { checkpointId, by, reason, reset, deleteNow = false, now: at }: RetireOptions,
): Promise<{ computer: ComputerRow; retired: RetiredRow }> {
  if (!retainsOnReset(machines)) {
    throw new Error(`The ${machines.name} provider cannot retire a machine`);
  }
  if (!row.containerId) throw new Error('The computer has no machine to retire');
  const now = at ?? new Date();
  const ref = machineRef(row);
  const key = randomUUID();
  const claim = randomUUID();
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
          statusAt: sql`clock_timestamp()`,
          generation: sql`${schema.computers.generation} + 1`,
          spec: sql`${schema.computers.spec} - 'provision'`,
        })
        .where(
          and(
            eq(schema.computers.id, row.id),
            eq(schema.computers.containerId, row.containerId!),
            eq(schema.computers.generation, row.generation),
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
      const context: RetireContext = { reason, by, ...(reset ? { reset } : {}) };
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
          // The member's choice, on the record from the start: every actor
          // that finishes it deletes it, and none restores it.
          deleteNow,
          deleteAfter: deleteNow ? now : new Date(now.getTime() + RETIRED_COMPUTER_DAYS * DAY_MS),
          // Claimed by this call; the sweep takes it only once the lease runs out.
          claim,
          nextAttemptAt: leaseEnd(RETIRE_LEASE_MS, at),
          fence: fenceOf(row.agentToken),
          context,
        })
        .returning();
      return { computer, retired: retired! };
    });
  } catch (error) {
    // Two resets of one machine at once: the record's unique index refused the second.
    if (isUniqueViolation(error)) throw computerChanged();
    throw error;
  }
  // No I/O between the record and the cut: here the old token is refused at
  // once (other processes read it from the record), and the cut comes next.
  fenceHere({
    id: row.id,
    fence: switched.retired.fence,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
  });
  endStartWork(row.id);
  try {
    await machines.retire!(ref);
  } catch (error) {
    return undoRetire(deps, machines, row, switched, claim, error, at);
  }
  const next = randomUUID();
  let done: { computer: ComputerRow | null; retired: RetiredRow } | null;
  try {
    done = await deps.db.transaction(async (tx) => {
      const sealed = new Date();
      const [retired] = await tx
        .update(schema.retiredComputers)
        .set(
          deleteNow
            ? {
                sealedAt: sealed,
                status: 'deleting',
                claim: next,
                nextAttemptAt: leaseEnd(RETIRED_LEASE_MS, at),
                lastError: null,
              }
            : {
                sealedAt: sealed,
                claim: next,
                nextAttemptAt: leaseEnd(RETIRE_LEASE_MS, at),
                lastError: null,
              },
        )
        .where(
          and(
            eq(schema.retiredComputers.id, switched.retired.id),
            eq(schema.retiredComputers.status, 'retiring'),
            eq(schema.retiredComputers.claim, claim),
            isNull(schema.retiredComputers.sealedAt),
          ),
        )
        .returning();
      // The sweep took the record past this reset's lease: its job settles it.
      if (!retired) return null;
      return { computer: await settleRetire(tx as unknown as Db, retired), retired };
    });
  } catch (error) {
    // The machine is out of reach (this reset's own cut went through); what
    // is left is the record's, and the job does it.
    deps.logger.error(
      { err: error, computerId: row.id, retiredId: switched.retired.id },
      'sealing a retired computer failed; the job finishes it',
    );
    await handToJob(deps, switched.retired.id, claim, 'retiring', error);
    throw finishingInBackground();
  }
  if (!done) {
    const [computer] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row.id))
      .catch(() => []);
    return { computer: computer ?? switched.computer, retired: switched.retired };
  }
  await announceSettled(deps, done.retired, done.computer);
  if (deleteNow) {
    await runRetiredComputerJob(deps, machines, {
      retiredId: done.retired.id,
      kind: 'delete',
      claim: next,
    }).catch((error: unknown) =>
      // The record is due and the job's retries take it from here.
      deps.logger.error(
        { err: error, retiredId: done.retired.id },
        'deleting the old computer failed',
      ),
    );
  } else {
    await queueRetire(deps, done.retired, next);
  }
  // The reset is done: a read that fails now does not turn it into an error.
  const [computer] = done.computer
    ? [done.computer]
    : await deps.db
        .select()
        .from(schema.computers)
        .where(eq(schema.computers.id, row.id))
        .catch(() => []);
  return { computer: computer ?? switched.computer, retired: done.retired };
}

/** The reset's 503 when the job finishes what it began. */
const finishingInBackground = () =>
  new DomainError(
    503,
    'COMPUTER_UNAVAILABLE',
    'The reset did not finish shutting off the old computer. It is retried in the background.',
  );

/**
 * Leaves a record its holder (`claim`) could not finish to the job: a claim
 * of the job's, due now, queued. Best effort: if this fails too, the claim
 * runs out and the sweep queues it.
 */
async function handToJob(
  deps: Deps,
  id: string,
  claim: string,
  status: 'retiring',
  why: unknown,
): Promise<void> {
  try {
    const job = randomUUID();
    const [retired] = await deps.db
      .update(schema.retiredComputers)
      .set({
        claim: job,
        attempts: sql`${schema.retiredComputers.attempts} + 1`,
        lastAttemptAt: new Date(),
        lastError: errorText(why),
        nextAttemptAt: new Date(),
      })
      .where(
        and(
          eq(schema.retiredComputers.id, id),
          eq(schema.retiredComputers.status, status),
          eq(schema.retiredComputers.claim, claim),
        ),
      )
      .returning();
    if (retired) await queueRetire(deps, retired, job);
  } catch (error) {
    deps.logger.error(
      { err: error, retiredId: id },
      'handing a retired computer to the job failed',
    );
  }
}

/**
 * The reach of the old machine could not be cut: undoes the reset, if the
 * record is still this reset's. Nothing of the member's changed (the cleanup
 * and audit wait for the seal), so the undo puts back only the machine: the
 * record is taken for it (one conditional UPDATE), the provider puts back
 * what its cut did (`unretire`), and one transaction gives the member's
 * computer its machine back, `stopped` with no agent (the old token stays
 * fenced, so its next start provisions the machine with a new one), and
 * deletes the record. Always throws 503: that the computer could not be
 * reset and is as it was; or, when the undo lost the record (the sweep took
 * it), the provider could not put the machine back, or the member's computer
 * moved on meanwhile, that the reset finishes in the background (the record
 * is left to the job, which never undoes: it cuts and seals).
 */
async function undoRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  switched: { computer: ComputerRow; retired: RetiredRow },
  claim: string,
  error: unknown,
  at: Date | undefined,
): Promise<never> {
  deps.logger.error(
    { err: error, computerId: row.id, retiredId: switched.retired.id },
    'cutting off the old computer failed; the reset is undone',
  );
  const id = switched.retired.id;
  const undo = randomUUID();
  const ours = and(
    eq(schema.retiredComputers.id, id),
    eq(schema.retiredComputers.status, 'retiring'),
    isNull(schema.retiredComputers.sealedAt),
    eq(schema.retiredComputers.claim, undo),
  );
  let back: ComputerRow | null;
  try {
    const [taken] = await deps.db
      .update(schema.retiredComputers)
      .set({ claim: undo, nextAttemptAt: leaseEnd(RETIRE_LEASE_MS, at) })
      .where(
        and(
          eq(schema.retiredComputers.id, id),
          eq(schema.retiredComputers.status, 'retiring'),
          isNull(schema.retiredComputers.sealedAt),
          eq(schema.retiredComputers.claim, claim),
        ),
      )
      .returning();
    // The sweep took it past this reset's lease: its job cuts the machine off.
    if (!taken) throw finishingInBackground();
    try {
      await machines.unretire!(machineRef(row));
    } catch (again) {
      deps.logger.error(
        { err: again, computerId: row.id },
        'putting the computer back after a failed reset failed; it is retired in the background',
      );
      await handToJob(deps, id, undo, 'retiring', error);
      throw finishingInBackground();
    }
    const { provision: _, ...spec } = (row.spec ?? {}) as Record<string, unknown>;
    back = await deps.db
      .transaction(async (tx) => {
        const gone = await tx
          .delete(schema.retiredComputers)
          .where(ours)
          .returning({ id: schema.retiredComputers.id });
        if (!gone.length) return null;
        const [computer] = await tx
          .update(schema.computers)
          .set({
            containerId: row.containerId,
            agentUrl: null,
            agentToken: null,
            machineKey: row.machineKey,
            status: 'stopped',
            generation: sql`${schema.computers.generation} + 1`,
            spec,
          })
          .where(
            and(
              eq(schema.computers.id, row.id),
              eq(schema.computers.status, 'stopping'),
              isNull(schema.computers.containerId),
              eq(schema.computers.generation, switched.computer.generation),
            ),
          )
          .returning();
        // Moved on meanwhile: nothing of this transaction stands.
        if (!computer) throw new UndoLost();
        return computer;
      })
      .catch((lost: unknown) => {
        if (lost instanceof UndoLost) return null;
        throw lost;
      });
    // The machine is in service again but not the member's: the job retires it again.
    if (!back) {
      await handToJob(deps, id, undo, 'retiring', error);
      throw finishingInBackground();
    }
  } catch (failure) {
    if (failure instanceof DomainError) throw failure;
    // A database that failed mid undo: the record keeps a claim that runs
    // out, and the job finishes the reset.
    deps.logger.error({ err: failure, computerId: row.id }, 'undoing a reset failed');
    throw finishingInBackground();
  }
  await publishStatus(deps, back, 'stopped');
  throw new DomainError(
    503,
    'COMPUTER_UNAVAILABLE',
    'The computer could not be reset. It was stopped and its coding sessions ended, but its files and sign-ins are as they were. Try the reset again in a few minutes.',
  );
}

class UndoLost extends Error {}

/**
 * Claims what is due in the current organization and queues a job for each:
 * rows past `delete_after` (and `deleting` rows whose claim ran out) to
 * delete, `restoring` rows whose lease ran out to retire again, and
 * `retiring` rows whose retry is due. Returns how many it queued. Each claim
 * is one UPDATE with the condition in it that sets a new claim token per
 * row, so of several workers sweeping at once only one takes a row, and a
 * job of an earlier claim does nothing. Rows the job gave up on are left to
 * an operator.
 */
export async function sweepRetiredComputers(deps: SweepDeps, at?: Date): Promise<number> {
  const now = at ?? new Date();
  const lease = leaseEnd(RETIRED_LEASE_MS, at);
  const retireLease = leaseEnd(RETIRE_LEASE_MS, at);
  const fresh = sql`gen_random_uuid()`;
  // A claim runs out on the clock it was written on (`leaseEnd`).
  const ranOut = sql`${schema.retiredComputers.nextAttemptAt} <= ${clockAt(at)}`;
  const due = or(isNull(schema.retiredComputers.nextAttemptAt), ranOut);
  const tried = isNull(schema.retiredComputers.gaveUpAt);
  const deleting = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'deleting', claim: fresh, nextAttemptAt: lease })
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
          and(eq(schema.retiredComputers.status, 'deleting'), ranOut),
        ),
      ),
    )
    .returning();
  // A restore cut short (its process died): retired again from the start.
  const recovered = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'retiring', sealedAt: null, claim: fresh, nextAttemptAt: retireLease })
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
    .set({ claim: fresh, nextAttemptAt: retireLease })
    .where(and(tried, eq(schema.retiredComputers.status, 'retiring'), due))
    .returning();
  // Once more, past the longest a provisioning the reset cancelled could
  // still run: the steps inside it again, which remove an agent it installed
  // after all. Sealed, so nothing of the member's runs again.
  const recheck = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'retiring', claim: fresh, nextAttemptAt: retireLease })
    .where(
      and(
        tried,
        eq(schema.retiredComputers.status, 'retired'),
        isNotNull(schema.retiredComputers.sealedAt),
        isNull(schema.retiredComputers.checkedAt),
        lte(schema.retiredComputers.retiredAt, new Date(now.getTime() - RETIRED_RECHECK_MS)),
        due,
      ),
    )
    .returning();
  const queue = deps.infra.queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE);
  let queued = 0;
  for (const [rows, kind] of [
    [deleting, 'delete'],
    [[...recovered, ...retiring, ...recheck], 'retire'],
  ] as const) {
    for (const row of rows) {
      try {
        await queue.enqueue(
          kind,
          { retiredId: row.id, workspaceId: row.workspaceId, kind, claim: row.claim! },
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

/** The row's own claim: what every write of a job that holds it requires. */
const held = (row: RetiredRow, status: string) =>
  and(
    eq(schema.retiredComputers.id, row.id),
    eq(schema.retiredComputers.status, status),
    row.claim === null
      ? isNull(schema.retiredComputers.claim)
      : eq(schema.retiredComputers.claim, row.claim),
  );

/** Thrown by a job's check when its claim on the record was taken meanwhile. */
class ClaimLost extends Error {}

/**
 * Records a failed attempt: retried with backoff, or given up after
 * `RETIRED_MAX_ATTEMPTS`. A sealed retire whose steps inside keep failing is
 * given up as out of reach (deleted when due) only when the whole cut
 * resolved in this attempt (`cutOk`) or the provider reads every part of it
 * back as set (`retiredState`); otherwise it waits for an operator like any
 * other.
 */
async function failed(
  deps: Deps,
  machines: ComputerProvider | null,
  row: RetiredRow,
  from: 'retiring' | 'deleting',
  error: unknown,
  now: Date,
  cutOk = false,
) {
  const attempts = row.attempts + 1;
  const giveUp = attempts >= RETIRED_MAX_ATTEMPTS;
  const sealed = row.sealedAt !== null;
  // A deletion that fails puts the row back where the sweep finds it.
  const status = from === 'deleting' ? (sealed ? 'retired' : 'retiring') : 'retiring';
  const delay = from === 'deleting' ? retiredRetryDelayMs(attempts) : retireRetryDelayMs(attempts);
  const retryAt = new Date(now.getTime() + delay);
  // The steps inside a machine already out of reach are not worth an
  // operator's time: it is deleted when due all the same. Out of reach is
  // what the provider says now, not what the row said once.
  let outOfReach = false;
  if (giveUp && from === 'retiring' && sealed) {
    outOfReach = cutOk;
    if (!outOfReach) {
      try {
        // A provider that cannot say keeps it for an operator.
        const state =
          machines?.name === row.provider && machines.retiredState
            ? await machines.retiredState(machineRef(row))
            : null;
        outOfReach = state === 'retired' || state === 'gone';
      } catch (again) {
        deps.logger.warn({ err: again, retiredId: row.id }, 'checking a retired computer failed');
      }
    }
  }
  const claim = randomUUID();
  const set = giveUp
    ? outOfReach
      ? {
          status: 'retired',
          claim: null,
          nextAttemptAt: null,
          checkedAt: now,
          lastError: `Gave up the steps inside it after ${attempts} attempts: ${errorText(error)}`,
        }
      : {
          status,
          claim: null,
          // Not recorded as out of reach: nothing says it is.
          ...(from === 'retiring' ? { sealedAt: null } : {}),
          gaveUpAt: now,
          nextAttemptAt: null,
          lastError: errorText(error),
        }
    : { status, claim, nextAttemptAt: retryAt, lastError: errorText(error) };
  // Giving up on a record its reset never settled releases the member's
  // computer, so the reset is settled in the same transaction: the member's
  // choice (sign-ins forgotten, checkouts and worktrees cleared) and its audit
  // land now, while the reset still holds the computer, and never later on
  // what the member does next.
  const settle = giveUp && !row.auditedAt;
  const result = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.retiredComputers)
      .set({ ...set, attempts, lastAttemptAt: now })
      .where(held(row, from))
      .returning();
    if (!updated) return null;
    const computer = settle ? await settleRetire(tx as unknown as Db, updated) : null;
    return { updated, computer };
  });
  if (!result) return;
  const { updated } = result;
  if (settle) await announceSettled(deps, updated, result.computer);
  if (giveUp) {
    deps.logger.error(
      { err: error, retiredId: row.id, attempts, sealed },
      outOfReach
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
  if (from === 'retiring') await queueRetire(deps, updated, claim, delay);
}

/** Throws `ClaimLost` unless the row still carries the claim the job holds. */
function claimCheck(deps: Deps, row: RetiredRow, status: string) {
  return async () => {
    const [still] = await deps.db
      .select({ id: schema.retiredComputers.id })
      .from(schema.retiredComputers)
      .where(held(row, status));
    if (!still) throw new ClaimLost();
  };
}

/**
 * The retire job, on a row it claimed. It never undoes: the reach is cut
 * (again, on every attempt: safe to repeat, and it takes back anything a
 * provisioning the reset cancelled put back); a record not yet sealed is
 * sealed and settled in one transaction (`settleRetire`: the member's
 * computer released, the reset's cleanup and audit); then, for a member who
 * asked for it, the machine is deleted, else the steps inside it run and it
 * is `retired` (and `checked_at` once that ran past `RETIRED_RECHECK_MS`).
 * Before each call that changes the machine it checks that it still holds
 * the record.
 */
async function finishRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: RetiredRow,
  now: Date,
  at: Date | undefined,
): Promise<void> {
  const ref = machineRef(row);
  const check = claimCheck(deps, row, 'retiring');
  let cutOk = false;
  try {
    await check();
    await machines.retire!(ref);
    cutOk = true;
    if (!row.sealedAt || row.deleteNow) {
      const next = randomUUID();
      const sealedAt = row.sealedAt ?? now;
      const sealed = await deps.db.transaction(async (tx) => {
        const [sealed] = await tx
          .update(schema.retiredComputers)
          .set(
            row.deleteNow
              ? {
                  sealedAt,
                  status: 'deleting',
                  claim: next,
                  nextAttemptAt: leaseEnd(RETIRED_LEASE_MS, at),
                }
              : { sealedAt },
          )
          .where(held(row, 'retiring'))
          .returning();
        return sealed ?? null;
      });
      if (!sealed) return;
      if (row.deleteNow) {
        await runRetiredComputerJob(
          deps,
          machines,
          { retiredId: row.id, kind: 'delete', claim: next },
          at,
        );
        return;
      }
      row = sealed;
    }
    await machines.retireInside!(ref, { check: claimCheck(deps, row, 'retiring') });
  } catch (error) {
    if (error instanceof ClaimLost) {
      deps.logger.info({ retiredId: row.id }, 'a retired computer was taken by another job');
      return;
    }
    await failed(deps, machines, row, 'retiring', error, now, cutOk);
    return;
  }
  const rechecked = row.retiredAt.getTime() <= now.getTime() - RETIRED_RECHECK_MS;
  await deps.db
    .update(schema.retiredComputers)
    .set({
      status: 'retired',
      claim: null,
      lastAttemptAt: now,
      lastError: null,
      nextAttemptAt: null,
      ...(rechecked ? { checkedAt: now } : {}),
    })
    .where(held(row, 'retiring'));
}

/**
 * The job: finishes retiring a `retiring` row, or deletes a `deleting` one
 * for good, once it took the row from the claim it was queued with (a claim
 * of its own, so a job delivered twice runs once). Does nothing for a row in
 * any other status (another worker finished it, or an operator restored it
 * meanwhile) or for a claim another took. Where the install has not the
 * row's provider, the attempt fails and counts toward giving up.
 */
export async function runRetiredComputerJob(
  deps: Deps,
  machines: ComputerProvider | null,
  job: Pick<RetiredComputerJob, 'retiredId' | 'kind' | 'claim'>,
  at?: Date,
): Promise<void> {
  const now = at ?? new Date();
  const [found] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(eq(schema.retiredComputers.id, job.retiredId));
  if (!found) return;
  const status = job.kind === 'retire' ? 'retiring' : 'deleting';
  if (found.status !== status || (job.kind === 'retire' && found.gaveUpAt)) return;
  if (!job.claim || !UUID.test(job.claim)) return;
  // Still this job's: take the claim, its own, for the time it runs.
  const [row] = await deps.db
    .update(schema.retiredComputers)
    .set({
      claim: randomUUID(),
      nextAttemptAt: leaseEnd(job.kind === 'retire' ? RETIRE_LEASE_MS : RETIRED_LEASE_MS, at),
    })
    .where(
      and(
        eq(schema.retiredComputers.id, found.id),
        eq(schema.retiredComputers.status, status),
        eq(schema.retiredComputers.claim, job.claim),
      ),
    )
    .returning();
  if (!row) return;
  // A provider this install does not have (not configured, or another one):
  // a failed attempt like any other, retried with backoff and then given up
  // for an operator (`gave_up_at`, `computers retired --gave-up`); giving up
  // settles the reset, which lets the member's computer go (`failed`). Never
  // left waiting without a count.
  if (!machines || machines.name !== row.provider || !retainsOnReset(machines)) {
    await failed(
      deps,
      null,
      row,
      status,
      new Error(`This install has no ${row.provider} provider to finish it`),
      now,
    );
    return;
  }
  // A record the reset did not settle (its process died, its cut failed and
  // could not be undone, its seal failed): the job never undoes it, so this
  // is past the point of no return. Settled first, before any call on the
  // machine, so the member's computer is not held while the job works.
  if (!row.auditedAt) {
    const settled = await deps.db.transaction(async (tx) => {
      const [still] = await tx
        .select()
        .from(schema.retiredComputers)
        .where(held(row, status))
        .for('update');
      if (!still) return null;
      return { computer: await settleRetire(tx as unknown as Db, still) };
    });
    if (!settled) return;
    await announceSettled(deps, row, settled.computer);
  }
  if (job.kind === 'retire') {
    await finishRetire(deps, machines, row, now, at);
    return;
  }
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
        claim: null,
        lastAttemptAt: now,
        lastError: "It is a member's current computer, so it was not deleted",
        nextAttemptAt: new Date(now.getTime() + RETIRED_RETRY_MAX_MS),
      })
      .where(held(row, 'deleting'));
    return;
  }
  try {
    // Deleting a machine already gone is not an error (the provider's destroy).
    await machines.destroy(ref, { computerId: row.computerId ?? row.id, home: true, state: true });
  } catch (error) {
    await failed(deps, machines, row, 'deleting', error, now);
    return;
  }
  await deps.db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(schema.retiredComputers)
      .set({
        status: 'deleted',
        claim: null,
        deletedAt: now,
        lastAttemptAt: now,
        lastError: null,
        nextAttemptAt: null,
      })
      .where(held(row, 'deleting'))
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      .set({
        status: 'deleting',
        claim: sql`gen_random_uuid()`,
        nextAttemptAt: leaseEnd(RETIRED_LEASE_MS),
      })
      .where(
        and(owned, inArray(schema.retiredComputers.status, ['retiring', 'retired', 'deleting'])),
      )
      .returning();
    for (const row of claimed) {
      await runRetiredComputerJob(deps, machines, {
        retiredId: row.id,
        kind: 'delete',
        claim: row.claim!,
      });
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

/** Every row of an organization the job gave up on, oldest first (`computers retired --gave-up`). */
export async function listGivenUp(db: Db, scope: { workspaceId: string }): Promise<RetiredRow[]> {
  return db
    .select()
    .from(schema.retiredComputers)
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, scope.workspaceId),
        isNotNull(schema.retiredComputers.gaveUpAt),
      ),
    )
    .orderBy(schema.retiredComputers.gaveUpAt);
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
  at?: Date,
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
  const lease = leaseEnd(RESTORE_LEASE_MS, at);
  const claim = randomUUID();
  const [retired] = await deps.db
    .update(schema.retiredComputers)
    .set({ status: 'restoring', claim, nextAttemptAt: lease })
    .where(
      and(
        eq(schema.retiredComputers.id, found.id),
        isNull(schema.retiredComputers.gaveUpAt),
        sql`${schema.retiredComputers.sealedAt} is not null`,
        eq(schema.retiredComputers.status, 'retired'),
        // The member asked for it gone: never brought back.
        eq(schema.retiredComputers.deleteNow, false),
      ),
    )
    .returning();
  if (!retired) {
    throw notRestorable(
      found.deleteNow
        ? 'Its owner asked for that computer to be deleted, so it cannot be restored'
        : found.gaveUpAt
          ? 'That computer is waiting for an operator to retry it, so it cannot be restored'
          : `That computer is ${found.status}, so it cannot be restored`,
    );
  }
  const ours = and(
    eq(schema.retiredComputers.id, retired.id),
    eq(schema.retiredComputers.status, 'restoring'),
    eq(schema.retiredComputers.claim, claim),
  );
  /** Gives the claim back: `retired`, or `retiring` (due now) when it is not out of reach. */
  const release = (sealed: boolean) =>
    deps.db
      .update(schema.retiredComputers)
      .set(
        sealed
          ? { status: 'retired', claim: null, nextAttemptAt: null }
          : // Due now, for the sweep to claim and finish.
            { status: 'retiring', sealedAt: null, claim: null, nextAttemptAt: null },
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
  let replaced: RetiredRow | null = null;
  const ref = machineRef(retired);
  try {
    let row = current;
    // The row names every machine that may still exist under it, one whose
    // home a reset cleared in place too (computer.ts `resetMachine`): it is
    // retired, never left in service unnamed.
    if (row.containerId) {
      await endWork(deps, row);
      let checkpointId: string | null = null;
      if (machines.checkpoint) {
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
    // Before each call that changes the machine: still this restore's (the
    // sweep takes it back once the lease runs out).
    const stillOurs = async () => {
      const [still] = await deps.db
        .select({ id: schema.retiredComputers.id })
        .from(schema.retiredComputers)
        .where(ours);
      if (!still) throw computerChanged();
    };
    await stillOurs();
    // Set before anything changes the machine: a checkpoint restore puts its
    // old agent and token back on the disk, and a restore or an unretire that
    // fails part way (or lands though its answer was lost) still leaves it to
    // be cut and cleared inside again.
    unretired = true;
    if (retired.checkpointId) {
      await machines.restore?.(ref, retired.checkpointId);
      await stillOurs();
    }
    await machines.unretire!(ref);
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
          generation: sql`${schema.computers.generation} + 1`,
        })
        .where(
          and(
            eq(schema.computers.id, row.id),
            isNull(schema.computers.containerId),
            notInArray(schema.computers.status, BUSY),
            eq(schema.computers.generation, row.generation),
            row.machineKey === null
              ? isNull(schema.computers.machineKey)
              : eq(schema.computers.machineKey, row.machineKey),
          ),
        )
        .returning();
      if (!computer) throw computerChanged();
      const [restored] = await tx
        .update(schema.retiredComputers)
        .set({ status: 'restored', restoredAt: new Date(), claim: null, nextAttemptAt: null })
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
    // What the record says now decides what is left to do. The last
    // transaction may have committed though its answer was lost: the machine
    // is then the member's computer, and nothing of it is undone.
    let now: Pick<RetiredRow, 'status' | 'claim'> | null | 'unknown';
    try {
      const [read] = await deps.db
        .select({ status: schema.retiredComputers.status, claim: schema.retiredComputers.claim })
        .from(schema.retiredComputers)
        .where(eq(schema.retiredComputers.id, retired.id));
      now = read ?? null;
    } catch (again) {
      now = 'unknown';
      deps.logger.error({ err: again, retiredId: retired.id }, 'reading a restore back failed');
    }
    if (now !== 'unknown' && now?.status === 'restored') {
      const done = await restoredAfterAll(deps, retired, replaced).catch(() => null);
      if (done) return done;
      // Committed, but not readable now: the restore stands; the operator reads it again.
      throw error;
    }
    // Not readable: the lease runs out, and the sweep takes the machine back
    // if the restore did not commit (`sweepRetiredComputers`). Cutting it
    // here could cut off a machine that is the member's after all.
    if (now === 'unknown') throw error;
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

/**
 * A restore whose last transaction committed though its caller saw it fail:
 * what it made, read back. Null when the member's computer no longer names
 * the restored machine (something moved it on since).
 */
async function restoredAfterAll(
  deps: Deps,
  retired: RetiredRow,
  replaced: RetiredRow | null,
): Promise<Restored | null> {
  const [restored] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(eq(schema.retiredComputers.id, retired.id));
  const [computer] = await deps.db
    .select()
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.workspaceId, retired.workspaceId),
        eq(schema.computers.ownerId, retired.ownerId),
        eq(schema.computers.containerId, retired.providerRef),
      ),
    );
  if (!restored || !computer) return null;
  deps.logger.warn(
    { retiredId: retired.id, computerId: computer.id },
    'a restore committed though its answer was lost; it stands',
  );
  return { restored, replaced, computer };
}
