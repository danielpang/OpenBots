import { createHash } from 'node:crypto';
import { base64urlEncode } from '@openbots/tunnel';
import { describe, expect, it, vi } from 'vitest';
import { connectHost, CredentialRejectedError } from '../transport';
import {
  CLOUD_CALLBACK,
  CloudSignInCancelled,
  cloudHost,
  readCallback,
  signInToCloud,
  signInWithAppleToCloud,
} from './cloud-sign-in';

// OpenBots Cloud sign-in on iOS (./cloud-sign-in.ts), with the browser,
// Apple and the server faked.

const CLOUD = 'https://cloud.openbots.example';
const sha256Base64url = async (text: string) =>
  createHash('sha256').update(text).digest('base64url');
const sha256Hex = async (text: string) => createHash('sha256').update(text).digest('hex');

let fill = 1;
const randomBytes = (length: number) => new Uint8Array(length).fill(fill++);

/** A server that answers health, pairing and the sign-in calls; records what it was sent. */
function server(pairStatus = 200) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const body =
        req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : undefined;
      calls.push({ url: req.url, method: req.method, body });
      if (req.url.endsWith('/healthz')) return Response.json({ ok: true });
      if (req.url.endsWith('/api/v1/devices/pair'))
        return pairStatus === 200
          ? Response.json({
              key: 'obk_device',
              device: { id: 'device-1' },
              owner: { id: 'owner-1' },
              setupNeeded: false,
            })
          : Response.json({ detail: 'This pairing code is not valid.' }, { status: pairStatus });
      if (req.url.endsWith('/sign-in/social')) return Response.json({ token: 'never-stored' });
      if (req.url.endsWith('/devices/pairings'))
        return Response.json({
          id: 'p',
          expiresAt: '2026-12-01T00:00:00Z',
          link: `openbots://pair#v=1&host=${'a'.repeat(26)}&key=${base64urlEncode(new Uint8Array(32).fill(3))}&code=${base64urlEncode(new Uint8Array(32).fill(4))}&direct=${encodeURIComponent(CLOUD)}&name=Cloud`,
        });
      if (req.url.endsWith('/sign-out')) return Response.json({ success: true });
      return new Response(null, { status: 404 });
    },
  ) as unknown as typeof fetch;
  return { fetch, calls };
}

describe('readCallback', () => {
  it('takes the code only from an answer with our state', () => {
    expect(readCallback(`${CLOUD_CALLBACK}#code=abc&state=s1`, 's1')).toBe('abc');
    expect(() => readCallback(`${CLOUD_CALLBACK}#code=abc&state=s2`, 's1')).toThrow(
      /not the one this app started/,
    );
    expect(() => readCallback(`${CLOUD_CALLBACK}#error=cancelled&state=s1`, 's1')).toThrow(
      CloudSignInCancelled,
    );
    expect(() => readCallback('openbots://pair#code=abc&state=s1', 's1')).toThrow();
    expect(() => readCallback(`${CLOUD_CALLBACK}?code=abc#state=s1`, 's1')).toThrow();
  });
});

