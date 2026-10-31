import { DEFAULT_LIMITS } from '@openbot/shared';
import { describe, expect, it } from 'vitest';
import { LIMIT_LABELS, limitLabel, settingsPatch } from './admin-settings.js';

describe('admin settings form', () => {
  it('labels every limit the server has', () => {
    expect(Object.keys(LIMIT_LABELS).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
  });

  it('says nothing about accounts in the Mac app local mode', () => {
    for (const key of Object.keys(LIMIT_LABELS) as (keyof typeof LIMIT_LABELS)[]) {
      expect(limitLabel(key, true)).not.toMatch(/account/i);
    }
    expect(limitLabel('botsPerAccount', true)).toBe('Bots');
    expect(limitLabel('botsPerAccount', false)).toBe('Bots per account');
  });

  it('sends the signup mode, retention and only the limits that changed', () => {
    const form = new FormData();
    form.set('signupMode', 'open');
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) form.set(key, String(value));
    form.set('botsPerAccount', '10');
    form.set('auditRetentionDays', '90');
    expect(settingsPatch(form, { ...DEFAULT_LIMITS })).toEqual({
      signupMode: 'open',
      limits: { botsPerAccount: 10 },
      auditRetentionDays: 90,
    });
  });
});
