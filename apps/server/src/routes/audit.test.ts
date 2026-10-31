import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { recordAudit, trimAuditLog } from '../services/audit.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

// The audit log (plan 17 control 9, S-11): what is recorded, the admin
// reader `GET /admin/audit` and its filters, and the retention trim. The
// computer's rows are covered in routes/computer.test.ts, webhooks' in
// hooks/ingress.test.ts.

interface Entry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface Page {
  items: Entry[];
  nextCursor: string | null;
}

const PASSWORD = 'correct horse battery';

describe('audit log', () => {
  let t: TestApp;
  let admin: string;
  let member: string;
  let adminId: string;
  let memberId: string;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open' });
    admin = (await t.signUp('admin@example.com')).cookie!;
    member = (await t.signUp('member@example.com')).cookie!;
    const users = await t.deps.db.select().from(schema.users);
    adminId = users.find((u) => u.email === 'admin@example.com')!.id;
    memberId = users.find((u) => u.email === 'member@example.com')!.id;
    workspaceId = (await ensureWorkspace(t.deps.db)).id;
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

  const auth = (path: string, body: unknown, cookie?: string) =>
    t.app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const read = async (query = '', cookie = admin) => {
    const res = await call(cookie, 'GET', `/admin/audit${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Page;
  };

  /** The rows for one action, oldest first. */
  const rows = async (action: string) =>
    (await read(`?action=${action}&limit=200`)).items.reverse();

  it('records sign-in, sign-out and failed sign-in', async () => {
    const before = (await rows('auth.sign_in')).length;
    const signedIn = await auth('/sign-in/email', {
      email: 'member@example.com',
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const signIns = await rows('auth.sign_in');
    expect(signIns).toHaveLength(before + 1);
    expect(signIns.at(-1)).toMatchObject({
      actorType: 'user',
      actorId: memberId,
      actorLabel: 'member@example.com',
      metadata: { via: '/sign-in/email' },
    });

    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
    expect((await auth('/sign-out', {}, cookie)).status).toBe(200);
    expect(await rows('auth.sign_out')).toEqual([
      expect.objectContaining({ actorId: memberId, targetId: memberId }),
    ]);

    expect(
      (await auth('/sign-in/email', { email: 'member@example.com', password: 'wrong password' }))
        .status,
    ).toBe(401);
    expect(
      (await auth('/sign-in/email', { email: 'nobody@example.com', password: 'wrong password' }))
        .status,
    ).toBe(401);
    const failed = await rows('auth.sign_in_failed');
    expect(failed).toEqual([
      expect.objectContaining({
        actorId: memberId,
        metadata: expect.objectContaining({ email: 'member@example.com', status: 401 }),
      }),
      expect.objectContaining({
        actorId: null,
        metadata: expect.objectContaining({ email: 'nobody@example.com', status: 401 }),
      }),
    ]);
    // The password tried is never kept.
    expect(JSON.stringify(failed)).not.toContain('wrong password');
  });

  it('records API keys created and revoked', async () => {
    const key = (await (await call(member, 'POST', '/api-keys', { name: 'ci' })).json()) as {
      id: string;
      key: string;
    };
    expect((await call(member, 'DELETE', `/api-keys/${key.id}`)).status).toBe(204);
    expect(await rows('api_key.create')).toEqual([
      expect.objectContaining({ actorId: memberId, targetId: key.id, metadata: expect.anything() }),
    ]);
    expect(await rows('api_key.revoke')).toEqual([
      expect.objectContaining({ actorId: memberId, targetId: key.id, metadata: { name: 'ci' } }),
    ]);
    expect(JSON.stringify(await read())).not.toContain(key.key);
  });

  it('records invites made and redeemed, and settings changes', async () => {
    const invite = (await (
      await call(admin, 'POST', '/admin/invites', { email: 'new@example.com' })
    ).json()) as { id: string; token: string };
    expect(await rows('invite.create')).toEqual([
      expect.objectContaining({
        actorId: adminId,
        targetType: 'invite',
        targetId: invite.id,
        metadata: expect.objectContaining({ email: 'new@example.com', role: 'member' }),
      }),
    ]);
    expect(JSON.stringify(await read())).not.toContain(invite.token);

    const patched = await call(admin, 'PATCH', '/settings', {
      signupMode: 'invite',
      auditRetentionDays: 90,
    });
    expect(await patched.json()).toMatchObject({ signupMode: 'invite', auditRetentionDays: 90 });
    const { res } = await t.signUp('new@example.com', { inviteToken: invite.token });
    expect(res.status).toBe(200);
    const [newUser] = await t.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'new@example.com'));
    expect(await rows('invite.redeem')).toEqual([
      expect.objectContaining({ actorId: newUser!.id, targetId: invite.id }),
    ]);
    expect(await rows('settings.update')).toEqual([
      expect.objectContaining({
        actorId: adminId,
        targetId: workspaceId,
        metadata: { signupMode: 'invite', auditRetentionDays: 90 },
      }),
    ]);
    await call(admin, 'PATCH', '/settings', { signupMode: 'open', auditRetentionDays: 180 });
  });

  it('records providers and connectors created, updated and deleted, without secrets', async () => {
    const provider = (await (
      await call(admin, 'POST', '/providers', { presetId: 'anthropic', apiKey: 'sk-ant-secret' })
    ).json()) as { id: string };
    await call(admin, 'PATCH', `/providers/${provider.id}`, {
      apiKey: 'sk-ant-rotated',
      headers: { 'x-team': 'hidden-value' },
    });
    await call(admin, 'PUT', `/providers/${provider.id}/models`, {
      models: [{ modelId: 'claude-x', displayName: 'X' }],
    });
    expect((await call(admin, 'DELETE', `/providers/${provider.id}`)).status).toBe(204);
    const providerRows = (await rows('provider.')).filter((r) => r.targetId === provider.id);
    expect(providerRows.map((r) => r.action)).toEqual([
      'provider.create',
      'provider.update',
      'provider.update',
      'provider.delete',
    ]);
    expect(providerRows[1]!.metadata).toEqual({
      fields: ['apiKey', 'headers'],
      headerNames: ['x-team'],
    });
    expect(providerRows[2]!.metadata).toEqual({ models: ['claude-x'], remove: [] });

    // A custom HTTP server: custom stdio is for admins only (S-1).
    const created = await call(member, 'POST', '/connectors', {
      name: 'Remote',
      url: 'https://mcp.example.com/mcp',
      secrets: { TOKEN: 'connector-secret' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const connector = (await created.json()) as { id: string };
    await call(member, 'PATCH', `/connectors/${connector.id}`, {
      url: 'https://mcp.example.com/v2',
      headers: { 'X-Mode': 'connector-header' },
      secrets: { TOKEN: 'connector-rotated' },
    });
    expect((await call(member, 'DELETE', `/connectors/${connector.id}`)).status).toBe(204);
    const connectorRows = (await rows('connector.')).filter((r) => r.targetId === connector.id);
    expect(connectorRows.map((r) => [r.action, r.actorId])).toEqual([
      ['connector.create', memberId],
      ['connector.update', memberId],
      ['connector.delete', memberId],
    ]);
    expect(connectorRows[1]!.metadata).toEqual({
      fields: ['url', 'headers', 'secrets'],
      secrets: ['TOKEN'],
      transport: 'http',
    });

    const all = JSON.stringify((await read('?limit=200')).items);
    for (const secret of ['sk-ant-secret', 'sk-ant-rotated', 'hidden-value', 'connector-']) {
      expect(all).not.toContain(secret);
    }
  });

  it('records event subscriptions', async () => {
    const created = (await (
      await call(member, 'POST', '/event-subscriptions', {
        // A public address (TEST-NET-3): a name would need DNS, which the save checks (S-8).
        url: 'https://203.0.113.10/hook?token=receiver-secret',
        events: ['run.completed'],
      })
    ).json()) as { subscription: { id: string } };
    const id = created.subscription.id;
    await call(member, 'PATCH', `/event-subscriptions/${id}`, { enabled: false });
    await call(member, 'DELETE', `/event-subscriptions/${id}`);
    const subscriptionRows = (await rows('event_subscription.')).filter((r) => r.targetId === id);
    expect(subscriptionRows.map((r) => [r.action, r.metadata])).toEqual([
      ['event_subscription.create', { origin: 'https://203.0.113.10', events: ['run.completed'] }],
      ['event_subscription.update', { enabled: false }],
      ['event_subscription.delete', {}],
    ]);
  });

  it('is for admins only', async () => {
    expect((await call(member, 'GET', '/admin/audit')).status).toBe(403);
    expect((await call(undefined, 'GET', '/admin/audit')).status).toBe(401);
    const key = (await (await call(member, 'POST', '/api-keys', { name: 'k' })).json()) as {
      key: string;
    };
    const viaKey = await t.app.request('/api/v1/admin/audit', {
      headers: { authorization: `Bearer ${key.key}` },
    });
    expect(viaKey.status).toBe(403);
  });

  it('filters by actor, action and time, and pages newest first', async () => {
    const { db } = t.deps;
    // A separate workspace's rows never show.
    const [other] = await db.insert(schema.workspaces).values({ name: 'Other' }).returning();
    await recordAudit(db, {
      workspaceId: other!.id,
      actor: { type: 'system', id: null },
      action: 'probe.elsewhere',
    });
    const at = (iso: string) => new Date(iso);
    for (const [action, createdAt] of [
      ['probe.one', '2026-01-01T00:00:00Z'],
      ['probe.two', '2026-02-01T00:00:00Z'],
      ['probe.three', '2026-03-01T00:00:00Z'],
    ] as const) {
      await db.insert(schema.auditLog).values({
        workspaceId,
        actorType: 'user',
        actorId: adminId,
        action,
        createdAt: at(createdAt),
      });
    }

    const probes = await read('?action=probe.');
    expect(probes.items.map((e) => e.action)).toEqual(['probe.three', 'probe.two', 'probe.one']);
    expect((await read('?action=probe.two')).items.map((e) => e.action)).toEqual(['probe.two']);
    // `_` and `%` in a group prefix are literal.
    expect((await read('?action=probe_%25.')).items).toEqual([]);
    expect(
      (await read('?action=probe.&from=2026-01-15T00:00:00Z&to=2026-03-01T00:00:00Z')).items.map(
        (e) => e.action,
      ),
    ).toEqual(['probe.three', 'probe.two']);

    const byMember = await read(`?actorId=${memberId}&limit=200`);
    expect(byMember.items.length).toBeGreaterThan(0);
    expect(byMember.items.every((e) => e.actorId === memberId)).toBe(true);
    expect(byMember.items.some((e) => e.action.startsWith('probe.'))).toBe(false);

    const first = await read('?action=probe.&limit=2');
    expect(first.items.map((e) => e.action)).toEqual(['probe.three', 'probe.two']);
    const second = await read(`?action=probe.&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((e) => e.action)).toEqual(['probe.one']);
    expect(second.nextCursor).toBeNull();

    // Rows written in one instant still page without gaps or repeats.
    const all = await read('?limit=200');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await read(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((e) => e.id));

    expect((await call(admin, 'GET', '/admin/audit?from=yesterday')).status).toBe(400);
    expect((await call(admin, 'GET', '/admin/audit?limit=500')).status).toBe(400);
    expect(JSON.stringify(all)).not.toContain('probe.elsewhere');
  });

  it('trims rows past the retention period, 180 days unless changed', async () => {
    const { db } = t.deps;
    const day = 86_400_000;
    const now = new Date('2026-10-01T00:00:00Z');
    for (const [action, age] of [
      ['retention.old', 181],
      ['retention.kept', 179],
      ['retention.middle', 100],
    ] as const) {
      await db.insert(schema.auditLog).values({
        workspaceId,
        actorType: 'system',
        action,
        createdAt: new Date(now.getTime() - age * day),
      });
    }
    const left = async () =>
      (
        await db
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.workspaceId, workspaceId),
              eq(schema.auditLog.actorType, 'system'),
            ),
          )
      )
        .map((r) => r.action)
        .filter((a) => a.startsWith('retention.'))
        .sort();

    expect(await trimAuditLog(t.deps, now)).toBeGreaterThanOrEqual(1);
    expect(await left()).toEqual(['retention.kept', 'retention.middle']);

    await call(admin, 'PATCH', '/settings', { auditRetentionDays: 90 });
    await trimAuditLog(t.deps, now);
    expect(await left()).toEqual([]);
    await call(admin, 'PATCH', '/settings', { auditRetentionDays: 180 });

    expect((await call(admin, 'PATCH', '/settings', { auditRetentionDays: 0 })).status).toBe(400);
    expect(
      ((await (await call(admin, 'GET', '/settings')).json()) as { auditRetentionDays: number })
        .auditRetentionDays,
    ).toBe(180);
  });
});
