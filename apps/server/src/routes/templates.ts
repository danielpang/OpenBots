import { createRoute, z } from '@hono/zod-openapi';
import { DomainError } from '../errors.js';
import { authenticateHeaders, requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  createBotFromTemplate,
  createTemplate,
  deleteTemplate,
  listTemplates,
  publicEnabled,
  setTemplateVisibility,
  TemplateFileSchema as TemplateFileShape,
  templateByToken,
  templateFile,
  type TemplateRecord,
} from '../services/templates.js';
import { computerAvailable } from '../services/computer.js';
import { BotSchema, toBot } from './bots.js';

// Bot templates (B6, U3; plan 14.1). A member saves one of their Bots as a
// template; every member of the workspace can list it, open its link and
// create a Bot from it. `GET /templates/{token}` is the JSON export too, and
// answers without a session only for a public template while the admin has
// public links on.

const VisibilitySchema = z.enum(['workspace', 'public']).openapi('TemplateVisibility', {
  description: '`public` links open without signing in, while the admin allows them',
});

const TemplateFileSchema = TemplateFileShape.openapi('TemplateFile', {
  description: 'A template as a file: the JSON export, and what an import takes',
});

const TemplateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    visibility: VisibilitySchema,
    token: z.string().openapi({ description: 'The link token, for `GET /templates/{token}`' }),
    owner: z.object({ id: z.uuid(), name: z.string() }),
    botName: z.string(),
    skills: z.number().int().openapi({ description: 'Skills in the snapshot' }),
    routines: z.number().int().openapi({ description: 'Routines in the snapshot' }),
    createdAt: z.iso.datetime(),
  })
  .openapi('Template');

const CreateTemplateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional().openapi({
      description: "The Bot's name when omitted",
    }),
    visibility: VisibilitySchema.optional().openapi({ description: '`workspace` by default' }),
  })
  .openapi('CreateTemplate');

const UpdateTemplateSchema = z
  .strictObject({ visibility: VisibilitySchema })
  .openapi('UpdateTemplate');

const FromTemplateSchema = z
  .strictObject({
    token: z.string().min(1).max(200).optional().openapi({ description: 'A template link token' }),
    file: TemplateFileSchema.optional().openapi({ description: 'An exported template file' }),
  })
  .refine((body) => !!body.token !== !!body.file, { message: 'Send a token or a file' })
  .openapi('FromTemplate');

const BotFromTemplateSchema = BotSchema.extend({
  templateModel: z
    .object({
      modelId: z.string().openapi({ description: 'The model the template names' }),
      used: z.boolean().openapi({
        description:
          "False when it is not available here (another instance's or another member's provider, or a model that is missing or turned off), so the Bot got the default model instead",
      }),
    })
    .nullable()
    .openapi({ description: 'Null when the template names no model' }),
}).openapi('BotFromTemplate');

const tokenParams = z.object({ token: z.string().min(1).max(200) });

function toTemplate({ template, ownerName }: TemplateRecord): z.infer<typeof TemplateSchema> {
  const { snapshot } = templateFile(template);
  return {
    id: template.id,
    name: template.name,
    visibility: template.visibility,
    token: template.token ?? '',
    owner: { id: template.ownerId, name: ownerName },
    botName: snapshot.profile.name,
    skills: snapshot.skills.length,
    routines: snapshot.routines.length,
    createdAt: new Date(template.createdAt).toISOString(),
  };
}

const templateResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: TemplateSchema } },
});

