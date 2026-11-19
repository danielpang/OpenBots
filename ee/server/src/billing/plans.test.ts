import { DEFAULT_LIMITS } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import {
  admission,
  billableSeats,
  ceilingOf,
  ceilingUnits,
  formatHours,
  HOUR_SECONDS,
  limitsUnderPlan,
  MAX_RUN_COMPUTER_HOURS,
  memberCapSeconds,
  monthlyTotalUsd,
  overagePolicyOf,
  overageUnits,
  periodAllowanceSeconds,
  personalLimitRefusal,
  reportableUnits,
  seatGrantSeconds,
  standingOf,
  startingCeilingUsd,
  stoppedBy,
  unitsUsd,
  warningDue,
  type AdmissionInput,
} from './plans.js';

// The plan rules as pure functions (plan 21.10): prices and seat minimums,
// where an organization stands from Stripe's status, the allowance with its
// mid-period seat rules, overage in whole units under the ceiling, every
// branch of the four checks, the per-run guard and the warnings.

const H = HOUR_SECONDS;
const periodEnd = new Date('2026-12-03T00:00:00Z');
const now = new Date('2026-11-20T12:00:00Z');

function input(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    standing: { kind: 'paid', plan: 'team' },
    policy: 'stop',
    ceilingUsd: 36,
    allowanceSeconds: 200 * H,
    usedSeconds: 0,
    member: { usedSeconds: 0, capHours: null, personalHours: null },
    periodEnd,
    now,
    ...over,
  };
}

describe('seats and price', () => {
  it('bills Pro per seat and Team at two seats at least', () => {
    expect(billableSeats('pro', 1)).toBe(1);
    expect(billableSeats('pro', 0)).toBe(1);
    expect(billableSeats('team', 1)).toBe(2);
    expect(billableSeats('team', 5)).toBe(5);
    expect(monthlyTotalUsd('pro', 1)).toBe(20);
    expect(monthlyTotalUsd('team', 1)).toBe(36);
    expect(monthlyTotalUsd('team', 5)).toBe(90);
  });

  it('starts the spending ceiling at the monthly seat total', () => {
    expect(startingCeilingUsd('pro', 1)).toBe(20);
    expect(startingCeilingUsd('team', 3)).toBe(54);
    expect(ceilingOf({ kind: 'paid', plan: 'team' }, 3, null)).toBe(54);
    expect(ceilingOf({ kind: 'paid', plan: 'team' }, 3, 100)).toBe(100);
    expect(ceilingOf({ kind: 'paid', plan: 'team' }, 3, 0)).toBe(0);
    expect(ceilingOf({ kind: 'none' }, 3, null)).toBe(0);
  });
});

describe('where an organization stands', () => {
  it('reads the plan from Stripe status, keeping it while Stripe retries a card', () => {
    expect(standingOf('none', null)).toEqual({ kind: 'none' });
    expect(standingOf('enterprise', 'active')).toEqual({ kind: 'none' });
    expect(standingOf('pro', 'trialing')).toEqual({ kind: 'trial', plan: 'pro' });
    expect(standingOf('team', 'active')).toEqual({ kind: 'paid', plan: 'team' });
    expect(standingOf('team', 'past_due')).toEqual({ kind: 'paid', plan: 'team' });
    expect(standingOf('pro', null)).toEqual({ kind: 'paid', plan: 'pro' });
    for (const status of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(standingOf('pro', status)).toEqual({ kind: 'inactive', plan: 'pro', status });
    }
  });

  it('reads an unknown overage policy as stop', () => {
    expect(overagePolicyOf('allow')).toBe('allow');
    expect(overagePolicyOf('stop')).toBe('stop');
    expect(overagePolicyOf('yes please')).toBe('stop');
    expect(overagePolicyOf(null)).toBe('stop');
  });
});

