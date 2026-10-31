import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptStoredOAuthTokens } from './auth.js';
import { schema } from './db/client.js';
import { hashInviteToken } from './invites.js';
import { createTestApp, ORIGIN, type TestApp } from './test-app.js';

// Signup modes (U1), invites, sessions and API keys (U4) end to end through
// the HTTP surface.

describe('auth in first_user_admin mode', () => {
  let t: TestApp;
  let adminCookie: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOT_DEPLOYMENT: 'managed',
      OPENBOT_SIGNUP_MODE: 'first_user_admin',
    });
  });
  afterAll(() => t.close());

  const me = (headers: Record<string, string>) => t.app.request('/api/v1/me', { headers });

  it('makes the first user to sign up the admin', async () => {
    const { res, cookie } = await t.signUp('ada@example.com');
    expect(res.status).toBe(200);
    expect(cookie).toBeDefined();
    adminCookie = cookie!;

    const body = await (await me({ cookie: adminCookie })).json();
    expect(body).toMatchObject({
      user: { email: 'ada@example.com', name: 'ada' },
      role: 'admin',
      workspace: { name: 'OpenBot' },
      limits: { botsPerAccount: 50, botsPerGroup: 6 },
    });
  });

  it('rejects a second signup without an invite', async () => {
    const { res, cookie } = await t.signUp('bob@example.com');
    expect(res.status).toBe(403);
    expect(cookie).toBeUndefined();
    const users = await t.testDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'bob@example.com'));
    expect(users).toHaveLength(0);
  });

  it('accepts a second signup with an invite, once', async () => {
    const created = await t.app.request('/api/v1/admin/invites', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const invite = (await created.json()) as { token: string; role: string };
    expect(invite.role).toBe('member');

    const { res, cookie } = await t.signUp('bob@example.com', { inviteToken: invite.token });
    expect(res.status).toBe(200);
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({ role: 'member' });

    const again = await t.signUp('carol@example.com', { inviteToken: invite.token });
    expect(again.res.status).toBe(403);
  });

  it('rejects an invite bound to another email address', async () => {
    const created = await t.app.request('/api/v1/admin/invites', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dan@example.com', role: 'admin' }),
    });
    const { token } = (await created.json()) as { token: string };
    expect((await t.signUp('eve@example.com', { inviteToken: token })).res.status).toBe(403);

    const { cookie } = await t.signUp('dan@example.com', { inviteToken: token });
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({ role: 'admin' });
  });

  it('keeps the invite when the signup fails after the invite was checked', async () => {
    const token = await newInviteToken(t, adminCookie);
    // The user insert itself fails, after the hook that checks the invite.
    await t.testDb.db.execute(sql`
      create function refuse_boom() returns trigger language plpgsql as $$
      begin
        if new.email = 'boom@example.com' then raise exception 'insert failed'; end if;
        return new;
      end $$`);
    await t.testDb.db.execute(
      sql`create trigger refuse_boom before insert on users for each row execute function refuse_boom()`,
    );
    try {
      const failed = await t.signUp('boom@example.com', { inviteToken: token });
      expect(failed.res.status).not.toBe(200);
      expect(failed.cookie).toBeUndefined();
    } finally {
      await t.testDb.db.execute(sql`drop trigger refuse_boom on users`);
      await t.testDb.db.execute(sql`drop function refuse_boom()`);
    }
    const [invite] = await t.testDb.db
      .select({ usedAt: schema.invites.usedAt })
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, hashInviteToken(token)));
    expect(invite?.usedAt).toBeNull();

    const { res, cookie } = await t.signUp('hana@example.com', { inviteToken: token });
    expect(res.status).toBe(200);
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({ role: 'member' });
    const [used] = await t.testDb.db
      .select({ usedAt: schema.invites.usedAt, usedBy: schema.invites.usedBy })
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, hashInviteToken(token)));
    expect(used?.usedAt).not.toBeNull();
    expect(used?.usedBy).toBeTruthy();
  });

  it('turns a signup away, user row and all, when another spent its invite first', async () => {
    const token = await newInviteToken(t, adminCookie);
    // Another signup spends the invite between the check and this one's user row.
    await t.testDb.db.execute(sql`
      create function spend_invite() returns trigger language plpgsql as $$
      begin
        if new.email = 'late@example.com' then
          update invites set used_at = now() where used_at is null;
        end if;
        return new;
      end $$`);
    await t.testDb.db.execute(
      sql`create trigger spend_invite after insert on users for each row execute function spend_invite()`,
    );
    try {
      const late = await t.signUp('late@example.com', { inviteToken: token });
      expect(late.res.status).toBe(403);
      expect(await late.res.json()).toMatchObject({ code: 'INVITE_INVALID' });
    } finally {
      await t.testDb.db.execute(sql`drop trigger spend_invite on users`);
      await t.testDb.db.execute(sql`drop function spend_invite()`);
    }
    const users = await t.testDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'late@example.com'));
    expect(users).toHaveLength(0);
  });

  it('keeps invites and settings to admins', async () => {
    const { cookie } = await t.signUp('frank@example.com', {
      inviteToken: await newInviteToken(t, adminCookie),
    });
    const invite = await t.app.request('/api/v1/admin/invites', {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invite.status).toBe(403);
    expect(invite.headers.get('content-type')).toContain('application/problem+json');
    expect((await t.app.request('/api/v1/settings', { headers: { cookie: cookie! } })).status).toBe(
      403,
    );
  });

  it('rejects /me without credentials', async () => {
    const res = await me({});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('authenticates /me with an API key as a bearer token or x-api-key', async () => {
    const created = await t.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'script' }),
    });
    expect(created.status).toBe(201);
    const { id, key } = (await created.json()) as { id: string; key: string };
    expect(key).toMatch(/^obk_/);

    const credentials: Record<string, string>[] = [
      { authorization: `Bearer ${key}` },
      { 'x-api-key': key },
    ];
    for (const headers of credentials) {
      const res = await me(headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ user: { email: 'ada@example.com' }, role: 'admin' });
    }

    const list = await t.app.request('/api/v1/api-keys', {
      headers: { authorization: `Bearer ${key}` },
    });
    const { items } = (await list.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, name: 'script' });
    expect(items[0]).not.toHaveProperty('key');

    const revoked = await t.app.request(`/api/v1/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(revoked.status).toBe(204);
    expect((await me({ authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it("does not revoke another user's API key", async () => {
    const created = await t.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mine' }),
    });
    const { id } = (await created.json()) as { id: string };
    const { cookie } = await t.signUp('gina@example.com', {
      inviteToken: await newInviteToken(t, adminCookie),
    });
    const res = await t.app.request(`/api/v1/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie: cookie! },
    });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown API key', async () => {
    expect((await me({ authorization: 'Bearer obk_nope' })).status).toBe(401);
  });

  it('answers CORS preflight only for the public URL origin', async () => {
    const preflight = (origin: string) =>
      t.app.request('/api/v1/me', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    const ok = await preflight(ORIGIN);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const other = await preflight('https://evil.example.com');
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });
});

