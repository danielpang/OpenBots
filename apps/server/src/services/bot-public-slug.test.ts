import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import type * as Sharing from './artifact-sharing.js';

// A new Bot's public slug is random (plan 21.11), so it can collide with
// another Bot's, in any organization. That is not the handle being taken:
// the Bot is made with another slug. The slug's random part is scripted
// here so the collision is certain.

const slugs = vi.hoisted(() => ({ next: [] as string[] }));

vi.mock('./artifact-sharing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Sharing>();
  return {
    ...actual,
    botPublicSlug: (handle: string, orgSlug: string) =>
      actual.botPublicSlug(handle, orgSlug, slugs.next.shift()),
  };
});

describe("a new Bot's public slug", () => {
  let t: TestApp;
  let cookie: string;
  let other: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_ARTIFACT_DOMAIN: 'openbots-artifacts.test',
    });
    cookie = (await t.signUp('owner@example.com')).cookie!;
    other = (await t.signUp('other@example.com')).cookie!;
  });
  afterAll(() => t.close());

  const create = (body: Record<string, unknown>, as = cookie) =>
    t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: as, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const slugOf = async (id: string) =>
    (await t.db.select().from(schema.bots).where(eq(schema.bots.id, id)))[0]!.publicSlug;

  it('takes another slug when the random one is taken, and still reports a taken handle', async () => {
    slugs.next = ['0badc0de'];
    const first = await create({ name: 'Writer', handle: 'writer' });
    expect(first.status).toBe(201);
    const { id: firstId } = (await first.json()) as { id: string };
    expect(await slugOf(firstId)).toBe('writer-0badc0de');

    // Another member's Bot with the same handle, and the same random digits, twice.
    slugs.next = ['0badc0de', '0badc0de', '5eed5eed'];
    const second = await create({ name: 'Writer two', handle: 'writer' }, other);
    expect(second.status, await second.clone().text()).toBe(201);
    const { id: secondId } = (await second.json()) as { id: string };
    expect(await slugOf(secondId)).toBe('writer-5eed5eed');

    // The handle itself taken is still that.
    const again = await create({ name: 'Writer again', handle: 'writer' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('HANDLE_TAKEN');
  });
});
