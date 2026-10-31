import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@openbot/server', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbot/server');
  });
});
