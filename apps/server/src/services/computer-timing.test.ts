import { SPRITES_PROVISION_MAX_MS } from '@openbots/computer';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_MARGIN_MS,
  PROVISION_MAX_MS,
  RESTORE_LEASE_MS,
  RESTORE_MAX_MS,
  RETIRED_RECHECK_MS,
} from './computer-timing.js';

// The time bounds are checked as the module loads (the server's start); these
// say which way each one must point, so a change that breaks one is named.

describe('computer time bounds', () => {
  it("a restore's lease outlasts the longest its calls take", () => {
    expect(RESTORE_LEASE_MS).toBeGreaterThan(RESTORE_MAX_MS + CLAIM_MARGIN_MS);
  });

  it('a cancelled provisioning is over before the retired machine is checked once more', () => {
    // A status read, a make and a start, each within the provider's bound.
    expect(PROVISION_MAX_MS).toBeGreaterThanOrEqual(2 * SPRITES_PROVISION_MAX_MS);
    expect(RETIRED_RECHECK_MS).toBeGreaterThan(PROVISION_MAX_MS);
  });
});
