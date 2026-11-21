import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createArtifact } from '../services/artifacts.js';
import { setVisibility } from '../services/artifact-sharing.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { HOST_RATE_LIMIT } from './handler.js';
import { EDGE_CLIENT_IP_HEADER, EDGE_HOST_HEADER, EDGE_SECRET_HEADER } from './mount.js';

// The two ways a request reaches the artifact host in the server (plan
// 21.11): by its Host header, and from the edge Worker at /artifact-host/
// with the shared secret. The secret is checked before anything else, and
// the Worker's client address is believed only behind it.

const DOMAIN = 'openbots-artifacts.test';
const SECRET = 's'.repeat(40);

describe('artifact host mounts', () => {
  let t: TestApp;
  let url: URL;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: DOMAIN,
      OPENBOTS_ARTIFACT_EDGE_SECRET: SECRET,
    });
    const cookie = (await t.signUp('owner@example.com')).cookie!;
    const ownerId = await t.userId('owner@example.com');
    const workspaceId = await t.defaultOrganization();
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edge' }),
    });
    const botId = ((await res.json()) as { id: string }).id;
    // Public links are off until the owner turns them on.
    const on = await t.app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ publicArtifactsEnabled: true }),
    });
    expect(on.status).toBe(200);
    const owner = { id: ownerId, workspaceId };
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: 'Hello', kind: 'document', botId, content: 'hello edge' },
      { userId: ownerId },
    );
    const state = await t.inOrganization(() =>
      setVisibility(
        t.deps,
        owner,
        artifact.id,
        { visibility: 'public' },
        { type: 'user', id: ownerId },
      ),
    );
    url = new URL(state.url!);
  });
  afterAll(() => t.close());

  const edge = (headers: Record<string, string>, path = url.pathname) =>
    t.app.request(`/artifact-host${path}`, { headers });

  it('serves the Worker with the right secret, for the hostname it forwards', async () => {
    const res = await edge({ [EDGE_SECRET_HEADER]: SECRET, [EDGE_HOST_HEADER]: url.host });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello edge');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('is a plain 404 without the secret, or with a wrong one', async () => {
    for (const headers of [
      { [EDGE_HOST_HEADER]: url.host } as Record<string, string>,
      { [EDGE_SECRET_HEADER]: 'wrong', [EDGE_HOST_HEADER]: url.host },
      { [EDGE_SECRET_HEADER]: `${SECRET}x`, [EDGE_HOST_HEADER]: url.host },
    ]) {
      const res = await edge(headers);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('hello edge');
    }
  });

  it('refuses a forwarded hostname that is not one plain name under the domain', async () => {
    for (const host of ['evil.example', `x/y@${url.host}`, '', `${url.host}:443/x`]) {
      const res = await edge({ [EDGE_SECRET_HEADER]: SECRET, [EDGE_HOST_HEADER]: host });
      expect(res.status, host).toBe(404);
    }
  });

  it('answers by the Host header too, before any app route', async () => {
    const res = await t.app.request(url.pathname, { headers: { host: url.host } });
    expect(await res.text()).toBe('hello edge');
    // An app path on the artifact host is not the app's.
    const api = await t.app.request('/api/v1/capabilities', { headers: { host: url.host } });
    expect(api.status).toBe(404);
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
  });

  it("rate limits by the client address, the Worker's only behind the secret", async () => {
    const headers = {
      [EDGE_SECRET_HEADER]: SECRET,
      [EDGE_HOST_HEADER]: url.host,
      [EDGE_CLIENT_IP_HEADER]: '198.51.100.20',
    };
    for (let i = 0; i < HOST_RATE_LIMIT; i++) {
      expect((await edge(headers, '/not-an-artifact')).status).toBe(404);
    }
    expect((await edge(headers, '/not-an-artifact')).status).toBe(429);
    const other = { ...headers, [EDGE_CLIENT_IP_HEADER]: '198.51.100.21' };
    expect((await edge(other)).status).toBe(200);
  });

  it('gives a new Bot a public slug from its handle', async () => {
    const [bot] = await t.db.select().from(schema.bots).where(eq(schema.bots.name, 'Edge'));
    expect(bot!.publicSlug).toMatch(/^edge-[0-9a-f]{8}$/);
  });
});
