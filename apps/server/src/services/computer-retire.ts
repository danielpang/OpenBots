import { randomUUID } from 'node:crypto';
import {
  SPRITES_RETIRE_MAX_MS,
  SPRITES_UNRETIRE_MAX_MS,
  type ComputerProvider,
  type ComputerRef,
} from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  wsEvent,
  type CoderControl,
  type JobHandler,
} from '@openbots/shared';
import { and, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace, rowsOf } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { fenceComputer, fenceOf } from './computer-fence.js';
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
//    seven days, with the fence of its agent token) and takes it off the
//    member's computer row, which gets a new `machine_key` (so its next
//    machine is a new Sprite under a new name) and reads `stopping`
//    meanwhile, so no start begins. From its commit every process refuses
//    the old agent token (computer-fence.ts), whatever it missed on the bus.
// 3. Inline, before the reset answers: the provider cuts off its reach
//    (`retire`: label, URL private, egress denied; metadata calls that need
//    no command inside it and do not wake it). Then the row is sealed
//    (`sealed_at`), the member's computer reads `stopped`, and the audit
//    rows and the reset's cleanup are written, once, by whoever seals it.
//    If the cut fails, the reset is undone, if the record is still this
//    reset's: the provider puts back what it did (`unretire`), the member's
//    computer gets its machine back with no agent (its next start provisions
//    it with a new token, as after a restore), the record goes, and the reset
//    answers 503. A reset never answers success with the old machine still in
//    reach.
//
// One owner at a time: whoever holds a record (the reset that made it, the
// job, an undo, a restore) took it with one conditional UPDATE that set
// `claim` to a token of its own, and every later write of the record carries
// that token and the status it expects. One that lost the record (its lease
// ran out and the sweep took it) writes nothing and puts nothing back. The
// reset's lease (`RETIRE_LEASE_MS`) outlasts the longest its provider's cut
// and undo can take, each of whose calls has a short limit of its own.
// 4. In the background, retried within seconds and then with backoff
//    (`retireRetryDelayMs`): the provider's steps inside the machine
//    (`retireInside`: holds dropped, agent and token removed). Then `retired`.
// 5. The next start makes the new Sprite (computer.ts, the provisioning job).
//
// A crash between 2 and 3 leaves a `retiring` row that is not sealed: its
// claim (`RETIRE_LEASE_MS`) runs out and the sweep, every `RETIRED_SWEEP_MS`,
// queues its job, which puts the member's computer back to `stopped` at once,
// fences the old token again over the bus, cuts the reach, writes the audit
// rows and the reset's cleanup the reset did not get to, and goes on with 4. The new Sprite is only made after 2, under a
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
/**
 * How long a retire's claim lasts: past the longest the reset's own cut and
 * undo can take (`SPRITES_RETIRE_MAX_MS` and `SPRITES_UNRETIRE_MAX_MS`, each
 * call limited), so the sweep does not take a record whose reset is still
 * at work. The claim token keeps a late one from writing all the same.
 */
export const RETIRE_LEASE_MS = 5 * 60_000;
if (RETIRE_LEASE_MS <= SPRITES_RETIRE_MAX_MS + SPRITES_UNRETIRE_MAX_MS + 60_000) {
  throw new Error('RETIRE_LEASE_MS must outlast a cut and its undo');
}
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
   * The row's `claim` as the one who queued it set it: the job runs only
   * while the row still carries it, and takes a claim of its own then, so of
   * a delayed retry, a job delivered twice and the sweep, one runs.
   */
  claim?: string;
}