export const templateRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/template',
      tags: ['templates'],
      summary: 'Save a Bot as a template',
      description:
        'Snapshots the profile, settings, avatar, enabled Skills and Routines; never the transcript, memories or attachments.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { 'application/json': { schema: CreateTemplateSchema } } },
      },
      responses: {
        201: templateResponse('The template'),
        400: problemResponse('Invalid request'),
        403: problemResponse('Public links are off (`PUBLIC_TEMPLATES_DISABLED`)'),
        404: problemResponse('No such Bot'),
        ...authProblems,
      },
    }),
    async (c) => {
      const body = c.req.valid('json') ?? {};
      const record = await createTemplate(c.var.deps, c.var.user, c.req.valid('param').id, body);
      return c.json(toTemplate(record), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/templates',
      tags: ['templates'],
      summary: "The workspace's templates, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Templates',
          content: {
            'application/json': {
              schema: z.object({
                items: z.array(TemplateSchema),
                publicEnabled: z.boolean().openapi({
                  description: 'Whether the admin allows public links, so a template can be public',
                }),
              }),
            },
          },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listTemplates(c.var.deps.db, c.var.user);
      const enabled = await publicEnabled(c.var.deps);
      return c.json({ items: rows.map(toTemplate), publicEnabled: enabled }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/templates/{token}',
      tags: ['templates'],
      summary: 'Open a template link; the JSON export',
      description:
        'Members of the workspace open any template. Without a session, only a public template answers, and only while the admin has public links on.',
      security: [...authenticated, {}],
      request: { params: tokenParams },
      responses: {
        200: {
          description: 'The template file',
          content: { 'application/json': { schema: TemplateFileSchema } },
        },
        404: problemResponse('No such template'),
        ...authProblems,
      },
    }),
    async (c) => {
      const viewer = await optionalUser(c.var.deps, c.req.raw.headers);
      const row = await templateByToken(c.var.deps, viewer, c.req.valid('param').token);
      return c.json(templateFile(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/templates/{token}',
      tags: ['templates'],
      summary: "Change one of your templates' visibility",
      description:
        'Making a template public needs the admin to allow public links; making it workspace-only closes its public link.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: tokenParams,
        body: { required: true, content: { 'application/json': { schema: UpdateTemplateSchema } } },
      },
      responses: {
        200: templateResponse('The template'),
        400: problemResponse('Invalid request'),
        403: problemResponse('Public links are off (`PUBLIC_TEMPLATES_DISABLED`)'),
        404: problemResponse('No such template of yours'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { visibility } = c.req.valid('json');
      const record = await setTemplateVisibility(
        c.var.deps,
        c.var.user,
        c.req.valid('param').token,
        visibility,
      );
      return c.json(toTemplate(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/templates/{token}',
      tags: ['templates'],
      summary: 'Delete one of your templates; its link stops working',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: tokenParams },
      responses: {
        204: { description: 'Deleted' },
        404: problemResponse('No such template of yours'),
        ...authProblems,
      },
    }),
    async (c) => {
      await deleteTemplate(c.var.deps.db, c.var.user, c.req.valid('param').token);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/from-template',
      tags: ['templates'],
      summary: 'Create a Bot from a template link or an imported file',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: FromTemplateSchema } } },
      },
      responses: {
        201: {
          description: "The new Bot, and whether it runs on the template's model",
          content: { 'application/json': { schema: BotFromTemplateSchema } },
        },
        400: problemResponse('Invalid template (`INVALID_TEMPLATE`, `INVALID_SCHEDULE`)'),
        404: problemResponse('No such template'),
        409: problemResponse(
          'Bot limit (`BOT_LIMIT_REACHED`), Routine limit (`ROUTINE_LIMIT_REACHED`) or Skill limit (`SKILL_LIMIT_REACHED`) reached',
        ),
        ...authProblems,
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const { token, file } = c.req.valid('json');
      const source = token ? { token } : { file: file! };
      const { record, templateModel } = await createBotFromTemplate(deps, user, source, {
        computer: computerAvailable(deps),
      });
      return c.json({ ...toBot(record), templateModel }, 201);
    },
  );

/** The caller when the request carries a session or API key; null when it carries neither. */
async function optionalUser(deps: Parameters<typeof authenticateHeaders>[0], headers: Headers) {
  try {
    return await authenticateHeaders(deps, headers);
  } catch (error) {
    if (error instanceof DomainError && error.status === 401) return null;
    throw error;
  }
}
