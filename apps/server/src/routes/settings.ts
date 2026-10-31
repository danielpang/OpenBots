import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin } from '../middleware/auth.js';
import { adminProblems, authenticated, createRouter, problemResponse } from '../openapi.js';
import { LimitsSchema, SignupModeSchema } from '../schemas.js';
import { DomainError } from '../errors.js';
import { recordAudit, userActor } from '../services/audit.js';
import { stopCustomStdio } from '../services/connectors.js';
import {
  effectiveSettings,
  ensureWorkspace,
  MANAGED_ONLY_SETTINGS,
  updateSettings,
} from '../workspace.js';

// Admin controls (U3), persisted on the workspace row. A self-hosted install
// has one owner (always an admin internally), who changes the limits and
// custom stdio here; signup mode and audit retention are managed only and
// keep their defaults there (see workspace.ts).

const SettingsSchema = z
  .object({
    signupMode: SignupModeSchema,
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
    signupMode: SignupModeSchema.optional(),
    limits: LimitsSchema.partial().strict().optional(),
    auditRetentionDays: z.number().int().min(1).max(3650).optional(),
    customStdioEnabled: z.boolean().optional(),
  })
  .openapi('SettingsPatch');

const settingsResponse = {
  description: 'Workspace settings in effect',
  content: { 'application/json': { schema: SettingsSchema } },
};

export const settingsRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      tags: ['settings'],
      summary: 'Workspace settings',
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: { 200: settingsResponse, ...adminProblems },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      return c.json(effectiveSettings(config, await ensureWorkspace(db)), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      tags: ['settings'],
      summary: 'Change workspace settings',
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: SettingsPatchSchema } } },
      },
      responses: {
        200: settingsResponse,
        400: problemResponse(
          'Invalid settings, or a managed-only setting on a self-hosted install',
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
      const workspace = await updateSettings(db, await ensureWorkspace(db), patch);
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
