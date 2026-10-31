import { randomBytes, randomUUID } from 'node:crypto';
import { triggerNextRunAt } from '@openbot/routines';
import {
  AvatarSchema,
  botModelNeeds,
  handleFromName,
  ModelConfigSchema,
  RoutineTriggerSchema,
  SKILL_NAME_MAX,
  SkillContentSchema,
  ToolPolicySchema,
  type Avatar,
  type ModelConfig,
  type RoutineTrigger,
} from '@openbot/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound, unauthorized } from '../errors.js';
import { effectiveSettings, ensureWorkspace } from '../workspace.js';
import { recordAudit, userActor } from './audit.js';
import {
  audit,
  canUseProvider,
  freeHandle,
  getBot,
  insertBot,
  reserveSlot,
  type BotRecord,
} from './bots.js';
import { avatarFileStatus } from './files.js';
import { assertBotModel, defaultModelConfig } from './providers.js';
import { checkedTrigger, routineLimitReached } from './routines.js';
import { createSkill, skillLimitReached } from './skills.js';

// Bot templates (B6, U3, plan 4.1, 14.1). A template is a snapshot of a Bot:
// profile, settings, avatar, enabled Skills (embedded, so a teammate without
// them gets copies in their own library) and Routines. Like duplicating (B5)
// it leaves out the transcript, memories and attachments; unlike it, nothing
// in the snapshot points at the owner's own rows, because another member (or,
// through a JSON file, another instance) restores it: per-Bot connector
// settings and an event trigger's webhook endpoint are left out, an uploaded
// avatar becomes a generated one, and a model is kept only when the restoring
// member can use its provider and the model is there and on. Otherwise the
// Bot gets the default model like any new Bot (plan 3), and the response
// says the template's model was not available.
//
// Sharing: every template has a link token. Any member of the workspace may
// read it with a session or API key; a `public` template is readable without
// one only while the admin has `publicTemplatesEnabled` on (off by default,
// PRD open question 2). The JSON file is the template as `GET` returns it.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type TemplatesDeps = Pick<AppDeps, 'db' | 'config'>;

export type TemplateRow = typeof schema.botTemplates.$inferSelect;
export type TemplateVisibility = TemplateRow['visibility'];

export const TEMPLATE_FORMAT = 'openbot.template';

const TemplateSkillSchema = z.strictObject({
  /** How the snapshot's Routines refer to this Skill. */
  ref: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(SKILL_NAME_MAX),
  content: SkillContentSchema.optional(),
  /** Templates saved when a Skill had sections and a status; read as content. */
  sections: z.record(z.string(), z.string().max(8_000)).optional(),
  status: z.enum(['draft', 'ready']).optional(),
  /** False for a Skill a Routine runs that is not switched on for the Bot. */
  enabled: z.boolean(),
});

/** The sections an older template's Skill has, in order, under the headings the skills_content migration kept. */
const LEGACY_SECTIONS = [
  ['when_to_use', 'When to use it'],
  ['inputs_and_access', 'Inputs and access'],
  ['sequence', 'Sequence'],
  ['validation', 'Validation'],
  ['output', 'Output'],
  ['approvals', 'Approvals'],
] as const;

/** A template Skill's content, or an older one's sections under their headings. */
function templateSkillContent(skill: z.infer<typeof TemplateSkillSchema>): string {
  if (skill.content !== undefined) return skill.content;
  return LEGACY_SECTIONS.flatMap(([key, title]) => {
    const text = skill.sections?.[key]?.trim();
    return text ? [`## ${title}\n${text}`] : [];
  }).join('\n\n');
}

const TemplateRoutineSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  trigger: RoutineTriggerSchema,
  prompt: z.string().max(20_000),
  skillRef: z.string().min(1).max(64).nullable(),
  enabled: z.boolean(),
  timezone: z.string().min(1).max(64),
  /** Posts into the Bot's transcript, rather than nowhere. */
  postsToTranscript: z.boolean(),
});

