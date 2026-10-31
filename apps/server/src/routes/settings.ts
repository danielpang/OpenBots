import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin } from '../middleware/auth.js';
import { adminProblems, authenticated, createRouter, problemResponse } from '../openapi.js';
import { LimitsSchema } from '../schemas.js';
import { DomainError } from '../errors.js';
import { recordAudit, userActor } from '../services/audit.js';
import { stopCustomStdio } from '../services/connectors.js';
import {
  effectiveSettings,
  getOrganization,
  MANAGED_ONLY_SETTINGS,
  updateSettings,
} from '../workspace.js';

// Organization settings (U3, plan 21.3), persisted on the organization's row
// and read and changed by its owners and admins. A self-hosted install has
// one owner, who changes the limits and custom stdio here; audit retention is
// managed only and keeps its default there (see workspace.ts).

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
  })
  .openapi('Settings');

const SettingsPatchSchema = z
  .strictObject({
    limits: LimitsSchema.partial().strict().optional(),
    auditRetentionDays: z.number().int().min(1).max(3650).optional(),
    customStdioEnabled: z.boolean().optional(),
  })
  .openapi('SettingsPatch');

const settingsResponse = {
  description: "The organization's settings in effect",
  content: { 'application/json': { schema: SettingsSchema } },
};

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
      const { db, config } = c.var.deps;
      return c.json(
        effectiveSettings(config, await getOrganization(db, c.var.user.workspaceId)),
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
          'Invalid settings, a managed-only setting on a self-hosted install, or custom stdio on the managed service',
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
      // A command would run on the server every organization shares (S-1, plan 21.6).
      if (!config.customStdio && patch.customStdioEnabled) {
        throw new DomainError(
          400,
          'SELF_HOSTED_ONLY',
          'Command (stdio) servers are not available on the hosted service',
        );
      }
      const workspace = await updateSettings(
        db,
        await getOrganization(db, c.var.user.workspaceId),
        patch,
      );
      await recordAudit(db, {
        workspaceId: workspace.id,
        actor: userActor(c.var.user),
        action: 'settings.update',
        targetType: 'workspace',
        targetId: workspace.id,
        metadata: patch,
      });
      // Their calls are refused from now on; their running children stop too (S-1).
      if (patch.customStdioEnabled === false) await stopCustomStdio(c.var.deps, workspace.id);
      return c.json(effectiveSettings(config, workspace), 200);
    },
  );
