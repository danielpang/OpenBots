import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@openbot/server/db/client';
import { ORIGIN, createTestApp, type TestApp } from '@openbot/server/test-app';
import { emailFromEnv, managedExtensions } from './index.js';
import { readInviteCookie, signInviteCookie } from './plugin.js';

// Sign-up on the managed service (plan 21.6): a 6-digit code confirms the
// email before the account can do anything; an unconfirmed sign-up holds
// nothing; codes stay out of logs; and a GitHub sign-up from an invite link
// carries the invite in a signed cookie.

const PASSWORD = 'correct horse battery';

function cookieOf(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.includes('session_token='));
}

function managedApp(email = {}, env: Record<string, string> = {}) {
  return createTestApp(
    { OPENBOT_DEPLOYMENT: 'managed', OPENBOT_SIGNUP_MODE: 'open', ...env },
    { extensions: managedExtensions({ email }) },
  );
}

/** A fake Resend that keeps each message. */
function mailbox() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as {
      to: string[];
      subject: string;
      text: string;
    };
    sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
    return Response.json({ id: 'email' });
  });
  return {
    fetch,
    sent,
    /** The newest code sent to `to`. */
    code(to: string) {
      return sent
        .filter((m) => m.to === to)
        .at(-1)
        ?.text.match(/\b(\d{6})\b/)?.[1];
    },
  };
}

const post = (t: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

const verify = (t: TestApp, email: string, otp: string) =>
  post(t, '/api/auth/email-otp/verify-email', { email, otp });

const signIn = (t: TestApp, email: string, password = PASSWORD) =>
  post(t, '/api/auth/sign-in/email', { email, password });

describe('sign-up codes', () => {
  let t: TestApp;
  const mail = mailbox();
  const email = { apiKey: 're_test', from: 'OpenBots <hi@example.com>', fetch: mail.fetch };

  beforeAll(async () => {
    t = await managedApp(email);
  });
  afterAll(() => t.close());

  it('confirms an account with the 6-digit code it was sent, and signs it in', async () => {
    const { res, cookie } = await t.signUp('vera@example.com');
    expect(res.status).toBe(200);
    expect(cookie).toBeUndefined();
    const code = mail.code('vera@example.com')!;
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.sent.at(-1)!.subject).toBe(`${code} is your OpenBots code`);
    expect(mail.sent.at(-1)!.text).not.toMatch(/https?:\/\//);
    // Unusable until then; signing in sends a new code.
    const sentBefore = mail.sent.length;
    const early = await signIn(t, 'vera@example.com');
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(mail.sent.length).toBe(sentBefore + 1);

    const confirmed = await verify(t, 'vera@example.com', mail.code('vera@example.com')!);
    expect(confirmed.status).toBe(200);
    const session = cookieOf(confirmed)!;
    const me = await t.app.request('/api/v1/me', { headers: { cookie: session } });
    expect(await me.json()).toMatchObject({ user: { emailVerified: true }, workspace: null });
  });

  it('refuses a wrong code, and after 5 tries needs a new one', async () => {
    await t.signUp('wes@example.com');
    const code = mail.code('wes@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await verify(t, 'wes@example.com', wrong);
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ code: 'INVALID_OTP' });
    for (let i = 0; i < 4; i++) await verify(t, 'wes@example.com', wrong);
    // The right code no longer works: five tries are spent.
    const late = await verify(t, 'wes@example.com', code);
    expect(late.status).toBe(403);
    expect(await late.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    // "Send a new code"
    const again = await post(t, '/api/auth/email-otp/send-verification-otp', {
      email: 'wes@example.com',
      type: 'email-verification',
    });
    expect(again.status).toBe(200);
    const fresh = mail.code('wes@example.com')!;
    expect((await verify(t, 'wes@example.com', fresh)).status).toBe(200);
  });

  it('expires a code after 10 minutes', async () => {
    await t.signUp('exp@example.com');
    await t.deps.db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(schema.verifications.identifier, '%exp@example.com'));
    const res = await verify(t, 'exp@example.com', mail.code('exp@example.com')!);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('lets a new sign-up replace an unconfirmed one, name, password and code', async () => {
    await t.signUp('rae@example.com', { name: 'Squatter', password: 'squatter password' });
    const old = mail.code('rae@example.com')!;
    await t.signUp('rae@example.com', { name: 'Rae', password: PASSWORD });
    const users = await t.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'rae@example.com'));
    expect(users.map((u) => u.name)).toEqual(['Rae']);
    const fresh = mail.code('rae@example.com')!;
    if (fresh !== old) expect((await verify(t, 'rae@example.com', old)).status).toBe(400);
    expect((await verify(t, 'rae@example.com', fresh)).status).toBe(200);
    expect((await signIn(t, 'rae@example.com', 'squatter password')).status).toBe(401);
    expect((await signIn(t, 'rae@example.com')).status).toBe(200);
  });

  it('never replaces a confirmed account', async () => {
    const before = mail.sent.length;
    const { res } = await t.signUp('rae@example.com', {
      name: 'Thief',
      password: 'thief password',
    });
    // The same answer as for a new address, which tells nothing.
    expect(res.status).toBe(200);
    const [user] = await t.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'rae@example.com'));
    expect(user).toMatchObject({ name: 'Rae', emailVerified: true });
    expect((await signIn(t, 'rae@example.com', 'thief password')).status).toBe(401);
    expect(mail.sent.slice(before).some((m) => m.to === 'rae@example.com')).toBe(false);
  });

  it('serves no sign-in, reset or email change by code', async () => {
    for (const [path, body] of [
      ['/api/auth/sign-in/email-otp', { email: 'vera@example.com', otp: '123456' }],
      [
        '/api/auth/email-otp/check-verification-otp',
        { email: 'vera@example.com', otp: '1', type: 'sign-in' },
      ],
      ['/api/auth/forget-password/email-otp', { email: 'vera@example.com' }],
      ['/api/auth/email-otp/send-verification-otp', { email: 'vera@example.com', type: 'sign-in' }],
    ] as const) {
      expect((await post(t, path, body)).status, path).toBe(404);
    }
  });
});