describe('sign-in provider tokens (S-9)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      OPENBOT_DEPLOYMENT: 'managed',
      OPENBOT_SIGNUP_MODE: 'open',
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    });
  });
  afterAll(() => t.close());

  it('encrypts tokens stored in plain text and still hands them out', async () => {
    const { cookie } = await t.signUp('octo@example.com');
    const [user] = await t.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'octo@example.com'));
    const [account] = await t.deps.db
      .insert(schema.accounts)
      .values({
        accountId: '583231',
        providerId: 'github',
        userId: user!.id,
        accessToken: 'gho_plaintext-access',
        refreshToken: 'ghr_plaintext-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();

    expect(await encryptStoredOAuthTokens(t.deps)).toBe(1);
    const [row] = await t.deps.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account!.id));
    expect(row!.accessToken).not.toContain('plaintext');
    expect(row!.refreshToken).not.toContain('plaintext');
    expect(await encryptStoredOAuthTokens(t.deps)).toBe(0);

    const res = await t.app.request('/api/auth/get-access-token', {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ accountId: account!.id }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { accessToken: string }).accessToken).toBe(
      'gho_plaintext-access',
    );
  });
});

describe('settings', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOT_DEPLOYMENT: 'managed',
      OPENBOT_LIMITS_BOTS_PER_ACCOUNT: '20',
    });
    cookie = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(() => t.close());

  const patch = (body: unknown) =>
    t.app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts from the environment', async () => {
    const res = await t.app.request('/api/v1/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signupMode: 'first_user_admin',
      limits: { botsPerAccount: 20, botsPerGroup: 6 },
    });
  });

  it('persists changes on the workspace row and applies the signup mode', async () => {
    const res = await patch({
      signupMode: 'open',
      limits: { botsPerGroup: 4 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signupMode: 'open',
      limits: { botsPerAccount: 20, botsPerGroup: 4 },
    });
    const [workspace] = await t.testDb.db.select().from(schema.workspaces);
    expect(workspace!.settings).toEqual({
      signupMode: 'open',
      limits: { botsPerGroup: 4 },
    });

    const { res: signup, cookie: memberCookie } = await t.signUp('open@example.com');
    expect(signup.status).toBe(200);
    const me = await t.app.request('/api/v1/me', { headers: { cookie: memberCookie! } });
    expect(await me.json()).toMatchObject({ role: 'member', limits: { botsPerGroup: 4 } });
  });

  it('rejects invalid settings as a problem document', async () => {
    const res = await patch({ signupMode: 'anyone' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect((await patch({ limits: { botsPerGroup: 0 } })).status).toBe(400);
    expect((await patch({ unknown: true })).status).toBe(400);
  });

  it('has no computer limits to set: 1.0 fixes them (PRD section 6)', async () => {
    const res = await t.app.request('/api/v1/settings', { headers: { cookie } });
    const { limits } = (await res.json()) as { limits: Record<string, number> };
    expect(limits).not.toHaveProperty('computersPerAccount');
    expect(limits).not.toHaveProperty('computerTasksPerBot');
    expect((await patch({ limits: { computersPerAccount: 2 } })).status).toBe(400);

    // An override an older version stored is dropped; the other settings still apply.
    const [workspace] = await t.testDb.db.select().from(schema.workspaces);
    await t.testDb.db
      .update(schema.workspaces)
      .set({
        settings: {
          ...(workspace!.settings as object),
          limits: { botsPerGroup: 4, computersPerAccount: 2, computerTasksPerBot: 3 },
        },
      })
      .where(eq(schema.workspaces.id, workspace!.id));
    const after = await t.app.request('/api/v1/settings', { headers: { cookie } });
    expect(await after.json()).toMatchObject({
      signupMode: 'open',
      limits: { botsPerAccount: 20, botsPerGroup: 4 },
    });
  });
});

describe('auth in invite mode', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'invite' });
  });
  afterAll(() => t.close());

  it('still lets the first user in as admin, then requires invites', async () => {
    const first = await t.signUp('ada@example.com');
    expect(first.res.status).toBe(200);
    const me = await t.app.request('/api/v1/me', { headers: { cookie: first.cookie! } });
    expect(await me.json()).toMatchObject({ role: 'admin' });
    const second = await t.signUp('bob@example.com');
    expect(second.res.status).toBe(403);
    expect(await second.res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
  });
});

async function newInviteToken(t: TestApp, cookie: string): Promise<string> {
  const res = await t.app.request('/api/v1/admin/invites', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  return ((await res.json()) as { token: string }).token;
}
