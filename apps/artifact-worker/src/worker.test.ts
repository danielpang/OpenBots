import { describe, expect, it } from 'vitest';
import {
  cacheableRequest,
  cacheableResponse,
  EDGE_CLIENT_IP_HEADER,
  EDGE_HOST_HEADER,
  EDGE_SECRET_HEADER,
  handle,
  type EdgeRuntime,
  type Env,
} from './worker.js';

// The edge Worker (plan 21.11): what it forwards, and that it stores only
// the public version, never a private or organization view.

const env: Env = {
  ARTIFACT_DOMAIN: 'openbots-artifacts.example',
  ORIGIN: 'https://app.openbots.example/',
  EDGE_SECRET: 's'.repeat(40),
};
const HOST = 'writer-1a2b3c4d--acme-0f0f0f0f.openbots-artifacts.example';
const ID = '11111111-1111-4111-8111-111111111111';

function runtime(answer: (request: Request) => Response) {
  const stored = new Map<string, Response>();
  const sent: Request[] = [];
  const pending: Promise<unknown>[] = [];
  const rt: EdgeRuntime = {
    fetch: async (request) => {
      sent.push(request);
      return answer(request);
    },
    cache: {
      match: async (request) => stored.get(request.url)?.clone(),
      put: async (request, response) => {
        stored.set(request.url, response);
      },
    },
    waitUntil: (promise) => pending.push(promise),
  };
  return { rt, stored, sent, settle: () => Promise.all(pending) };
}

const publicAnswer = () =>
  new Response('public v1', { headers: { 'cache-control': 'public, max-age=60' } });
const privateAnswer = () =>
  new Response('private', { headers: { 'cache-control': 'private, no-store' } });

describe('the artifact edge Worker', () => {
  it('forwards to the server with the secret, the hostname and the client address only', async () => {
    const { rt, sent } = runtime(publicAnswer);
    await handle(
      new Request(`https://${HOST}/${ID}/?token=abc`, {
        headers: {
          'cf-connecting-ip': '198.51.100.7',
          cookie: '__Secure-ob_view=v',
          authorization: 'Bearer stolen',
          [EDGE_SECRET_HEADER]: 'forged',
          'x-forwarded-for': '10.0.0.1',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none',
        },
      }),
      env,
      rt,
    );
    const [forwarded] = sent;
    expect(forwarded!.url).toBe(`https://app.openbots.example/artifact-host/${ID}/?token=abc`);
    expect(forwarded!.headers.get(EDGE_SECRET_HEADER)).toBe(env.EDGE_SECRET);
    expect(forwarded!.headers.get(EDGE_HOST_HEADER)).toBe(HOST);
    expect(forwarded!.headers.get(EDGE_CLIENT_IP_HEADER)).toBe('198.51.100.7');
    expect(forwarded!.headers.get('cookie')).toBe('__Secure-ob_view=v');
    // Where the browser will put the answer: the server serves a page's content only into its frame.
    expect(forwarded!.headers.get('sec-fetch-dest')).toBe('document');
    expect(forwarded!.headers.get('sec-fetch-site')).toBe('none');
    expect(forwarded!.headers.get('authorization')).toBeNull();
    expect(forwarded!.headers.get('x-forwarded-for')).toBeNull();
    expect(forwarded!.redirect).toBe('manual');
  });

  it('answers 404 itself for a hostname outside the artifact domain', async () => {
    const { rt, sent } = runtime(publicAnswer);
    for (const host of ['app.openbots.example', 'openbots-artifacts.example.evil.test']) {
      expect((await handle(new Request(`https://${host}/${ID}/`), env, rt)).status).toBe(404);
    }
    expect(sent).toEqual([]);
  });

  it('caches the public version and serves it again without asking the server', async () => {
    const { rt, sent, settle, stored } = runtime(publicAnswer);
    const first = await handle(new Request(`https://${HOST}/${ID}/`), env, rt);
    expect(await first.text()).toBe('public v1');
    await settle();
    expect(stored.size).toBe(1);
    const again = await handle(new Request(`https://${HOST}/${ID}/?anything=1`), env, rt);
    expect(await again.text()).toBe('public v1');
    expect(sent).toHaveLength(1);
  });

  it('never caches a private or organization view, a token exchange, or a request with a cookie', async () => {
    const answers: Record<string, () => Response> = {
      private: privateAnswer,
      redirect: () =>
        new Response(null, {
          status: 303,
          headers: {
            location: `/${ID}/`,
            'set-cookie': 'x=y',
            'cache-control': 'private, no-store',
          },
        }),
      notFound: () => new Response('Not found', { status: 404 }),
      publicWithCookie: () =>
        new Response('x', {
          headers: { 'cache-control': 'public, max-age=60', 'set-cookie': 'a=b' },
        }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      const { rt, settle, stored } = runtime(answer);
      await handle(new Request(`https://${HOST}/${ID}/`), env, rt);
      await settle();
      expect(stored.size, name).toBe(0);
    }
    // A public answer to a request that carried the view cookie or a token is not stored either.
    for (const request of [
      new Request(`https://${HOST}/${ID}/`, { headers: { cookie: '__Secure-ob_view=v' } }),
      new Request(`https://${HOST}/${ID}/?token=t`),
      new Request(`https://${HOST}/${ID}/`, { method: 'HEAD' }),
    ]) {
      const { rt, settle, stored } = runtime(publicAnswer);
      await handle(request, env, rt);
      await settle();
      expect(stored.size).toBe(0);
    }
  });

  it("keeps a page's framed content apart from what a top-level request gets", async () => {
    const answers: Record<string, string> = {};
    const { rt, settle, sent } = runtime((request) => {
      const dest = request.headers.get('sec-fetch-dest') ?? 'none';
      return new Response(`for ${dest}`, {
        headers: { 'cache-control': 'public, max-age=60', vary: 'Sec-Fetch-Dest' },
      });
    });
    const get = async (dest: string | null) => {
      const headers: Record<string, string> = dest
        ? { 'sec-fetch-dest': dest, 'sec-fetch-site': 'same-origin' }
        : {};
      const res = await handle(new Request(`https://${HOST}/${ID}/content`, { headers }), env, rt);
      await settle();
      answers[dest ?? 'none'] = await res.text();
    };
    await get('iframe');
    await get('document');
    await get(null);
    await get('iframe');
    expect(answers).toEqual({ iframe: 'for iframe', document: 'for document', none: 'for none' });
    // The second framed request came from the cache; the others each asked the server.
    expect(sent).toHaveLength(3);
  });

  it('never caches the page that asks before leaving an Artifact', async () => {
    const { rt, settle, stored, sent } = runtime(publicAnswer);
    const to = encodeURIComponent('https://example.com/?d=1');
    const request = () =>
      new Request(`https://${HOST}/${ID}/leave?to=${to}`, {
        headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
      });
    expect(cacheableRequest(request())).toBe(false);
    await handle(request(), env, rt);
    await handle(request(), env, rt);
    await settle();
    expect(stored.size).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.url).toBe(`https://app.openbots.example/artifact-host/${ID}/leave?to=${to}`);
  });

  it('reads the rules from the headers alone', () => {
    expect(cacheableRequest(new Request(`https://${HOST}/${ID}/`))).toBe(true);
    expect(cacheableResponse(publicAnswer())).toBe(true);
    expect(cacheableResponse(privateAnswer())).toBe(false);
    expect(
      cacheableResponse(new Response('', { headers: { 'cache-control': 'public, no-store' } })),
    ).toBe(false);
  });
});
