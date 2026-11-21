import { describe, expect, it } from 'vitest';
import {
  PENDING_MS,
  appRedirect,
  readAppSignIn,
  savePendingAppSignIn,
  takePendingAppSignIn,
} from './app-sign-in.js';

const challenge = 'a'.repeat(43);
const state = 'state-from-the-app-1234';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

describe('app sign-in requests', () => {
  it('reads a whole, well formed request only', () => {
    expect(readAppSignIn({ platform: 'ios', challenge, state })).toEqual({
      platform: 'ios',
      challenge,
      state,
    });
    expect(readAppSignIn({ platform: 'desktop', challenge, state })?.platform).toBe('desktop');
    expect(readAppSignIn({ platform: 'android', challenge, state })).toBeNull();
    expect(readAppSignIn({ platform: 'ios', challenge: 'short', state })).toBeNull();
    expect(readAppSignIn({ platform: 'ios', challenge, state: 'x' })).toBeNull();
    expect(readAppSignIn({ platform: 'ios', challenge, state: 'has spaces in it ok' })).toBeNull();
    expect(readAppSignIn({})).toBeNull();
  });

  it('goes back to the app with the code, or the cancel, in the fragment', () => {
    expect(appRedirect(state, { code: 'abc_-1' })).toBe(
      `openbots://app-sign-in#code=abc_-1&state=${state}`,
    );
    expect(appRedirect(state, { error: 'cancelled' })).toBe(
      `openbots://app-sign-in#error=cancelled&state=${state}`,
    );
  });

  it('waits for the person to sign in, once, and not for ever', () => {
    const store = memoryStorage();
    const request = { platform: 'desktop' as const, challenge, state };
    savePendingAppSignIn(request, 1_000, store);
    expect(takePendingAppSignIn(2_000, store)).toEqual(request);
    expect(takePendingAppSignIn(3_000, store)).toBeNull();

    savePendingAppSignIn(request, 1_000, store);
    expect(takePendingAppSignIn(1_000 + PENDING_MS + 1, store)).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it('ignores what it cannot read', () => {
    const store = memoryStorage();
    store.setItem('openbots.app-sign-in', 'not json');
    expect(takePendingAppSignIn(0, store)).toBeNull();
    store.setItem('openbots.app-sign-in', JSON.stringify({ platform: 'ios', at: 0 }));
    expect(takePendingAppSignIn(1, store)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(() =>
      savePendingAppSignIn({ platform: 'ios', challenge, state }, 0, broken),
    ).not.toThrow();
    expect(takePendingAppSignIn(0, broken)).toBeNull();
  });
});