describe('the allowance', () => {
  it('is 100 hours a seat, shared, a trial’s 20 whatever the seats, and nothing unpaid', () => {
    expect(periodAllowanceSeconds({ kind: 'paid', plan: 'pro' }, 1)).toBe(100 * H);
    expect(periodAllowanceSeconds({ kind: 'paid', plan: 'team' }, 3)).toBe(300 * H);
    // Team bills two seats at least, so its pool is at least 200.
    expect(periodAllowanceSeconds({ kind: 'paid', plan: 'team' }, 1)).toBe(200 * H);
    expect(periodAllowanceSeconds({ kind: 'trial', plan: 'team' }, 9)).toBe(20 * H);
    expect(periodAllowanceSeconds({ kind: 'none' }, 4)).toBe(0);
    expect(periodAllowanceSeconds({ kind: 'inactive', plan: 'pro', status: 'unpaid' }, 1)).toBe(0);
  });

  it('grants a seat added mid-period its prorated share, as Stripe prorates its price', () => {
    const period = {
      start: new Date('2026-11-01T00:00:00Z'),
      end: new Date('2026-12-01T00:00:00Z'),
    };
    // Halfway: half of 100 hours.
    expect(seatGrantSeconds(1, period, new Date('2026-11-16T00:00:00Z'))).toBe(50 * H);
    expect(seatGrantSeconds(2, period, period.start)).toBe(200 * H);
    expect(seatGrantSeconds(1, period, period.end)).toBe(0);
    expect(seatGrantSeconds(1, period, new Date('2027-01-01T00:00:00Z'))).toBe(0);
    // Removing a seat grants nothing and takes nothing.
    expect(seatGrantSeconds(0, period, now)).toBe(0);
    expect(seatGrantSeconds(-1, period, now)).toBe(0);
    // Rounded down, never up.
    expect(seatGrantSeconds(1, period, new Date('2026-11-30T23:59:59.999Z'))).toBe(0);
  });
});

describe('overage', () => {
  it('counts whole hundredths of an hour past the allowance, rounded down', () => {
    expect(overageUnits(100 * H, 100 * H)).toBe(0);
    expect(overageUnits(100 * H + 35, 100 * H)).toBe(0);
    expect(overageUnits(100 * H + 36, 100 * H)).toBe(1);
    expect(overageUnits(101 * H, 100 * H)).toBe(100);
    expect(overageUnits(10, 100 * H)).toBe(0);
  });

  it('prices an hour at exactly $0.20 and never reports past the ceiling', () => {
    expect(unitsUsd(100)).toBe(0.2);
    expect(unitsUsd(4)).toBe(0); // 0.8 cents, rounded down for display
    expect(unitsUsd(5_000)).toBe(10);
    expect(ceilingUnits(20)).toBe(10_000); // $20 is 100 hours
    expect(ceilingUnits(0.01)).toBe(5);
    expect(reportableUnits(150 * H, 100 * H, 20)).toBe(5_000);
    // 200 hours over is $40; a $20 ceiling caps what Stripe hears at $20.
    expect(reportableUnits(300 * H, 100 * H, 20)).toBe(10_000);
    expect(reportableUnits(300 * H, 100 * H, 0)).toBe(0);
  });
});

describe('member caps and personal limits', () => {
  it('takes the lower of the admin cap and the member’s own limit', () => {
    expect(memberCapSeconds(null, null)).toBeNull();
    expect(memberCapSeconds(10, null)).toBe(10 * H);
    expect(memberCapSeconds(null, 4.5)).toBe(4.5 * H);
    expect(memberCapSeconds(10, 4)).toBe(4 * H);
    expect(memberCapSeconds(3, 4)).toBe(3 * H);
  });

  it('refuses a personal limit above the admin’s cap', () => {
    expect(personalLimitRefusal(5, 10)).toBeNull();
    expect(personalLimitRefusal(10, 10)).toBeNull();
    expect(personalLimitRefusal(null, 10)).toBeNull();
    expect(personalLimitRefusal(50, null)).toBeNull();
    expect(personalLimitRefusal(12, 10)).toBe(
      'Your limit cannot be above the 10 computer hours an admin set for you.',
    );
  });
});

