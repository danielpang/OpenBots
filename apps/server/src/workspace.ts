import { DEFAULT_LIMITS, type Limits } from '@openbot/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.js';
import { schema, type Db } from './db/client.js';

// The single v1 workspace (plan section 4) and its admin settings (U3), kept
// in `workspaces.settings`. Anything unset there falls back to the
// environment (`OPENBOT_SIGNUP_MODE`, `OPENBOT_LIMITS_*`).
//
// A self-hosted install (OPENBOT_DEPLOYMENT) has one owner and no admin
// screens, so the settings that only matter with members keep their defaults
// whatever is stored: sign-up closes after the first account (auth.ts refuses
// it), template links stay workspace-only and the audit log keeps 180 days.
// The limits and custom stdio connectors stay the owner's to change.

export type Workspace = typeof schema.workspaces.$inferSelect;
export type Role = (typeof schema.workspaceRole.enumValues)[number];
export type SignupMode = Config['signupMode'];

/** Audit rows are kept this long unless the admin changes it (S-11). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

/** The settings a self-hosted install does not offer; they keep their defaults there. */
export const MANAGED_ONLY_SETTINGS = [
  'signupMode',
  'publicTemplatesEnabled',
  'auditRetentionDays',
] as const;

const limitKeys = Object.keys(DEFAULT_LIMITS) as [keyof Limits, ...(keyof Limits)[]];

export const storedSettingsSchema = z.object({
  signupMode: z.enum(['first_user_admin', 'invite', 'open']).optional(),
  publicTemplatesEnabled: z.boolean().optional(),
  // A limit stored by an older version that is no longer a setting (computers
  // per account, computer tasks per Bot) is dropped, not a reason to ignore
  // every other setting.
  limits: z
    .preprocess(
      (value) =>
        value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).filter(([key]) => (limitKeys as string[]).includes(key)),
            )
          : value,
      z.partialRecord(z.enum(limitKeys), z.number().int().positive()),
    )
    .optional(),
  auditRetentionDays: z.number().int().positive().optional(),
  /** Whether admins may add custom stdio connectors, which run any command on the server (S-1). */
  customStdioEnabled: z.boolean().optional(),
  /** Background-task model per provider id, overriding the cheapest-with-tools pick (plan 5.9). */
  smallModels: z.record(z.string(), z.string()).optional(),
});

export type StoredSettings = z.infer<typeof storedSettingsSchema>;

export interface Settings {
  signupMode: SignupMode;
  publicTemplatesEnabled: boolean;
  limits: Limits;
  auditRetentionDays: number;
  customStdioEnabled: boolean;
}

/** Serializes workspace creation and first-admin assignment. */
const WORKSPACE_LOCK = 0x6f70656e; // "open"

export function lockWorkspace(db: Db) {
  return db.execute(sql`select pg_advisory_xact_lock(${WORKSPACE_LOCK})`);
}

/** The workspace, created on first use. */
export async function ensureWorkspace(db: Db): Promise<Workspace> {
  const existing = await firstWorkspace(db);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    await lockWorkspace(tx);
    const again = await firstWorkspace(tx);
    if (again) return again;
    const [created] = await tx.insert(schema.workspaces).values({ name: 'OpenBot' }).returning();
    return created!;
  });
}

async function firstWorkspace(db: Db): Promise<Workspace | undefined> {
  const [row] = await db
    .select()
    .from(schema.workspaces)
    .orderBy(asc(schema.workspaces.createdAt))
    .limit(1);
  return row;
}

export function storedSettings(workspace: Workspace): StoredSettings {
  // Ignore anything unrecognised rather than failing every request on it.
  const parsed = storedSettingsSchema.safeParse(workspace.settings);
  return parsed.success ? parsed.data : {};
}

export function effectiveSettings(config: Config, workspace: Workspace): Settings {
  const stored = storedSettings(workspace);
  if (config.deployment === 'self_hosted') {
    return {
      // First user, then no invites: closed once the owner exists.
      signupMode: 'first_user_admin',
      publicTemplatesEnabled: false,
      limits: { ...config.limits, ...stored.limits },
      auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
      customStdioEnabled: stored.customStdioEnabled ?? false,
    };
  }
  return {
    signupMode: stored.signupMode ?? config.signupMode,
    publicTemplatesEnabled: stored.publicTemplatesEnabled ?? false,
    limits: { ...config.limits, ...stored.limits },
    auditRetentionDays: stored.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    customStdioEnabled: stored.customStdioEnabled ?? false,
  };
}

/**
 * How someone at a limit gets more room: an admin raises it on the managed
 * service; a self-hosted owner raises it in Settings > Limits.
 */
export function raiseLimitHint(config: Pick<Config, 'deployment'>, what = 'it'): string {
  return config.deployment === 'managed'
    ? `ask an admin to raise ${what}`
    : `raise ${what} in Settings > Limits`;
}

export async function updateSettings(
  db: Db,
  workspace: Workspace,
  patch: StoredSettings,
): Promise<Workspace> {
  const current = storedSettings(workspace);
  const next: StoredSettings = {
    ...current,
    ...patch,
    limits: { ...current.limits, ...patch.limits },
  };
  const [row] = await db
    .update(schema.workspaces)
    .set({ settings: next })
    .where(eq(schema.workspaces.id, workspace.id))
    .returning();
  return row!;
}
