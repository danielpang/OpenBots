import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

// App sign-in through the browser (services/app-sign-in.ts): a signed-in
// browser makes a one-time code bound to the app's PKCE challenge; the iOS
// app trades it for a device key at /devices/pair, the Mac app for a session
// that is a device too.

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function pkce() {
  const verifier = b64(randomBytes(32));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let peers = 0;
/** A different client address each call, so the per-client limit stays out of the way. */
const freshPeer = () => `203.0.113.${(peers++ % 250) + 1}`;

function request(
  t: TestApp,
  method: string,
  path: string,
  {
    cookie,
    key,
    body,
    peer = freshPeer(),
  }: { cookie?: string; key?: string; body?: unknown; peer?: string } = {},
) {
  return t.app.request(
    path.startsWith('/api/') ? path : `/api/v1${path}`,
    {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: peer, remotePort: 50_000, remoteFamily: 'IPv4' } } },
  );
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

const sessionCookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('better-auth.session_token='))
    ?.split(';')[0];

const pairBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: "Ada's iPhone",
  platform: 'ios',
  publicKey: b64(randomBytes(32)),
  pushKey: b64(randomBytes(32)),
  ...extra,
});

interface Code {
  code: string;
  expiresAt: string;
}

describe('app sign-in on a self-hosted install', () => {
  let t: TestApp;
  let cookie: string;
  const logs: string[] = [];

  const newCode = async (platform: 'ios' | 'desktop', challenge: string, as = cookie) =>
    json<Code>(
      request(t, 'POST', '/app-sign-in/codes', {
        cookie: as,
        body: { platform, codeChallenge: challenge },
      }),
      201,
    );

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    });
    t = await createTestApp({}, { logger: pino({ level: 'debug' }, sink) });
    cookie = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.devicePairings);
  });

  it('signs the iOS app in: the code works once, and only with its verifier', async () => {
    const { verifier, challenge } = pkce();
    const { code, expiresAt } = await newCode('ios', challenge);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Without the verifier, or with another one, the code does nothing and is not spent.
    const missing = await request(t, 'POST', '/devices/pair', { body: pairBody(code) });
    expect(missing.status).toBe(401);
    const wrong = await request(t, 'POST', '/devices/pair', {
      body: pairBody(code, { codeVerifier: pkce().verifier }),
    });
    expect(wrong.status).toBe(401);
    const missingText = await missing.text();
    expect(missingText).not.toContain(code);

    const paired = await json<{ key: string; device: { id: string } }>(
      request(t, 'POST', '/devices/pair', { body: pairBody(code, { codeVerifier: verifier }) }),
    );
    expect(paired.key).toMatch(/^obk_/);
    const me = await request(t, 'GET', '/me', { key: paired.key });
    expect(me.status).toBe(200);

    const again = await request(t, 'POST', '/devices/pair', {
      body: pairBody(code, { codeVerifier: verifier }),
    });
    expect(again.status).toBe(401);

    // A revoked device's key stops working at once.
    const revoke = await request(t, 'DELETE', `/devices/${paired.device.id}`, { cookie });
    expect(revoke.status).toBe(204);
    expect((await request(t, 'GET', '/me', { key: paired.key })).status).toBe(401);
  });

  it('still pairs from a QR code with no verifier, and ignores one sent', async () => {
    const pairing = await json<{ qr: { code: string } }>(
      request(t, 'POST', '/devices/pairings', { cookie, body: {} }),
      201,
    );
    await json(
      request(t, 'POST', '/devices/pair', {
        body: pairBody(pairing.qr.code, { codeVerifier: pkce().verifier }),
      }),
    );
  });

  it('signs the Mac app in with a session that is a device, revocable from Devices', async () => {
    const { verifier, challenge } = pkce();
    const { code } = await newCode('desktop', challenge);
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: "Ada's MacBook" },
    });
    const body = await json<{ device: { id: string; platform: string }; user: { id: string } }>(
      res,
    );
    expect(body.device.platform).toBe('desktop');
    const mac = sessionCookieOf(res)!;
    expect(mac).toBeDefined();
    expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(200);

    const devices = await json<{ items: { id: string; name: string; platform: string }[] }>(
      request(t, 'GET', '/devices', { cookie }),
    );
    expect(devices.items).toContainEqual(
      expect.objectContaining({ id: body.device.id, name: "Ada's MacBook", platform: 'desktop' }),
    );

    // Spent.
    const again = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Mac' },
    });
    expect(again.status).toBe(401);

    const revoke = await request(t, 'DELETE', `/devices/${body.device.id}`, { cookie });
    expect(revoke.status).toBe(204);
    expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(401);
    const [row] = await t.db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, body.device.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.sessionId).toBeNull();

    const actions = (await t.db.select().from(schema.auditLog)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['device.pairing_created', 'device.paired', 'device.revoked']),
    );
  });

  it("revokes the Mac's device when its session signs out", async () => {
    const { verifier, challenge } = pkce();
    const { code } = await newCode('desktop', challenge);
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Signing out' },
    });
    const { device } = await json<{ device: { id: string } }>(res);
    const mac = sessionCookieOf(res)!;
    const out = await request(t, 'POST', '/api/auth/sign-out', { cookie: mac, body: {} });
    expect(out.status).toBe(200);
    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, device.id));
    expect(row!.revokedAt).not.toBeNull();
    const devices = await json<{ items: { id: string }[] }>(
      request(t, 'GET', '/devices', { cookie }),
    );
    expect(devices.items.map((d) => d.id)).not.toContain(device.id);
  });

  it("signs out even when revoking the Mac's device fails, and logs it without the token", async () => {
    const { verifier, challenge } = pkce();
    const { code } = await newCode('desktop', challenge);
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Failing revoke' },
    });
    const { device } = await json<{ device: { id: string } }>(res);
    const mac = sessionCookieOf(res)!;
    const token = decodeURIComponent(mac.split('=')[1]!).split('.')[0]!;
    // Revoking a device fails while this trigger is in place.
    await t.db.execute(sql`create function test_refuse_device_write() returns trigger
      language plpgsql as $$ begin
        if new.revoked_at is not null and old.revoked_at is null then
          raise exception 'refused by the test';
        end if;
        return new;
      end $$`);
    await t.db.execute(sql`create trigger test_refuse_device_write before update on devices
      for each row execute function test_refuse_device_write()`);
    const before = logs.length;
    try {
      const out = await request(t, 'POST', '/api/auth/sign-out', { cookie: mac, body: {} });
      expect(out.status).toBe(200);
    } finally {
      await t.db.execute(sql`drop trigger test_refuse_device_write on devices`);
      await t.db.execute(sql`drop function test_refuse_device_write()`);
    }
    expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(401);
    const logged = logs.slice(before).join('');
    expect(logged).toContain('revoking the device of an ended session failed');
    expect(logged).not.toContain(token);
    // The session is gone; the device row stays, unrevoked, for Devices to revoke.
    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, device.id));
    expect(row!.revokedAt).toBeNull();
  });

  it('trades only an app sign-in code for a session, and only with its verifier', async () => {
    const pairing = await json<{ qr: { code: string } }>(
      request(t, 'POST', '/devices/pairings', { cookie, body: {} }),
      201,
    );
    const qr = await request(t, 'POST', '/app-sign-in/session', {
      body: { code: pairing.qr.code, codeVerifier: pkce().verifier, name: 'Mac' },
    });
    expect(qr.status).toBe(401);

    const { challenge } = pkce();
    const { code } = await newCode('desktop', challenge);
    const wrong = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: pkce().verifier, name: 'Mac' },
    });
    expect(wrong.status).toBe(401);
    expect(sessionCookieOf(wrong)).toBeUndefined();
    expect((await wrong.json()) as { code: string }).toMatchObject({ code: 'PAIRING_INVALID' });
  });

  it('makes codes for a browser session only, with a real challenge', async () => {
    const bad = await request(t, 'POST', '/app-sign-in/codes', {
      cookie,
      body: { platform: 'ios', codeChallenge: 'short' },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await request(t, 'POST', '/app-sign-in/codes', {
          body: { platform: 'ios', codeChallenge: pkce().challenge },
        })
      ).status,
    ).toBe(401);

    // An API key, even one that is no device's, cannot mint a sign-in for an app.
    const key = await json<{ key: string }>(
      request(t, 'POST', '/api-keys', { cookie, body: { name: 'script' } }),
      201,
    );
    const viaKey = await request(t, 'POST', '/app-sign-in/codes', {
      key: key.key,
      body: { platform: 'ios', codeChallenge: pkce().challenge },
    });
    expect(viaKey.status).toBe(403);
    expect(await viaKey.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    // A paired device's key is refused before that.
    const { verifier, challenge } = pkce();
    const { code } = await newCode('ios', challenge);
    const phone = await json<{ key: string }>(
      request(t, 'POST', '/devices/pair', { body: pairBody(code, { codeVerifier: verifier }) }),
    );
    const viaDevice = await request(t, 'POST', '/app-sign-in/codes', {
      key: phone.key,
      body: { platform: 'desktop', codeChallenge: pkce().challenge },
    });
    expect(viaDevice.status).toBe(403);
    expect(await viaDevice.json()).toMatchObject({ code: 'DEVICE_KEY_NOT_ALLOWED' });
  });

  it("takes each app's code at its own route only, and leaves a mismatched code unspent", async () => {
    // The iOS app's code makes no web session...
    const ios = pkce();
    const { code: iosCode } = await newCode('ios', ios.challenge);
    const asSession = await request(t, 'POST', '/app-sign-in/session', {
      body: { code: iosCode, codeVerifier: ios.verifier, name: 'Not a Mac' },
    });
    expect(asSession.status).toBe(401);
    expect(sessionCookieOf(asSession)).toBeUndefined();
    expect(await asSession.json()).toMatchObject({ code: 'PAIRING_INVALID' });
    // ...and is still good where it belongs.
    await json(
      request(t, 'POST', '/devices/pair', {
        body: pairBody(iosCode, { codeVerifier: ios.verifier }),
      }),
    );

    // The Mac app's code makes no device key...
    const mac = pkce();
    const { code: macCode } = await newCode('desktop', mac.challenge);
    const asPair = await request(t, 'POST', '/devices/pair', {
      body: pairBody(macCode, { codeVerifier: mac.verifier }),
    });
    expect(asPair.status).toBe(401);
    expect(await asPair.json()).toMatchObject({ code: 'PAIRING_INVALID' });
    // ...and is still good where it belongs.
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code: macCode, codeVerifier: mac.verifier, name: 'Right route' },
    });
    expect(res.status).toBe(200);
  });

  it("counts a try at the other app's route against the code's limit", async () => {
    const mac = pkce();
    const { code } = await newCode('desktop', mac.challenge);
    for (let i = 0; i < 5; i++) {
      const res = await request(t, 'POST', '/devices/pair', {
        body: pairBody(code, { codeVerifier: mac.verifier }),
      });
      expect(res.status).toBe(401);
    }
    const late = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: mac.verifier, name: 'Too late' },
    });
    expect(late.status).toBe(429);
  });

  it('limits tries per client', async () => {
    const peer = '192.0.2.77';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(t, 'POST', '/app-sign-in/session', {
        peer,
        body: { code: b64(randomBytes(32)), codeVerifier: pkce().verifier, name: 'Mac' },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('never logs a code, a verifier, a key or a session token', async () => {
    const { verifier, challenge } = pkce();
    const { code } = await newCode('desktop', challenge);
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Logged' },
    });
    const token = decodeURIComponent(sessionCookieOf(res)!.split('=')[1]!).split('.')[0]!;
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [code, verifier, challenge, token]) expect(text).not.toContain(secret);
    const audit = JSON.stringify(await t.db.select().from(schema.auditLog));
    for (const secret of [code, verifier, token]) expect(audit).not.toContain(secret);
  });
});