describe('whether work starts: the four checks', () => {
  it('refuses with no plan, and with a subscription that no longer pays', () => {
    expect(admission(input({ standing: { kind: 'none' } }))).toMatchObject({
      admit: false,
      code: 'BILLING_REQUIRED',
    });
    const unpaid = admission(
      input({ standing: { kind: 'inactive', plan: 'team', status: 'unpaid' } }),
    );
    expect(unpaid).toMatchObject({ admit: false, code: 'BILLING_INACTIVE' });
    expect(!unpaid.admit && unpaid.message).toContain('nothing has been deleted');
  });

  it('1. refuses a member at their admin cap, naming who set it', () => {
    const capped = admission(
      input({ member: { usedSeconds: 25 * H, capHours: 25, personalHours: null } }),
    );
    expect(capped).toEqual({
      admit: false,
      code: 'MEMBER_CAP_REACHED',
      message:
        'You have used the 25 computer hours an admin set for you this period. An owner or admin can raise your cap under Settings, Billing.',
    });
    // Under it, the organization's checks decide.
    expect(
      admission(input({ member: { usedSeconds: 24 * H, capHours: 25, personalHours: null } })),
    ).toEqual({ admit: true, covered: 'plan' });
  });

  it('1. refuses a member at the limit they set themselves, which wins when lower', () => {
    const own = admission(
      input({ member: { usedSeconds: 10 * H, capHours: 25, personalHours: 10 } }),
    );
    expect(own).toMatchObject({ admit: false, code: 'MEMBER_CAP_REACHED' });
    expect(!own.admit && own.message).toContain('you set as your own limit');
  });

  it('1 before 2: a member at their cap is refused even with the allowance unused', () => {
    expect(
      admission(
        input({ usedSeconds: 0, member: { usedSeconds: 2 * H, capHours: 2, personalHours: null } }),
      ),
    ).toMatchObject({ admit: false, code: 'MEMBER_CAP_REACHED' });
  });

  it('2. starts work within the allowance, covered by the plan', () => {
    expect(admission(input({ usedSeconds: 200 * H - 1 }))).toEqual({
      admit: true,
      covered: 'plan',
    });
    expect(
      admission(input({ standing: { kind: 'trial', plan: 'pro' }, allowanceSeconds: 20 * H })),
    ).toEqual({ admit: true, covered: 'plan' });
  });

  it('3. stops at the allowance on the stop policy, saying how to go on', () => {
    const stopped = admission(input({ usedSeconds: 200 * H }));
    expect(stopped).toEqual({
      admit: false,
      code: 'PLAN_ALLOWANCE_REACHED',
      message:
        'This organization has used the 200 computer hours its plan includes this period. An owner or admin can allow overage at $0.20 a computer hour under Settings, Billing, or work starts again on December 3.',
    });
  });

  it('3. stops a trial at its 20 hours, whatever the policy', () => {
    for (const policy of ['stop', 'allow'] as const) {
      expect(
        admission(
          input({
            standing: { kind: 'trial', plan: 'team' },
            policy,
            allowanceSeconds: 20 * H,
            usedSeconds: 20 * H,
          }),
        ),
      ).toMatchObject({ admit: false, code: 'TRIAL_HOURS_REACHED' });
    }
  });

  it('4. meters overage under the ceiling, and refuses at it', () => {
    const allow = { policy: 'allow' as const, ceilingUsd: 36 };
    expect(admission(input({ ...allow, usedSeconds: 200 * H }))).toEqual({
      admit: true,
      covered: 'overage',
    });
    // $36 is 180 hours of overage.
    expect(admission(input({ ...allow, usedSeconds: 380 * H - 36 }))).toEqual({
      admit: true,
      covered: 'overage',
    });
    const ceiling = admission(input({ ...allow, usedSeconds: 380 * H }));
    expect(ceiling).toMatchObject({ admit: false, code: 'SPENDING_CEILING_REACHED' });
    expect(!ceiling.admit && ceiling.message).toBe(
      "This organization's overage reached its spending limit of $36 for this period. An owner or admin can raise the limit under Settings, Billing, or work starts again on December 3.",
    );
    // A ceiling of nothing allows no overage at all.
    expect(
      admission(input({ policy: 'allow', ceilingUsd: 0, usedSeconds: 200 * H })),
    ).toMatchObject({ admit: false, code: 'SPENDING_CEILING_REACHED' });
  });

  it('keeps every refusal’s first sentence short enough for a socket close', () => {
    const refusals = [
      input({ standing: { kind: 'none' } }),
      input({ standing: { kind: 'inactive', plan: 'pro', status: 'unpaid' } }),
      input({ member: { usedSeconds: 9e9, capHours: 1000, personalHours: null } }),
      input({ member: { usedSeconds: 9e9, capHours: null, personalHours: 1000 } }),
      input({ standing: { kind: 'trial', plan: 'pro' }, usedSeconds: 9e9 }),
      input({ usedSeconds: 9e9 }),
      input({ policy: 'allow', ceilingUsd: 99_999.99, usedSeconds: 9e12 }),
      input({ continuingSince: new Date(0) }),
    ].map(admission);
    for (const r of refusals) {
      expect(r.admit).toBe(false);
      if (r.admit) continue;
      const first = /^.*?[.!?](?=\s|$)/.exec(r.message)![0];
      expect(Buffer.byteLength(first), r.code).toBeLessThanOrEqual(123);
      expect(r.message).not.toMatch(/[–—]/);
    }
  });
});