export const TemplateSnapshotSchema = z.strictObject({
  profile: z.strictObject({
    name: z.string().trim().min(1).max(80),
    label: z.string().max(80).nullable(),
    description: z.string().max(20_000),
    avatar: AvatarSchema,
  }),
  settings: z.strictObject({
    modelConfig: ModelConfigSchema.nullable(),
    toolPolicy: ToolPolicySchema,
  }),
  skills: z.array(TemplateSkillSchema).max(500),
  routines: z.array(TemplateRoutineSchema).max(500),
});

export type TemplateSnapshot = z.infer<typeof TemplateSnapshotSchema>;

/** The JSON export, and what `GET /templates/{token}` answers. */
export const TemplateFileSchema = z.strictObject({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  snapshot: TemplateSnapshotSchema,
});

export type TemplateFile = z.infer<typeof TemplateFileSchema>;

export interface TemplateRecord {
  template: TemplateRow;
  ownerName: string;
}

export const publicTemplatesDisabled = () =>
  new DomainError(
    403,
    'PUBLIC_TEMPLATES_DISABLED',
    'Public template links are off. Ask an admin to turn them on.',
  );

const invalidTemplate = (message: string) => new DomainError(400, 'INVALID_TEMPLATE', message);

/** What a Bot looks like as a template (B6), read in one pass. */
export async function snapshotBot(db: Db, owner: Owner, botId: string): Promise<TemplateSnapshot> {
  const { bot, chatId } = await getBot(db, owner, botId);

  const enabled = await db
    .select({ skillId: schema.botSkills.skillId })
    .from(schema.botSkills)
    .where(and(eq(schema.botSkills.botId, bot.id), eq(schema.botSkills.enabled, true)));
  const routines = await db
    .select()
    .from(schema.routines)
    .where(eq(schema.routines.botId, bot.id))
    .orderBy(schema.routines.createdAt, schema.routines.name);
  const enabledIds = new Set(enabled.map((s) => s.skillId));
  const skillIds = [
    ...new Set([...enabledIds, ...routines.flatMap((r) => (r.skillId ? [r.skillId] : []))]),
  ];
  const skills = skillIds.length
    ? await db
        .select()
        .from(schema.skills)
        .where(inArray(schema.skills.id, skillIds))
        .orderBy(schema.skills.name)
    : [];
  const refs = new Map(skills.map((s, i) => [s.id, `skill-${i + 1}`]));

  const avatar = AvatarSchema.safeParse(bot.avatar);
  const modelConfig = ModelConfigSchema.safeParse(bot.modelConfig);
  return {
    profile: {
      name: bot.name,
      label: bot.label,
      description: bot.description,
      // An uploaded file stays the owner's; the template gets a generated look.
      avatar:
        avatar.success && avatar.data.kind === 'generated'
          ? avatar.data
          : ({ kind: 'generated', seed: bot.id } satisfies Avatar),
    },
    settings: {
      modelConfig: modelConfig.success ? modelConfig.data : null,
      toolPolicy: ToolPolicySchema.catch({}).parse(bot.toolPolicy),
    },
    skills: skills.map((s) => ({
      ref: refs.get(s.id)!,
      name: s.name,
      content: s.content,
      enabled: enabledIds.has(s.id),
    })),
    routines: routines.flatMap((r) => {
      const trigger = RoutineTriggerSchema.safeParse(r.trigger);
      if (!trigger.success) return [];
      return [
        {
          name: r.name,
          // The webhook endpoint belongs to the source Bot.
          trigger:
            trigger.data.type === 'event' ? { ...trigger.data, endpoint_id: null } : trigger.data,
          prompt: r.promptMd,
          skillRef: (r.skillId && refs.get(r.skillId)) || null,
          enabled: r.enabled,
          timezone: r.timezone,
          postsToTranscript: r.chatId === chatId,
        },
      ];
    }),
  };
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** `POST /bots/{id}/template`: snapshots one of the caller's Bots. */
export async function createTemplate(
  deps: TemplatesDeps,
  owner: Owner,
  botId: string,
  input: { name?: string; visibility?: TemplateVisibility },
): Promise<TemplateRecord> {
  const visibility = input.visibility ?? 'workspace';
  if (visibility === 'public') await assertPublicEnabled(deps);
  const snapshot = await snapshotBot(deps.db, owner, botId);
  const [template] = await deps.db
    .insert(schema.botTemplates)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: input.name?.trim() || snapshot.profile.name,
      visibility,
      token: newToken(),
      snapshot,
    })
    .returning();
  await recordAudit(deps.db, {
    workspaceId: owner.workspaceId,
    actor: userActor(owner),
    action: 'template.share',
    targetType: 'template',
    targetId: template!.id,
    metadata: { botId, visibility },
  });
  return getTemplateRecord(deps.db, template!.id);
}

