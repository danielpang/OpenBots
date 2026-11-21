import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudSignInError,
  SIGN_IN_MS,
  createCloudSignIn,
  parseSignInCallback,
  sessionFromSetCookie,
} from './cloud-sign-in.js';

// OpenBots Cloud sign-in in the default browser (./cloud-sign-in.ts).

const CLOUD = 'https://app.openbots.example';

function setup(answer: () => Response = () => okAnswer()) {
  let clock = 1_000_000;
  let fill = 1;
  const opened: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  const signIn = createCloudSignIn({
    cloudUrl: CLOUD,
    openExternal: async (url) => void opened.push(url),
    fetch,
    deviceName: async () => "  Ada's MacBook  ",
    now: () => clock,
    // Each call fills its bytes with a new value, so verifier and state differ.
    randomBytes: (n) => new Uint8Array(n).fill(fill++),
  });
  return {
    signIn,
    opened,
    fetch,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function okAnswer() {
  const headers = new Headers();
  headers.append('set-cookie', 'other=1; Path=/');
  headers.append(
    'set-cookie',
    '__Secure-better-auth.session_token=tok.sig; Path=/; HttpOnly; Secure; SameSite=Lax',
  );
  return new Response(JSON.stringify({ device: { id: 'd' } }), { status: 200, headers });
}

/** The state and challenge the browser was sent with. */
function sent(url: string) {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    platform: parsed.searchParams.get('platform'),
    challenge: parsed.searchParams.get('challenge')!,
    state: parsed.searchParams.get('state')!,
  };
}

describe('parseSignInCallback', () => {
  it('reads the code and state, or a cancel, from the fragment only', () => {
    const state = 'A'.repeat(22);
    expect(parseSignInCallback(`openbots://app-sign-in#code=abc&state=${state}`)).toEqual({
      kind: 'code',
      code: 'abc',
      state,
    });
    expect(parseSignInCallback(`openbots://app-sign-in#error=cancelled&state=${state}`)).toEqual({
      kind: 'cancelled',
      state,
    });
    expect(parseSignInCallback(`openbots://app-sign-in?code=abc&state=${state}`)).toBeNull();
    expect(parseSignInCallback(`openbots://pair#code=abc&state=${state}`)).toBeNull();
    expect(parseSignInCallback(`https://app-sign-in#code=abc&state=${state}`)).toBeNull();
    expect(parseSignInCallback('openbots://app-sign-in#code=abc&state=short')).toBeNull();
    expect(parseSignInCallback(`openbots://app-sign-in#code=a b&state=${state}`)).toBeNull();
  });
});

describe('sessionFromSetCookie', () => {
  it('finds the session cookie among others', () => {
    expect(sessionFromSetCookie(['a=1', 'better-auth.session_token=t.s; Path=/'])).toEqual({
      name: 'better-auth.session_token',
      value: 't.s',
    });
    expect(sessionFromSetCookie(['a=1'])).toBeNull();
  });
});

describe('cloud sign-in', () => {
  it("opens the hosted sign-in with an S256 challenge of a verifier it keeps, and trades the code for the Mac's session", async () => {
    const { signIn, opened, fetch } = setup();
    await signIn.start();
    expect(opened).toHaveLength(1);
    const request = sent(opened[0]!);
    expect(request.path).toBe('/app-sign-in');
    expect(request.platform).toBe('desktop');

    const token = await signIn.finish(
      `openbots://app-sign-in#code=one-time&state=${request.state}`,
    );
    expect(token).toEqual({ name: '__Secure-better-auth.session_token', value: 'tok.sig' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${CLOUD}/api/v1/app-sign-in/session`);
    const body = JSON.parse(String(init!.body)) as Record<string, string>;
    expect(body.code).toBe('one-time');
    expect(body.name).toBe("Ada's MacBook");
    expect(createHash('sha256').update(body.codeVerifier!).digest('base64url')).toBe(
      request.challenge,
    );
  });

  it('refuses an answer to another request, a second answer, or one too late, and sends nothing', async () => {
    const { signIn, opened, fetch, tick } = setup();
    await expect(
      signIn.finish(`openbots://app-sign-in#code=x&state=${'B'.repeat(22)}`),
    ).rejects.toThrow(CloudSignInError);
    await signIn.start();
    const { state } = sent(opened[0]!);
    await expect(
      signIn.finish(`openbots://app-sign-in#code=x&state=${'C'.repeat(22)}`),
    ).rejects.toThrow(/not the one this app started/);
    tick(SIGN_IN_MS + 1);
    await expect(signIn.finish(`openbots://app-sign-in#code=x&state=${state}`)).rejects.toThrow(
      /too old/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops at a cancel in the browser', async () => {
    const { signIn, opened, fetch } = setup();
    await signIn.start();
    const { state } = sent(opened[0]!);
    await expect(
      signIn.finish(`openbots://app-sign-in#error=cancelled&state=${state}`),
    ).rejects.toThrow('Sign-in was cancelled.');
    // The request is spent: the same state does nothing again.
    await expect(signIn.finish(`openbots://app-sign-in#code=x&state=${state}`)).rejects.toThrow(
      /not the one/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says why a refused code did not sign in, without repeating the code', async () => {
    const { signIn, opened } = setup(
      () => new Response(JSON.stringify({ code: 'PAIRING_INVALID' }), { status: 401 }),
    );
    await signIn.start();
    const { state } = sent(opened[0]!);
    const error = await signIn
      .finish(`openbots://app-sign-in#code=secret-code&state=${state}`)
      .then(
        () => new Error('signed in'),
        (e: unknown) => e as Error,
      );
    expect(error.message).toMatch(/expired or was already used/);
    expect(error.message).not.toContain('secret-code');
  });
});
