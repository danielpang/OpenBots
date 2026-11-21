import { randomUUID } from 'node:crypto';
import { spriteName } from '@openbots/computer';
import { schema } from '@openbots/server/db/client';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  csvUsageSource,
  reconcile,
  spritesUsageSource,
  type ProviderUsageSource,
} from './reconcile.js';
import { billingApp, type BillingApp } from './testing.js';

// Reconciliation against a fake provider (plan 21.10): each organization's
// ledger hours against what the provider billed for its Sprites, the over
// metered first, Sprites nobody owns reported, small edges tolerated, and
// nothing changed.

const H = 3600;
const since = new Date('2026-11-01T00:00:00Z');
const until = new Date('2026-12-01T00:00:00Z');

describe('reconciliation', () => {
  let b: BillingApp;
  let a: { org: string; id: string };
  let c: { org: string; id: string };
  let computerA: string;
  let computerC: string;

  beforeAll(async () => {
    b = await billingApp();
    a = await b.founder('ann@example.com', 'Ann Co');
    c = await b.founder('cid@example.com', 'Cid Co');
    const computer = async (org: string, owner: string) =>
      (
        await b.t.db
          .insert(schema.computers)
          .values({ workspaceId: org, ownerId: owner, provider: 'sprites', status: 'stopped' })
          .returning({ id: schema.computers.id })
      )[0]!.id;
    computerA = await computer(a.org, a.id);
    computerC = await computer(c.org, c.id);
    const ledger = (org: string, user: string, seconds: number, endedAt: Date) =>
      b.t.db.insert(schema.billingUsage).values({
        workspaceId: org,
        intervalId: randomUUID(),
        periodStart: since,
        userId: user,
        seconds,
        startedAt: new Date(endedAt.getTime() - seconds * 1000),
        endedAt,
      });
    await ledger(a.org, a.id, 10 * H, new Date('2026-11-10T00:00:00Z'));
    await ledger(c.org, c.id, 5 * H, new Date('2026-11-11T00:00:00Z'));
    // Outside the window: not counted.
    await ledger(c.org, c.id, 50 * H, new Date('2026-12-02T00:00:00Z'));
  });
  afterAll(() => b.t.close());

  const fake = (rows: { name: string; awakeSeconds: number }[]): ProviderUsageSource => ({
    usageBetween: async () => rows,
  });

  it('reports an organization metered past what the provider billed, and changes nothing', async () => {
    const before = await b.t.db.select().from(schema.billingUsage);
    const found = await reconcile(
      b.t.deps.db,
      fake([
        { name: spriteName(computerA), awakeSeconds: 8 * H },
        { name: spriteName(computerC), awakeSeconds: 5 * H + 300 },
      ]),
      since,
      until,
    );
    expect(found).toEqual([
      { workspaceId: a.org, ledgerHours: 10, providerHours: 8, overMeteredHours: 2 },
    ]);
    expect(await b.t.db.select().from(schema.billingUsage)).toEqual(before);
  });

  it('reports usage the ledger missed, and Sprites no organization owns', async () => {
    const found = await reconcile(
      b.t.deps.db,
      fake([
        { name: spriteName(computerA), awakeSeconds: 10 * H },
        { name: spriteName(computerC), awakeSeconds: 9 * H },
        { name: 'ob-0000deadbeef', awakeSeconds: 3 * H },
      ]),
      since,
      until,
    );
    // Most over metered first: here nobody is, so the smaller shortfall leads.
    expect(found).toEqual([
      {
        workspaceId: null,
        sprites: ['ob-0000deadbeef'],
        ledgerHours: 0,
        providerHours: 3,
        overMeteredHours: -3,
      },
      { workspaceId: c.org, ledgerHours: 5, providerHours: 9, overMeteredHours: -4 },
    ]);
  });

  it('reads a CSV export, and refuses one it cannot read', async () => {
    const source = csvUsageSource(`name,awake_hours\n${spriteName(computerA)},10\n`);
    expect(await source.usageBetween(since, until)).toEqual([
      { name: spriteName(computerA), awakeSeconds: 10 * H },
    ]);
    expect(() => csvUsageSource('sprite,hours\nx,1')).toThrow(/name column/);
  });

  it('refuses a Sprites API answer of a shape it does not know, rather than reading zero', async () => {
    const answer = (body: unknown) =>
      spritesUsageSource({
        token: 'sprites-token',
        fetch: (async () => Response.json(body)) as typeof fetch,
      });
    await expect(answer({ data: [] }).usageBetween(since, until)).rejects.toThrow(/shape/);
    await expect(
      answer({ sprites: [{ name: 'ob-1', awake_seconds: 60 }] }).usageBetween(since, until),
    ).resolves.toEqual([{ name: 'ob-1', awakeSeconds: 60 }]);
  });
});

