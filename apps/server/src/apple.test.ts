import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLE_ISSUER, SECRET_DAYS, appleProvider, sameNonce } from './apple.js';
import { loadConfig } from './config.js';
import { generateMasterKey } from './secrets.js';
import { ORIGIN, createTestApp, type TestApp } from './test-app.js';

// Sign in with Apple (apple.ts): absent until configured, then on the web and
// natively, with Apple's keys faked so nothing reaches the network.

const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = ecKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();

const APPLE_ENV = {
  APPLE_CLIENT_ID: 'com.example.openbots.web',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  // As it sits in .env: one line, with \n for each break.
  APPLE_PRIVATE_KEY: P8.replace(/\n/g, '\\n'),
  APPLE_APP_BUNDLE_ID: 'com.example.openbots',
};

const base = { OPENBOTS_MASTER_KEY: generateMasterKey(), DATABASE_URL: 'postgres://unused' };

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

/** Apple's answer to the web sign-in: a cross-site form POST, here with a cookie a CDN set. */
function applePost(t: TestApp, path: string, form: Record<string, string>) {
  return t.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: APPLE_ISSUER,
      'sec-fetch-site': 'cross-site',
      cookie: '__cf_bm=cdn-cookie',
    },
    body: new URLSearchParams(form).toString(),
  });
}

