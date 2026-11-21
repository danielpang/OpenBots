import { SPRITES_PROVISION_MAX_MS } from '@openbots/computer';
import { describe, expect, it } from 'vitest';
import { PROVISION_MAX_MS, RETIRED_RECHECK_MS } from './computer-timing.js';

// The time bounds are checked as the module loads (the server's start); these
// say which way each one must point, so a change that breaks one is named.

describe('computer time bounds', () => {
  it('a cancelled provisioning is over before an old machine is deleted for the last time', () => {
    // A status read, a make and a start, each within the provider's bound.
    expect(PROVISION_MAX_MS).toBeGreaterThanOrEqual(2 * SPRITES_PROVISION_MAX_MS);
    expect(RETIRED_RECHECK_MS).toBeGreaterThan(PROVISION_MAX_MS);
  });
});
