import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

export const bots = pgTable(
  'bots',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    /** The `@slug`, without the `@`. Unique per (organization, owner). */
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
     * first Bot, or one made after the main Bot went); duplicates never
     * carry it over.
     */
    isMain: boolean('is_main').notNull().default(false),
    archivedAt: timestamptz('archived_at'),
    /**
     * The Bot's name on the artifact domain (plan 21.11):
     * `https://<public_slug>--<organization slug>.<OPENBOTS_ARTIFACT_DOMAIN>`.
     * Unique across every organization, since handles are only unique per
     * member; lower case letters and digits in hyphen-separated runs, so it
     * never holds `--` and the label splits one way. Given at creation
     * (services/bots.ts) and never changed; the default covers rows written
     * any other way.
     */
    publicSlug: text('public_slug')
      .notNull()
      .unique('bots_public_slug_unique')
      .default(sql`('b' || substr(md5(gen_random_uuid()::text), 1, 11))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'bots_public_slug_format',
      sql`${t.publicSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.publicSlug}) BETWEEN 3 AND 40`,
    ),
    unique('bots_handle_per_owner').on(t.workspaceId, t.ownerId, t.handle),
    uniqueIndex('bots_one_main_per_owner')
      .on(t.workspaceId, t.ownerId)
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
  /** The tool running while `working` (I5: a computer tool shows on the Preview button). */
  currentTool: text('current_tool'),
  runId: uuid('run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});
