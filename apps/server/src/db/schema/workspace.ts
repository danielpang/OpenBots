import { jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, id, timestamptz } from './columns.js';

// One workspace in v1 (plan section 4); every other table carries `workspace_id`.

export const workspaceRole = pgEnum('workspace_role', ['admin', 'member']);

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  /** Admin controls (U3): signup mode, limit overrides. */
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
});

/** Who belongs to a workspace and who is its admin (U1). */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull().default('member'),
    /**
     * Set when an admin disables the member's sign-in (U3): sessions are
     * ended, API keys stop working and new sign-ins are refused, while their
     * Bots and data stay. Null while the member can sign in.
     */
    disabledAt: timestamptz('disabled_at'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workspaceId, t.userId)],
);

/** `workspace_id` column for section 4 tables. */
export const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/**
 * Signup invites (U1). The token is shown once to the admin who creates it;
 * only its SHA-256 is stored. Redeemed at signup, after which `used_at` is set.
 */
export const invites = pgTable('invites', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  /** When set, only this address can redeem the invite. */
  email: text('email'),
  role: workspaceRole('role').notNull().default('member'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});
