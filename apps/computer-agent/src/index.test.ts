import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@openbot/computer-agent', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbot/computer-agent');
  });
});