describe('signing in to OpenBots Cloud in the browser', () => {
  it("opens the hosted sign-in with an S256 challenge and trades the code, with the verifier, for this device's key", async () => {
    const { fetch, calls } = server();
    let opened = '';
    const result = await signInToCloud({
      cloudUrl: CLOUD,
      deviceName: "Ada's iPhone",
      openAuthSession: async (url, callback) => {
        opened = url;
        expect(callback).toBe(CLOUD_CALLBACK);
        const state = new URL(url).searchParams.get('state');
        return `${CLOUD_CALLBACK}#code=one-time&state=${state}`;
      },
      sha256Base64url,
      randomBytes,
      fetch,
    });
    const sent = new URL(opened);
    expect(sent.origin + sent.pathname).toBe(`${CLOUD}/app-sign-in`);
    expect(sent.searchParams.get('platform')).toBe('ios');

    const pair = calls.find((call) => call.url.endsWith('/api/v1/devices/pair'))!;
    expect(pair.body).toMatchObject({ code: 'one-time', platform: 'ios', name: "Ada's iPhone" });
    expect(await sha256Base64url(String(pair.body!.codeVerifier))).toBe(
      sent.searchParams.get('challenge'),
    );
    expect(result.host).toMatchObject({
      ...cloudHost(CLOUD),
      deviceId: 'device-1',
      ownerId: 'owner-1',
    });
    expect(result.secrets.apiKey).toBe('obk_device');
    // The code and the verifier are not kept.
    expect(JSON.stringify(result)).not.toContain('one-time');
    expect(JSON.stringify(result)).not.toContain(String(pair.body!.codeVerifier));
  });

  it('stops when the person closes the browser, and sends nothing', async () => {
    const { fetch, calls } = server();
    await expect(
      signInToCloud({
        cloudUrl: CLOUD,
        deviceName: 'iPhone',
        openAuthSession: async () => null,
        sha256Base64url,
        randomBytes,
        fetch,
      }),
    ).rejects.toThrow(CloudSignInCancelled);
    expect(calls).toEqual([]);
  });

  it('says why a refused code did not sign in', async () => {
    const { fetch } = server(401);
    await expect(
      signInToCloud({
        cloudUrl: CLOUD,
        deviceName: 'iPhone',
        openAuthSession: async (url) =>
          `${CLOUD_CALLBACK}#code=c&state=${new URL(url).searchParams.get('state')}`,
        sha256Base64url,
        randomBytes,
        fetch,
      }),
    ).rejects.toThrow('This pairing code is not valid.');
  });
});

describe('native Sign in with Apple', () => {
  it("asks Apple for the hashed nonce, signs in with Apple's token and the nonce, pairs, then signs the session out", async () => {
    const { fetch, calls } = server();
    let askedNonce = '';
    const result = await signInWithAppleToCloud({
      cloudUrl: CLOUD,
      deviceName: 'iPhone',
      signInWithApple: async (hashed) => {
        askedNonce = hashed;
        return { identityToken: 'apple.id.token', name: 'Ada Lovelace' };
      },
      sha256Hex,
      randomBytes,
      fetch,
    });
    const social = calls.find((call) => call.url.endsWith('/api/auth/sign-in/social'))!;
    const idToken = social.body!.idToken as { token: string; nonce: string };
    expect(social.body!.provider).toBe('apple');
    expect(idToken.token).toBe('apple.id.token');
    expect(await sha256Hex(idToken.nonce)).toBe(askedNonce);
    expect(calls.at(-1)?.url).toBe(`${CLOUD}/api/auth/sign-out`);
    expect(result.host).toMatchObject({ ...cloudHost(CLOUD), deviceId: 'device-1' });
    expect(JSON.stringify(result)).not.toContain('apple.id.token');
  });
});

describe('a revoked OpenBots Cloud device', () => {
  it("keeps the host on a 401 that is not the server's own refusal", async () => {
    const answers = [
      // A proxy in the way, or an older server that sends no code.
      new Response(null, { status: 401 }),
      new Response('<html>Unauthorized</html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    for (const answer of answers) {
      const answering = vi.fn<typeof globalThis.fetch>(async () => answer);
      const attempt = connectHost(
        { ...cloudHost(CLOUD), deviceId: 'd' },
        { apiKey: 'obk_x' },
        { fetch: answering },
      );
      await expect(attempt).rejects.toThrow('Cannot reach this server');
      await expect(attempt).rejects.not.toBeInstanceOf(CredentialRejectedError);
    }
  });

  it('is told apart from an unreachable server, for an account only', async () => {
    const refused = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Invalid API key',
            status: 401,
            code: 'UNAUTHORIZED',
          }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    await expect(
      connectHost({ ...cloudHost(CLOUD), deviceId: 'd' }, { apiKey: 'obk_x' }, { fetch: refused }),
    ).rejects.toThrow(CredentialRejectedError);
    // A self-hosted server with a key keeps the old answer.
    await expect(
      connectHost(
        { id: 'server', name: 's', kind: 'server', directUrls: [CLOUD], relayUrl: null },
        { apiKey: 'obk_x' },
        { fetch: refused },
      ),
    ).rejects.toThrow('Cannot reach this server');
  });
});