/** Queues a retire job for a row already claimed with `claim`; the sweep is the fallback. */
async function queueRetire(deps: Deps, row: RetiredRow, claim: string, delayMs = 0) {
  if (!deps.infra.queue) return;
  try {
    await deps.infra
      .queue<RetiredComputerJob>(RETIRED_COMPUTERS_QUEUE)
      .enqueue(
        'retire',
        { retiredId: row.id, workspaceId: row.workspaceId, kind: 'retire', claim },
        { groupKey: row.id, ...(delayMs > 0 ? { delayMs } : {}) },
      );
  } catch (error) {
    // The claim runs out and the sweep queues it again.
    deps.logger.error({ err: error, retiredId: row.id }, 'queueing a retired computer failed');
  }
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
 * A reset's cleanup, in `tx`, in the transaction that takes the machine away:
 * every checkout of the computer becomes `missing`, the member's sessions
 * lose their worktrees, and, with the sign-ins, the coding agents' sign-ins
 * are forgotten. Returns how many checkouts it marked.
 */
export async function cleanupAfterReset(
  tx: Db,
  computer: { id: string; workspaceId: string; ownerId: string },
  signIns: boolean,
): Promise<number> {
  const checkouts = await tx
    .update(schema.repoCheckouts)
    .set({ state: 'missing', error: null, updatedAt: new Date() })
    .where(eq(schema.repoCheckouts.computerId, computer.id))
    .returning({ id: schema.repoCheckouts.id });
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
 * The audit rows of a retired machine (and of the reset that retired it),
 * written once the machine is out of reach, by whoever gets there first (the
 * reset that sealed it, or the job that finished what a reset cut short):
 * `audited_at` says it was done.
 */
async function completeRetire(tx: Db, row: RetiredRow): Promise<void> {
  const [mark] = await tx
    .update(schema.retiredComputers)
    .set({ auditedAt: new Date() })
    .where(and(eq(schema.retiredComputers.id, row.id), isNull(schema.retiredComputers.auditedAt)))
    .returning({ id: schema.retiredComputers.id });
  if (!mark) return;
  const context = (row.context ?? null) as RetireContext | null;
  const by = context?.by ?? SYSTEM_ACTOR;
  const target = row.computerId ?? row.id;
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
      ...(row.checkpointId ? { checkpoint: row.checkpointId } : {}),
    },
  });
  if (context?.reset) {
    await auditReset(tx, { id: target, workspaceId: row.workspaceId }, by, context.reset);
  }
}

/** The member's computer, back to `stopped` with no machine, where a retire left it `stopping`. */
async function releaseComputer(deps: Deps, row: RetiredRow): Promise<ComputerRow | null> {
  if (!row.computerId) return null;
  const [computer] = await deps.db
    .update(schema.computers)
    .set({ status: 'stopped', generation: sql`${schema.computers.generation} + 1` })
    .where(
      and(
        eq(schema.computers.id, row.computerId),
        eq(schema.computers.status, 'stopping'),
        isNull(schema.computers.containerId),
      ),
    )
    .returning();
  if (computer) await publishStatus(deps, computer, 'stopped');
  return computer ?? null;
}

/**
 * Steps 2 to 4 above for the machine `row` has now: records it retired,
 * takes it off the row (which gets a new machine key and reads `stopped`
 * with no machine), fences its agent token everywhere, cuts off its reach
 * through the provider, and queues the steps inside it (or, with
 * `deleteNow`, deletes it). `row` is the computer as the caller read or
 * claimed it: nothing happens unless it still has that machine and that
 * generation. The row as it now is. 409 `COMPUTER_BUSY` while a job is
 * making, starting or stopping the computer; 409 `COMPUTER_CHANGED` when the
 * row moved on (two resets at once: the other one retired it). When the
 * reach cannot be cut, the reset is undone and this throws 503
 * (`undoRetire`).
 */
