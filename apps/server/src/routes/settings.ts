import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin } from '../middleware/auth.js';
import { adminProblems, authenticated, createRouter, problemResponse } from '../openapi.js';
import { LimitsSchema } from '../schemas.js';
import { DomainError } from '../errors.js';
import { countPublic, stopPublicLinks } from '../services/artifact-sharing.js';
import { recordAudit, userActor } from '../services/audit.js';
import { stopCustomStdio } from '../services/connectors.js';
import type { Limits } from '@openbots/shared';
import type { AppDeps } from '../context.js';
import {
  effectiveSettings,
  getOrganization,
  limitsCeiling,
  MANAGED_ONLY_SETTINGS,
  updateSettings,
  type Workspace,
} from '../workspace.js';

// Organization settings (U3, plan 21.3), persisted on the organization's row
// and read and changed by its owners and admins. A self-hosted install has
// one owner, who changes the limits and custom stdio here; audit retention is
// managed only and keeps its default there (see workspace.ts). On the
// managed service an organization's limits stay under a ceiling, the
// operator's (OPENBOTS_LIMITS_*) or its plan's: owners and admins may lower
// them, never raise them above it (400 ABOVE_PLAN_LIMIT), and a higher
// number in the row counts as the ceiling.

const SettingsSchema = z
  .object({
    limits: LimitsSchema,
    auditRetentionDays: z.number().int().openapi({
      description: 'Audit log rows older than this many days are deleted (default 180)',
    }),
    customStdioEnabled: z.boolean().openapi({
      description:
        'Whether admins may add custom stdio connectors, which run a command on the server (default false; members never may)',
    }),
    publicArtifactsEnabled: z.boolean().openapi({
      description:
        'Whether members may make Artifacts public, so anyone with the link can view them (default false). Turning it off makes every public Artifact visible to the organization only, so turning it on again brings no old link back.',
    }),
    publicArtifacts: z.number().int().openapi({
      description:
        'How many Artifacts are public now, not counting any the service took down: the links that turning `publicArtifactsEnabled` off would stop',
    }),
    publicLinksStopped: z.number().int().optional().openapi({
      description:
        'Only in the answer to a change: how many public links it stopped, by turning `publicArtifactsEnabled` off or by leaving it off',
    }),
    ceilings: z.object(LimitsSchema.shape).nullable().openapi({
      description:
        'The most each limit may be on the managed service; null on a self-hosted install, which has none',
    }),
  })
  .openapi('Settings');

const SettingsPatchSchema = z
  .strictObject({
    limits: LimitsSchema.partial().strict().optional(),
    auditRetentionDays: z.number().int().min(1).max(3650).optional(),
    customStdioEnabled: z.boolean().optional(),
    publicArtifactsEnabled: z.boolean().optional(),
  })
  .openapi('SettingsPatch');

const settingsResponse = {
  description: "The organization's settings in effect",
  content: { 'application/json': { schema: SettingsSchema } },
};

/** The settings in effect for the organization, with the ceilings its limits stay under. */
async function settingsOf(deps: AppDeps, workspace: Workspace) {
  const ceilings = await limitsCeiling(deps, workspace);
  return {
    ...effectiveSettings(deps.config, workspace, ceilings),
    publicArtifacts: await countPublic(deps.db, workspace.id),
    ceilings,
  };
}

/** The least an organization keeps its audit log for on the managed service. */
export const MIN_MANAGED_AUDIT_DAYS = 30;

export const settingsRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      tags: ['settings'],
      summary: "The active organization's settings",
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: { 200: settingsResponse, ...adminProblems },
    }),
    async (c) => {
      const { db } = c.var.deps;
      return c.json(
        await settingsOf(c.var.deps, await getOrganization(db, c.var.user.workspaceId)),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      tags: ['settings'],
      summary: "Change the active organization's settings",
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: SettingsPatchSchema } } },
      },
      responses: {
        200: settingsResponse,
        400: problemResponse(
          'Invalid settings, a managed-only setting on a self-hosted install, custom stdio on the managed service, or a limit above its ceiling (`ABOVE_PLAN_LIMIT`)',
        ),
        ...adminProblems,
      },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      const patch = c.req.valid('json');
      if (config.deployment === 'self_hosted') {
        const managedOnly = MANAGED_ONLY_SETTINGS.filter((key) => patch[key] !== undefined);
        if (managedOnly.length) {
          throw new DomainError(
            400,
            'MANAGED_ONLY',
            `Not available on a self-hosted install: ${managedOnly.join(', ')}`,
          );
        }
      }
      // An admin cannot wipe the organization's record of what they did: the
      // managed service keeps at least 30 days (S-11, plan 21.6).
      if (
        config.deployment === 'managed' &&
        patch.auditRetentionDays !== undefined &&
        patch.auditRetentionDays < MIN_MANAGED_AUDIT_DAYS
      ) {
        throw new DomainError(
          400,
          'RETENTION_TOO_SHORT',
          `Keep the audit log for at least ${MIN_MANAGED_AUDIT_DAYS} days`,
        );
      }
      // A command would run on the server every organization shares (S-1, plan 21.6).
      if (!config.customStdio && patch.customStdioEnabled) {
        throw new DomainError(
          400,
          'SELF_HOSTED_ONLY',
          'Command (stdio) servers are not available on the hosted service',
        );
      }
      const current = await getOrganization(db, c.var.user.workspaceId);
      const ceilings = await limitsCeiling(c.var.deps, current);
      for (const [key, value] of Object.entries(patch.limits ?? {})) {
        const ceiling = ceilings?.[key as keyof Limits];
        if (ceiling !== undefined && value > ceiling) {
          throw new DomainError(
            400,
            'ABOVE_PLAN_LIMIT',
            `That is above your plan's limit of ${ceiling}.`,
          );
        }
      }
      const actor = userActor(c.var.user);
      const { workspace, stopped } = await db.transaction(async (tx) => {
        // Merged from the organization's row as locked here, so a change
        // another admin made meanwhile stays (`updateSettings`).
        const { after: updated } = await updateSettings(tx, current.id, patch);
        // Whenever the setting this leaves is off, every public link becomes
        // an organization one, in this transaction: on again brings none of
        // them back (plan 21.11). Asked of the written row, not the patch, so
        // a link made public while another admin had them on is stopped even
        // by a change that did not name the setting. It takes the lock that
        // shares wait on after the row's, as it always has; when nothing is
        // public it changes nothing.
        const stopped = effectiveSettings(config, updated).publicArtifactsEnabled
          ? 0
          : await stopPublicLinks(tx, updated.id, actor);
        await recordAudit(tx, {
          workspaceId: updated.id,
          actor,
          action: 'settings.update',
          targetType: 'workspace',
          targetId: updated.id,
          metadata: stopped ? { ...patch, publicLinksStopped: stopped } : patch,
        });
        return { workspace: updated, stopped };
      });
      // Their calls are refused from now on; their running children stop too (S-1).
      if (patch.customStdioEnabled === false) await stopCustomStdio(c.var.deps, workspace.id);
      return c.json(
        { ...(await settingsOf(c.var.deps, workspace)), publicLinksStopped: stopped },
        200,
      );
    },
  );
