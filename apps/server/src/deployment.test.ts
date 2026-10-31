import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/client.js';
import { createInvite } from './invites.js';
import { botLimitReached } from './services/bots.js';
import { routineLimitReached } from './services/routines.js';
import { skillImportOverLimit, skillLimitReached } from './services/skills.js';
import { createTestApp, ORIGIN, type TestApp } from './test-app.js';
import { ensureWorkspace, updateSettings } from './workspace.js';

// OPENBOT_DEPLOYMENT: a self-hosted install (the default) has one account, its
// owner. Sign-up closes once it exists, whatever the stored mode and with an
// invite or not; members, invites and the audit log answer 404; the settings
// that only matter with members keep their defaults. Audit rows are still
// written. The managed service keeps all of it (members.test.ts, audit.test.ts).

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/v1/admin/members'],
  ['PATCH', '/api/v1/admin/members/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/v1/admin/invites'],
  ['POST', '/api/v1/admin/invites'],
  ['DELETE', '/api/v1/admin/invites/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/v1/admin/audit'],
];

function call(t: TestApp, method: string, path: string, cookie?: string, body?: unknown) {
  return t.app.request(path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('a self-hosted install', () => {
  let t: TestApp;
  let owner: string;

  beforeAll(async () => {
    t = await createTestApp();
    const res = await t.app.request('/api/v1/setup/admin', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'correct horse' }),
    });
    expect(res.status).toBe(201);
    owner = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
  });
  afterAll(() => t.close());

  it('reports itself as self-hosted', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(await res.json()).toMatchObject({ deployment: 'self_hosted' });
  });

  it('makes the setup account its owner, an admin internally', async () => {
    const res = await call(t, 'GET', '/api/v1/me', owner);
    expect(await res.json()).toMatchObject({ role: 'admin' });
  });

  it('closes sign-up after the owner, whatever the stored mode, invite or not', async () => {
    const workspace = await ensureWorkspace(t.deps.db);
    await updateSettings(t.deps.db, workspace, { signupMode: 'open' });
    const first = await t.signUp('bob@example.com');
    expect(first.res.status).toBe(403);
    expect(await first.res.json()).toMatchObject({ code: 'SIGNUP_CLOSED' });

    const [user] = await t.deps.db.select().from(schema.users);
    const { token } = await createInvite(t.deps.db, {
      workspaceId: workspace.id,
      createdBy: user!.id,
    });
    const invited = await t.signUp('cy@example.com', { inviteToken: token });
    expect(invited.res.status).toBe(403);
    expect(await invited.res.json()).toMatchObject({ code: 'SIGNUP_CLOSED' });
    expect(await t.deps.db.select().from(schema.users)).toHaveLength(1);
  });

  it('answers 404 for members, invites and the audit log, even to the owner', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      expect((await call(t, method, path, owner, method === 'GET' ? undefined : {})).status).toBe(
        404,
      );
      expect((await call(t, method, path)).status).toBe(404);
    }
  });

  it('still records audit rows', async () => {
    const rows = await t.deps.db.select().from(schema.auditLog);
    expect(rows.map((r) => r.action)).toContain('auth.sign_in');
  });

  it('keeps the limits and custom stdio for the owner, and the rest at defaults', async () => {
    const workspace = await ensureWorkspace(t.deps.db);
    await updateSettings(t.deps.db, workspace, { signupMode: 'open', auditRetentionDays: 7 });
    const res = await call(t, 'PATCH', '/api/v1/settings', owner, {
      limits: { botsPerGroup: 4 },
      customStdioEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signupMode: 'first_user_admin',
      auditRetentionDays: 180,
      customStdioEnabled: true,
      limits: { botsPerGroup: 4 },
    });

    for (const body of [{ signupMode: 'open' }, { auditRetentionDays: 30 }]) {
      const refused = await call(t, 'PATCH', '/api/v1/settings', owner, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'MANAGED_ONLY' });
    }
  });
});

describe('the managed service', () => {
  let t: TestApp;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open' });
    admin = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(() => t.close());

  it('reports itself as managed', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(await res.json()).toMatchObject({ deployment: 'managed' });
  });

  it('lets a second account sign up and an admin read members and the audit log', async () => {
    expect((await t.signUp('bob@example.com')).res.status).toBe(200);
    const members = await call(t, 'GET', '/api/v1/admin/members', admin);
    expect(members.status).toBe(200);
    expect(((await members.json()) as { items: unknown[] }).items).toHaveLength(2);
    expect((await call(t, 'GET', '/api/v1/admin/invites', admin)).status).toBe(200);
    expect((await call(t, 'GET', '/api/v1/admin/audit', admin)).status).toBe(200);
    expect((await call(t, 'GET', '/api/v1/admin/audit')).status).toBe(401);
  });
});

describe('the single owner', () => {
  // PGlite runs the two one after the other; on Postgres the recheck under the
  // workspace lock in auth.ts is what keeps a second owner out.
  it('goes to one of two first signups sent together', async () => {
    const t = await createTestApp({ OPENBOT_SIGNUP_MODE: 'open' });
    try {
      const results = await Promise.all(
        ['ada@example.com', 'bob@example.com'].map((email) => t.signUp(email)),
      );
      expect(results.map((r) => r.res.status).sort()).toEqual([200, 403]);
      expect(await t.deps.db.select().from(schema.users)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('is the only account that gets in once a managed install turns self-hosted', async () => {
    const t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open' });
    try {
      const ada = (await t.signUp('ada@example.com')).cookie!;
      const bob = (await t.signUp('bob@example.com')).cookie!;
      (t.deps.config as { deployment: string }).deployment = 'self_hosted';
      expect((await call(t, 'GET', '/api/v1/me', ada)).status).toBe(200);
      const me = await call(t, 'GET', '/api/v1/me', bob);
      expect(me.status).toBe(403);
      expect(await me.json()).toMatchObject({ code: 'NOT_OWNER' });
      const signIn = await t.app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'bob@example.com', password: 'correct horse battery' }),
      });
      expect(signIn.status).toBe(403);
      expect(await signIn.json()).toMatchObject({ code: 'NOT_OWNER' });
    } finally {
      await t.close();
    }
  });
});

describe('limit messages', () => {
  it('send a self-hosted owner to Settings > Limits, and managed members to an admin', () => {
    const selfHosted = { deployment: 'self_hosted' } as const;
    for (const error of [
      botLimitReached(2, selfHosted),
      routineLimitReached(2, selfHosted),
      skillLimitReached(2, selfHosted),
      skillImportOverLimit(3, 2, 0, selfHosted),
    ]) {
      expect(error.message).toContain('in Settings > Limits');
      expect(error.message).not.toMatch(/admin/i);
    }
    expect(botLimitReached(2, { deployment: 'managed' }).message).toContain(
      'ask an admin to raise it',
    );
  });
});
