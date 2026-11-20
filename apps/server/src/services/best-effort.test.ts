import { describe, expect, it } from 'vitest';
import { bestEffort } from './best-effort.js';

describe('best effort', () => {
  it('goes on once its wait is over, and logs what fails later', async () => {
    const logged: unknown[] = [];
    let fail!: (error: Error) => void;
    const hanging = new Promise<void>((_, reject) => (fail = reject));
    const began = Date.now();
    await bestEffort(hanging, (error) => logged.push(error), 20);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(logged).toEqual([]);
    const down = new Error('redis down');
    fail(down);
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toEqual([down]);
  });

  it('never throws what it waited for', async () => {
    const logged: unknown[] = [];
    await expect(
      bestEffort(Promise.reject(new Error('no')), (error) => logged.push(error)),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });
});
