import { afterEach, describe, expect, it } from 'vitest';
import { fenceHere, forgetFences, isFenced } from './computer-fence.js';

// The fences a process knows (computer-fence.ts) are kept by time, never by
// number: no run of resets can push out a fence that still guards a machine.

describe('computer fences in a process', () => {
  afterEach(() => forgetFences());

  it('keeps every fence it learned, however many follow it', () => {
    const token = (i: number) => new TextEncoder().encode(`sealed-token-${i}`);
    fenceHere({ id: 'computer-0', agentToken: token(0) });
    for (let i = 1; i <= 20_000; i++) fenceHere({ id: `computer-${i}`, agentToken: token(i) });
    expect(isFenced({ agentToken: token(0) })).toBe(true);
    expect(isFenced({ agentToken: token(20_000) })).toBe(true);
    expect(isFenced({ agentToken: token(20_001) })).toBe(false);
  });
});