describe('sign-up codes in the logs', () => {
  it('logs a code only on a development server that asked for it', async () => {
    for (const [logLinks, expected] of [
      [false, false],
      [true, true],
    ] as const) {
      const app = await managedApp(logLinks ? { logLinks } : {});
      try {
        const info = vi.spyOn(app.deps.logger, 'info');
        await app.signUp('quiet@example.com');
        const logged = info.mock.calls.find(([, message]) => message === 'email verification code');
        expect(Boolean(logged), String(logLinks)).toBe(expected);
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
      await app.signUp('lost@example.com');
      const code = sentBodies.join('').match(/\b(\d{6})\b/)?.[1];
      expect(code).toBeDefined();
      await app.deps.db
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.email, 'lost@example.com'));
      const session = cookieOf(await signIn(app, 'lost@example.com'))!;
      const call = (path: string, body: unknown) =>
        post(app, `/api/v1${path}`, body, { cookie: session });
      await call('/organizations', { name: 'Quiet Co' });
      const invite = (await (
        await call('/organization/invitations', { email: 'guest@example.com' })
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
    await t.signUp('owner@example.com');
    await t.deps.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, 'owner@example.com'));
    ownerCookie = cookieOf(await signIn(t, 'owner@example.com'))!;
    const org = (await (
      await post(t, '/api/v1/organizations', { name: 'Invited Co' }, { cookie: ownerCookie })
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
        await post(t, '/api/v1/organization/invitations', { email }, { cookie: ownerCookie })
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
    const me = await t.app.request('/api/v1/me', { headers: { cookie: cookieOf(done)! } });
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
