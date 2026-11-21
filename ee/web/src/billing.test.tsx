import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Billing } from './api.js';
import { BillingView, stoppedText } from './billing.js';

// Settings > Billing (plan 21.10), rendered to HTML: what an owner or admin
// sees and may change, what a member sees, and why work is stopped.

const ada = '00000000-0000-4000-8000-000000000001';
const bea = '00000000-0000-4000-8000-000000000002';

function billing(over: Partial<Billing> = {}): Billing {
  return {
    plan: { kind: 'paid', id: 'team', name: 'Team', status: 'active', trialEndsAt: null },
    seats: { active: 2, billed: 2, perSeatUsd: 18, monthlyTotalUsd: 36 },
    period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
    usage: { allowanceHours: 200, usedHours: 12.5, overageHours: 0, overageUsd: 0, stopped: null },
    overage: { policy: 'stop', usdPerHour: 0.2, ceilingUsd: 36, ceilingIsDefault: true },
    me: { userId: ada, name: 'Ada', usedHours: 10, capHours: null, personalHours: null },
    members: [
      { userId: ada, name: 'Ada', usedHours: 10, capHours: null, personalHours: null },
      { userId: bea, name: 'Bea', usedHours: 2.5, capHours: 20, personalHours: null },
    ],
    activity: [],
    catalog: [
      {
        id: 'pro',
        name: 'Pro',
        perSeatUsd: 20,
        minimumSeats: 1,
        hoursPerSeat: 100,
        summary: 'For one person.',
        monthlyTotalUsd: 40,
      },
      {
        id: 'team',
        name: 'Team',
        perSeatUsd: 18,
        minimumSeats: 2,
        hoursPerSeat: 100,
        summary: 'For a team.',
        monthlyTotalUsd: 36,
      },
    ],
    trial: { days: 14, hours: 20, available: false },
    canManage: true,
    stripe: true,
    enforced: true,
    ...over,
  };
}

function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  return renderToString(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');

describe('Settings > Billing', () => {
  it('shows an owner or admin the plan, the invoice, usage by member, and every control', () => {
    const html = render(<BillingView billing={billing()} />);
    const words = text(html);
    expect(words).toContain('Team. 2 seats at $18: $36 a month before overage.');
    expect(words).toContain('12.5 of 200 hours used');
    expect(words).toContain('Change to Pro');
    expect(words).toContain('Manage payment and invoices');
    expect(words).toContain('Spending limit on overage');
    expect(html).toContain('data-usage="00000000-0000-4000-8000-000000000002"');
    expect(html).toContain('aria-label="Cap for Bea (hours)"');
    expect(words).toContain('Your limit');
  });

  it('shows a member their own usage and limit, and no money controls', () => {
    const html = render(
      <BillingView
        billing={billing({
          canManage: false,
          me: { userId: bea, name: 'Bea', usedHours: 2.5, capHours: 20, personalHours: 5 },
          members: [],
        })}
      />,
    );
    const words = text(html);
    expect(words).toContain(
      'You have used 2.5 hours this period. An admin capped you at 20 hours.',
    );
    expect(html).toContain('max="20"');
    expect(words).not.toContain('Spending limit');
    expect(words).not.toContain('Change to');
    expect(words).not.toContain('Manage payment');
  });

  it('offers a new organization the trial', () => {
    const fresh = billing({
      plan: { kind: 'none', id: null, name: 'No plan', status: null, trialEndsAt: null },
      seats: { active: 1, billed: null, perSeatUsd: null, monthlyTotalUsd: null },
      trial: { days: 14, hours: 20, available: true },
      usage: { allowanceHours: 0, usedHours: 0, overageHours: 0, overageUsd: 0, stopped: 'none' },
    });
    const words = text(render(<BillingView billing={fresh} />));
    expect(words).toContain('Try Pro free for 14 days');
    expect(words).toContain('Try Team free for 14 days');
    expect(words).toContain('When the hours run out');
    expect(words).toContain('Start a trial below.');
  });

  it('says plainly why new work is stopped, and that running work was not', () => {
    const at = (stopped: Billing['usage']['stopped']) =>
      stoppedText(billing({ usage: { ...billing().usage, stopped } }));
    expect(at(null)).toBeNull();
    expect(at('allowance')).toContain('Allowing overage starts it again');
    expect(at('ceiling')).toContain('Raising the limit starts it again');
    expect(at('trial')).toContain('Start the paid plan');
    expect(at('inactive')).toContain('nothing has been deleted');
  });

  it('uses no dashes in its copy', () => {
    const all = [
      render(<BillingView billing={billing()} />),
      render(<BillingView billing={billing({ canManage: false })} />),
      ...(['none', 'inactive', 'trial', 'allowance', 'ceiling'] as const).map((stopped) =>
        stoppedText(billing({ usage: { ...billing().usage, stopped } }))!,
      ),
    ].join('');
    expect(all).not.toMatch(/[–—]/);
  });
});
