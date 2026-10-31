import { describe, expect, it } from 'vitest';
import { ACTION_GROUPS, auditFilter, describeActor } from './audit-log.js';

describe('audit log page', () => {
  it('sends only the filters that are set, days as local start and end', () => {
    const form = new FormData();
    form.set('action', '');
    form.set('actorId', '  ');
    expect(auditFilter(form)).toEqual({});

    form.set('action', 'auth.');
    form.set('actorId', '00000000-0000-4000-8000-000000000001');
    form.set('from', '2026-10-01');
    form.set('to', '2026-10-02');
    expect(auditFilter(form)).toEqual({
      action: 'auth.',
      actorId: '00000000-0000-4000-8000-000000000001',
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 2, 23, 59, 59, 999).toISOString(),
    });
  });

  it('filters by the member changes admins make', () => {
    expect(ACTION_GROUPS).toContainEqual({ value: 'member.', label: 'Members' });
  });

  it('names the actor', () => {
    const id = '0123456789abcdef';
    expect(describeActor({ actorType: 'system', actorId: null, actorLabel: null })).toBe('OpenBot');
    expect(describeActor({ actorType: 'user', actorId: id, actorLabel: 'a@example.com' })).toBe(
      'a@example.com',
    );
    expect(describeActor({ actorType: 'bot', actorId: id, actorLabel: 'Ada' })).toBe('Bot Ada');
    expect(describeActor({ actorType: 'user', actorId: id, actorLabel: null })).toBe(
      'User 01234567',
    );
    expect(describeActor({ actorType: 'user', actorId: null, actorLabel: null })).toBe('Unknown');
  });
});
