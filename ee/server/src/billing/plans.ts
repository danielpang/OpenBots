import type { Limits } from '@openbots/shared';

// Plans and limits on the managed service (plan 21.10), as data and pure
// functions: everything that enforces, bills or shows a plan reads it from
// here, so a pricing change is one edit, and every rule is tested without a
// database or Stripe.
//
// The unit is the computer hour: an hour a member's computer was awake for
// their work (the core's `computer_usage_intervals`). Usage is kept in exact
// seconds and rounded once, at the period's total, so rounding can only ever
// lose the customer less than one billing unit (a hundredth of an hour) a
// period, never charge them for one.

export type PlanId = 'pro' | 'team';

export interface PlanInfo {
  id: PlanId;
  name: string;
  /** Dollars per seat per month. */
  perSeatUsd: number;
  /** Seats billed at least, whoever is in the organization. */
  minimumSeats: number;
  summary: string;
}

export const PLANS: Record<PlanId, PlanInfo> = {
  pro: {
    id: 'pro',
    name: 'Pro',
    perSeatUsd: 20,
    minimumSeats: 1,
    summary: 'For one person: a personal account is an organization of one.',
  },
  team: {
    id: 'team',
    name: 'Team',
    perSeatUsd: 18,
    // A team is at least two people; one person is better off on Pro.
    minimumSeats: 2,
    summary: 'For a team that shares one pool of computer hours.',
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return value === 'pro' || value === 'team';
}

/** Computer hours each seat brings to the period's allowance. On Team the pool is shared. */
export const HOURS_PER_SEAT = 100;
/** The price of a computer hour past the allowance, when the organization allows overage. */
export const OVERAGE_USD_PER_HOUR = 0.2;
/** A trial lasts this long, with a card on file, before the paid plan begins. */
export const TRIAL_DAYS = 14;
/** And includes this many computer hours, for the whole organization; it stops there. */
export const TRIAL_HOURS = 20;

export const HOUR_SECONDS = 3600;
/**
 * The billing unit: a hundredth of a computer hour (36 seconds). Stripe is
 * told whole units, priced at a fifth of a cent each (`OVERAGE_USD_PER_HOUR`
 * over 100, a decimal unit amount of 0.2 cents), so an hour is exactly $0.20.
 */
export const UNIT_SECONDS = HOUR_SECONDS / 100;
/** Units in a cent: a unit is a fifth of a cent. */
export const UNITS_PER_CENT = 100 / (OVERAGE_USD_PER_HOUR * 100);

/**
 * The most computer time one Bot run may use, from its first computer call.
 *
 * A run is the model's loop: at most a few hundred steps, and a command
 * stops after 30 minutes, so a run that legitimately needs the computer for
 * more than three hours is rare, while a run stuck in a loop (a page that
 * never loads, a test that never passes) keeps the computer awake for as
 * long as it goes on. Three hours bounds that at $0.60 of overage, where a
 * night would be several dollars and a Routine firing all weekend far more.
 * Past it the run's next computer call is refused and the run finishes
 * without the computer; nothing already running is stopped. A coding session
 * is not a run and has no such cap: it ends when its agent does.
 */
export const MAX_RUN_COMPUTER_HOURS = 3;

/**
 * Limits a plan lowers below the operator's (`OPENBOTS_LIMITS_*`, plan
 * 21.6), applied through the core's `limitsCeiling`. None does today: the
 * plans differ in price and hours, not in how many Bots or Routines a member
 * may have. An organization with no paying plan keeps the operator's limits
 * too, since its work is stopped by the computer checks, not by its settings.
 */
export const PLAN_LIMITS: Record<PlanId, Partial<Limits>> = { pro: {}, team: {} };

/** The operator's limits, each lowered to the plan's where it sets one. */
export function limitsUnderPlan(
  standing: Standing,
  operator: Limits,
  planLimits: Record<PlanId, Partial<Limits>> = PLAN_LIMITS,
): Limits {
  if (standing.kind === 'none') return operator;
  const own = planLimits[standing.plan];
  const limits = { ...operator };
  for (const key of Object.keys(own) as (keyof Limits)[]) {
    limits[key] = Math.min(operator[key], own[key]!);
  }
  return limits;
}

// --- Seats and price -------------------------------------------------------------

/** The seats a plan bills for: active members, at least the plan's minimum. */
export function billableSeats(plan: PlanId, activeMembers: number): number {
  return Math.max(Math.floor(activeMembers), PLANS[plan].minimumSeats);
}

/** What an organization pays a month for its seats. */
export function monthlyTotalUsd(plan: PlanId, seats: number): number {
  return PLANS[plan].perSeatUsd * billableSeats(plan, seats);
}

/** A seat line as Stripe bills it: the plan's price times a quantity. */
export interface SeatLine {
  plan: PlanId;
  seats: number;
}

/** A seat line's monthly price in cents, so no float is compared. */
const lineCents = (line: SeatLine) => Math.round(PLANS[line.plan].perSeatUsd * 100) * line.seats;

/** The dearer seat price of two plans; the first when they cost the same. */
export function dearerPlan(a: PlanId, b: PlanId): PlanId {
  return PLANS[b].perSeatUsd > PLANS[a].perSeatUsd ? b : a;
}

/**
 * How a change of plan within a period is charged, the same rule as seats:
 * a change that lowers what the organization pays (or keeps it) is made
 * without proration, so nothing is credited and the lower price starts at
 * renewal; a change back up to what this period already paid for costs
 * nothing more; a change past that is charged prorated, after the line is
 * first put back, at no charge, to what was paid (`restore`), so Stripe
 * charges only the difference from it. `paid` is the dearest seat price
 * paid for this period with the most seats paid for.
 */
export function planChangeCharge(
  current: SeatLine,
  next: SeatLine,
  paid: SeatLine,
): { prorate: false } | { prorate: true; restore: SeatLine | null } {
  const now = lineCents(current);
  const then = lineCents(next);
  const covered = lineCents(paid);
  if (then <= now || then <= covered) return { prorate: false };
  return { prorate: true, restore: now < covered ? paid : null };
}

/**
 * The spending ceiling an organization starts with: its own monthly seat
 * total, so overage cannot more than double the bill without an owner or
 * admin saying so.
 */
export function startingCeilingUsd(plan: PlanId, seats: number): number {
  return monthlyTotalUsd(plan, seats);
}

// --- Where an organization stands --------------------------------------------------

/**
 * What an organization may do now: no plan, a trial, a paid plan, or a
 * subscription that no longer pays.
 */
export type Standing =
  | { kind: 'none' }
  | { kind: 'trial'; plan: PlanId }
  | { kind: 'paid'; plan: PlanId }
  | { kind: 'inactive'; plan: PlanId; status: string };

/**
 * Stripe statuses worth their plan. `past_due` is one: Stripe retries a
 * failed card for days, and cutting a paying organization off at the first
 * decline is worse than a short grace. A row with no status is a plan set by
 * hand, and entitles.
 */
const PAYING = new Set(['active', 'past_due']);

export function standingOf(plan: string | null | undefined, status: string | null): Standing {
  if (!isPlanId(plan)) return { kind: 'none' };
  if (status === 'trialing') return { kind: 'trial', plan };
  if (status === null || PAYING.has(status)) return { kind: 'paid', plan };
  // unpaid, canceled, incomplete, incomplete_expired, paused, and anything new.
  return { kind: 'inactive', plan, status };
}

/** The plan's name as people read it, a trial included. */
export function standingName(standing: Standing): string {
  switch (standing.kind) {
    case 'none':
      return 'No plan';
    case 'trial':
      return `${PLANS[standing.plan].name} trial`;
    default:
      return PLANS[standing.plan].name;
  }
}

/** What a period row records as its plan. */
export function periodPlan(standing: Standing): 'none' | 'trial' | PlanId {
  if (standing.kind === 'trial') return 'trial';
  if (standing.kind === 'paid') return standing.plan;
  return 'none';
}

// --- The allowance --------------------------------------------------------------

/**
 * The allowance fixed when a period begins: the seats then, times the
 * plan's hours; a trial's fixed hours whatever the seats; nothing without a
 * paying plan. Removing a seat later changes nothing until the next period.
 */
export function periodAllowanceSeconds(standing: Standing, seats: number): number {
  if (standing.kind === 'trial') return TRIAL_HOURS * HOUR_SECONDS;
  if (standing.kind !== 'paid') return 0;
  return billableSeats(standing.plan, seats) * HOURS_PER_SEAT * HOUR_SECONDS;
}

/**
 * The hours a seat added during a period brings: its share of the period
 * still to come, as Stripe prorates its price. Rounded down to the second.
 */
export function seatGrantSeconds(
  addedSeats: number,
  period: { start: Date; end: Date },
  at: Date,
): number {
  if (addedSeats <= 0) return 0;
  const total = period.end.getTime() - period.start.getTime();
  if (total <= 0) return 0;
  const left = Math.min(Math.max(period.end.getTime() - at.getTime(), 0), total);
  return Math.floor((addedSeats * HOURS_PER_SEAT * HOUR_SECONDS * left) / total);
}

// --- Overage -----------------------------------------------------------------------

export function overageSeconds(usedSeconds: number, allowanceSeconds: number): number {
  return Math.max(0, usedSeconds - allowanceSeconds);
}

/** Whole billing units of overage, rounded down: a part unit is never charged. */
export function overageUnits(usedSeconds: number, allowanceSeconds: number): number {
  return Math.floor(overageSeconds(usedSeconds, allowanceSeconds) / UNIT_SECONDS);
}

/** What units come to, in dollars, rounded down to the cent. */
export function unitsUsd(units: number): number {
  return Math.floor(units / UNITS_PER_CENT) / 100;
}

/** The most units a ceiling allows: its cents times five, so no float is compared. */
export function ceilingUnits(ceilingUsd: number): number {
  return Math.round(ceilingUsd * 100) * UNITS_PER_CENT;
}

/**
 * The overage units Stripe may be told about: the whole units used past the
 * allowance, less those absorbed, never more than the ceiling allows. Work
 * already running when the ceiling is reached finishes, and its time past
 * the ceiling is not billed: the ceiling is the most the organization agreed
 * to find on its invoice, and nothing may make it more. Absorbed units (time
 * used while overage was not allowed or past the ceiling) stay unbilled when
 * overage is allowed or the ceiling raised later.
 */
export function reportableUnits(
  usedSeconds: number,
  allowanceSeconds: number,
  ceilingUsd: number,
  absorbedUnits = 0,
): number {
  return Math.max(
    0,
    Math.min(overageUnits(usedSeconds, allowanceSeconds) - absorbedUnits, ceilingUnits(ceilingUsd)),
  );
}

/**
 * The overage units that will never be billed, given what Stripe was told
 * and what it may be told now: everything past both. Only ever grows.
 */
export function absorbedUnitsNow(
  usedSeconds: number,
  allowanceSeconds: number,
  reportable: number,
  reportedUnits: number,
): number {
  return Math.max(
    0,
    overageUnits(usedSeconds, allowanceSeconds) - Math.max(reportable, reportedUnits),
  );
}

// --- Policy ------------------------------------------------------------------------

/** What happens past the allowance: stop new work (the default), or keep going and pay. */
export type OveragePolicy = 'stop' | 'allow';

export const DEFAULT_OVERAGE_POLICY: OveragePolicy = 'stop';

/** An unrecognised stored value reads as stop: never guess "keep spending". */
export function overagePolicyOf(value: unknown): OveragePolicy {
  return value === 'allow' ? 'allow' : DEFAULT_OVERAGE_POLICY;
}

/** The ceiling in force: the one set, else the monthly seat total. */
export function ceilingOf(standing: Standing, seats: number, stored: number | null): number {
  if (stored !== null && Number.isFinite(stored) && stored >= 0) return stored;
  if (standing.kind === 'none') return 0;
  return startingCeilingUsd(standing.plan, seats);
}

/** A member's cap in seconds: the lower of the admin's cap and their own limit, or none. */
export function memberCapSeconds(capHours: number | null, personalHours: number | null) {
  const caps = [capHours, personalHours].filter((h): h is number => h !== null && h >= 0);
  return caps.length ? Math.round(Math.min(...caps) * HOUR_SECONDS) : null;
}

/** Whether a member may set this personal limit: never above the admin's cap. */
export function personalLimitRefusal(
  personalHours: number | null,
  capHours: number | null,
): string | null {
  if (personalHours === null || capHours === null || personalHours <= capHours) return null;
  return `Your limit cannot be above the ${formatHours(capHours)} computer hours an admin set for you.`;
}

// --- Whether work starts --------------------------------------------------------------

export interface AdmissionInput {
  standing: Standing;
  policy: OveragePolicy;
  /** The ceiling in force, in dollars. */
  ceilingUsd: number;
  allowanceSeconds: number;
  /** The organization's seconds this period, work in flight included. */
  usedSeconds: number;
  member: {
    usedSeconds: number;
    capHours: number | null;
    personalHours: number | null;
  };
  periodEnd: Date;
  /** Set for a run's later computer calls: only the per-run guard applies. */
  continuingSince?: Date;
  now: Date;
}

export type RefusalCode =
  | 'BILLING_REQUIRED'
  | 'BILLING_INACTIVE'
  | 'MEMBER_CAP_REACHED'
  | 'TRIAL_HOURS_REACHED'
  | 'PLAN_ALLOWANCE_REACHED'
  | 'SPENDING_CEILING_REACHED'
  | 'RUN_HOURS_REACHED';

export type Admission =
  | { admit: true; covered: 'plan' | 'overage' | 'run' }
  | { admit: false; code: RefusalCode; message: string };

const refuse = (code: RefusalCode, message: string): Admission => ({
  admit: false,
  code,
  message,
});

/**
 * Whether new computer work may start, and if not why, in plain words.
 *
 * The organization must have a plan that pays (or a trial). Then four
 * checks, in order: the member is under their cap (else refused); the
 * organization is within its allowance (starts, covered by the plan); the
 * organization allows overage (else refused: the plan stops at its
 * allowance, and a trial always does); the overage is under the spending
 * ceiling (starts, metered as overage; else refused). A refusal only stops
 * new work: the caller never asks about work already running, except a
 * run's own later calls, which meet only the per-run guard.
 */
export function admission(input: AdmissionInput): Admission {
  if (input.continuingSince) {
    const ranSeconds = (input.now.getTime() - input.continuingSince.getTime()) / 1000;
    if (ranSeconds < MAX_RUN_COMPUTER_HOURS * HOUR_SECONDS) return { admit: true, covered: 'run' };
    return refuse(
      'RUN_HOURS_REACHED',
      `This run has used the computer for ${MAX_RUN_COMPUTER_HOURS} hours, the most one run may. Work already running finishes; start a new run if the work should go on.`,
    );
  }
  const { standing } = input;
  if (standing.kind === 'none') {
    return refuse(
      'BILLING_REQUIRED',
      `This organization has no plan yet. An owner or admin can start a ${TRIAL_DAYS} day trial under Settings, Billing.`,
    );
  }
  if (standing.kind === 'inactive') {
    return refuse(
      'BILLING_INACTIVE',
      "This organization's subscription is unpaid or cancelled, so new computer work is paused. An owner or admin can update the payment details under Settings, Billing; nothing has been deleted.",
    );
  }

  // 1. The member's own cap.
  const { member } = input;
  const cap = memberCapSeconds(member.capHours, member.personalHours);
  if (cap !== null && member.usedSeconds >= cap) {
    const personal =
      member.personalHours !== null &&
      (member.capHours === null || member.personalHours <= member.capHours);
    return refuse(
      'MEMBER_CAP_REACHED',
      personal
        ? `You have used the ${formatHours(member.personalHours!)} computer hours you set as your own limit this period. You can raise it under Settings, Billing.`
        : `You have used the ${formatHours(member.capHours!)} computer hours an admin set for you this period. An owner or admin can raise your cap under Settings, Billing.`,
    );
  }

  // 2. Within the allowance: covered by the plan.
  if (input.usedSeconds < input.allowanceSeconds) return { admit: true, covered: 'plan' };

  const hours = formatHours(input.allowanceSeconds / HOUR_SECONDS);
  const resumes = `work starts again on ${formatDay(input.periodEnd)}`;
  // 3. Past it, only with overage allowed, and never on a trial.
  if (standing.kind === 'trial') {
    return refuse(
      'TRIAL_HOURS_REACHED',
      `This organization has used the ${TRIAL_HOURS} computer hours the trial includes. An owner or admin can start the paid plan now under Settings, Billing.`,
    );
  }
  if (input.policy !== 'allow') {
    return refuse(
      'PLAN_ALLOWANCE_REACHED',
      `This organization has used the ${hours} computer hours its plan includes this period. An owner or admin can allow overage at $${OVERAGE_USD_PER_HOUR.toFixed(2)} a computer hour under Settings, Billing, or ${resumes}.`,
    );
  }

  // 4. Overage under the ceiling: metered.
  const units = overageUnits(input.usedSeconds, input.allowanceSeconds);
  if (units < ceilingUnits(input.ceilingUsd)) return { admit: true, covered: 'overage' };
  return refuse(
    'SPENDING_CEILING_REACHED',
    `This organization's overage reached its spending limit of ${formatUsd(input.ceilingUsd)} for this period. An owner or admin can raise the limit under Settings, Billing, or ${resumes}.`,
  );
}

/** Which organization-wide wall stops new work now, if any (warnings, the Billing tab). */
export function stoppedBy(
  input: Omit<AdmissionInput, 'member' | 'continuingSince'>,
): 'trial' | 'allowance' | 'ceiling' | 'inactive' | 'none' | null {
  const decision = admission({
    ...input,
    member: { usedSeconds: 0, capHours: null, personalHours: null },
  });
  if (decision.admit) return null;
  switch (decision.code) {
    case 'TRIAL_HOURS_REACHED':
      return 'trial';
    case 'PLAN_ALLOWANCE_REACHED':
      return 'allowance';
    case 'SPENDING_CEILING_REACHED':
      return 'ceiling';
    case 'BILLING_INACTIVE':
      return 'inactive';
    case 'BILLING_REQUIRED':
      return 'none';
    default:
      return null;
  }
}

// --- Warnings ----------------------------------------------------------------------

export interface WarningState {
  notified75: boolean;
  notified90: boolean;
  notifiedStopped: boolean;
  overageNotifiedUsd: number;
}

export type Warning =
  | { kind: 'stopped'; wall: 'trial' | 'allowance' | 'ceiling' }
  | { kind: '90' }
  | { kind: '75' }
  | { kind: 'overage'; stepUsd: number };

/** Owners and admins hear about overage at every this many dollars. */
export const OVERAGE_WARNING_STEP_USD = 50;

/**
 * The warning due now, if any: when work stops, at 90% and 75% of the
 * allowance, and at each $50 of overage. Each is sent once a period (the
 * caller claims its flag before sending), and the most urgent wins.
 */
export function warningDue(
  state: WarningState,
  input: Omit<AdmissionInput, 'member' | 'continuingSince'>,
  reportedUnits: number,
): Warning | null {
  const wall = stoppedBy(input);
  if ((wall === 'trial' || wall === 'allowance' || wall === 'ceiling') && !state.notifiedStopped) {
    return { kind: 'stopped', wall };
  }
  const share = input.allowanceSeconds > 0 ? input.usedSeconds / input.allowanceSeconds : 0;
  if (share >= 0.9 && share < 1 && !state.notified90) return { kind: '90' };
  if (share >= 0.75 && share < 0.9 && !state.notified75) return { kind: '75' };
  if (input.policy === 'allow' && input.standing.kind === 'paid') {
    const spent = unitsUsd(reportedUnits);
    const step = Math.floor(spent / OVERAGE_WARNING_STEP_USD) * OVERAGE_WARNING_STEP_USD;
    if (step > state.overageNotifiedUsd) return { kind: 'overage', stepUsd: step };
  }
  return null;
}

// --- Words -------------------------------------------------------------------------

/** Hours as people read them: one decimal, none when whole. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatUsd(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** A day, such as "December 3", in UTC like the periods. */
export function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}