/** Every template in the workspace, newest first; members share them (B6). */
export async function listTemplates(db: Db, viewer: Owner): Promise<TemplateRecord[]> {
  return db
    .select({ template: schema.botTemplates, ownerName: schema.users.name })
    .from(schema.botTemplates)
    .innerJoin(schema.users, eq(schema.users.id, schema.botTemplates.ownerId))
    .where(eq(schema.botTemplates.workspaceId, viewer.workspaceId))
    .orderBy(desc(schema.botTemplates.createdAt));
}

async function getTemplateRecord(db: Db, id: string): Promise<TemplateRecord> {
  const [row] = await db
    .select({ template: schema.botTemplates, ownerName: schema.users.name })
    .from(schema.botTemplates)
    .innerJoin(schema.users, eq(schema.users.id, schema.botTemplates.ownerId))
    .where(eq(schema.botTemplates.id, id));
  if (!row) throw notFound('Template not found');
  return row;
}

/**
 * Only its owner changes who a template's link opens for (B6, U3). Making it
 * public needs the admin's public links setting; making it workspace-only
 * never does.
 */
export async function setTemplateVisibility(
  deps: TemplatesDeps,
  owner: Owner,
  token: string,
  visibility: TemplateVisibility,
): Promise<TemplateRecord> {
  const [row] = await deps.db
    .select({ id: schema.botTemplates.id, visibility: schema.botTemplates.visibility })
    .from(schema.botTemplates)
    .where(
      and(
        eq(schema.botTemplates.token, token),
        eq(schema.botTemplates.ownerId, owner.id),
        eq(schema.botTemplates.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Template not found');
  if (visibility === 'public') await assertPublicEnabled(deps);
  if (row.visibility !== visibility) {
    await deps.db
      .update(schema.botTemplates)
      .set({ visibility })
      .where(eq(schema.botTemplates.id, row.id));
    await recordAudit(deps.db, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'template.visibility',
      targetType: 'template',
      targetId: row.id,
      metadata: { from: row.visibility, to: visibility },
    });
  }
  return getTemplateRecord(deps.db, row.id);
}

/** Only its owner deletes a template; its link stops working. */
export async function deleteTemplate(db: Db, owner: Owner, token: string): Promise<void> {
  const [row] = await db
    .delete(schema.botTemplates)
    .where(
      and(
        eq(schema.botTemplates.token, token),
        eq(schema.botTemplates.ownerId, owner.id),
        eq(schema.botTemplates.workspaceId, owner.workspaceId),
      ),
    )
    .returning({ id: schema.botTemplates.id, visibility: schema.botTemplates.visibility });
  if (!row) throw notFound('Template not found');
  await recordAudit(db, {
    workspaceId: owner.workspaceId,
    actor: userActor(owner),
    action: 'template.revoke',
    targetType: 'template',
    targetId: row.id,
    metadata: { visibility: row.visibility },
  });
}

/**
 * The template behind a link. `viewer` is the signed-in member, or null for
 * an anonymous request, which only a public template answers, and only while
 * public links are on; otherwise it is asked to sign in.
 */
export async function templateByToken(
  deps: TemplatesDeps,
  viewer: Owner | null,
  token: string,
): Promise<TemplateRow> {
  const [row] = await deps.db
    .select()
    .from(schema.botTemplates)
    .where(eq(schema.botTemplates.token, token));
  if (viewer) {
    if (!row || row.workspaceId !== viewer.workspaceId) throw notFound('Template not found');
    return row;
  }
  if (row?.visibility === 'public' && (await publicEnabled(deps))) return row;
  throw unauthorized('Sign in to open this template');
}

export function templateFile(row: Pick<TemplateRow, 'name' | 'snapshot'>): TemplateFile {
  return {
    format: TEMPLATE_FORMAT,
    version: 1,
    name: row.name,
    snapshot: TemplateSnapshotSchema.parse(row.snapshot),
  };
}

/** Whether public template links are on (U3, off by default). */
export async function publicEnabled(deps: TemplatesDeps): Promise<boolean> {
  return effectiveSettings(deps.config, await ensureWorkspace(deps.db)).publicTemplatesEnabled;
}

async function assertPublicEnabled(deps: TemplatesDeps) {
  if (!(await publicEnabled(deps))) throw publicTemplatesDisabled();
}

/** The model a template names, and whether the Bot made from it runs on that model. */
export interface TemplateModel {
  modelId: string;
  used: boolean;
}

export interface FromTemplateResult {
  record: BotRecord;
  /** Null when the template names no model. */
  templateModel: TemplateModel | null;
}

/**
 * The template's model when the caller may use its provider and the model is
 * there and turned on; else the default model a new Bot gets (plan 3), which
 * a file from another instance always needs, as provider ids are per instance.
 */
async function modelForTemplate(
  db: Db,
  owner: Owner,
  settings: TemplateSnapshot['settings'],
  computer: boolean,
): Promise<{ modelConfig: ModelConfig | null; templateModel: TemplateModel | null }> {
  const named = settings.modelConfig;
  if (named && (await canUseProvider(db, owner, named.provider_id))) {
    try {
      await assertBotModel(db, named);
      return { modelConfig: named, templateModel: { modelId: named.model_id, used: true } };
    } catch (error) {
      // UNKNOWN_MODEL or MODEL_DISABLED: fall back below.
      if (!(error instanceof DomainError && error.status === 400)) throw error;
    }
  }
  return {
    modelConfig: await defaultModelConfig(db, owner, botModelNeeds(settings.toolPolicy, computer)),
    templateModel: named ? { modelId: named.model_id, used: false } : null,
  };
}

/**
 * `POST /bots/from-template`: a new Bot for the caller from a template link
 * or an imported file. Its Skills land in the caller's library (an identical
 * one already there is reused) and its Routines are recreated, all in one
 * transaction under the Bot and Routine limits. `computer` says whether this
 * install has a computer, so a default model is picked with vision (L4).
 */
export async function createBotFromTemplate(
  deps: TemplatesDeps,
  owner: Owner,
  source: { token: string } | { file: TemplateFile },
  { computer = false }: { computer?: boolean } = {},
): Promise<FromTemplateResult> {
  let templateId: string | null = null;
  let snapshot: TemplateSnapshot;
  if ('token' in source) {
    const row = await templateByToken(deps, owner, source.token);
    templateId = row.id;
    snapshot = templateFile(row).snapshot;
  } else {
    snapshot = source.file.snapshot;
  }
  const refs = new Set(snapshot.skills.map((s) => s.ref));
  if (refs.size !== snapshot.skills.length) invalid('Two Skills share a ref');
  for (const routine of snapshot.routines) {
    if (routine.skillRef && !refs.has(routine.skillRef)) {
      invalid(`Routine ${routine.name} refers to a Skill the template does not have`);
    }
  }

  const { modelConfig, templateModel } = await modelForTemplate(
    deps.db,
    owner,
    snapshot.settings,
    computer,
  );

  const botId = await deps.db.transaction(async (tx) => {
    await reserveSlot(deps, tx, owner);
    const { limits } = effectiveSettings(deps.config, await ensureWorkspace(tx));
    if (snapshot.routines.length > limits.routinesPerBot) {
      throw routineLimitReached(limits.routinesPerBot, deps.config);
    }
    // Each new library Skill is checked again as it is created (reused ones are free).
    if (snapshot.skills.length > limits.skillsPerAccount) {
      throw skillLimitReached(limits.skillsPerAccount, deps.config);
    }
    const { profile, settings } = snapshot;
    const handle = await freeHandle(tx, owner, handleFromName(profile.name));
    const bot = await insertBot(tx, owner, {
      handle,
      name: profile.name,
      label: profile.label,
      description: profile.description,
      // A file's avatar only when the file is the caller's (S-18 G1) and an image.
      avatar:
        profile.avatar.kind === 'upload' &&
        (await avatarFileStatus(tx, owner, profile.avatar.file_id)) !== 'usable'
          ? { kind: 'generated', seed: randomUUID() }
          : profile.avatar,
      modelConfig: modelConfig ?? {},
      toolPolicy: settings.toolPolicy,
      templateId,
    });

    const skillIds = new Map<string, string>();
    for (const skill of snapshot.skills) {
      const id = await librarySkill({ db: tx, config: deps.config }, owner, skill);
      skillIds.set(skill.ref, id);
      if (skill.enabled) {
        await tx
          .insert(schema.botSkills)
          .values({ workspaceId: owner.workspaceId, botId: bot.id, skillId: id, enabled: true })
          .onConflictDoNothing();
      }
    }

    const slugs = new Set<string>();
    const now = new Date();
    for (const routine of snapshot.routines) {
      const checked: RoutineTrigger = checkedTrigger(routine.trigger, routine.timezone);
      // A new Bot has no endpoints; one named in a file is someone else's (S-18 G3).
      const trigger: RoutineTrigger =
        checked.type === 'event' ? { ...checked, endpoint_id: null } : checked;
      const base = handleFromName(routine.name) || 'routine';
      let slug = base;
      for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`;
      slugs.add(slug);
      await tx.insert(schema.routines).values({
        workspaceId: owner.workspaceId,
        botId: bot.id,
        name: routine.name,
        slug,
        trigger,
        promptMd: routine.prompt,
        skillId: routine.skillRef ? skillIds.get(routine.skillRef)! : null,
        chatId: routine.postsToTranscript ? bot.chatId : null,
        enabled: routine.enabled,
        timezone: routine.timezone,
        nextRunAt: routine.enabled ? triggerNextRunAt(trigger, routine.timezone, now) : null,
      });
    }

    await audit(tx, owner, 'bot.from_template', bot.id, { templateId, handle });
    return bot.id;
  });
  return { record: await getBot(deps.db, owner, botId), templateModel };
}

function invalid(message: string): never {
  throw invalidTemplate(message);
}

/** The caller's Skill with the same name and content, or a new one in their library. */
async function librarySkill(
  deps: Pick<AppDeps, 'config'> & { db: Db },
  owner: Owner,
  skill: TemplateSnapshot['skills'][number],
): Promise<string> {
  const candidates = await deps.db
    .select()
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.ownerId, owner.id),
        eq(schema.skills.workspaceId, owner.workspaceId),
        eq(schema.skills.name, skill.name.trim()),
      ),
    );
  const content = templateSkillContent(skill);
  const same = candidates.find((c) => c.content === content);
  if (same) return same.id;
  const { skill: created } = await createSkill(deps, owner, { name: skill.name, content });
  return created.id;
}
