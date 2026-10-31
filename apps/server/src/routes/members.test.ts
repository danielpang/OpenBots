import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { MEMBER_DISABLED_CHANNEL, type MemberDisabled } from '../services/members.js';
import { createTestApp, ORIGIN, type TestApp } from '../test-app.js';

// Members and invites for admins (U1, U3, plan 14.1): pending invites and
// revoking them, the member list, roles, disabling sign-in, the last-admin
// guard, and that only admins get any of it.

describe('members and invites admin', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const disabled: MemberDisabled[] = [];

  beforeAll(async () => {
    t = await createTestApp({ OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'invite' });
    admin = (await t.signUp('ada@example.com')).cookie!;
    adminId = (await userOf('ada@example.com')).id;
    await t.deps.infra.bus.subscribe<MemberDisabled>(MEMBER_DISABLED_CHANNEL, (e) =>
      disabled.push(e),
    );
  });
  afterAll(() => t.close());

  async function userOf(email: string) {
    const [user] = await t.deps.db.select().from(schema.users).where(eq(schema.users.email, email));
    return user!;
  }

  function call(
    cookieOrKey: string,
    method: string,
    path: string,
    body?: unknown,
    as: 'cookie' | 'key' = 'cookie',
  ) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(as === 'cookie' ? { cookie: cookieOrKey } : { authorization: `Bearer ${cookieOrKey}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function invite(body: Record<string, unknown> = {}) {
    const res = await call(admin, 'POST', '/admin/invites', body);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; token: string };
  }

  /** A new member, signed up with an invite; returns their cookie and id. */
  async function member(email: string, role?: 'admin') {
    const { token } = await invite(role ? { role } : {});
    const { res, cookie } = await t.signUp(email, { inviteToken: token });
    expect(res.status).toBe(200);
    return { cookie: cookie!, id: (await userOf(email)).id };
  }

  const signIn = (email: string) =>
    t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'correct horse battery' }),
    });

  const audits = (action: string) =>
    t.deps.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(asc(schema.auditLog.createdAt));

  const patch = (cookie: string, id: string, body: unknown) =>
    call(cookie, 'PATCH', `/admin/members/${id}`, body);

  it('keeps every route to admins', async () => {
    const bob = await member('bob@example.com');
    const someInvite = await invite();
    for (const [method, path, body] of [
      ['GET', '/admin/invites'],
      ['DELETE', `/admin/invites/${someInvite.id}`],
      ['GET', '/admin/members'],
      ['PATCH', `/admin/members/${bob.id}`, { role: 'admin' }],
      ['PATCH', `/admin/members/${adminId}`, { disabled: true }],
    ] as const) {
      const res = await call(bob.cookie, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
    expect((await call(admin, 'GET', '/admin/members')).status).toBe(200);
  });

  it('lists pending invites only, and revokes one so its token stops working', async () => {
    const pending = await invite({ email: 'carol@example.com' });
    const used = await invite();
    await t.signUp('used@example.com', { inviteToken: used.token });
    const expired = await invite();
    await t.deps.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.invites.id, expired.id));

    const list = (await (await call(admin, 'GET', '/admin/invites')).json()) as {
      items: { id: string; email: string | null; createdBy: string | null }[];
    };
    const ids = list.items.map((i) => i.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(used.id);
    expect(ids).not.toContain(expired.id);
    expect(list.items.find((i) => i.id === pending.id)).toMatchObject({
      email: 'carol@example.com',
      createdBy: 'ada@example.com',
    });
    expect(JSON.stringify(list)).not.toContain(pending.token);

    expect((await call(admin, 'DELETE', `/admin/invites/${pending.id}`)).status).toBe(204);
    expect((await call(admin, 'DELETE', `/admin/invites/${pending.id}`)).status).toBe(404);
    expect((await call(admin, 'DELETE', `/admin/invites/${used.id}`)).status).toBe(404);
    expect((await t.signUp('carol@example.com', { inviteToken: pending.token })).res.status).toBe(
      403,
    );
    expect(await audits('invite.revoke')).toEqual([
      expect.objectContaining({
        actorId: adminId,
        targetType: 'invite',
        targetId: pending.id,
        metadata: { email: 'carol@example.com', role: 'member' },
      }),
    ]);
  });

  it('lists members with their role, join date and Bot count', async () => {
    const dan = await member('dan@example.com');
    for (const name of ['One', 'Two']) {
      const res = await call(dan.cookie, 'POST', '/bots', { name, description: '' });
      expect(res.status).toBe(201);
    }
    const { items } = (await (await call(admin, 'GET', '/admin/members')).json()) as {
      items: { id: string; email: string; role: string; botCount: number; disabledAt: null }[];
    };
    expect(items[0]).toMatchObject({ email: 'ada@example.com', role: 'admin', botCount: 0 });
    expect(items.find((m) => m.id === dan.id)).toMatchObject({
      name: 'dan',
      email: 'dan@example.com',
      role: 'member',
      botCount: 2,
      disabledAt: null,
      createdAt: expect.any(String),
    });
  });

  it('changes a role, audited', async () => {
    const erin = await member('erin@example.com');
    const res = await patch(admin, erin.id, { role: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: erin.id, role: 'admin' });
    expect(await (await call(erin.cookie, 'GET', '/me')).json()).toMatchObject({ role: 'admin' });
    expect(await audits('member.role')).toContainEqual(
      expect.objectContaining({ targetId: erin.id, metadata: { from: 'member', to: 'admin' } }),
    );
    expect((await patch(admin, erin.id, { role: 'member' })).status).toBe(200);
    expect(
      (await patch(admin, '00000000-0000-4000-8000-000000000000', { role: 'admin' })).status,
    ).toBe(404);
    expect((await patch(admin, erin.id, { role: 'owner' })).status).toBe(400);
  });

  it('disables sign-in: ends sessions, blocks API keys and new sign-ins, keeps the Bots', async () => {
    const frank = await member('frank@example.com');
    await call(frank.cookie, 'POST', '/bots', { name: 'Keeper', description: '' });
    const key = (await (await call(frank.cookie, 'POST', '/api-keys', { name: 'cli' })).json()) as {
      key: string;
    };
    expect((await call(key.key, 'GET', '/me', undefined, 'key')).status).toBe(200);
    const other = await signIn('frank@example.com');
    expect(other.status).toBe(200);

    const res = await patch(admin, frank.id, { disabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disabledAt: expect.any(String), botCount: 1 });

    expect(
      await t.deps.db.select().from(schema.sessions).where(eq(schema.sessions.userId, frank.id)),
    ).toEqual([]);
    expect((await call(frank.cookie, 'GET', '/me')).status).toBe(401);
    const byKey = await call(key.key, 'GET', '/me', undefined, 'key');
    expect(byKey.status).toBe(403);
    expect(await byKey.json()).toMatchObject({ code: 'ACCOUNT_DISABLED' });
    const again = await signIn('frank@example.com');
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(disabled).toContainEqual({ userId: frank.id });
    // Their Bots stay.
    expect(
      await t.deps.db.select().from(schema.bots).where(eq(schema.bots.ownerId, frank.id)),
    ).toHaveLength(1);
    expect(await audits('member.disable')).toContainEqual(
      expect.objectContaining({
        actorId: adminId,
        targetId: frank.id,
        metadata: { sessionsEnded: 2 },
      }),
    );

    // Enabled again, they sign in and the key works again.
    const enabled = await patch(admin, frank.id, { disabled: false });
    expect(await enabled.json()).toMatchObject({ disabledAt: null });
    expect((await signIn('frank@example.com')).status).toBe(200);
    expect((await call(key.key, 'GET', '/me', undefined, 'key')).status).toBe(200);
    expect(await audits('member.enable')).toContainEqual(
      expect.objectContaining({ targetId: frank.id }),
    );
  });

  it('never leaves the workspace without an admin who can sign in', async () => {
    const lastAdmin = async (res: Response) => {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'LAST_ADMIN' });
    };
    // Ada is the only admin: she cannot step down.
    await lastAdmin(await patch(admin, adminId, { role: 'member' }));
    // Nor disable herself, whoever else is an admin.
    const self = await patch(admin, adminId, { disabled: true });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: 'CANNOT_DISABLE_SELF' });

    // A second admin who is disabled does not count.
    const gus = await member('gus@example.com', 'admin');
    expect((await patch(admin, gus.id, { disabled: true })).status).toBe(200);
    await lastAdmin(await patch(admin, adminId, { role: 'member' }));

    // Enabled, Gus can take over and Ada can step down; then Gus is the last one.
    expect((await patch(admin, gus.id, { disabled: false })).status).toBe(200);
    const gusCookie = (await signIn('gus@example.com')).headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
    expect((await patch(admin, adminId, { role: 'member' })).status).toBe(200);
    await lastAdmin(await patch(gusCookie, gus.id, { role: 'member' }));
    await lastAdmin(await patch(gusCookie, gus.id, { role: 'member', disabled: false }));
    expect((await patch(gusCookie, adminId, { role: 'admin' })).status).toBe(200);

    const [row] = await t.deps.db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, adminId)));
    expect(row!.role).toBe('admin');
  });
});