function post(t: TestApp, path: string, body: unknown) {
  return t.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

describe('Apple settings', () => {
  it('are off with none set', () => {
    expect(loadConfig(base).oauth.apple).toBeUndefined();
  });

  it('need all four, and name what is missing but never the key', () => {
    const run = () =>
      loadConfig({ ...base, APPLE_CLIENT_ID: 'com.example.web', APPLE_PRIVATE_KEY: P8 });
    expect(run).toThrow(/APPLE_TEAM_ID: needed/);
    expect(run).toThrow(/APPLE_KEY_ID: needed/);
    try {
      run();
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE KEY-----\n');
    }
  });

  it('refuse a bundle ID alone', () => {
    expect(() => loadConfig({ ...base, APPLE_APP_BUNDLE_ID: 'com.example.app' })).toThrow(
      /APPLE_APP_BUNDLE_ID: set only with/,
    );
  });

  it('read a key written on one line', () => {
    const apple = loadConfig({ ...base, ...APPLE_ENV }).oauth.apple!;
    expect(apple.privateKey).toBe(P8);
    expect(apple.appBundleId).toBe('com.example.openbots');
  });
});

describe('the client secret', () => {
  const config = loadConfig({ ...base, ...APPLE_ENV }).oauth.apple!;

  it('is an ES256 JWT from the team about the Services ID, for SECRET_DAYS', () => {
    const now = Date.UTC(2026, 10, 1);
    const provider = appleProvider(config, { now: () => now, keys: async () => ecKey.publicKey });
    const [header, payload, signature] = provider.clientSecret.split('.') as [
      string,
      string,
      string,
    ];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({
      iss: 'TEAM123456',
      sub: 'com.example.openbots.web',
      aud: APPLE_ISSUER,
      iat: now / 1000,
      exp: now / 1000 + SECRET_DAYS * 86_400,
    });
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(ecKey.privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
  });

  it('is made again a day before it ends', () => {
    let now = Date.UTC(2026, 10, 1);
    const provider = appleProvider(config, { now: () => now });
    const first = provider.clientSecret;
    now += (SECRET_DAYS - 2) * 86_400_000;
    expect(provider.clientSecret).toBe(first);
    now += 86_400_000 + 1;
    expect(provider.clientSecret).not.toBe(first);
  });

  it('refuses a key that does not parse, without quoting it', () => {
    expect(() => appleProvider({ ...config, privateKey: 'not a key' })).toThrow(
      /APPLE_PRIVATE_KEY: not a key/,
    );
  });
});

describe('sameNonce', () => {
  it("takes only the SHA-256 in hex of the nonce sent, never the token's own claim", () => {
    const hashed = createHash('sha256').update('n0nce').digest('hex');
    expect(sameNonce(hashed, 'n0nce')).toBe(true);
    // The claim sent back as the nonce: what anyone holding the token could do.
    expect(sameNonce(hashed, hashed)).toBe(false);
    expect(sameNonce('n0nce', 'n0nce')).toBe(false);
    expect(sameNonce('other', 'n0nce')).toBe(false);
    expect(sameNonce(undefined, 'n0nce')).toBe(false);
  });
});

describe('Sign in with Apple, not configured', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('is absent from the capabilities', async () => {
    const caps = await json(await t.app.request('/api/v1/capabilities'));
    expect(caps.oauth).toEqual({ github: false, google: false, apple: false });
    expect(caps.nativeAppleSignIn).toBe(false);
  });

  it("keeps refusing a cross-site POST with a cookie at Apple's callback", async () => {
    const res = await applePost(t, '/api/auth/callback/apple', { code: 'c', state: 's' });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('cannot be started', async () => {
    const res = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      callbackURL: '/',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await json(res))).not.toContain('appleid.apple.com');
  });
});

describe('Sign in with Apple, configured', () => {
  let t: TestApp;
  let appleKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let jwk: JWK;

  /** An ID token as Apple would sign it, for the app (or `aud`), with the hashed nonce. */
  async function idToken(nonce: string, claims: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: APPLE_ISSUER,
      aud: 'com.example.openbots',
      sub: '000123.apple.user',
      iat: now,
      exp: now + 600,
      email: 'ada@privaterelay.appleid.com',
      email_verified: true,
      nonce: createHash('sha256').update(nonce).digest('hex'),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(appleKey);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    appleKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };
    t = await createTestApp(APPLE_ENV, {
      apple: { keys: createLocalJWKSet({ keys: [jwk] }) },
    });
  });
  afterAll(() => t.close());

  it('is in the capabilities, with the native sign-in', async () => {
    const caps = await json(await t.app.request('/api/v1/capabilities'));
    expect(caps.oauth).toEqual({ github: false, google: false, apple: true });
    expect(caps.nativeAppleSignIn).toBe(true);
  });

  it('starts the web sign-in at Apple, for the Services ID', async () => {
    const res = await post(t, '/api/auth/sign-in/social', { provider: 'apple', callbackURL: '/' });
    expect(res.status).toBe(200);
    const url = new URL(String((await json(res)).url));
    expect(url.origin).toBe(APPLE_ISSUER);
    expect(url.searchParams.get('client_id')).toBe('com.example.openbots.web');
    expect(url.searchParams.get('response_mode')).toBe('form_post');
  });

  it("takes Apple's cross-site form POST with a cookie, and only redirects it to the GET callback", async () => {
    const res = await applePost(t, '/api/auth/callback/apple', {
      code: 'apple-code',
      state: 'not-a-state',
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/api/auth/callback/apple`);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      code: 'apple-code',
      state: 'not-a-state',
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    // The GET callback is where the state is checked: this one is refused.
    const get = await t.app.request(location.pathname + location.search);
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toMatch(/error=/);
    expect(
      get.headers
        .getSetCookie()
        .some((c) => c.includes('session_token=') && !c.includes('Max-Age=0')),
    ).toBe(false);
    expect(await t.db.query.users.findMany()).toEqual([]);
  });

  it('still refuses a cross-site POST with a cookie anywhere else', async () => {
    for (const path of [
      '/api/auth/callback/github',
      '/api/auth/callback/apple/',
      '/api/auth/sign-out',
      '/api/v1/devices/pairings',
    ]) {
      const res = await applePost(t, path, { code: 'c', state: 's' });
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses a native ID token for another app, without the nonce, or not signed by Apple', async () => {
    const forOther = await idToken('a-nonce', { aud: 'com.example.other' });
    const res = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: forOther, nonce: 'a-nonce' },
    });
    expect(res.status).toBe(401);
    const body = JSON.stringify(await json(res));
    expect(body).not.toContain(forOther);

    const good = await idToken('a-nonce');
    const noNonce = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: good },
    });
    expect(noNonce.status).toBe(401);
    const wrongNonce = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: good, nonce: 'another' },
    });
    expect(wrongNonce.status).toBe(401);

    const forged = await new SignJWT({ nonce: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(APPLE_ISSUER)
      .setAudience('com.example.openbots')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign((await generateKeyPair('RS256')).privateKey);
    const forgedRes = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: forged, nonce: 'x' },
    });
    expect(forgedRes.status).toBe(401);
    expect(await t.db.query.users.findMany()).toEqual([]);
  });

  it('refuses a native token sent with its own nonce claim', async () => {
    const token = await idToken('c-nonce');
    const claim = createHash('sha256').update('c-nonce').digest('hex');
    const replayed = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token, nonce: claim },
    });
    expect(replayed.status).toBe(401);
    expect(await t.db.query.users.findMany()).toEqual([]);
  });

  it("refuses a native token made for the web's Services ID", async () => {
    const forWeb = await idToken('c-nonce', { aud: 'com.example.openbots.web' });
    const webRes = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: forWeb, nonce: 'c-nonce' },
    });
    expect(webRes.status).toBe(401);
    expect(await t.db.query.users.findMany()).toEqual([]);
  });

  it("signs in natively with the app's ID token and nonce: here the install's first account, its owner", async () => {
    const res = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: { token: await idToken('a-nonce'), nonce: 'a-nonce' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const me = await t.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  it('still closes a self-hosted install after its owner', async () => {
    const res = await post(t, '/api/auth/sign-in/social', {
      provider: 'apple',
      idToken: {
        token: await idToken('b-nonce', { sub: 'someone.else', email: 'bob@example.com' }),
        nonce: 'b-nonce',
      },
    });
    expect(res.status).toBe(403);
  });
});
