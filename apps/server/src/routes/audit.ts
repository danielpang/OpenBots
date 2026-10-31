import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin, requireManaged } from '../middleware/auth.js';
import { authenticated, managedProblems, createRouter, problemResponse } from '../openapi.js';
import { listAudit, type AuditListing } from '../services/audit.js';

// The audit log reader (plan 17 control 9, S-11): admins only, newest first,
// filtered by actor, action and time range, a page at a time. Managed only:
// a self-hosted install still records audit rows but answers 404 here.

const AuditEntrySchema = z
  .object({
    id: z.uuid(),
    actorType: z.enum(['user', 'bot', 'system']),
    actorId: z.uuid().nullable(),
    actorLabel: z
      .string()
      .nullable()
      .openapi({ description: "The user's email or the Bot's name, while they exist" }),
    action: z.string().openapi({ example: 'auth.sign_in' }),
    targetType: z.string().nullable(),
    targetId: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .openapi('AuditEntry');

const AuditPageSchema = z
  .object({
    items: z.array(AuditEntrySchema),
    nextCursor: z
      .uuid()
      .nullable()
      .openapi({ description: 'Pass as `cursor` for the next page; null on the last' }),
  })
  .openapi('AuditPage');

const toEntry = (row: AuditListing['items'][number]) => ({
  id: row.id,
  actorType: row.actorType as 'user' | 'bot' | 'system',
  actorId: row.actorId,
  actorLabel: row.actorLabel,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  metadata: row.metadata as Record<string, unknown>,
  createdAt: row.createdAt.toISOString(),
});

export const auditRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/admin/audit',
    tags: ['settings'],
    summary: 'Read the audit log',
    middleware: [requireManaged, requireAdmin] as const,
    security: authenticated,
    request: {
      query: z.object({
        actorId: z.uuid().optional(),
        action: z.string().max(100).optional().openapi({
          description: 'An action (`auth.sign_in`), or a group ending in `.` (`auth.`)',
        }),
        from: z.iso.datetime().optional().openapi({ description: 'At or after' }),
        to: z.iso.datetime().optional().openapi({ description: 'At or before' }),
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Entries, newest first',
        content: { 'application/json': { schema: AuditPageSchema } },
      },
      400: problemResponse('Invalid filters'),
      ...managedProblems,
    },
  }),
  async (c) => {
    const { actorId, action, from, to, cursor, limit } = c.req.valid('query');
    const page = await listAudit(c.var.deps.db, c.var.user.workspaceId, {
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    });
    return c.json({ items: page.items.map(toEntry), nextCursor: page.nextCursor }, 200);
  },
);
