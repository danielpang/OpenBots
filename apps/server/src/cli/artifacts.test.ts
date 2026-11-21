import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createArtifact } from '../services/artifacts.js';
import { setVisibility } from '../services/artifact-sharing.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { runArtifacts } from './artifacts.js';
import type { CliContext } from './context.js';

// `openbots artifacts takedown | restore <link>` (plan 21.11): the operator's
// switch for one public link, audited in its organization.

describe('the artifacts command', () => {
  let t: TestApp;
  let url: string;
  let id: string;
  let lines: string[];

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: 'openbots-artifacts.test',
    });
    const cookie = (await t.signUp('owner@example.com')).cookie!;
    const ownerId = await t.userId('owner@example.com');
    const workspaceId = await t.defaultOrganization();
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pages' }),
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
      { title: 'Sign in here', kind: 'document', botId, content: '<form>password</form>' },
      { userId: ownerId },
    );
    id = artifact.id;
    const state = await t.inOrganization(() =>
      setVisibility(
        t.deps,
        owner,
        id,
        { visibility: 'public' },
        {
          type: 'user',
          id: ownerId,
        },
      ),
    );
    url = state.url!;
  });
  afterAll(() => t.close());

  const ctx = (): CliContext => {
    lines = [];
    return {
      config: t.deps.config,
      db: t.deps.db,
      infra: t.deps.infra,
      write: (l) => lines.push(l),
    };
  };
  const host = () => {
    const u = new URL(url);
    return t.app.request(u.pathname, { headers: { host: u.host } });
  };

  it('takes a public link down at once and puts it back, audited', async () => {
    expect((await host()).status).toBe(200);
    expect(await runArtifacts(['takedown', url, 'phishing', 'report'], ctx())).toBe(0);
    expect(lines.join('\n')).toContain(`Took down the public link to Artifact ${id}`);
    expect(lines.join('\n')).not.toContain('Sign in here');
    expect((await host()).status).toBe(404);
    expect(await runArtifacts(['restore', url], ctx())).toBe(0);
    expect((await host()).status).toBe(200);
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.actorType, 'system')));
    expect(audit.map((a) => [a.action, a.metadata])).toEqual([
      ['artifact.taken_down', { visibility: 'public', reason: 'phishing report' }],
      ['artifact.restored', { visibility: 'public' }],
    ]);
  });

  it('refuses a link that is not an Artifact on this domain', async () => {
    expect(await runArtifacts(['takedown', 'https://evil.example/x'], ctx())).toBe(2);
    expect(await runArtifacts(['takedown', 'not a link'], ctx())).toBe(2);
    expect(await runArtifacts(['takedown'], ctx())).toBe(2);
    const missing = url.replace(id, '00000000-0000-4000-8000-000000000000');
    expect(await runArtifacts(['takedown', missing], ctx())).toBe(1);
  });
});
