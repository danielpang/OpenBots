import {
  SPRITES_CHECKPOINT_MAX_MS,
  SPRITES_EXEC_KILL_MS,
  SPRITES_PROVISION_MAX_MS,
  SPRITES_RESTORE_MAX_MS,
  SPRITES_RETIRE_INSIDE_MAX_MS,
  SPRITES_RETIRE_MAX_MS,
  SPRITES_STATUS_MAX_MS,
  SPRITES_UNRETIRE_MAX_MS,
} from '@openbots/computer';

// Every time bound the computers' claims rest on, in one place, with the
// checks between them run as the server starts (this module's load): a claim
// that could run out while its holder is still at work would let a second
// actor in beside the first. computer.ts and computer-retire.ts take theirs
// from here.

/** Slack for the database writes around a provider's calls, and a slow event loop. */
export const CLAIM_MARGIN_MS = 60_000;

/**
 * How often whoever holds a computer `stopping` (a stop, a reset) refreshes
 * its `status_at` while its provider calls run (computer.ts `holdingStop`).
 */
export const STOPPING_HEARTBEAT_MS = 15_000;
/**
 * How long a `stopping` computer may go without that refresh before a start,
 * a reset or the sweep takes it over: its holder died or stalled. A computer
 * a reset retired is never taken over this way while its retirement is open
 * (computer.ts `abandonedStop`): the retirement's own record holds it.
 */
export const STOPPING_TAKEOVER_MS = 4 * STOPPING_HEARTBEAT_MS;
/**
 * How long a holder of `stopping` goes on with no refresh landing (the
 * database unreachable) before it ends its own provider call: past this its
 * claim may soon be taken over, and the call must be over before then. The
 * call ends at most `SPRITES_EXEC_KILL_MS` after its signal. Counted from
 * when the last refresh that landed was sent (computer.ts `holdingStop`):
 * its write, and so the takeover's start, came no sooner, and an answer
 * that was slow to come back uses none of the margin.
 */
export const STOPPING_GIVE_UP_MS = 2 * STOPPING_HEARTBEAT_MS;
/** Slack for a give-up timer that fires late on a busy event loop. */
export const STOPPING_GIVE_UP_SLACK_MS = 5_000;

/** The longest a reset's own work on the record takes: the cut, then its undo. */
export const RESET_RETIRE_MAX_MS = SPRITES_RETIRE_MAX_MS + SPRITES_UNRETIRE_MAX_MS;
/** The longest a retire job takes on a record: the cut, then the steps inside or a read back. */
export const JOB_RETIRE_MAX_MS = SPRITES_RETIRE_MAX_MS + SPRITES_RETIRE_INSIDE_MAX_MS;

/**
 * How long a retire's claim on its record lasts: past the longest the
 * reset's cut and undo, or the job's cut and steps inside, can take, so the
 * sweep does not take a record whose holder is still at work. The claim
 * token keeps a late one from writing all the same.
 */
export const RETIRE_LEASE_MS = 5 * 60_000;
/** How long a deletion's claim lasts before another worker may take the row again. */
export const RETIRED_LEASE_MS = 30 * 60_000;
/**
 * The longest an operator's restore holds its record (computer-retire.ts
 * `restoreRetiredComputer`): a checkpoint of the member's current machine,
 * its retire (the cut, and its undo), the retired machine's checkpoint put
 * back, its return to service, and on a failure the cut and the steps
 * inside it again.
 */
export const RESTORE_MAX_MS =
  SPRITES_CHECKPOINT_MAX_MS +
  RESET_RETIRE_MAX_MS +
  SPRITES_RESTORE_MAX_MS +
  SPRITES_UNRETIRE_MAX_MS +
  JOB_RETIRE_MAX_MS;
/** How long an operator's restore may take before the sweep takes the machine back. */
export const RESTORE_LEASE_MS = 45 * 60_000;

/**
 * How long a provisioning job may go without its heartbeat before a start or
 * the sweep queues it again (computer.ts): counted from when it last showed
 * it was running, not from when it was queued.
 */
export const PROVISION_HEARTBEAT_MS = 15_000;
export const PROVISION_STALE_MS = 20 * 60_000;
/**
 * The longest a provisioning job can run once its computer moved on before
 * it ends: it checks its claim every heartbeat and ends its provider call
 * then, but a process cut off from the database is bounded only by the
 * provisioning's own limits (packages/computer sprites.ts): a status read,
 * then a make and a start, each within `SPRITES_PROVISION_MAX_MS`.
 */
export const PROVISION_MAX_MS = SPRITES_STATUS_MAX_MS + 2 * SPRITES_PROVISION_MAX_MS;
/**
 * When a retired machine's steps inside it are run once more: past the
 * longest a provisioning the reset cancelled could still be running, so an
 * agent it installed after all is removed (computer-retire.ts).
 */
export const RETIRED_RECHECK_MS = PROVISION_MAX_MS + CLAIM_MARGIN_MS;

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`Computer time bounds: ${what}`);
}

check(
  RETIRE_LEASE_MS > RESET_RETIRE_MAX_MS + CLAIM_MARGIN_MS,
  "RETIRE_LEASE_MS must outlast a reset's cut and its undo",
);
check(
  RETIRE_LEASE_MS > JOB_RETIRE_MAX_MS + CLAIM_MARGIN_MS,
  "RETIRE_LEASE_MS must outlast a job's cut and its steps inside",
);
check(
  STOPPING_TAKEOVER_MS >= 3 * STOPPING_HEARTBEAT_MS,
  'STOPPING_TAKEOVER_MS must allow for two missed heartbeats',
);
// Both sides counted from the same moment: the takeover from the last
// refresh's write, the give-up from its sending, which came first.
check(
  STOPPING_GIVE_UP_MS + SPRITES_EXEC_KILL_MS + STOPPING_GIVE_UP_SLACK_MS <= STOPPING_TAKEOVER_MS,
  'a holder that cannot refresh its stop must end its call before the stop can be taken over, counted from when its last refresh was sent',
);
check(
  STOPPING_GIVE_UP_MS > STOPPING_HEARTBEAT_MS,
  'STOPPING_GIVE_UP_MS must allow for one missed heartbeat',
);
check(
  PROVISION_STALE_MS >= 10 * PROVISION_HEARTBEAT_MS,
  'PROVISION_STALE_MS must allow for missed heartbeats',
);
check(RETIRED_LEASE_MS > CLAIM_MARGIN_MS, 'RETIRED_LEASE_MS must outlast a deletion');
check(
  RESTORE_LEASE_MS > RESTORE_MAX_MS + CLAIM_MARGIN_MS,
  "RESTORE_LEASE_MS must outlast a restore's calls",
);
check(
  RETIRED_RECHECK_MS > PROVISION_MAX_MS,
  'RETIRED_RECHECK_MS must come after any provisioning a reset cancelled has ended',
);