export async function retireMachine(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  { checkpointId, by, reason, reset, deleteNow = false, now = new Date() }: RetireOptions,
): Promise<{ computer: ComputerRow; retired: RetiredRow }> {
  if (!retainsOnReset(machines)) {
    throw new Error(`The ${machines.name} provider cannot retire a machine`);
  }
  if (!row.containerId) throw new Error('The computer has no machine to retire');
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
      // The reset's cleanup goes with the machine: the next machine starts with none of it.
      const checkouts = reset
        ? await cleanupAfterReset(tx as unknown as Db, row, reset.signIns)
        : undefined;
      const context: RetireContext = {
        reason,
        by,
        ...(reset ? { reset: { ...reset, checkouts } } : {}),
      };
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
          // Claimed by this call; the sweep takes it only once the lease runs out.
          claim,
          nextAttemptAt: new Date(now.getTime() + RETIRE_LEASE_MS),
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
  await publishStatus(deps, switched.computer, 'stopping');
  endStartWork(row.id);
  // The old agent token is never used again, whatever follows (an undo
  // provisions the machine with a new one): every process refuses it now.
  await fenceComputer(deps, { id: row.id, fence: switched.retired.fence });
  try {
    await machines.retire!(ref);
  } catch (error) {
    return undoRetire(deps, machines, row, switched, claim, error, now);
  }
  const sealed = new Date();
  const ours = and(
    eq(schema.retiredComputers.id, switched.retired.id),
    eq(schema.retiredComputers.status, 'retiring'),
    eq(schema.retiredComputers.claim, claim),
  );
  const next = randomUUID();
  const done = await deps.db.transaction(async (tx) => {
    const [retired] = await tx
      .update(schema.retiredComputers)
      .set(
        deleteNow
          ? {
              sealedAt: sealed,
              status: 'deleting',
              deleteAfter: sealed,
              claim: next,
              nextAttemptAt: new Date(sealed.getTime() + RETIRED_LEASE_MS),
              lastError: null,
            }
          : {
              sealedAt: sealed,
              claim: next,
              nextAttemptAt: new Date(sealed.getTime() + RETIRE_LEASE_MS),
              lastError: null,
            },
      )
      .where(and(ours, isNull(schema.retiredComputers.sealedAt)))
      .returning();
    // The sweep took the record past this reset's lease: it finishes it.
    if (!retired) return null;
    const [computer] = await tx
      .update(schema.computers)
      .set({ status: 'stopped' })
      .where(
        and(
          eq(schema.computers.id, row.id),
          eq(schema.computers.machineKey, key),
          eq(schema.computers.status, 'stopping'),
          eq(schema.computers.generation, switched.computer.generation),
        ),
      )
      .returning();
    await completeRetire(tx as unknown as Db, retired);
    return { computer: computer ?? switched.computer, retired };
  });
  if (!done) {
    // This reset's own cut went through, so the machine is out of reach;
    // what is left is the job's that took the record.
    const [computer] = await deps.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row.id));
    return { computer: computer ?? switched.computer, retired: switched.retired };
  }
  if (done.computer.status === 'stopped') await publishStatus(deps, done.computer, 'stopped');
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
  return done;
}

/**
 * The reach of the old machine could not be cut: undoes the reset, if the
 * record is still this reset's and not out of reach. It takes the record for
 * the undo first (one conditional UPDATE); only then does the provider put
 * back what it did, and the member's computer gets its machine back,
 * `stopped`, with no agent: the old token is fenced, so its next start
 * provisions the machine with a new one. The record goes in the same
 * transaction. Always throws 503. When the undo lost the record (the sweep
 * took it), the provider could not put the machine back, or the member's
 * computer moved on meanwhile, the record stays (claimed for the job,
 * queued at once), the job retires the machine, and the reset answers that
 * it finishes in the background.
 */
