import { PROVISION_VERSION_FILE, spriteName } from '@openbots/computer';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestSprites, type TestSprites } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import { destroyComputer, sweepIdleComputers } from './computer.js';

// The server on the sprites provider (the hosted service), with a fake
// Sprites API: a start makes and provisions the Sprite, a paused Sprite still
// counts as running, the idle sweep marks the row stopped without deleting
// the Sprite, and a reset deletes it or clears its home.

describe('computers on Sprites', () => {
  let t: TestApp;
  let sprites: TestSprites;
  let cookie: string;
  let ownerId: string;

  beforeAll(async () => {
    t = await createTestApp();
    sprites = await useTestSprites(t.ownerDeps);
    cookie = (await t.signUp('sprite@example.com')).cookie!;
    ownerId = await t.userId('sprite@example.com');
  });
  afterAll(async () => {
    await sprites.close();
    await t.close();
  });

  const start = () =>
    t.app.request('/api/v1/computer/start', { method: 'POST', headers: { cookie } });
  const row = async () =>
    (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, ownerId)))[0]!;

  it('makes and provisions a Sprite on first start', async () => {
    const res = await start();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ provider: 'sprites', status: 'running' });
    const computer = await row();
    const name = spriteName(computer.id);
    expect(computer).toMatchObject({ provider: 'sprites', containerId: name, volumeName: null });
    expect(sprites.api.sprites.get(name)?.policy?.rules[0]).toEqual({ include: 'defaults' });
    expect(sprites.api.provisions).toHaveLength(1);
    // The token the server sealed is the one provisioned.
    expect(sprites.agent.token).toBe(sprites.api.provisions[0]!.token);
  });

  it('treats a paused Sprite as running: a start only marks it used', async () => {
    const name = (await row()).containerId!;
    sprites.api.sprites.get(name)!.status = 'cold';
    const res = await start();
    expect(res.status).toBe(200);
    expect(sprites.api.provisions).toHaveLength(1);
  });

  it('stops for idleness without deleting the Sprite, and wakes it at the next start', async () => {
    const computer = await row();
    await t.db
      .update(schema.computers)
      .set({ lastUsedAt: new Date(0) })
      .where(eq(schema.computers.id, computer.id));
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(1);
    expect((await row()).status).toBe('stopped');
    expect(sprites.api.sprites.has(computer.containerId!)).toBe(true);
    expect(sprites.api.calls.some((c) => c.op === 'delete')).toBe(false);

    const sprite = sprites.api.sprites.get(computer.containerId!)!;
    sprite.status = 'warm';
    // A new release's agent: the start provisions again.
    sprite.files.set(PROVISION_VERSION_FILE, new TextEncoder().encode('0'));
    const res = await start();
    expect(await res.json()).toMatchObject({ status: 'running' });
    expect(sprites.api.provisions).toHaveLength(2);
  });

  it('resets keeping the sign-ins by clearing the home in place', async () => {
    const computer = await row();
    const sprite = sprites.api.sprites.get(computer.containerId!)!;
    sprite.files.set('/home/bot/notes.md', new Uint8Array([1]));
    sprite.files.set('/var/lib/openbots/sign-in', new Uint8Array([1]));
    const after = await t.inOrganization(() =>
      destroyComputer(t.deps, computer, { signIns: false }),
    );
    expect(after).toMatchObject({ status: 'stopped', agentUrl: null, containerId: null });
    expect(sprite.files.has('/home/bot/notes.md')).toBe(false);
    expect(sprite.files.has('/var/lib/openbots/sign-in')).toBe(true);
    // The next start provisions the same Sprite with a new token.
    expect((await start()).status).toBe(200);
    expect(sprites.api.sprites.size).toBe(1);
    expect(sprites.api.provisions).toHaveLength(3);
    expect(sprites.api.provisions[2]!.token).not.toBe(sprites.api.provisions[1]!.token);
  });

  it('resets with the sign-ins by deleting the Sprite; the next start makes a new one', async () => {
    const computer = await row();
    sprites.api.sprites
      .get(computer.containerId!)!
      .files.set('/var/lib/openbots/x', new Uint8Array([1]));
    await t.inOrganization(() => destroyComputer(t.deps, computer, { signIns: true }));
    expect(sprites.api.sprites.size).toBe(0);
    expect((await start()).status).toBe(200);
    const fresh = sprites.api.sprites.get(computer.containerId!)!;
    expect(fresh.files.has('/var/lib/openbots/x')).toBe(false);
  });

  it('makes a Sprite for a remote row on a loopback agent instead of adopting it into Docker', async () => {
    const computer = await row();
    await t.db
      .update(schema.computers)
      .set({
        provider: 'remote',
        status: 'stopped',
        containerId: null,
        agentUrl: 'http://127.0.0.1:7070',
        agentToken: encryptSecret('standalone token', keyringFromConfig(t.deps.config)),
      })
      .where(eq(schema.computers.id, computer.id));
    expect((await start()).status).toBe(200);
    expect(await row()).toMatchObject({
      provider: 'sprites',
      containerId: spriteName(computer.id),
    });
  });
});
