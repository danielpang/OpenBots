import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import { NO_TOKEN } from '../hooks/inbox.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace, updateSettings } from '../workspace.js';

interface Bot {
  id: string;
  handle: string;
  name: string;
  label: string | null;
  description: string;
  avatar: Record<string, unknown>;
  modelConfig: { provider_id: string; model_id: string } | null;
  toolPolicy: Record<string, unknown>;
  chatId: string;
}

type FromTemplate = Bot & { templateModel: { modelId: string; used: boolean } | null };

interface Template {
  id: string;
  name: string;
  visibility: 'workspace' | 'public';
  token: string;
  owner: { id: string; name: string };
  botName: string;
  skills: number;
  routines: number;
}

interface TemplateFile {
  format: string;
  version: number;
  name: string;
  snapshot: {
    profile: Record<string, unknown>;
    settings: Record<string, unknown>;
    skills: { ref: string; name: string; enabled: boolean; content?: string }[];
    routines: {
      name: string;
      trigger: Record<string, unknown>;
      skillRef: string | null;
      postsToTranscript: boolean;
    }[];
  };
}

const SCHEDULE = { type: 'schedule', cron: '0 9 * * *', preset: { kind: 'daily', time: '09:00' } };
const CONTENT = 'Each morning.\n\nRead, then summarize.';

