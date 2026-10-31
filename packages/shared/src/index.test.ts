import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, packageName } from './index.js';

describe('@openbot/shared', () => {
  it('names the product', () => {
    expect(PRODUCT_NAME).toBe('OpenBot');
  });

  it('scopes package names', () => {
    expect(packageName('agent')).toBe('@openbot/agent');
  });
});
