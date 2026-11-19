import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { workspaceId, workspaces } from './workspace.js';

// Billing on the managed service (plan 21.10). The core owns the schema; the
// managed build (ee/server billing) is the only reader and writer. Every
// table carries `workspace_id` and is held to its organization by row-level
// security (drizzle/0045). Every column added after the first is nullable or
// defaulted, so a row written now still loads later, and a value the code
// does not recognise reads as the safe one (no plan, stop at the allowance).

/**
 * Where an organization stands: its plan, its Stripe customer and
 * subscription, and the limits its owners and admins set. No row means no
 * plan. `last_event_at` is the newest Stripe event folded in, so an older
 * event delivered late changes nothing.
 */
export const organizationBilling = pgTable(
  'organization_billing',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `none`, `pro` or `team`: what was bought. A trial is a plan whose status is `trialing`. */
    plan: text('plan').notNull().default('none'),
    /** Stripe's subscription status (`trialing`, `active`, `past_due`, `unpaid`, `canceled`...). */
    status: text('status'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** The seat quantity Stripe bills, as Stripe last said or was told. */
    billedSeats: integer('billed_seats'),
    /** `stop` (the default) or `allow`: what happens past the allowance. */
    overagePolicy: text('overage_policy').notNull().default('stop'),
    /** The most overage may come to in a period, in dollars; null is the monthly seat total. */
    ceilingUsd: numeric('ceiling_usd', { precision: 12, scale: 2, mode: 'number' }),
    /** Where the organization's monthly periods are counted from: Stripe's period start. */
    periodAnchor: timestamptz('period_anchor'),
    trialEndsAt: timestamptz('trial_ends_at'),
    lastEventAt: bigint('last_event_at', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('organization_billing_customer').on(t.stripeCustomerId)],
);

/**
 * What happened to the subscription, one row per Stripe event (or per plan
 * change made in the product, under a synthesized id). The unique event id
 * is the webhook's idempotency key.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    stripeEventId: text('stripe_event_id').notNull().unique(),
    type: text('type').notNull(),
    /** `started`, `upgraded`, `downgraded`, `cancelled`, `renewed`, `payment_failed`, `trial_started`. */
    activity: text('activity'),
    fromPlan: text('from_plan'),
    toPlan: text('to_plan'),
    /** In the currency's smallest unit, as Stripe gives it. */
    amountTotal: bigint('amount_total', { mode: 'number' }),
    currency: text('currency'),
    subscriptionId: text('subscription_id'),
    invoiceId: text('invoice_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('billing_events_workspace').on(t.workspaceId, t.occurredAt)],
);

/**
 * One billing period of an organization: its allowance, fixed when the
 * period begins (seats then times the plan's hours, plus a prorated share
 * for each seat added during it), the seconds used, how much overage Stripe
 * has been told about (in hundredths of an hour), and which warnings went out.
 */
export const billingPeriods = pgTable(
  'billing_periods',
  {
    workspaceId: workspaceId(),
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    /** The plan in force when the period began: `trial`, `pro`, `team` or `none`. */
    plan: text('plan').notNull(),
    baseSeats: integer('base_seats').notNull(),
    /** The most seats paid for at once this period; a seat back within it costs nothing more. */
    paidSeats: integer('paid_seats').notNull(),
    allowanceSeconds: bigint('allowance_seconds', { mode: 'number' }).notNull(),
    usedSeconds: bigint('used_seconds', { mode: 'number' }).notNull().default(0),
    reportedUnits: integer('reported_units').notNull().default(0),
    reportSeq: integer('report_seq').notNull().default(0),
    /**
     * Overage units Stripe will never be told about: time used past the
     * allowance while overage was not allowed, or past the spending ceiling.
     * Raising the ceiling or allowing overage later does not bill it.
     */
    absorbedUnits: integer('absorbed_units').notNull().default(0),
    notified75: boolean('notified_75').notNull().default(false),
    notified90: boolean('notified_90').notNull().default(false),
    notifiedStopped: boolean('notified_stopped').notNull().default(false),
    /** The last $50 step of overage owners and admins were told about. */
    overageNotifiedUsd: integer('overage_notified_usd').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.periodStart] })],
);

/**
 * The usage ledger: each closed computer usage interval's seconds, split at
 * period boundaries, with who used them by name as it was then, so last
 * period's page still names someone who has since left. Keyed on the
 * interval and the period, so a repeated close records nothing twice. No
 * foreign keys: a billing record outlives the computer and the account.
 */
export const billingUsage = pgTable(
  'billing_usage',
  {
    id: id(),
    workspaceId: workspaceId(),
    intervalId: uuid('interval_id').notNull(),
    periodStart: timestamptz('period_start').notNull(),
    userId: uuid('user_id').notNull(),
    userName: text('user_name'),
    seconds: integer('seconds').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('billing_usage_interval_period').on(t.intervalId, t.periodStart),
    index('billing_usage_period').on(t.workspaceId, t.periodStart, t.userId),
    index('billing_usage_ended').on(t.workspaceId, t.endedAt),
  ],
);

/**
 * A member's computer hours a period: the cap an owner or admin set, and the
 * limit the member set for themselves, never above the cap. Null is none.
 */
export const billingMemberLimits = pgTable(
  'billing_member_limits',
  {
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capHours: numeric('cap_hours', { precision: 8, scale: 1, mode: 'number' }),
    personalHours: numeric('personal_hours', { precision: 8, scale: 1, mode: 'number' }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);