describe('the per-run guard', () => {
  it('lets a run go on until its own computer time reaches the cap, whatever the organization', () => {
    const since = new Date(now.getTime() - (MAX_RUN_COMPUTER_HOURS * H - 1) * 1000);
    // Past every organization limit, work in progress continues.
    expect(
      admission(
        input({
          continuingSince: since,
          standing: { kind: 'inactive', plan: 'pro', status: 'canceled' },
          usedSeconds: 9e9,
        }),
      ),
    ).toEqual({ admit: true, covered: 'run' });
    const longer = new Date(now.getTime() - MAX_RUN_COMPUTER_HOURS * H * 1000);
    expect(admission(input({ continuingSince: longer }))).toMatchObject({
      admit: false,
      code: 'RUN_HOURS_REACHED',
    });
  });
});

describe('what stops the organization, and the warnings', () => {
  const org = (over: Partial<AdmissionInput> = {}) => {
    const { member: _m, continuingSince: _c, ...rest } = input(over);
    return rest;
  };
  const none = {
    notified75: false,
    notified90: false,
    notifiedStopped: false,
    overageNotifiedUsd: 0,
  };

  it('names the wall', () => {
    expect(stoppedBy(org())).toBeNull();
    expect(stoppedBy(org({ usedSeconds: 200 * H }))).toBe('allowance');
    expect(stoppedBy(org({ policy: 'allow', usedSeconds: 380 * H }))).toBe('ceiling');
    expect(
      stoppedBy(
        org({
          standing: { kind: 'trial', plan: 'pro' },
          allowanceSeconds: 20 * H,
          usedSeconds: 20 * H,
        }),
      ),
    ).toBe('trial');
  });

  it('warns at 75%, 90%, when work stops, and every $50 of overage, each once', () => {
    expect(warningDue(none, org({ usedSeconds: 149 * H }), 0)).toBeNull();
    expect(warningDue(none, org({ usedSeconds: 150 * H }), 0)).toEqual({ kind: '75' });
    expect(warningDue({ ...none, notified75: true }, org({ usedSeconds: 160 * H }), 0)).toBeNull();
    expect(warningDue(none, org({ usedSeconds: 180 * H }), 0)).toEqual({ kind: '90' });
    expect(warningDue(none, org({ usedSeconds: 200 * H }), 0)).toEqual({
      kind: 'stopped',
      wall: 'allowance',
    });
    expect(
      warningDue({ ...none, notifiedStopped: true }, org({ usedSeconds: 200 * H }), 0),
    ).toBeNull();
    // Paying for overage: no stop at the allowance, a warning per $50 reported.
    const paying = org({ policy: 'allow', ceilingUsd: 500, usedSeconds: 500 * H });
    // A unit is a fifth of a cent: 25,000 units are $50.
    expect(warningDue(none, paying, 24_999)).toBeNull();
    expect(warningDue(none, paying, 25_000)).toEqual({ kind: 'overage', stepUsd: 50 });
    expect(warningDue({ ...none, overageNotifiedUsd: 50 }, paying, 49_999)).toBeNull();
    expect(warningDue({ ...none, overageNotifiedUsd: 50 }, paying, 125_000)).toEqual({
      kind: 'overage',
      stepUsd: 250,
    });
  });
});

describe('limits under a plan', () => {
  it('keeps the operator’s limits, lowered where a plan sets its own', () => {
    expect(limitsUnderPlan({ kind: 'paid', plan: 'pro' }, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
    const lower = { pro: { botsPerAccount: 5, uploadBytes: 1e12 }, team: {} };
    expect(limitsUnderPlan({ kind: 'trial', plan: 'pro' }, DEFAULT_LIMITS, lower)).toEqual({
      ...DEFAULT_LIMITS,
      botsPerAccount: 5,
    });
    expect(limitsUnderPlan({ kind: 'none' }, DEFAULT_LIMITS, lower)).toEqual(DEFAULT_LIMITS);
  });
});

describe('words', () => {
  it('shows hours to one decimal', () => {
    expect(formatHours(20)).toBe('20');
    expect(formatHours(4.56)).toBe('4.6');
    expect(formatHours(0.04)).toBe('0');
  });
});
