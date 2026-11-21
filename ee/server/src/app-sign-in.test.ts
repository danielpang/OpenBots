import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@openbots/server/db/client';
import { ORIGIN, createTestApp, type TestApp } from '@openbots/server/test-app';
import { managedExtensions } from './index.js';
import { emailTo, mailbox, post, sessionOf, signUpByEmail } from './testing.js';

// Sign-in on the hosted service (phase 4): invite-only sign-up holds for
// Sign in with Apple too, and the iOS and Mac apps sign in through the
// browser into the organization the person works in.

const P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
  .trim();

const APPLE_ENV = {
  APPLE_CLIENT_ID: 'com.example.openbots.web',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: P8,
  APPLE_APP_BUNDLE_ID: 'com.example.openbots',
};

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('hosted sign-in', () => {
  let t: TestApp;
  const mail = mailbox();
  let appleKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let owner: string;

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function appleToken(nonce: string, sub: string, email: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: 'https://appleid.apple.com',
      aud: 'com.example.openbots',
      sub,
      iat: now,
      exp: now + 600,
      email,
      email_verified: true,
      nonce: createHash('sha256').update(nonce).digest('hex'),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(appleKey);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    appleKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    t = await createTestApp(
      { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'invite', ...APPLE_ENV },
      {
        extensions: managedExtensions({ email: emailTo(mail) }),
        apple: { keys: createLocalJWKSet({ keys: [jwk] }) },
      },
    );
    const first = await signUpByEmail(t, mail, 'owner@example.com');
    expect(first.res.status).toBe(200);
    owner = first.cookie!;
    expect((await call(owner, 'POST', '/organizations', { name: 'Hosted' })).status).toBe(201);
  });
  afterAll(() => t.close());

  it('refuses a native Apple sign-up without an invitation, and makes no account', async () => {
    const token = await appleToken('n1', 'apple.stranger', 'stranger@example.com');
    const res = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token, nonce: 'n1' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
    const rows = await t.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'stranger@example.com'));
    expect(rows).toEqual([]);
  });

  it('refuses an email sign-up without an invitation', async () => {
    const res = await post(t, '/api/auth/sign-up/start', { email: 'walk-in@example.com' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
  });

  it('signs an invited member into the Mac app, in their organization, as a device', async () => {
    const invitation = (await (
      await call(owner, 'POST', '/organization/invitations', { email: 'mia@example.com' })
    ).json()) as { id: string };
    const mia = await signUpByEmail(t, mail, 'mia@example.com', { invite: invitation.id });
    expect(mia.res.status).toBe(200);
    expect((await call(mia.cookie!, 'POST', `/invitations/${invitation.id}/accept`)).status).toBe(
      200,
    );
    const browser = sessionOf(
      await post(t, '/api/auth/sign-in/email', {
        email: 'mia@example.com',
        password: 'correct horse battery',
      }),
    )!;

    const { verifier, challenge } = pkce();
    const codeRes = await call(browser, 'POST', '/app-sign-in/codes', {
      platform: 'desktop',
      codeChallenge: challenge,
    });
    expect(codeRes.status).toBe(201);
    const { code } = (await codeRes.json()) as { code: string };
    const exchanged = await t.app.request('/api/v1/app-sign-in/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier: verifier, name: "Mia's Mac" }),
    });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const mac = sessionOf(exchanged)!;
    const me = (await (await call(mac, 'GET', '/me')).json()) as {
      role: string;
      workspace: { name: string };
    };
    expect(me).toMatchObject({ role: 'member', workspace: { name: 'Hosted' } });

    const devices = (await (await call(browser, 'GET', '/devices')).json()) as {
      items: { name: string; platform: string }[];
    };
    expect(devices.items).toContainEqual(
      expect.objectContaining({ name: "Mia's Mac", platform: 'desktop' }),
    );
    // The owner's list is their own devices, not a member's.
    const owners = (await (await call(owner, 'GET', '/devices')).json()) as {
      items: { name: string }[];
    };
    expect(owners.items.map((d) => d.name)).not.toContain("Mia's Mac");
  });
});