// A full reset on Sprites (computer-retire.ts) gives the member's computer a
// new machine key, so its next Sprite has a new name, and deletes the old
// Sprite through a `retired_computers` record under its old name. Until the
// record is `deleted` the old Sprite may still exist, and the window's usage
// before the reset was on it: both are the organization's. One deleted
// before the window should not be billed in it, so it is nobody's.
describe('reconciliation after a full reset', () => {
  let b: BillingApp;
  let d: { org: string; id: string };
  let computerD: string;
  let record: string;
  const machineKey = randomUUID();
  const oldKey = randomUUID();

  beforeAll(async () => {
    b = await billingApp();
    d = await b.founder('dee@example.com', 'Dee Co');
    computerD = (
      await b.t.db
        .insert(schema.computers)
        .values({
          workspaceId: d.org,
          ownerId: d.id,
          provider: 'sprites',
          status: 'stopped',
          machineKey,
        })
        .returning({ id: schema.computers.id })
    )[0]!.id;
    const retired = (providerRef: string, retiredAt: Date) =>
      b.t.db
        .insert(schema.retiredComputers)
        .values({
          workspaceId: d.org,
          ownerId: d.id,
          computerId: computerD,
          provider: 'sprites',
          providerRef,
          status: 'deleting',
          retiredAt,
        })
        .returning({ id: schema.retiredComputers.id });
    record = (await retired(spriteName(computerD), new Date('2026-11-10T00:00:00Z')))[0]!.id;
    // An earlier full reset, its Sprite deleted in October.
    const [earlier] = await retired(spriteName(oldKey), new Date('2026-10-05T00:00:00Z'));
    await b.t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted', deletedAt: new Date('2026-10-05T01:00:00Z') })
      .where(eq(schema.retiredComputers.id, earlier!.id));
    await b.t.db.insert(schema.billingUsage).values({
      workspaceId: d.org,
      intervalId: randomUUID(),
      periodStart: since,
      userId: d.id,
      seconds: 6 * H,
      startedAt: new Date('2026-11-09T00:00:00Z'),
      endedAt: new Date('2026-11-12T00:00:00Z'),
    });
  });
  afterAll(() => b.t.close());

  const usage = (extra: { name: string; awakeSeconds: number }[] = []) => ({
    usageBetween: async () => [
      { name: spriteName(computerD), awakeSeconds: 4 * H },
      { name: spriteName(machineKey), awakeSeconds: 2 * H },
      ...extra,
    ],
  });

  it("counts the member's new Sprite and the one being deleted as the organization's", async () => {
    expect(await reconcile(b.t.deps.db, usage(), since, until)).toEqual([]);
  });

  it('still counts the old Sprite once deleted in the window', async () => {
    await b.t.db
      .update(schema.retiredComputers)
      .set({ status: 'deleted', deletedAt: new Date('2026-11-10T00:50:00Z') })
      .where(eq(schema.retiredComputers.id, record));
    expect(await reconcile(b.t.deps.db, usage(), since, until)).toEqual([]);
  });

  it("reports a Sprite billed in the window but deleted before it as nobody's", async () => {
    const found = await reconcile(
      b.t.deps.db,
      usage([{ name: spriteName(oldKey), awakeSeconds: 1 * H }]),
      since,
      until,
    );
    expect(found).toEqual([
      {
        workspaceId: null,
        sprites: [spriteName(oldKey)],
        ledgerHours: 0,
        providerHours: 1,
        overMeteredHours: -1,
      },
    ]);
  });
});