describe('bot templates', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let aliceId: string;
  let bobId: string;
  let workspaceId: string;
  let sharedProvider: string;
  let aliceProvider: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const users = await t.deps.db.select().from(schema.users);
    aliceId = users.find((u) => u.email === 'alice@example.com')!.id;
    bobId = users.find((u) => u.email === 'bob@example.com')!.id;
    workspaceId = (await ensureWorkspace(t.deps.db)).id;
    const [shared, own] = await t.deps.db
      .insert(schema.providers)
      .values([
        {
          workspaceId,
          ownerId: null,
          name: 'Shared',
          slug: 'shared',
          kind: 'openai',
          protocol: 'native',
          status: 'ok',
        },
        {
          workspaceId,
          ownerId: aliceId,
          name: 'Mine',
          slug: 'mine',
          kind: 'openai',
          protocol: 'native',
          status: 'ok',
        },
      ])
      .returning();
    sharedProvider = shared!.id;
    aliceProvider = own!.id;
    await t.addModels(sharedProvider, ['m']);
    await t.addModels(aliceProvider, ['m']);
  });
  afterAll(() => t.close());

  const call = (cookie: string | undefined, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };

  const setPublic = async (on: boolean) =>
    updateSettings(t.deps.db, await ensureWorkspace(t.deps.db), { publicTemplatesEnabled: on });

  /** A Bot of Alice's with one enabled and one disabled Skill, two Routines, history and memory. */
  async function richBot(name: string, provider = sharedProvider) {
    const { db } = t.deps;
    const bot = await json<Bot>(
      await call(alice, 'POST', '/bots', {
        name,
        label: 'Lead',
        description: 'Be brief.',
        avatar: { kind: 'generated', seed: 'orig', accessory: 'hat' },
        modelConfig: { provider_id: provider, model_id: 'm' },
        toolPolicy: { tools: { send_email: 'ask' } },
      }),
      201,
    );
    const slug = name.toLowerCase().replaceAll(' ', '-');
    const [on, off, routineOnly] = await db
      .insert(schema.skills)
      .values([
        {
          workspaceId,
          ownerId: aliceId,
          name: `${name} brief`,
          slug: `${slug}-on`,
          content: CONTENT,
        },
        { workspaceId, ownerId: aliceId, name: `${name} off`, slug: `${slug}-off` },
        { workspaceId, ownerId: aliceId, name: `${name} digest`, slug: `${slug}-digest` },
      ])
      .returning();
    await db.insert(schema.botSkills).values([
      { workspaceId, botId: bot.id, skillId: on!.id, enabled: true },
      { workspaceId, botId: bot.id, skillId: off!.id, enabled: false },
    ]);
    const [endpoint] = await db
      .insert(schema.webhookEndpoints)
      .values({ workspaceId, botId: bot.id, slug: `${slug}-hook`, tokenHash: 'x' })
      .returning();
    await db.insert(schema.routines).values([
      {
        workspaceId,
        botId: bot.id,
        name: 'Daily',
        slug: 'daily',
        trigger: SCHEDULE,
        promptMd: 'Report',
        chatId: bot.chatId,
        skillId: routineOnly!.id,
      },
      {
        workspaceId,
        botId: bot.id,
        name: 'On push',
        slug: 'on-push',
        trigger: { type: 'event', source: 'github', endpoint_id: endpoint!.id },
        promptMd: 'Review the push',
        enabled: false,
      },
    ]);
    await db.transaction(async (tx) => {
      await tx.insert(schema.messages).values({
        workspaceId,
        chatId: bot.chatId,
        seq: await nextSeq(tx, bot.chatId),
        authorType: 'user',
        authorId: aliceId,
        parts: [{ type: 'text', text: 'secret history' }],
      });
    });
    await db
      .insert(schema.botMemories)
      .values({ workspaceId, botId: bot.id, kind: 'fact', content: 'Likes tea' });
    return bot;
  }

  it('snapshots profile, settings, Skills and Routines, not history, memory or the endpoint', async () => {
    const bot = await richBot('Original');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`, {}),
      201,
    );
    expect(template).toMatchObject({
      name: 'Original',
      visibility: 'workspace',
      owner: { id: aliceId },
      botName: 'Original',
      skills: 2,
      routines: 2,
    });
    expect(template.token.length).toBeGreaterThan(20);

    const file = await json<TemplateFile>(
      await call(bob, 'GET', `/templates/${template.token}`),
      200,
    );
    expect(file).toMatchObject({ format: 'openbot.template', version: 1, name: 'Original' });
    expect(file.snapshot.profile).toEqual({
      name: 'Original',
      label: 'Lead',
      description: 'Be brief.',
      avatar: { kind: 'generated', seed: 'orig', accessory: 'hat' },
    });
    expect(file.snapshot.settings).toEqual({
      modelConfig: { provider_id: sharedProvider, model_id: 'm' },
      toolPolicy: { tools: { send_email: 'ask' } },
    });
    // The enabled Skill, and the one a Routine runs; not the disabled one.
    expect(file.snapshot.skills.map((s) => [s.name, s.enabled, s.content])).toEqual([
      ['Original brief', true, CONTENT],
      ['Original digest', false, ''],
    ]);
    const [daily, push] = file.snapshot.routines;
    expect(daily).toMatchObject({ name: 'Daily', trigger: SCHEDULE, postsToTranscript: true });
    expect(daily!.skillRef).toBe(file.snapshot.skills[1]!.ref);
    expect(push).toMatchObject({ trigger: { type: 'event', endpoint_id: null } });

    const text = JSON.stringify(file);
    expect(text).not.toContain('secret history');
    expect(text).not.toContain('Likes tea');
    expect(text).not.toContain(bot.id);
    expect(text).not.toContain(bot.chatId);
    expect(text).not.toContain(aliceId);
  });

  it('replaces an uploaded avatar with a generated one', async () => {
    const [file] = await t.deps.db
      .insert(schema.files)
      .values({
        workspaceId,
        ownerId: aliceId,
        name: 'me.png',
        mime: 'image/png',
        size: 1,
        storageKey: 'avatars/me.png',
        sha256: 'x',
      })
      .returning();
    const bot = await json<Bot>(
      await call(alice, 'POST', '/bots', {
        name: 'Uploaded',
        avatar: { kind: 'upload', file_id: file!.id },
      }),
      201,
    );
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const exported = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );
    expect(exported.snapshot.profile.avatar).toMatchObject({ kind: 'generated' });
  });

  it('creates a Bot from a link for another member, in their own library', async () => {
    const bot = await richBot('Shared one');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`, { name: 'Morning analyst' }),
      201,
    );
    const made = await json<Bot>(
      await call(bob, 'POST', '/bots/from-template', { token: template.token }),
      201,
    );
    expect(made).toMatchObject({
      handle: 'shared-one-2',
      name: 'Shared one',
      label: 'Lead',
      description: 'Be brief.',
      modelConfig: { provider_id: sharedProvider, model_id: 'm' },
      toolPolicy: { tools: { send_email: 'ask' } },
    });

    const { db } = t.deps;
    const [row] = await db.select().from(schema.bots).where(eq(schema.bots.id, made.id));
    expect(row).toMatchObject({ ownerId: bobId, templateId: template.id });

    const skills = await db.select().from(schema.skills).where(eq(schema.skills.ownerId, bobId));
    expect(skills.map((s) => s.name).sort()).toEqual(['Shared one brief', 'Shared one digest']);
    const enabled = await db
      .select({ skillId: schema.botSkills.skillId })
      .from(schema.botSkills)
      .where(eq(schema.botSkills.botId, made.id));
    expect(enabled.map((e) => e.skillId)).toEqual([
      skills.find((s) => s.name === 'Shared one brief')!.id,
    ]);

    const routines = await db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.botId, made.id))
      .orderBy(schema.routines.name);
    expect(routines).toHaveLength(2);
    const [daily, push] = routines;
    expect(daily).toMatchObject({
      name: 'Daily',
      chatId: made.chatId,
      skillId: skills.find((s) => s.name === 'Shared one digest')!.id,
      enabled: true,
    });
    expect(daily!.nextRunAt).toBeInstanceOf(Date);
    expect(push).toMatchObject({
      trigger: { type: 'event', source: 'github', endpoint_id: null },
      chatId: null,
      enabled: false,
      nextRunAt: null,
    });
    // The new Bot has its own inbox and no other endpoint, without a token yet (H1).
    const endpoints = await db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.botId, made.id));
    expect(endpoints).toMatchObject([{ slug: 'inbox', routineId: null, tokenHash: NO_TOKEN }]);

    const messages = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, made.chatId));
    expect(messages).toHaveLength(0);
    const memories = await db
      .select()
      .from(schema.botMemories)
      .where(eq(schema.botMemories.botId, made.id));
    expect(memories).toHaveLength(0);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'bot.from_template'), eq(schema.auditLog.targetId, made.id)),
      );
    expect(audit).toHaveLength(1);

    // A second Bot from the same template reuses the identical Skills.
    const again = await json<Bot>(
      await call(bob, 'POST', '/bots/from-template', { token: template.token }),
      201,
    );
    expect(again.handle).toBe('shared-one-3');
    const after = await db.select().from(schema.skills).where(eq(schema.skills.ownerId, bobId));
    expect(after).toHaveLength(2);
  });

  it('gives the default model instead of one on a provider the member cannot use', async () => {
    const bot = await richBot('Private model', aliceProvider);
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const forBob = await json<FromTemplate>(
      await call(bob, 'POST', '/bots/from-template', { token: template.token }),
      201,
    );
    // Bob's default (plan 3): the shared provider's first model with tools.
    expect(forBob.modelConfig).toEqual({ provider_id: sharedProvider, model_id: 'm' });
    expect(forBob.templateModel).toEqual({ modelId: 'm', used: false });
    const forAlice = await json<FromTemplate>(
      await call(alice, 'POST', '/bots/from-template', { token: template.token }),
      201,
    );
    expect(forAlice.modelConfig).toEqual({ provider_id: aliceProvider, model_id: 'm' });
    expect(forAlice.templateModel).toEqual({ modelId: 'm', used: true });
  });

  it('gives a file from another instance, or a model turned off, the default model (B6, plan 3)', async () => {
    const bot = await richBot('Travelled');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const file = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );
    const elsewhere = structuredClone(file);
    elsewhere.snapshot.settings.modelConfig = {
      provider_id: crypto.randomUUID(),
      model_id: 'gpt-elsewhere',
    };
    const imported = await json<FromTemplate>(
      await call(bob, 'POST', '/bots/from-template', { file: elsewhere }),
      201,
    );
    expect(imported.modelConfig).toEqual({ provider_id: sharedProvider, model_id: 'm' });
    expect(imported.templateModel).toEqual({ modelId: 'gpt-elsewhere', used: false });

    // A usable provider whose model is gone or turned off is not kept either.
    const missing = structuredClone(file);
    missing.snapshot.settings.modelConfig = { provider_id: aliceProvider, model_id: 'gone' };
    const fallback = await json<FromTemplate>(
      await call(alice, 'POST', '/bots/from-template', { file: missing }),
      201,
    );
    expect(fallback.modelConfig).toMatchObject({ model_id: 'm' });
    expect(fallback.templateModel).toEqual({ modelId: 'gone', used: false });
    const sharedM = and(
      eq(schema.providerModels.providerId, sharedProvider),
      eq(schema.providerModels.modelId, 'm'),
    );
    await t.deps.db.update(schema.providerModels).set({ enabled: false }).where(sharedM);
    try {
      const off = await json<FromTemplate>(
        await call(alice, 'POST', '/bots/from-template', { file }),
        201,
      );
      expect(off.modelConfig).toEqual({ provider_id: aliceProvider, model_id: 'm' });
      expect(off.templateModel).toEqual({ modelId: 'm', used: false });
    } finally {
      await t.deps.db.update(schema.providerModels).set({ enabled: true }).where(sharedM);
    }

    // A template without a model gets the default, with nothing to report.
    const none = structuredClone(file);
    none.snapshot.settings.modelConfig = null;
    const plain = await json<FromTemplate>(
      await call(bob, 'POST', '/bots/from-template', { file: none }),
      201,
    );
    expect(plain.modelConfig).toEqual({ provider_id: sharedProvider, model_id: 'm' });
    expect(plain.templateModel).toBeNull();
  });

  it('lists the workspace templates and lets only the owner delete one', async () => {
    const bot = await richBot('Listed');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    await setPublic(false);
    const list = await json<{ items: Template[]; publicEnabled: boolean }>(
      await call(bob, 'GET', '/templates'),
      200,
    );
    expect(list.publicEnabled).toBe(false);
    expect(list.items.map((i) => i.id)).toContain(template.id);
    expect(list.items[0]!.id).toBe(template.id);

    expect((await call(bob, 'DELETE', `/templates/${template.token}`)).status).toBe(404);
    expect((await call(alice, 'DELETE', `/templates/${template.token}`)).status).toBe(204);
    expect((await call(alice, 'GET', `/templates/${template.token}`)).status).toBe(404);
  });

  it('enforces visibility: workspace needs a session, public needs the admin setting', async () => {
    await setPublic(false);
    const bot = await richBot('Visible');
    const ws = await json<Template>(await call(alice, 'POST', `/bots/${bot.id}/template`), 201);

    // Saving a public template while public links are off.
    const refused = await call(alice, 'POST', `/bots/${bot.id}/template`, { visibility: 'public' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'PUBLIC_TEMPLATES_DISABLED' });

    expect((await call(undefined, 'GET', `/templates/${ws.token}`)).status).toBe(401);
    expect((await call(undefined, 'GET', '/templates/no-such-token')).status).toBe(401);
    expect((await call(bob, 'GET', '/templates/no-such-token')).status).toBe(404);
    expect((await call(bob, 'GET', `/templates/${ws.token}`)).status).toBe(200);
    expect((await call(undefined, 'GET', '/templates')).status).toBe(401);
    expect((await call(undefined, 'POST', '/bots/from-template', { token: ws.token })).status).toBe(
      401,
    );

    await setPublic(true);
    const pub = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`, { visibility: 'public' }),
      201,
    );
    expect(pub.visibility).toBe('public');
    expect((await call(undefined, 'GET', `/templates/${pub.token}`)).status).toBe(200);
    // A workspace template stays private while public links are on.
    expect((await call(undefined, 'GET', `/templates/${ws.token}`)).status).toBe(401);

    // Turning public links off closes existing public links again.
    await setPublic(false);
    expect((await call(undefined, 'GET', `/templates/${pub.token}`)).status).toBe(401);
    expect((await call(bob, 'GET', `/templates/${pub.token}`)).status).toBe(200);
  });

  it('lets the owner change visibility, public only while the admin allows it', async () => {
    await setPublic(false);
    const bot = await richBot('Switched');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const patch = (cookie: string | undefined, visibility: string, token = template.token) =>
      call(cookie, 'PATCH', `/templates/${token}`, { visibility });

    const refused = await patch(alice, 'public');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'PUBLIC_TEMPLATES_DISABLED' });
    expect((await patch(bob, 'public')).status).toBe(404);
    expect((await patch(alice, 'workspace', 'no-such-token')).status).toBe(404);
    expect((await patch(undefined, 'workspace')).status).toBe(401);
    expect((await patch(alice, 'everyone')).status).toBe(400);

    await setPublic(true);
    const made = await json<Template>(await patch(alice, 'public'), 200);
    expect(made).toMatchObject({ id: template.id, visibility: 'public', token: template.token });
    expect((await call(undefined, 'GET', `/templates/${template.token}`)).status).toBe(200);
    // Only the owner: another member cannot close it either.
    expect((await patch(bob, 'workspace')).status).toBe(404);

    // Back to workspace-only needs no admin setting, and closes the public link.
    await setPublic(false);
    const back = await json<Template>(await patch(alice, 'workspace'), 200);
    expect(back.visibility).toBe('workspace');
    await setPublic(true);
    expect((await call(undefined, 'GET', `/templates/${template.token}`)).status).toBe(401);
    // An unchanged visibility is not a change.
    await json<Template>(await patch(alice, 'workspace'), 200);
    await setPublic(false);

    const audit = await t.deps.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'template.visibility'),
          eq(schema.auditLog.targetId, template.id),
        ),
      );
    expect(audit.map((a) => a.metadata)).toEqual([
      { from: 'workspace', to: 'public' },
      { from: 'public', to: 'workspace' },
    ]);
  });

  it('round-trips through an exported file', async () => {
    const bot = await richBot('Exported');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const file = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );
    await call(alice, 'DELETE', `/templates/${template.token}`);

    const imported = await json<Bot>(
      await call(bob, 'POST', '/bots/from-template', { file: JSON.parse(JSON.stringify(file)) }),
      201,
    );
    const [row] = await t.deps.db.select().from(schema.bots).where(eq(schema.bots.id, imported.id));
    expect(row!.templateId).toBeNull();

    // The imported Bot, saved as a template, exports the same snapshot.
    const again = await json<Template>(
      await call(bob, 'POST', `/bots/${imported.id}/template`),
      201,
    );
    const reexported = await json<TemplateFile>(
      await call(bob, 'GET', `/templates/${again.token}`),
      200,
    );
    expect(reexported).toEqual(file);
  });

  it('rejects a malformed or inconsistent file', async () => {
    const bot = await richBot('Checked');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const file = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );

    expect((await call(bob, 'POST', '/bots/from-template', {})).status).toBe(400);
    expect(
      (await call(bob, 'POST', '/bots/from-template', { token: template.token, file })).status,
    ).toBe(400);
    expect(
      (await call(bob, 'POST', '/bots/from-template', { file: { ...file, format: 'other' } }))
        .status,
    ).toBe(400);

    const dangling = structuredClone(file);
    dangling.snapshot.routines[0]!.skillRef = 'skill-99';
    const res = await call(bob, 'POST', '/bots/from-template', { file: dangling });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_TEMPLATE' });

    const badCron = structuredClone(file);
    badCron.snapshot.routines[0]!.trigger = {
      type: 'schedule',
      cron: '',
      preset: { kind: 'custom', cron: 'not a cron at all' },
    };
    expect((await call(bob, 'POST', '/bots/from-template', { file: badCron })).status).toBe(400);
  });

  it('caps the Skills an import adds to the library', async () => {
    const bot = await richBot('Skilled');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const file = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );
    expect(file.snapshot.skills).toHaveLength(2);
    const carol = (await t.signUp('carol@example.com')).cookie!;
    const carolId = (await t.deps.db.select().from(schema.users)).find(
      (u) => u.email === 'carol@example.com',
    )!.id;
    await t.deps.db
      .insert(schema.skills)
      .values({ workspaceId, ownerId: carolId, name: 'Already here', slug: 'already-here' });
    const limit = async (skillsPerAccount: number) =>
      updateSettings(t.deps.db, await ensureWorkspace(t.deps.db), { limits: { skillsPerAccount } });
    const carolsSkills = async () =>
      (await t.deps.db.select().from(schema.skills).where(eq(schema.skills.ownerId, carolId)))
        .length;
    const carolsBots = async () =>
      (await t.deps.db.select().from(schema.bots).where(eq(schema.bots.ownerId, carolId))).length;
    const botsBefore = await carolsBots();
    try {
      // More Skills in the file than the limit allows at all.
      await limit(1);
      const tooMany = await call(carol, 'POST', '/bots/from-template', { file });
      expect(tooMany.status).toBe(409);
      expect(await tooMany.json()).toMatchObject({ code: 'SKILL_LIMIT_REACHED' });

      // Room for one more: the second new Skill hits the limit and nothing is kept.
      await limit(2);
      const full = await call(carol, 'POST', '/bots/from-template', { file });
      expect(full.status).toBe(409);
      expect(await full.json()).toMatchObject({ code: 'SKILL_LIMIT_REACHED' });
      expect(await carolsSkills()).toBe(1);
      expect(await carolsBots()).toBe(botsBefore);

      await limit(3);
      await json<Bot>(await call(carol, 'POST', '/bots/from-template', { file }), 201);
      expect(await carolsSkills()).toBe(3);
    } finally {
      await limit(200);
    }
  });

  it('reads a Skill with sections from an older template file as content', async () => {
    const bot = await richBot('Older');
    const template = await json<Template>(
      await call(alice, 'POST', `/bots/${bot.id}/template`),
      201,
    );
    const file = await json<TemplateFile>(
      await call(alice, 'GET', `/templates/${template.token}`),
      200,
    );
    const [first, ...rest] = file.snapshot.skills;
    const older = {
      ...file,
      snapshot: {
        ...file.snapshot,
        skills: [
          {
            ref: first!.ref,
            name: 'Older format',
            sections: { when_to_use: 'Mondays', sequence: '1. Go', output: '' },
            status: 'ready',
            enabled: true,
          },
          ...rest,
        ],
      },
    };
    await json<Bot>(await call(bob, 'POST', '/bots/from-template', { file: older }), 201);
    const [skill] = await t.deps.db
      .select()
      .from(schema.skills)
      .where(and(eq(schema.skills.ownerId, bobId), eq(schema.skills.name, 'Older format')));
    expect(skill!.content).toBe('## When to use it\nMondays\n\n## Sequence\n1. Go');
  });

  it('answers 404 for another member’s Bot', async () => {
    const bot = await richBot('Not yours');
    expect((await call(bob, 'POST', `/bots/${bot.id}/template`)).status).toBe(404);
  });
});