describe('app sign-in in local mode', () => {
  it('makes no session: the Mac app signs this install in itself', async () => {
    const token = 'x'.repeat(40);
    const t = await createTestApp({ OPENBOTS_LOCAL_TOKEN: token });
    try {
      const local = await t.app.request('/api/v1/local/session', {
        method: 'POST',
        headers: { 'x-openbots-local-token': token },
      });
      const cookie = sessionCookieOf(local)!;
      const { verifier, challenge } = pkce();
      const { code } = await json<Code>(
        request(t, 'POST', '/app-sign-in/codes', {
          cookie,
          body: { platform: 'desktop', codeChallenge: challenge },
        }),
        201,
      );
      const res = await request(t, 'POST', '/app-sign-in/session', {
        body: { code, codeVerifier: verifier, name: 'Mac' },
      });
      expect(res.status).toBe(403);
      expect(sessionCookieOf(res)).toBeUndefined();
      const devices = await t.db.select().from(schema.devices);
      expect(devices).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe('app sign-in across organizations', () => {
  let t: TestApp;
  let ada: string;
  let bob: string;
  let other: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    ada = (await t.signUp('ada@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    other = await t.createOrganization('Other');
    const bobId = await t.userId('bob@example.com');
    await t.db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, bobId));
    await t.addMember(bobId, other, 'owner');
    await t.switchOrganization(bob, other);
  });
  afterAll(() => t.close());

  it("signs the app in to the organization the browser works in, and no one else's sees it", async () => {
    const { verifier, challenge } = pkce();
    const { code } = await json<Code>(
      request(t, 'POST', '/app-sign-in/codes', {
        cookie: ada,
        body: { platform: 'desktop', codeChallenge: challenge },
      }),
      201,
    );
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: "Ada's Mac" },
    });
    const { device } = await json<{ device: { id: string } }>(res);
    const mac = sessionCookieOf(res)!;
    const token = decodeURIComponent(mac.split('=')[1]!).split('.')[0]!;
    const [session] = await t.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.token, token));
    expect(session!.activeOrganizationId).toBe(await t.defaultOrganization());

    const bobs = await json<{ items: { id: string }[] }>(
      request(t, 'GET', '/devices', { cookie: bob }),
    );
    expect(bobs.items.map((d) => d.id)).not.toContain(device.id);
    const steal = await request(t, 'DELETE', `/devices/${device.id}`, { cookie: bob });
    expect(steal.status).toBe(404);
    expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(200);

    const sign = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'auth.sign_in'), eq(schema.auditLog.workspaceId, other)),
      );
    const adaId = await t.userId('ada@example.com');
    expect(sign.filter((r) => r.actorId === adaId)).toEqual([]);
  });

  it("notes when the Mac's session was last used", async () => {
    const { verifier, challenge } = pkce();
    const { code } = await json<Code>(
      request(t, 'POST', '/app-sign-in/codes', {
        cookie: ada,
        body: { platform: 'desktop', codeChallenge: challenge },
      }),
      201,
    );
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Seen Mac' },
    });
    const { device } = await json<{ device: { id: string } }>(res);
    const old = new Date(Date.now() - 3_600_000);
    await t.db
      .update(schema.devices)
      .set({ lastSeenAt: old })
      .where(eq(schema.devices.id, device.id));
    expect((await request(t, 'GET', '/me', { cookie: sessionCookieOf(res)! })).status).toBe(200);
    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, device.id));
    expect(row!.lastSeenAt!.getTime()).toBeGreaterThan(old.getTime());
  });

  it("keeps finding the Mac's device in its own organization after the session switches", async () => {
    const home = await t.defaultOrganization();
    const adaId = await t.userId('ada@example.com');
    await t.addMember(adaId, other, 'member');
    try {
      const { verifier, challenge } = pkce();
      const { code } = await json<Code>(
        request(t, 'POST', '/app-sign-in/codes', {
          cookie: ada,
          body: { platform: 'desktop', codeChallenge: challenge },
        }),
        201,
      );
      const res = await request(t, 'POST', '/app-sign-in/session', {
        body: { code, codeVerifier: verifier, name: 'Switching Mac' },
      });
      const { device } = await json<{ device: { id: string } }>(res);
      const mac = sessionCookieOf(res)!;
      const old = new Date(Date.now() - 3_600_000);
      await t.db
        .update(schema.devices)
        .set({ lastSeenAt: old })
        .where(eq(schema.devices.id, device.id));
      await t.switchOrganization(mac, other);

      // Last seen still moves on.
      expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(200);
      const [seen] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, device.id));
      expect(seen!.lastSeenAt!.getTime()).toBeGreaterThan(old.getTime());

      // From the other organization the device is not there to revoke (it is
      // listed and revoked in its own); signing out still revokes it.
      expect((await request(t, 'DELETE', `/devices/${device.id}`, { cookie: mac })).status).toBe(
        404,
      );
      const out = await request(t, 'POST', '/api/auth/sign-out', { cookie: mac, body: {} });
      expect(out.status).toBe(200);
      const [row] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, device.id));
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.workspaceId).toBe(home);
      const audit = await t.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'device.revoked'),
            eq(schema.auditLog.targetId, device.id),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.workspaceId).toBe(home);
      expect(audit[0]!.metadata).toMatchObject({ via: 'session_ended' });
    } finally {
      await t.db
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.userId, adaId),
            eq(schema.workspaceMembers.workspaceId, other),
          ),
        );
    }
  });

  it("revokes the Mac's device when its session expires in another organization", async () => {
    const { verifier, challenge } = pkce();
    const { code } = await json<Code>(
      request(t, 'POST', '/app-sign-in/codes', {
        cookie: ada,
        body: { platform: 'desktop', codeChallenge: challenge },
      }),
      201,
    );
    const res = await request(t, 'POST', '/app-sign-in/session', {
      body: { code, codeVerifier: verifier, name: 'Expiring Mac' },
    });
    const { device } = await json<{ device: { id: string } }>(res);
    const mac = sessionCookieOf(res)!;
    await t.switchOrganization(mac, other);
    const token = decodeURIComponent(mac.split('=')[1]!).split('.')[0]!;
    await t.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.token, token));
    expect((await request(t, 'GET', '/me', { cookie: mac })).status).toBe(401);
    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, device.id));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('refuses a code once its owner is suspended', async () => {
    const { verifier, challenge } = pkce();
    const { code } = await json<Code>(
      request(t, 'POST', '/app-sign-in/codes', {
        cookie: ada,
        body: { platform: 'ios', codeChallenge: challenge },
      }),
      201,
    );
    const adaId = await t.userId('ada@example.com');
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, adaId));
    try {
      const res = await request(t, 'POST', '/devices/pair', {
        body: pairBody(code, { codeVerifier: verifier }),
      });
      expect(res.status).toBe(401);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, adaId));
    }
  });
});