async function undoRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: ComputerRow,
  switched: { computer: ComputerRow; retired: RetiredRow },
  claim: string,
  error: unknown,
  now: Date,
): Promise<never> {
  deps.logger.error(
    { err: error, computerId: row.id, retiredId: switched.retired.id },
    'cutting off the old computer failed; the reset is undone',
  );
  const id = switched.retired.id;
  const background = () =>
    new DomainError(
      503,
      'COMPUTER_UNAVAILABLE',
      'The reset did not finish shutting off the old computer. It is retried in the background.',
    );
  const undo = randomUUID();
  const [taken] = await deps.db
    .update(schema.retiredComputers)
    .set({ claim: undo, nextAttemptAt: new Date(Date.now() + RETIRE_LEASE_MS) })
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
  if (!taken) throw background();
  /** Leaves the record to the job, due now, and queues it. */
  const toJob = async (why: unknown) => {
    const job = randomUUID();
    const [retired] = await deps.db
      .update(schema.retiredComputers)
      .set({
        claim: job,
        attempts: 1,
        lastAttemptAt: now,
        lastError: errorText(why),
        nextAttemptAt: new Date(),
      })
      .where(
        and(
          eq(schema.retiredComputers.id, id),
          eq(schema.retiredComputers.status, 'retiring'),
          eq(schema.retiredComputers.claim, undo),
        ),
      )
      .returning();
    if (retired) await queueRetire(deps, retired, job);
    return background();
  };
  try {
    await machines.unretire!(machineRef(row));
  } catch (again) {
    deps.logger.error(
      { err: again, computerId: row.id },
      'putting the computer back after a failed reset failed; it is retired in the background',
    );
    throw await toJob(error);
  }
  const { provision: _, ...spec } = (row.spec ?? {}) as Record<string, unknown>;
  const back = await deps.db
    .transaction(async (tx) => {
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
      if (!computer) return null;
      const gone = await tx
        .delete(schema.retiredComputers)
        .where(
          and(
            eq(schema.retiredComputers.id, id),
            eq(schema.retiredComputers.status, 'retiring'),
            isNull(schema.retiredComputers.sealedAt),
            eq(schema.retiredComputers.claim, undo),
          ),
        )
        .returning({ id: schema.retiredComputers.id });
      // Lost meanwhile: nothing of this transaction stands.
      if (!gone.length) throw new UndoLost();
      return computer;
    })
    .catch((lost: unknown) => {
      if (lost instanceof UndoLost) return null;
      throw lost;
    });
  // The machine is in service again but not the member's: retired again by the job.
  if (!back) throw await toJob(error);
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
export async function sweepRetiredComputers(deps: SweepDeps, now = new Date()): Promise<number> {
  const lease = new Date(now.getTime() + RETIRED_LEASE_MS);
  const retireLease = new Date(now.getTime() + RETIRE_LEASE_MS);
  const fresh = sql`gen_random_uuid()`;
  const due = or(
    isNull(schema.retiredComputers.nextAttemptAt),
    lte(schema.retiredComputers.nextAttemptAt, now),
  );
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

/**
 * Records a failed attempt: retried with backoff, or given up after
 * `RETIRED_MAX_ATTEMPTS`. A retire whose machine is out of reach but whose
 * steps inside it keep failing is given up only once the provider itself
 * says the machine is out of reach (`retiredState`, after one more cut);
 * otherwise it waits for an operator like any other.
 */
async function failed(
  deps: Deps,
  machines: ComputerProvider,
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
  // operator's time: it is deleted when due all the same. Out of reach is
  // what the provider says now, not what the row said once.
  let outOfReach = false;
  if (giveUp && from === 'retiring' && sealed) {
    const ref = machineRef(row);
    await machines.retire!(ref).catch((again: unknown) =>
      deps.logger.warn({ err: again, retiredId: row.id }, 'cutting off a retired computer failed'),
    );
    try {
      // A provider that cannot say keeps it for an operator.
      const state = machines.retiredState ? await machines.retiredState(ref) : 'in_service';
      outOfReach = state === 'retired' || state === 'gone';
    } catch (again) {
      deps.logger.warn({ err: again, retiredId: row.id }, 'checking a retired computer failed');
    }
  }
  const claim = randomUUID();
  const set = giveUp
    ? outOfReach
      ? {
          status: 'retired',
          claim: null,
          nextAttemptAt: null,
          lastError: `Gave up the steps inside it after ${attempts} attempts: ${errorText(error)}`,
        }
      : {
          status,
          claim: null,
          ...(from === 'retiring' ? { sealedAt: null } : {}),
          gaveUpAt: now,
          nextAttemptAt: null,
          lastError: errorText(error),
        }
    : { status, claim, nextAttemptAt: retryAt, lastError: errorText(error) };
  const [updated] = await deps.db
    .update(schema.retiredComputers)
    .set({ ...set, attempts, lastAttemptAt: now })
    .where(held(row, from))
    .returning();
  if (!updated) return;
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

/**
 * The retire job, on a row it claimed: a reset that was cut short leaves the
 * member's computer `stopping`, which goes back to `stopped` at once (nothing
 * needs it held) and the old token is fenced again over the bus; then the
 * reach is cut (again, on every attempt: safe to repeat, and it takes back
 * anything a provisioning the reset cancelled put back), the record sealed
 * and its audit rows and cleanup written if the reset did not get to them,
 * then the steps inside it, then `retired`.
 */
async function finishRetire(
  deps: Deps,
  machines: ComputerProvider,
  row: RetiredRow,
  now: Date,
): Promise<void> {
  const ref = machineRef(row);
  if (!row.sealedAt) {
    await releaseComputer(deps, row);
    await fenceComputer(deps, { id: row.computerId ?? row.id, fence: row.fence });
  }
  try {
    await machines.retire!(ref);
    if (!row.sealedAt) {
      const sealed = await deps.db.transaction(async (tx) => {
        const [sealed] = await tx
          .update(schema.retiredComputers)
          .set({ sealedAt: now })
          .where(and(held(row, 'retiring'), isNull(schema.retiredComputers.sealedAt)))
          .returning();
        if (sealed) await completeRetire(tx as unknown as Db, sealed);
        return sealed;
      });
      if (!sealed) return;
      row = sealed;
    }
    await machines.retireInside!(ref);
  } catch (error) {
    await failed(deps, machines, row, 'retiring', error, now);
    return;
  }
  await deps.db.transaction(async (tx) => {
    const [done] = await tx
      .update(schema.retiredComputers)
      .set({
        status: 'retired',
        claim: null,
        lastAttemptAt: now,
        lastError: null,
        nextAttemptAt: null,
      })
      .where(held(row, 'retiring'))
      .returning();
    if (done) await completeRetire(tx as unknown as Db, done);
  });
}

/**
 * The job: finishes retiring a `retiring` row, or deletes a `deleting` one
 * for good, once it took the row from the claim it was queued with (a claim
 * of its own, so a job delivered twice runs once). Does nothing for a row in
 * any other status (another worker finished it, or an operator restored it
 * meanwhile), for a claim another took, or when the provider is not the
 * row's (the claim runs out and it is tried again later).
 */
export async function runRetiredComputerJob(
  deps: Deps,
  machines: ComputerProvider | null,
  job: Pick<RetiredComputerJob, 'retiredId' | 'kind' | 'claim'>,
  now = new Date(),
): Promise<void> {
  const [found] = await deps.db
    .select()
    .from(schema.retiredComputers)
    .where(eq(schema.retiredComputers.id, job.retiredId));
  if (!found) return;
  if (!machines || machines.name !== found.provider || !retainsOnReset(machines)) {
    deps.logger.warn(
      { retiredId: found.id, provider: found.provider },
      'a retired computer is on a provider this install no longer has; left for later',
    );
    return;
  }
  const status = job.kind === 'retire' ? 'retiring' : 'deleting';
  if (found.status !== status || (job.kind === 'retire' && found.gaveUpAt)) return;
  if (!job.claim || !UUID.test(job.claim)) return;
  // Still this job's: take the claim, its own, for the time it runs.
  const [row] = await deps.db
    .update(schema.retiredComputers)
    .set({
      claim: randomUUID(),
      nextAttemptAt: new Date(
        now.getTime() + (job.kind === 'retire' ? RETIRE_LEASE_MS : RETIRED_LEASE_MS),
      ),
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
  if (job.kind === 'retire') {
    await finishRetire(deps, machines, row, now);
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
    // A machine deleted before its retire's audit was written (a reset cut short).
    await completeRetire(tx as unknown as Db, deleted);
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
        nextAttemptAt: new Date(now.getTime() + RETIRED_LEASE_MS),
      })
      .where(
        and(owned, inArray(schema.retiredComputers.status, ['retiring', 'retired', 'deleting'])),
      )
      .returning();
    for (const row of claimed) {
      await runRetiredComputerJob(
        deps,
        machines,
        { retiredId: row.id, kind: 'delete', claim: row.claim! },
        now,
      );
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
