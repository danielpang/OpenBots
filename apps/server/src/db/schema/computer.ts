import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { bytea, createdAt, id, timestamptz } from './columns.js';
import { workspaceId } from './workspace.js';

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
