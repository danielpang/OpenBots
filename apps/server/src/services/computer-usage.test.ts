import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import type { ComputerUsageEvent } from '../extensions.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { inEveryOrganization } from '../workers.js';
import { beginComputerUse, getComputer, startComputer, type ComputerRow } from './computer.js';
import {
  closeDanglingUsage,
  openUsageInterval,
  uncoveredSeconds,
  USAGE_DANGLING_MS,
} from './computer-usage.js';
import { settleComputerUses } from './computer-use.js';

// The awake-time ledger (plan 9.5) on the docker provider: a stretch of use
// opens an interval and closes it when the last use ends (no pause tail on
// Docker), the extension hears each close once, an interval a dead process
// left open is closed at its last heartbeat, and overlapping intervals count
// their shared seconds once.

describe('computer usage intervals', () => {
  let t: TestApp;
  let computer: TestComputer;
  let row: ComputerRow;
  const heard: ComputerUsageEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp(
      {},
      { extensions: { onComputerUsage: (event) => void heard.push(event) } },
    );
    computer = await useTestComputer(t.ownerDeps);
    await t.signUp('usage@example.com');
    const ownerId = await t.userId('usage@example.com');
    const owner = { id: ownerId, workspaceId: await t.defaultOrganization() };
    row = (await t.inOrganization(() => startComputer(t.deps, owner))).computer;
    expect(await t.inOrganization(() => getComputer(t.deps, owner))).toBeTruthy();
  });
  afterAll(async () => {
    await computer.close();
    await t.close();
  });

  const intervals = () =>
    t.db
      .select()
      .from(schema.computerUsageIntervals)
      .where(eq(schema.computerUsageIntervals.computerId, row.id));

  it('opens one interval for overlapping uses and closes it with the last, telling the extension once', async () => {
    heard.length = 0;
    const run = beginComputerUse(t.deps, row, 'run');
    const exec = beginComputerUse(t.deps, row, 'exec');
    await settleComputerUses();
    expect(await intervals()).toEqual([
      expect.objectContaining({ reason: 'run', provider: 'docker', endedAt: null }),
    ]);
    await exec.end();
    await settleComputerUses();
    expect((await intervals())[0]!.endedAt).toBeNull();
    await run.end();
    await run.end();
    await settleComputerUses();
    const [closed] = await intervals();
    expect(closed!.endedAt).not.toBeNull();
    expect(closed!.seconds).toBe(0);
    expect(heard).toEqual([
      {
        intervalId: closed!.id,
        workspaceId: row.workspaceId,
        ownerId: row.ownerId,
        computerId: row.id,
        provider: 'docker',
        startedAt: new Date(closed!.startedAt),
        endedAt: new Date(closed!.endedAt!),
        seconds: 0,
      },
    ]);
  });

  it('closes an interval a dead process left open, at its last heartbeat', async () => {
    heard.length = 0;
    const seen = new Date(Date.now() - USAGE_DANGLING_MS - 60_000);
    const started = new Date(seen.getTime() - 120_000);
    const id = await t.inOrganization(() =>
      openUsageInterval(
        t.deps,
        {
          workspaceId: row.workspaceId,
          ownerId: row.ownerId,
          computerId: row.id,
          provider: 'docker',
        },
        'run',
        started,
      ),
    );
    await t.db
      .update(schema.computerUsageIntervals)
      .set({ seenAt: seen })
      .where(eq(schema.computerUsageIntervals.id, id));
    // A fresh one is left alone.
    const fresh = beginComputerUse(t.deps, row, 'terminal', { touchMs: null });
    await settleComputerUses();
    expect(await inEveryOrganization(t.deps, () => closeDanglingUsage(t.deps))).toBe(1);
    const [dangling] = (await intervals()).filter((i) => i.id === id);
    expect(new Date(dangling!.endedAt!)).toEqual(seen);
    expect(dangling!.seconds).toBe(120);
    expect(heard).toHaveLength(1);
    expect(await inEveryOrganization(t.deps, () => closeDanglingUsage(t.deps))).toBe(0);
    await fresh.end();
    await settleComputerUses();
    expect(heard).toHaveLength(2);
  });

  it('a throwing extension does not undo the close', async () => {
    const throwing = await createTestApp(
      {},
      {
        extensions: {
          onComputerUsage: () => {
            throw new Error('billing is down');
          },
        },
      },
    );
    try {
      const docker = await useTestComputer(throwing.ownerDeps);
      await throwing.signUp('throws@example.com');
      const owner = {
        id: await throwing.userId('throws@example.com'),
        workspaceId: await throwing.defaultOrganization(),
      };
      const { computer: mine } = await throwing.inOrganization(() =>
        startComputer(throwing.deps, owner),
      );
      const warn = vi.spyOn(throwing.deps.logger, 'warn');
      const use = beginComputerUse(throwing.deps, mine, 'run');
      await settleComputerUses();
      await use.end();
      await settleComputerUses();
      const [closed] = await throwing.db
        .select()
        .from(schema.computerUsageIntervals)
        .where(eq(schema.computerUsageIntervals.computerId, mine.id));
      expect(closed!.endedAt).not.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.anything(), 'the computer usage extension failed');
      await docker.close();
    } finally {
      await throwing.close();
    }
  });

  it('counts the seconds intervals share once', () => {
    const at = (s: number) => new Date(s * 1000);
    expect(uncoveredSeconds(at(0), at(10), [])).toBe(10);
    expect(uncoveredSeconds(at(0), at(10), [{ startedAt: at(2), endedAt: at(5) }])).toBe(7);
    expect(
      uncoveredSeconds(at(0), at(10), [
        { startedAt: at(-5), endedAt: at(3) },
        { startedAt: at(2), endedAt: at(4) },
        { startedAt: at(8), endedAt: at(20) },
      ]),
    ).toBe(4);
    expect(uncoveredSeconds(at(0), at(10), [{ startedAt: at(-1), endedAt: at(11) }])).toBe(0);
  });
});
