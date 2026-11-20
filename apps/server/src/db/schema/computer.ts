import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth.js';
import { bots } from './bots.js';
import { bytea, createdAt, id, timestamptz } from './columns.js';
import { workspaceId, workspaces } from './workspace.js';

// Plan 4.5: Computer (K1 to K7).

export const computerProvider = pgEnum('computer_provider', ['docker', 'remote', 'sprites']);

/** One per account in each organization (K1, plan 21.3). */
export const computers = pgTable(
  'computers',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    provider: computerProvider('provider').notNull().default('docker'),
    spec: jsonb('spec').notNull().default({}),
    /**
     * What names the machine where the provider names it (Sprites), instead of
     * the row's id (`ComputerSpec.machineKey`): a full reset that keeps the
     * old machine gives the row a new one, so its next machine is a new one.
     * A column of its own, not part of `spec`, which many paths write whole.
     */
    machineKey: text('machine_key'),
    status: text('status').notNull(),
    containerId: text('container_id'),
    agentUrl: text('agent_url'),
    agentToken: bytea('agent_token'),
    volumeName: text('volume_name'),
    alwaysOn: boolean('always_on').notNull().default(false),
    idleTimeoutMin: integer('idle_timeout_min'),
    lastUsedAt: timestamptz('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('computers_one_per_owner').on(t.workspaceId, t.ownerId)],
);

/** One screen per Bot (K2); `controlled_by_user_id` set during takeover (K3). */
export const botScreens = pgTable(
  'bot_screens',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .unique()
      .references(() => bots.id, { onDelete: 'cascade' }),
    computerId: uuid('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    displayNumber: integer('display_number').notNull(),
    browserProfileDir: text('browser_profile_dir'),
    cdpPort: integer('cdp_port'),
    status: text('status').notNull(),
    controlledByUserId: uuid('controlled_by_user_id').references(() => users.id),
    controlledSince: timestamptz('controlled_since'),
  },
  (t) => [unique().on(t.computerId, t.displayNumber)],
);

/**
 * When a member's computer was in use (plan 9.5): one row per stretch of use
 * a server process saw, from the first use to the last plus, on a provider
 * that pauses itself, the tail before it pauses. `ended_at` and `seconds` are
 * null while it is open; `seen_at` is its last heartbeat, so one a crashed
 * process left open is closed at its last sign of life. `seconds` counts only
 * time no other closed interval of the computer already covers, so the
 * seconds of a computer add up to its time in use even when two processes
 * (the API's terminal, a worker's run) used it at once. For usage billing
 * later (`ServerExtensions.onComputerUsage`); nothing reads it yet.
 */
export const computerUsageIntervals = pgTable(
  'computer_usage_intervals',
  {
    id: id(),
    workspaceId: workspaceId(),
    computerId: uuid('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    provider: computerProvider('provider').notNull(),
    /** What began it: `run`, `coding_session`, `exec`, `terminal` or `screen`. */
    reason: text('reason').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    seenAt: timestamptz('seen_at').notNull(),
    endedAt: timestamptz('ended_at'),
    seconds: integer('seconds'),
    createdAt: createdAt(),
  },
  (t) => [
    index('computer_usage_intervals_owner').on(t.workspaceId, t.ownerId, t.startedAt),
    index('computer_usage_intervals_computer').on(t.computerId, t.startedAt),
  ],
);

/**
 * Machines a full reset took out of service but kept (plan 9.5, the owner's
 * decision): one row per retired machine, kept `RETIRED_COMPUTER_DAYS` (7)
 * so support can restore it (`openbots computers restore`), then deleted for
 * good by the retired-computers job (services/computer-retire.ts). Only on a
 * provider that can retire a machine (Sprites); Docker removes it at once.
 *
 * `status`: `retiring` (recorded; out of reach once `sealed_at` is set, the
 * steps inside it not yet done), `retired`, `deleting` (claimed by the job),
 * `deleted`, `restoring` (an operator's restore under way, leased by
 * `next_attempt_at`) or `restored` (the member's computer again). The row
 * outlives the machine as the record of it. The organization cannot be
 * deleted while it has rows (`restrict`): there is no organization deletion
 * yet, and whatever adds one must call `purgeRetiredComputers` first, so no
 * machine is left behind unrecorded.
 */
export const retiredComputers = pgTable(
  'retired_computers',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    /** The computer it was; null once that row is gone. */
    computerId: uuid('computer_id').references(() => computers.id, { onDelete: 'set null' }),
    provider: computerProvider('provider').notNull(),
    /** The machine as the provider names it (the Sprite's name). */
    providerRef: text('provider_ref').notNull(),
    /** The `machineKey` it was made under, for a restore to make it the computer's again. */
    machineKey: text('machine_key'),
    agentUrl: text('agent_url'),
    /** The checkpoint taken just before it was retired; null if that failed. */
    checkpointId: text('checkpoint_id'),
    status: text('status').notNull(),
    retiredAt: timestamptz('retired_at').notNull(),
    deleteAfter: timestamptz('delete_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** When the job may next take it (a retry's backoff, or a claim's lease). */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** When the machine was taken out of reach (`ComputerProvider.retire`). */
    sealedAt: timestamptz('sealed_at'),
    /**
     * When the job stopped retrying it after `RETIRED_MAX_ATTEMPTS`; the sweep
     * leaves it alone until an operator retries it (`openbots computers retry`).
     */
    gaveUpAt: timestamptz('gave_up_at'),
    lastAttemptAt: timestamptz('last_attempt_at'),
    lastError: text('last_error'),
    deletedAt: timestamptz('deleted_at'),
    restoredAt: timestamptz('restored_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('retired_computers_owner').on(t.workspaceId, t.ownerId, t.retiredAt),
    index('retired_computers_due').on(t.status, t.deleteAfter),
    // One live record per machine: two resets racing cannot record it twice.
    uniqueIndex('retired_computers_live_ref')
      .on(t.provider, t.providerRef)
      .where(sql`status in ('retiring', 'retired', 'deleting', 'restoring')`),
  ],
);
