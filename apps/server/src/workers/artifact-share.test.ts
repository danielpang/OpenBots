import { localEmbedder } from '@openbots/agent';
import { scriptedModel } from '@openbots/agent/testing';
import type { MessagePart } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { artifactServices, createArtifact, writeArtifact } from '../services/artifacts.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// A Bot asks to share an Artifact (plan 21.11): the request is an approval
// its owner answers in the app, whatever the Bot's settings say; only a
// person may approve it; and the server shares only on that approval.

describe('a Bot asking to share an Artifact', () => {
  let t: TestApp;
  let cookie: string;
  let ownerId: string;
  let workspaceId: string;
  let unhook: () => void;
  const models = new Map<string, RunModel>();

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: 'openbots-artifacts.test',
    });
    cookie = (await t.signUp('owner@example.com')).cookie!;
    ownerId = await t.userId('owner@example.com');
    workspaceId = await t.defaultOrganization();
    unhook = registerRunHooks();
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(
      createRunWorker(t.deps, {
        resolveModel: async (_config, bot) => models.get(bot.id)!,
        smallModel: async () => null,
        embedder: localEmbedder,
      }),
      { concurrency: 2 },
    );
  });
  afterAll(async () => {
    unhook();
    await t.close();
  });

  function call(method: string, path: string, body?: unknown, auth: Record<string, string> = {}) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(auth.authorization ? auth : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  async function botAsking(
    name: string,
    args: Record<string, unknown>,
    { approval: expectApproval = true }: { approval?: boolean } = {},
  ) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
      // Every setting that could run a tool unasked.
      toolPolicy: {
        groups: { artifacts: 'auto' },
        tools: { request_artifact_share: 'auto' },
      },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as { id: string; chatId: string };
    const { artifact } = await createArtifact(
      t.ownerDeps,
      { id: ownerId, workspaceId },
      { title: `${name} report`, kind: 'document', botId: bot.id, content: 'quarterly numbers' },
      { userId: ownerId },
    );
    models.set(bot.id, {
      model: scriptedModel([
        [{ tool: 'request_artifact_share', args: { id: artifact.id, ...args }, id: 's1' }],
        [{ text: 'Done asking.' }],
      ]),
      info: null,
      providerOptions: {},
    });
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Please share the report' });
    if (!expectApproval) return { bot, artifactId: artifact.id, approval: null as never };
    const approval = await until(async () => {
      const mine = (
        await t.db
          .select()
          .from(schema.approvals)
          .where(eq(schema.approvals.toolName, 'request_artifact_share'))
      ).find((a) => (a.args as { id: string }).id === artifact.id);
      expect(mine?.status).toBe('pending');
      return mine!;
    });
    return { bot, artifactId: artifact.id, approval };
  }

  const saveVersion = (id: string, content: string) =>
    writeArtifact(t.ownerDeps, { id: ownerId, workspaceId }, id, { content }, { userId: ownerId });

  const visibilityOf = async (id: string) =>
    (await t.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)))[0]!;

  /** The owner (an admin of their install) turns public links on or off. */
  const publicLinks = async (on: boolean) =>
    expect((await call('PATCH', '/settings', { publicArtifactsEnabled: on })).status).toBe(200);

  it('waits for the owner whatever the settings say, and says future versions become public', async () => {
    await publicLinks(true);
    const { bot, artifactId, approval } = await botAsking('Asker', { visibility: 'public' });
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
    expect(run!.status).toBe('waiting');
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
    // The approval names the Artifact only: no version is pinned.
    expect(approval.args).toEqual({ id: artifactId, visibility: 'public' });
    const [message] = await t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, approval.messageId!));
    const widget = (message!.parts as MessagePart[]).find(
      (p) => p.type === 'widget' && p.kind === 'approval',
    ) as { props: { summary: string; trace: { why: string }[] } };
    expect(widget.props.summary).toBe(
      'Make “Asker report” public: anyone with the link can view it and every future version of it, without signing in',
    );
    expect(widget.props.trace.at(-1)!.why).toContain('always waits for its owner');
    // The viewer shows the pending request.
    const sharing = (await (await call('GET', `/artifacts/${artifactId}/sharing`)).json()) as {
      pendingRequest: Record<string, unknown>;
    };
    expect(sharing.pendingRequest).toMatchObject({ approvalId: approval.id, visibility: 'public' });
    expect(sharing.pendingRequest).not.toHaveProperty('version');

    // A script's API key cannot approve it.
    const key = (await (await call('POST', '/api-keys', { name: 'script' })).json()) as {
      key: string;
    };
    const byKey = await call(
      'POST',
      `/approvals/${approval.id}/decide`,
      { decision: 'approve' },
      { authorization: `Bearer ${key.key}` },
    );
    expect(byKey.status).toBe(403);
    expect(((await byKey.json()) as { code: string }).code).toBe('PERSON_REQUIRED');
    const [still] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval.id));
    expect(still!.status).toBe('pending');

    // A version saved while the request waits is what the link shows once approved.
    await saveVersion(artifactId, 'newer numbers');
    const decided = await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    await until(async () => {
      const [after] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, run!.id));
      expect(after!.status).toBe('completed');
    });
    const shared = await visibilityOf(artifactId);
    expect(shared.visibility).toBe('public');
    expect(shared.sharedBy).toBe(ownerId);
    const [audit] = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'artifact.visibility'),
          eq(schema.auditLog.targetId, artifactId),
        ),
      );
    expect(audit).toMatchObject({
      actorType: 'user',
      actorId: ownerId,
      metadata: { from: 'private', to: 'public', approvalId: approval.id },
    });
    await publicLinks(false);
  });

  it('refuses a public request while public links are off, and asks the owner nothing', async () => {
    const { bot, artifactId } = await botAsking(
      'Closed',
      { visibility: 'public' },
      { approval: false },
    );
    const run = await until(async () => {
      const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
      expect(row!.status).toBe('completed');
      return row!;
    });
    const asked = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run.id));
    expect(asked).toHaveLength(0);
    const parts = (
      await t.db.select().from(schema.messages).where(eq(schema.messages.chatId, bot.chatId))
    ).flatMap((m) => m.parts as MessagePart[]);
    const result = parts.find((p) => p.type === 'tool_result') as { result: unknown };
    expect(JSON.stringify(result.result)).toContain('has not turned on public links');
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
  });

  it('says plainly that sharing with the organization covers future versions too', async () => {
    const { approval } = await botAsking('Teammate', { visibility: 'org' });
    const [message] = await t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, approval.messageId!));
    const widget = (message!.parts as MessagePart[]).find(
      (p) => p.type === 'widget' && p.kind === 'approval',
    ) as { props: { summary: string } };
    expect(widget.props.summary).toBe(
      'Share “Teammate report” with everyone in your organization: members can view it and every future version of it, read only',
    );
    await call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' });
  });

  it('applies an approval only to the Artifact it names', async () => {
    const { bot, artifactId, approval } = await botAsking('Exact', { visibility: 'org' });
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
    const { artifact: other } = await createArtifact(
      t.ownerDeps,
      { id: ownerId, workspaceId },
      { title: 'Other', kind: 'document', botId: bot.id, content: 'other' },
      { userId: ownerId },
    );
    const share = artifactServices(
      t.ownerDeps,
      { id: run!.id, chatId: bot.chatId },
      { id: bot.id, ownerId, workspaceId },
    ).share!;
    await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    await until(async () => expect((await visibilityOf(artifactId)).visibility).toBe('org'));
    await expect(share.apply({ id: other.id, visibility: 'org' })).rejects.toThrow(
      'has not approved',
    );
    expect((await visibilityOf(other.id)).visibility).toBe('private');
  });

  it('uses an approval once, even after its audit entry is gone', async () => {
    const { bot, artifactId, approval } = await botAsking('Retained', { visibility: 'org' });
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
    const share = artifactServices(
      t.ownerDeps,
      { id: run!.id, chatId: bot.chatId },
      { id: bot.id, ownerId, workspaceId },
    ).share!;
    await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    await until(async () => expect((await visibilityOf(artifactId)).visibility).toBe('org'));
    // Audit retention deletes the entry; the approval row still says it was used.
    await t.db
      .delete(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'artifact.visibility'),
          eq(schema.auditLog.targetId, artifactId),
        ),
      );
    await call('PUT', `/artifacts/${artifactId}/sharing`, { visibility: 'private' });
    await expect(share.apply({ id: artifactId, visibility: 'org' })).rejects.toThrow(
      'has not approved',
    );
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
    const [used] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval.id));
    expect((used as { consumedAt?: Date | null }).consumedAt).toBeInstanceOf(Date);
  });

  it('shares nothing when the owner denies it', async () => {
    const { artifactId, approval } = await botAsking('Denied', { visibility: 'org' });
    const decided = await call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' });
    expect(decided.status).toBe(200);
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
  });

  it('shares nothing when the tool runs without an approval, or reuses a used one', async () => {
    const { bot, artifactId, approval } = await botAsking('Bypass', { visibility: 'org' });
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
    const share = artifactServices(
      t.ownerDeps,
      { id: run!.id, chatId: bot.chatId },
      {
        id: bot.id,
        ownerId,
        workspaceId,
      },
    ).share!;
    // As if a path ran the tool without the owner (the policy never does).
    await expect(share.apply({ id: artifactId, visibility: 'org' })).rejects.toThrow(
      'has not approved',
    );
    await expect(share.apply({ id: artifactId, visibility: 'public' })).rejects.toThrow(
      'has not approved',
    );
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
    // Approved once, it is used once: a second apply on the same approval is refused.
    await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    await until(async () => expect((await visibilityOf(artifactId)).visibility).toBe('org'));
    await call('PUT', `/artifacts/${artifactId}/sharing`, { visibility: 'private' });
    await expect(share.apply({ id: artifactId, visibility: 'org' })).rejects.toThrow(
      'has not approved',
    );
    expect((await visibilityOf(artifactId)).visibility).toBe('private');
  });

  it('is not offered on an install that does not host Artifacts', async () => {
    const plain = await createTestApp();
    try {
      const services = artifactServices(
        plain.ownerDeps,
        { id: '00000000-0000-4000-8000-000000000000', chatId: null },
        { id: '00000000-0000-4000-8000-000000000001', ownerId, workspaceId },
      );
      expect(services.share).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});
