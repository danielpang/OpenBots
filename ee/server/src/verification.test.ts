import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@openbot/server/db/client';
import { createTestApp, type TestApp } from '@openbot/server/test-app';
import { emailFromEnv, managedExtensions } from './index.js';
import { readInviteCookie, signInviteCookie } from './plugin.js';
import { SENDS_PER_HOUR, TRIES_PER_HOUR } from './sign-up.js';
import {
  PASSWORD,
  completeSignUp,
  createAccount,
  emailTo,
  mailbox,
  post,
  sessionOf,
  signIn,
  signUpByEmail,
  startSignUp,
  verifyCode,
} from './testing.js';

// Email sign-up on the managed service (plan 21.6, sign-up.ts): the email
// first, confirmed with a code bound to its request, then the name and
// password. Nothing an unauthenticated request does deletes or replaces an
// account; limits come before work; codes stay out of logs. And a GitHub
// sign-up from an invite link carries the invite in a signed cookie.

function managedApp(email = {}, env: Record<string, string> = {}) {
  return createTestApp(
    { OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open', ...env },
    { extensions: managedExtensions({ email }) },
  );
}

const userRows = (t: TestApp, email: string) =>
  t.deps.db.select().from(schema.users).where(eq(schema.users.email, email));

const pendingRows = (t: TestApp) =>
  t.deps.db
    .select()
    .from(schema.verifications)
    .where(like(schema.verifications.identifier, 'sign-up:%'));

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('email sign-up', () => {
  let t: TestApp;
  const mail = mailbox();

  beforeAll(async () => {
    t = await managedApp(emailTo(mail));
  });
  afterAll(() => t.close());

  it('takes the email, then the code, then the name and password', async () => {
    const start = await startSignUp(t, 'vera@example.com');
    expect(start.res.status).toBe(200);
    expect(start.request).toBeDefined();
    const header = start.res.headers.getSetCookie().find((c) => c.startsWith('openbot_sign_up='))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    // No account and no password yet.
    expect(await userRows(t, 'vera@example.com')).toEqual([]);
    const code = mail.code('vera@example.com')!;
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.sent.at(-1)!.subject).toBe(`${code} is your OpenBots code`);
    expect(mail.sent.at(-1)!.text).not.toMatch(/https?:\/\//);
    // The code is stored as an HMAC, not as itself.
    expect(JSON.stringify(await pendingRows(t))).not.toContain(code);

    // Credentials before the code are refused.
    const early = await completeSignUp(t, start.request);
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    expect((await verifyCode(t, start.request, code)).status).toBe(200);
    const done = await completeSignUp(t, start.request, { name: 'Vera' });
    expect(done.status).toBe(200);
    const me = await t.app.request('/api/v1/me', { headers: { cookie: sessionOf(done)! } });
    expect(await me.json()).toMatchObject({
      user: { name: 'Vera', emailVerified: true },
      workspace: null,
    });
    expect((await signIn(t, 'vera@example.com')).status).toBe(200);
    // Once: the request is spent.
    expect((await completeSignUp(t, start.request)).status).toBe(400);
    expect((await verifyCode(t, start.request, code)).status).toBe(400);
  });

  it('lets no second sign-up set a credential the inbox owner then confirms', async () => {
    const victim = await startSignUp(t, 'pat@example.com');
    const victimCode = mail.code('pat@example.com')!;
    const attacker = await startSignUp(t, 'pat@example.com');
    expect(attacker.res.status).toBe(200);
    const attackerCode = mail.code('pat@example.com')!;
    expect(await userRows(t, 'pat@example.com')).toEqual([]);
    // The newest email is the attacker's request: its code does not complete the victim's.
    if (attackerCode !== victimCode) {
      const crossed = await verifyCode(t, victim.request, attackerCode);
      expect(crossed.status).toBe(400);
      expect(await crossed.json()).toMatchObject({ code: 'INVALID_OTP' });
    }
    // Nor can the attacker finish theirs without the code from the inbox.
    expect((await completeSignUp(t, attacker.request, { password: 'attacker pass' })).status).toBe(
      400,
    );
    expect((await verifyCode(t, victim.request, victimCode)).status).toBe(200);
    const done = await completeSignUp(t, victim.request, { name: 'Pat' });
    expect(done.status).toBe(200);
    expect((await signIn(t, 'pat@example.com', 'attacker pass')).status).toBe(401);
    expect((await signIn(t, 'pat@example.com')).status).toBe(200);
  });

  it('deletes and replaces nothing for an unauthenticated request', async () => {
    // An unconfirmed account from before this flow, and a confirmed one.
    await createAccount(t, 'old@example.com', { password: 'old password' });
    await signUpByEmail(t, mail, 'kept@example.com', { name: 'Kept' });
    const before = [
      ...(await userRows(t, 'old@example.com')),
      ...(await userRows(t, 'kept@example.com')),
    ];
    const credentials = await t.deps.db.select().from(schema.accounts);
    for (const address of ['old@example.com', 'kept@example.com']) {
      expect((await startSignUp(t, address)).res.status).toBe(200);
    }
    const after = [
      ...(await userRows(t, 'old@example.com')),
      ...(await userRows(t, 'kept@example.com')),
    ];
    expect(after).toEqual(before);
    expect(await t.deps.db.select().from(schema.accounts)).toEqual(credentials);
  });

  it('lets whoever holds the inbox take over an unconfirmed account, ending its sessions', async () => {
    await createAccount(t, 'legacy@example.com', { name: 'Squatter', password: 'squatter pass' });
    const [user] = await userRows(t, 'legacy@example.com');
    await t.deps.db.insert(schema.sessions).values({
      userId: user!.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // Unusable until confirmed.
    const early = await signIn(t, 'legacy@example.com', 'squatter pass');
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    const done = await signUpByEmail(t, mail, 'legacy@example.com', { name: 'Lee' });
    expect(done.res.status).toBe(200);
    const [now] = await userRows(t, 'legacy@example.com');
    expect(now).toMatchObject({ id: user!.id, name: 'Lee', emailVerified: true });
    const sessions = await t.deps.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user!.id));
    expect(sessions).toHaveLength(1); // the new one only
    expect((await signIn(t, 'legacy@example.com', 'squatter pass')).status).toBe(401);
    expect((await signIn(t, 'legacy@example.com')).status).toBe(200);
  });

  it('tells an existing account by email, and answers the same', async () => {
    const fresh = await startSignUp(t, 'nobody@example.com');
    const taken = await startSignUp(t, 'vera@example.com');
    expect(taken.res.status).toBe(fresh.res.status);
    expect(await taken.res.json()).toEqual(await fresh.res.json());
    expect(taken.request).toBeDefined();
    const notice = mail.sent.at(-1)!;
    expect(notice).toMatchObject({
      to: 'vera@example.com',
      subject: 'Someone tried to sign up with your email',
    });
    expect(notice.text).not.toMatch(/\d{6}/);
    // No code completes it.
    const res = await verifyCode(t, taken.request, '123456');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_OTP' });
  });

  it('expires a code after 10 minutes', async () => {
    const start = await startSignUp(t, 'exp@example.com');
    await t.deps.db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(schema.verifications.identifier, 'sign-up:%'));
    const res = await verifyCode(t, start.request, mail.code('exp@example.com')!);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('checks the send limit before making or sending anything', async () => {
    for (let i = 0; i < SENDS_PER_HOUR; i++) {
      expect((await startSignUp(t, 'busy@example.com')).res.status).toBe(200);
    }
    const rows = (await pendingRows(t)).length;
    const sent = mail.sent.length;
    const over = await startSignUp(t, 'busy@example.com');
    expect(over.res.status).toBe(429);
    expect(await over.res.json()).toMatchObject({ code: 'TOO_MANY_CODES' });
    expect(Number(over.res.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect((await pendingRows(t)).length).toBe(rows);
    expect(mail.sent.length).toBe(sent);
  });

  it('counts code attempts per address, across new codes', async () => {
    let start = await startSignUp(t, 'guess@example.com');
    for (let i = 0; i < TRIES_PER_HOUR; i++) {
      if (i === TRIES_PER_HOUR / 2) start = await startSignUp(t, 'guess@example.com');
      const code = mail.code('guess@example.com')!;
      expect((await verifyCode(t, start.request, wrong(code))).status).toBe(400);
    }
    // A new code, and the right one: still refused until the window passes.
    const last = await startSignUp(t, 'guess@example.com');
    const res = await verifyCode(t, last.request, mail.code('guess@example.com')!);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('needs the request a code was sent for', async () => {
    await startSignUp(t, 'bound@example.com');
    const res = await verifyCode(t, undefined, mail.code('bound@example.com')!);
    expect(res.status).toBe(400);
    const forged = await verifyCode(t, 'openbot_sign_up=forged', mail.code('bound@example.com')!);
    expect(forged.status).toBe(400);
  });

  it("serves none of better-auth's own email sign-up or verification links", async () => {
    for (const [path, body] of [
      ['/api/auth/sign-up/email', { name: 'X', email: 'x@example.com', password: PASSWORD }],
      ['/api/auth/send-verification-email', { email: 'x@example.com' }],
    ] as const) {
      expect((await post(t, path, body)).status, path).toBe(404);
    }
    const link = await t.app.request('/api/auth/verify-email?token=x');
    expect(link.status).toBe(404);
    expect(await userRows(t, 'x@example.com')).toEqual([]);
  });
});

describe('sign-up codes in the logs', () => {
  it('logs a code only on a development server that asked for it', async () => {
    for (const logLinks of [false, true]) {
      const app = await managedApp(logLinks ? { logLinks } : {});
      try {
        const info = vi.spyOn(app.deps.logger, 'info');
        await startSignUp(app, 'quiet@example.com');
        const logged = info.mock.calls.find(([, message]) => message === 'email verification code');
        expect(Boolean(logged), String(logLinks)).toBe(logLinks);
        if (logged) expect((logged[0] as { code: string }).code).toMatch(/^\d{6}$/);
      } finally {
        await app.close();
      }
    }
    expect(() =>
      emailFromEnv({ OPENBOT_DEV_LOG_EMAIL_LINKS: '1', NODE_ENV: 'production' }),
    ).toThrow(/OPENBOT_DEV_LOG_EMAIL_LINKS/);
  });

  it('logs no code or invitation id when sending fails', async () => {
    const sentBodies: string[] = [];
    const failing = vi.fn<typeof fetch>(async (_url, init) => {
      sentBodies.push(String(init?.body));
      return new Response('down', { status: 503 });
    });
    const app = await managedApp({
      apiKey: 're_test',
      from: 'OpenBots <hi@example.com>',
      fetch: failing,
    });
    const calls: unknown[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(app.deps.logger, level).mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);
    }
    try {
      await startSignUp(app, 'lost@example.com');
      const code = sentBodies.join('').match(/\b(\d{6})\b/)?.[1];
      expect(code).toBeDefined();
      await createAccount(app, 'owner@example.com');
      await app.deps.db
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.email, 'owner@example.com'));
      const session = sessionOf(await signIn(app, 'owner@example.com'))!;
      await post(app, '/api/v1/organizations', { name: 'Quiet Co' }, session);
      const invite = (await (
        await post(app, '/api/v1/organization/invitations', { email: 'guest@example.com' }, session)
      ).json()) as { id: string; emailed: boolean };
      expect(invite.emailed).toBe(false);
      await app.app.request(`/api/v1/invitations/${invite.id}`, { headers: { cookie: session } });
      const logged = JSON.stringify(calls);
      expect(logged).toContain('verification email failed');
      expect(logged).toContain('invite email failed');
      expect(logged).not.toContain(code!);
      expect(logged).not.toContain(invite.id);
    } finally {
      await app.close();
    }
  });
});

describe('a GitHub sign-up from an invite link', () => {
  let t: TestApp;
  let ownerCookie: string;
  let workspaceId: string;
  const realFetch = globalThis.fetch;
  let github: { email: string; verified: boolean } = { email: '', verified: true };

  beforeAll(async () => {
    t = await createTestApp(
      {
        OPENBOT_DEPLOYMENT: 'managed',
        OPENBOT_SIGNUP_MODE: 'invite',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
      },
      { extensions: managedExtensions() },
    );
    // GitHub, as better-auth calls it.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({
          access_token: 'gh-token',
          token_type: 'bearer',
          scope: 'user:email',
        });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 4242,
          login: 'gina',
          name: 'Gina',
          email: github.email,
          avatar_url: null,
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([{ email: github.email, primary: true, verified: github.verified }]);
      }
      return realFetch(input, init);
    });
    await createAccount(t, 'owner@example.com');
    await t.deps.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, 'owner@example.com'));
    ownerCookie = sessionOf(await signIn(t, 'owner@example.com'))!;
    const org = (await (
      await post(t, '/api/v1/organizations', { name: 'Invited Co' }, ownerCookie)
    ).json()) as { id: string };
    workspaceId = org.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  /** Starts a GitHub sign-up, with the invite cookie when given, and finishes the callback. */
  async function githubSignUp(inviteCookie?: string) {
    const start = await post(t, '/api/auth/sign-in/social', {
      provider: 'github',
      callbackURL: '/',
    });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const cookies = start.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .concat(inviteCookie ? [inviteCookie] : []);
    return t.app.request(`/api/auth/callback/github?code=gh-code&state=${state}`, {
      headers: { cookie: cookies.join('; ') },
    });
  }

  const invite = async (email: string) =>
    (
      (await (
        await post(t, '/api/v1/organization/invitations', { email }, ownerCookie)
      ).json()) as { id: string }
    ).id;

  /** The cookie POST /invitations/{id}/oauth sets. */
  async function inviteCookieFor(id: string) {
    const res = await post(t, `/api/v1/invitations/${id}/oauth`, {});
    expect(res.status).toBe(204);
    const header = res.headers.getSetCookie().find((c) => c.startsWith('openbot_oauth_invite='))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Max-Age=600/);
    return header.split(';')[0]!;
  }

  it('joins the invited organization once, when the verified address is the invited one', async () => {
    github = { email: 'gina@example.com', verified: true };
    const id = await invite('gina@example.com');
    const cookie = await inviteCookieFor(id);
    const done = await githubSignUp(cookie);
    expect(done.status).toBe(302);
    // The invite never rides in the OAuth state.
    expect(done.headers.get('location') ?? '').not.toContain(id);
    const [user] = await t.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'gina@example.com'));
    const members = await t.deps.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user!.id));
    expect(members.map((m) => [m.workspaceId, m.role])).toEqual([[workspaceId, 'member']]);
    const [row] = await t.deps.db.select().from(schema.invites).where(eq(schema.invites.id, id));
    expect(row!.status).toBe('accepted');
    // The session works there now.
    const me = await t.app.request('/api/v1/me', { headers: { cookie: sessionOf(done)! } });
    expect(await me.json()).toMatchObject({ workspace: { id: workspaceId } });
    // The cookie is cleared.
    expect(
      done.headers.getSetCookie().some((c) => /^openbot_oauth_invite=;|Max-Age=0/.test(c)),
    ).toBe(true);
  });

  it('refuses a sign-up whose provider address is another, unverified, or has no invite', async () => {
    const id = await invite('hal@example.com');
    const cookie = await inviteCookieFor(id);
    for (const account of [
      { email: 'mallory@example.com', verified: true },
      { email: 'hal@example.com', verified: false },
    ]) {
      github = account;
      await githubSignUp(cookie);
      const users = await t.deps.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, account.email));
      expect(users, account.email).toEqual([]);
    }
    github = { email: 'hal@example.com', verified: true };
    await githubSignUp();
    expect(
      await t.deps.db.select().from(schema.users).where(eq(schema.users.email, 'hal@example.com')),
    ).toEqual([]);
    const [row] = await t.deps.db.select().from(schema.invites).where(eq(schema.invites.id, id));
    expect(row!.status).toBe('pending');
  });

  it('signs its cookie and keeps it for 10 minutes', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const value = signInviteCookie(t.deps.config, id, 1_000);
    expect(readInviteCookie(t.deps.config, value, 2_000)).toBe(id);
    expect(readInviteCookie(t.deps.config, value, 1_000 + 601_000)).toBeNull();
    const other = '00000000-0000-4000-8000-000000000002';
    expect(readInviteCookie(t.deps.config, value.replace(id, other), 2_000)).toBeNull();
    expect(readInviteCookie(t.deps.config, 'garbage', 2_000)).toBeNull();
  });

  it('sets no cookie for an invitation that is not pending', async () => {
    const res = await post(t, '/api/v1/invitations/00000000-0000-4000-8000-000000000009/oauth', {});
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
