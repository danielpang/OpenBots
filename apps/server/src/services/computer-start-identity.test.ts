import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coderWorld, gitArgs, type CoderWorld } from './__fixtures__/coders/setup.js';
import { getComputer, startComputer, startWorkSettled, stopComputer } from './computer.js';

// A start writes the owner's git identity into the computer's git config in
// the background, one `git config` at a time (computer.ts `afterStart`). A
// stop ends those writes: none reaches the agent of a computer that has
// stopped, since on the hosted service a call would wake a paused Sprite.

describe('the git identity a start writes', () => {
  let w: CoderWorld;

  beforeAll(async () => {
    w = await coderWorld('start-identity@example.com');
  });
  afterAll(() => w.close());

  const owner = () => ({ id: w.ownerId, workspaceId: w.workspaceId });

  it('ends between its writes when the computer stops, and calls its agent no more', async () => {
    const first = (await w.t.inOrganization(() => getComputer(w.t.deps, owner())))!;
    // The world's own start wrote it already, or is writing it: let that end.
    await startWorkSettled(first.id);
    await w.t.inOrganization(() => stopComputer(w.t.deps, first));

    // The first write of the next start is held until the computer has stopped.
    const writes: string[][] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const coder = w.coder.coder;
    w.coder.coder = async (launch, handlers) => {
      const args = gitArgs(launch.args);
      if (launch.command === 'git' && args[0] === 'config') {
        writes.push(args.slice(0, 3));
        if (writes.length === 1) await held;
      }
      return coder(launch, handlers);
    };
    try {
      const { computer } = await w.t.inOrganization(() => startComputer(w.t.deps, owner()));
      await w.until(() => expect(writes).toHaveLength(1));
      await w.t.inOrganization(() => stopComputer(w.t.deps, computer));
      release();
      await startWorkSettled(computer.id);
      expect(writes).toEqual([['config', '--global', 'user.name']]);
    } finally {
      w.coder.coder = coder;
    }
  });
});
