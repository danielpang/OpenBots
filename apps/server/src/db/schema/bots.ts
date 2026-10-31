import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Plan 4.1: Bots and identity (B1 to B8, I1, I2).

export const botStateKind = pgEnum('bot_state_kind', [
  'idle',
  'thinking',
  'working',
  'waiting',
  'blocked',
  'done',
]);

export const templateVisibility = pgEnum('template_visibility', ['workspace', 'public']);

export const bots = pgTable(
  'bots',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    /** The `@slug`, without the `@`. Unique per workspace. */
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    label: text('label'),
    /** Standing rules (B3). */
    description: text('description').notNull().default(''),
    /** Generator params (seed, shape, palette, eyes, accessory) or an uploaded file id. */
    avatar: jsonb('avatar').notNull().default({}),
    /** provider (a `providers.id`), model, temperature, reasoning, max_steps. */
    modelConfig: jsonb('model_config').notNull().default({}),
    toolPolicy: jsonb('tool_policy').notNull().default({}),
    pinned: boolean('pinned').notNull().default(false),
    hidden: boolean('hidden').notNull().default(false),
    /**
     * The owner's main Bot (K8): other Bots' sign-in requests go to it. At
     * most one per owner. A new Bot is it when the owner has none (their
     * first Bot, or one made after the main Bot went); duplicates and
     * templates never carry it over.
     */
    isMain: boolean('is_main').notNull().default(false),
    archivedAt: timestamptz('archived_at'),
    templateId: uuid('template_id').references((): AnyPgColumn => botTemplates.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.workspaceId, t.handle),
    uniqueIndex('bots_one_main_per_owner')
      .on(t.ownerId)
      .where(sql`${t.isMain}`),
  ],
);

/** Denormalized for the roster (I2, I3); one row per Bot. */
export const botState = pgTable('bot_state', {
  id: id(),
  workspaceId: workspaceId(),
  botId: uuid('bot_id')
    .notNull()
    .unique()
    .references(() => bots.id, { onDelete: 'cascade' }),
  state: botStateKind('state').notNull().default('idle'),
  currentAction: text('current_action'),
  /** The tool running while `working` (I5: a computer tool lights the title-bar icon). */
  currentTool: text('current_tool'),
  runId: uuid('run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/** Snapshot: profile, settings, enabled Skills (embedded), Routines, avatar (B5, B6). */
export const botTemplates = pgTable('bot_templates', {
  id: id(),
  workspaceId: workspaceId(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  visibility: templateVisibility('visibility').notNull().default('workspace'),
  /** Share-link token; null until a link is made. */
  token: text('token').unique(),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: createdAt(),
});
