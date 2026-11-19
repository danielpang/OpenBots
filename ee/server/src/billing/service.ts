import type {
  ComputerUsageEvent,
  ComputerWorkRefusal,
  ComputerWorkRequest,
  ExtensionContext,
} from '@openbots/server';
import type { AppDeps } from '@openbots/server/context';
import type { Limits } from '@openbots/shared';
import { schema, type Db } from '@openbots/server/db/client';
import { billingCustomerWorkspace, inWorkspace } from '@openbots/server/db/scope';
import { recordAudit, SYSTEM_ACTOR } from '@openbots/server/services/audit';
import { stopComputer } from '@openbots/server/services/computer';
import { and, eq, ne } from 'drizzle-orm';
import { errorText, sendBillingWarning, type EmailOptions } from '../email.js';
import { splitAcrossPeriods } from './periods.js';
import {
  absorbedUnitsNow,
  admission,
  billableSeats,
  ceilingOf,
  formatDay,
  formatHours,
  formatUsd,
  HOUR_SECONDS,
  OVERAGE_USD_PER_HOUR,
  periodAllowanceSeconds,
  periodPlan,
  limitsUnderPlan,
  reportableUnits,
  seatGrantSeconds,
  standingOf,
  TRIAL_HOURS,
  unitsUsd,
  warningDue,
  type Standing,
  type Warning,
} from './plans.js';
import {
  absorbUnits,
  activeMembers,
  anchorFor,
  billingContacts,
  billingFor,
  claimOverageStep,
  claimReport,
  claimWarning,
  ensurePeriod,
  inFlightSeconds,
  memberLimits,
  memberSeconds,
  periodRowAt,
  raiseAllowance,
  recordBillingEvent,
  recordShare,
  releaseReport,
  setBilling,
  type BillingRow,
  type PeriodRow,
} from './store.js';
import {
  planOfSubscription,
  periodStartOf,
  seatItemOf,
  type BillingPrices,
  type BillingStripe,
  type StripeEvent,
  type StripeSubscription,
} from './stripe.js';

// Billing on the managed service (plan 21.10): the core's extension points
// answered from the plan rules (plans.ts) and the billing tables (store.ts).
//
// - `admit`: whether new computer work may start (the four checks).
// - `recordUsage`: each closed usage interval into the ledger, then the
//   overage Stripe has not heard of yet, then any warning due.
// - `syncSeats`: the subscription's seat quantity follows active members.
// - `applyEvent`: a verified Stripe event, the only record of a purchase.
//
// Without Stripe (no STRIPE_SECRET_KEY) plans, limits and the ledger still
// work from the rows; nothing is reported and upgrading answers 503.

export type Context = ExtensionContext;

export interface BillingConfig {
  /** OPENBOTS_BILLING: `off` admits all work and records nothing (development only). */
  enforce: boolean;
  stripe: BillingStripe | null;
  webhookSecret: string | null;
  prices: BillingPrices;
  /** The Stripe meter's event name both plans' overage is reported on. */
  meterEventName: string;
  email: EmailOptions;
  /** The clock; tests move it. */
  now?: () => Date;
}

/** The meter's event name unless STRIPE_METER_EVENT names another. */
export const DEFAULT_METER_EVENT = 'openbots_computer_hours';

export type Billing = ReturnType<typeof createBilling>;

/** Where an organization stands this period, for the gate, the reporting and the Billing tab. */
export interface Standings {
  billing: BillingRow;
  standing: Standing;
  period: { start: Date; end: Date };
  row: PeriodRow;
  seats: number;
  ceilingUsd: number;
}

export function createBilling(config: BillingConfig) {
  const now = () => config.now?.() ?? new Date();

  /** Seats: Stripe's quantity when there is a subscription, else active members. */
  async function seatsOf(db: Db, billing: BillingRow) {
    return billing.billedSeats ?? (await activeMembers(db, billing.workspaceId));
  }

  /**
   * The period's row, its allowance brought in line with the plan now in
   * force: a period that began with no plan (or before payment recovered)
   * gets the plan's whole allowance, and a change between paid plans its
   * prorated difference. An allowance only ever grows within a period.
   */
  async function standings(db: Db, workspaceId: string, at = now()): Promise<Standings> {
    const billing = await billingFor(db, workspaceId);
    const standing = standingOf(billing.plan, billing.status);
    let { period, row } = await periodRowAt(db, billing, at);
    const plan = periodPlan(standing);
    if (row.plan !== plan && plan !== 'none') {
      const target = periodAllowanceSeconds(standing, row.paidSeats);
      const prorated =
        row.plan === 'none'
          ? { atLeastSeconds: target }
          : {
              addSeconds: Math.max(
                0,
                Math.floor(
                  ((target - row.allowanceSeconds) *
                    Math.max(0, period.end.getTime() - at.getTime())) /
                    (period.end.getTime() - period.start.getTime()),
                ),
              ),
            };
      // The target counts the plan's minimum seats (Team's two), and Stripe
      // bills them from now: they are paid for this period, so a later seat
      // sync does not grant their hours a second time.
      const paidSeats =
        'plan' in standing ? billableSeats(standing.plan, row.paidSeats) : undefined;
      await raiseAllowance(db, workspaceId, period.start, { ...prorated, plan, paidSeats });
      ({ period, row } = await periodRowAt(db, billing, at));
    }
    const seats = await seatsOf(db, billing);
    return {
      billing,
      standing,
      period,
      row,
      seats,
      ceilingUsd: ceilingOf(standing, seats, billing.ceilingUsd),
    };
  }

  // --- Whether work starts ---------------------------------------------------------

  async function admit(
    request: ComputerWorkRequest,
    ctx: Context,
  ): Promise<ComputerWorkRefusal | null> {
    if (!config.enforce) return null;
    if (request.continuingSince) {
      // The core stamped the run's start with the wall clock, so its length
      // is measured with the same one.
      const at = new Date();
      // Work under way meets only the per-run guard: no database, no
      // organization limits.
      const decision = admission({
        standing: { kind: 'none' },
        policy: 'stop',
        ceilingUsd: 0,
        allowanceSeconds: 0,
        usedSeconds: 0,
        member: { usedSeconds: 0, capHours: null, personalHours: null },
        periodEnd: at,
        continuingSince: request.continuingSince,
        now: at,
      });
      return decision.admit ? null : { code: decision.code, message: decision.message };
    }
    const at = now();
    const { db } = ctx;
    const s = await standings(db, request.workspaceId, at);
    const flying = await inFlightSeconds(db, request.workspaceId, at);
    let flyingAll = 0;
    for (const seconds of flying.values()) flyingAll += seconds;
    const limits = (await memberLimits(db, request.workspaceId)).get(request.ownerId);
    const decision = admission({
      standing: s.standing,
      policy: s.billing.overagePolicy,
      ceilingUsd: s.ceilingUsd,
      allowanceSeconds: s.row.allowanceSeconds,
      usedSeconds: s.row.usedSeconds + flyingAll,
      member: {
        usedSeconds:
          (await memberSeconds(db, request.workspaceId, s.period.start, request.ownerId)) +
          (flying.get(request.ownerId) ?? 0),
        capHours: limits?.capHours ?? null,
        personalHours: limits?.personalHours ?? null,
      },
      periodEnd: s.period.end,
      now: at,
    });
    return decision.admit ? null : { code: decision.code, message: decision.message };
  }

  // --- Usage, overage and warnings -------------------------------------------------------

  /**
   * One closed interval into the ledger, split at period boundaries, then
   * the reporting and the warnings. A close told twice adds nothing.
   */
  async function recordUsage(event: ComputerUsageEvent, ctx: Context): Promise<void> {
    if (!config.enforce) return;
    const { db } = ctx;
    const billing = await billingFor(db, event.workspaceId);
    const anchor = await anchorFor(db, billing);
    const [user] = await db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, event.ownerId));
    let fresh = false;
    for (const share of splitAcrossPeriods(anchor, event.startedAt, event.endedAt, event.seconds)) {
      const added = await recordShare(
        db,
        event.workspaceId,
        {
          intervalId: event.intervalId,
          userId: event.ownerId,
          // Kept with the usage, so the page still names someone who has left.
          userName: user?.name ?? null,
          periodStart: share.start,
          periodEnd: share.end,
          seconds: share.seconds,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
        },
        () => ensurePeriod(db, billing, share, () => activeMembers(db, event.workspaceId)),
      );
      fresh ||= added;
    }
    if (fresh) await reportAndWarn(ctx, event.workspaceId);
  }

  /**
   * Tells Stripe the overage it has not heard of yet, then warns owners and
   * admins if a warning is due. The current period only: a past period's
   * invoice is already drawn up, so a late share of it is not reported
   * (it undercharges, and reconciliation shows it).
   */
  async function reportAndWarn(ctx: Context, workspaceId: string): Promise<void> {
    const { db, logger } = ctx;
    const s = await standings(db, workspaceId);
    const units = reportableUnits(
      s.row.usedSeconds,
      s.row.allowanceSeconds,
      s.ceilingUsd,
      s.row.absorbedUnits,
    );
    let reported = s.row.reportedUnits;
    if (
      s.standing.kind === 'paid' &&
      s.billing.overagePolicy === 'allow' &&
      config.stripe &&
      config.prices.overage &&
      s.billing.stripeCustomerId &&
      units > reported
    ) {
      const claim = await claimReport(db, workspaceId, s.period.start, units);
      if (claim) {
        try {
          await config.stripe.billing.meterEvents.create({
            event_name: config.meterEventName,
            // The sequence is this claim's alone, so a retry of this call is
            // dropped by Stripe rather than counted twice.
            identifier: `${workspaceId}:${s.period.start.toISOString()}:${claim.seq}`,
            payload: {
              stripe_customer_id: s.billing.stripeCustomerId,
              value: String(units - claim.previous),
            },
            timestamp: Math.floor(now().getTime() / 1000),
          });
          reported = units;
        } catch (error) {
          await releaseReport(db, workspaceId, s.period.start, units, claim.previous);
          logger.warn({ err: errorText(error), workspaceId }, 'reporting overage to Stripe failed');
        }
      }
    }
    await absorb(db, s);
    const due = warningDue(
      s.row,
      {
        standing: s.standing,
        policy: s.billing.overagePolicy,
        ceilingUsd: s.ceilingUsd,
        allowanceSeconds: s.row.allowanceSeconds,
        usedSeconds: s.row.usedSeconds,
        periodEnd: s.period.end,
        now: now(),
      },
      reported,
    );
    if (due) await warn(ctx, s, due, reported);
  }

  /**
   * Marks the overage the settings in force may not bill (all of it while
   * overage is not allowed, the part past the ceiling when it is) as never
   * to be billed, so allowing overage or raising the ceiling later bills
   * only time used after the change. `inFlightSeconds` adds work still
   * running, for a change of settings while it runs.
   */
  async function absorb(db: Db, s: Standings, inFlightSeconds = 0): Promise<void> {
    const used = s.row.usedSeconds + inFlightSeconds;
    const allowed = s.standing.kind === 'paid' && s.billing.overagePolicy === 'allow';
    const reportable = allowed
      ? reportableUnits(used, s.row.allowanceSeconds, s.ceilingUsd, s.row.absorbedUnits)
      : 0;
    const units = absorbedUnitsNow(used, s.row.allowanceSeconds, reportable, s.row.reportedUnits);
    if (units > s.row.absorbedUnits) {
      await absorbUnits(db, s.billing.workspaceId, s.period.start, units);
    }
  }

  /** Before the overage policy or the ceiling changes: absorbs what the old settings would not bill. */
  async function absorbBeforeChange(db: Db, workspaceId: string): Promise<void> {
    if (!config.enforce) return;
    const at = now();
    const s = await standings(db, workspaceId, at);
    let flying = 0;
    for (const seconds of (await inFlightSeconds(db, workspaceId, at)).values()) flying += seconds;
    await absorb(db, s, flying);
  }

  async function warn(ctx: Context, s: Standings, warning: Warning, reportedUnits: number) {
    const { db, logger, config: server } = ctx;
    const workspaceId = s.billing.workspaceId;
    const claimed =
      warning.kind === 'overage'
        ? await claimOverageStep(db, workspaceId, s.period.start, warning.stepUsd)
        : await claimWarning(
            db,
            workspaceId,
            s.period.start,
            warning.kind === 'stopped'
              ? 'notifiedStopped'
              : warning.kind === '90'
                ? 'notified90'
                : 'notified75',
          );
    if (!claimed) return;
    const [org] = await db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    const words = warningWords(s, warning, reportedUnits);
    const link = `${server.publicUrl.replace(/\/$/, '')}/settings/billing`;
    for (const contact of await billingContacts(db, workspaceId)) {
      await sendBillingWarning(
        config.email,
        { to: contact.email, organization: org?.name ?? 'your organization', link, ...words },
        // The organization only: never the address or the words.
        (error) => logger.warn({ err: errorText(error), workspaceId }, 'billing warning failed'),
      );
    }
  }

  // --- Seats ------------------------------------------------------------------------

  const seatSyncs = new Map<string, Promise<unknown>>();

  /**
   * Makes the subscription bill the active members (at least the plan's
   * minimum). A seat beyond the most paid for this period is charged
   * prorated now and brings its prorated hours; fewer seats, or a seat back
   * within what was paid, change the quantity without proration, so the
   * change shows at renewal and nobody pays twice for one seat in a period.
   * One sync per organization at a time in this process; the paid-seats
   * mark moves with a conditional update, so two processes cannot both
   * grant one seat's hours.
   */
  function syncSeats(ctx: Context, workspaceId: string): Promise<void> {
    const previous = seatSyncs.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => syncSeatsNow(ctx, workspaceId))
      .finally(() => {
        if (seatSyncs.get(workspaceId) === next) seatSyncs.delete(workspaceId);
      });
    seatSyncs.set(workspaceId, next);
    return next;
  }

  async function syncSeatsNow(ctx: Context, workspaceId: string): Promise<void> {
    const { stripe } = config;
    if (!stripe || !config.enforce) return;
    const { db } = ctx;
    const s = await standings(db, workspaceId);
    if (!s.billing.stripeSubscriptionId) return;
    if (s.standing.kind !== 'paid' && s.standing.kind !== 'trial') return;
    const desired = billableSeats(s.standing.plan, await activeMembers(db, workspaceId));
    const billed = s.billing.billedSeats;
    if (billed === desired) return;
    const subscription = await stripe.subscriptions.retrieve(s.billing.stripeSubscriptionId);
    const item = seatItemOf(subscription, config.prices);
    if (!item) return;
    const paid = s.row.paidSeats;
    if (desired > paid) {
      // Claim the new seats' hours first: if Stripe then fails, the hours
      // were given without the charge, never the charge without the hours.
      const grant =
        s.standing.kind === 'paid' ? seatGrantSeconds(desired - paid, s.period, now()) : 0;
      const [moved] = await db
        .update(schema.billingPeriods)
        .set({
          paidSeats: desired,
          allowanceSeconds: s.row.allowanceSeconds + grant,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.billingPeriods.workspaceId, workspaceId),
            eq(schema.billingPeriods.periodStart, s.period.start),
            eq(schema.billingPeriods.paidSeats, paid),
            eq(schema.billingPeriods.allowanceSeconds, s.row.allowanceSeconds),
          ),
        )
        .returning({ paidSeats: schema.billingPeriods.paidSeats });
      if (!moved) return syncSeatsNow(ctx, workspaceId);
      if ((item.quantity ?? billed ?? paid) < paid) {
        // Back up to what was paid for this period at no charge, then the rest prorated.
        await stripe.subscriptions.update(subscription.id, {
          items: [{ id: item.id, quantity: paid }],
          proration_behavior: 'none',
        });
      }
      await stripe.subscriptions.update(subscription.id, {
        items: [{ id: item.id, quantity: desired }],
        proration_behavior: 'create_prorations',
      });
    } else {
      await stripe.subscriptions.update(subscription.id, {
        items: [{ id: item.id, quantity: desired }],
        proration_behavior: 'none',
      });
    }
    await setBilling(db, workspaceId, { billedSeats: desired });
  }

  // --- Stripe events -----------------------------------------------------------------

  /**
   * Folds a verified Stripe event in: the only place a purchase is recorded.
   * The organization is the one whose customer the event names (never an id
   * in the payload); the event's row and its change land in one
   * transaction, so a redelivery records nothing and changes nothing, and
   * every write carries the event's time, so an older event delivered late
   * loses to what is stored. When the subscription stops paying, new work is
   * refused and the organization's computers are stopped; data is kept.
   */
  async function applyEvent(
    deps: AppDeps,
    event: StripeEvent,
  ): Promise<'applied' | 'duplicate' | 'ignored'> {
    const object = event.data.object as Record<string, unknown>;
    const customer =
      typeof object.customer === 'string'
        ? object.customer
        : (object.customer as { id?: string } | null)?.id;
    if (!customer) return 'ignored';
    const workspaceId = await billingCustomerWorkspace(deps.db, customer);
    if (!workspaceId) return 'ignored';
    return inWorkspace(workspaceId, async () => {
      const before = await billingFor(deps.db, workspaceId);
      const wasActive = isActive(standingOf(before.plan, before.status));
      const outcome = await deps.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        const decision = eventChange(event, object, before, config.prices);
        const fresh = await recordBillingEvent(db, {
          workspaceId,
          stripeEventId: event.id,
          type: event.type,
          activity: decision.activity,
          fromPlan: decision.activity ? before.plan : null,
          toPlan: decision.activity ? (decision.change.plan ?? before.plan) : null,
          amountTotal: decision.amount ?? null,
          currency: decision.currency ?? null,
          subscriptionId: decision.change.stripeSubscriptionId ?? before.stripeSubscriptionId,
          invoiceId: decision.invoiceId ?? null,
          occurredAt: new Date(event.created * 1000),
        });
        if (!fresh) return 'duplicate' as const;
        if (Object.keys(decision.change).length) {
          await setBilling(db, workspaceId, decision.change, event.created);
        }
        return 'applied' as const;
      });
      if (outcome !== 'applied') return outcome;
      const after = await billingFor(deps.db, workspaceId);
      if (wasActive && !isActive(standingOf(after.plan, after.status))) {
        await stopComputers(deps, workspaceId);
      }
      return outcome;
    });
  }

  /** Every computer of the organization, stopped: new work is refused, nothing is deleted. */
  async function stopComputers(deps: AppDeps, workspaceId: string) {
    const rows = await deps.db
      .select()
      .from(schema.computers)
      .where(
        and(eq(schema.computers.workspaceId, workspaceId), ne(schema.computers.status, 'stopped')),
      );
    for (const row of rows) {
      try {
        await stopComputer(deps, row, SYSTEM_ACTOR);
      } catch (error) {
        deps.logger.warn(
          { err: errorText(error), computerId: row.id },
          'stopping a computer after the subscription lapsed failed',
        );
      }
    }
    await recordAudit(deps.db, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      action: 'billing.lapsed',
      targetType: 'organization',
      targetId: workspaceId,
      metadata: { computersStopped: rows.length },
    });
  }

  /**
   * The most an organization's limits may be (plan 21.6): the operator's,
   * lowered where its plan says so (`PLAN_LIMITS`).
   */
  async function limitsCeiling(workspaceId: string, operator: Limits, db: Db): Promise<Limits> {
    const billing = await billingFor(db, workspaceId);
    return limitsUnderPlan(standingOf(billing.plan, billing.status), operator);
  }

  return {
    config,
    now,
    standings,
    admit,
    recordUsage,
    reportAndWarn,
    absorbBeforeChange,
    syncSeats,
    applyEvent,
    stopComputers,
    limitsCeiling,
    seatsOf,
  };
}

const isActive = (standing: Standing) => standing.kind === 'paid' || standing.kind === 'trial';

interface EventDecision {
  change: Parameters<typeof setBilling>[2];
  activity: string | null;
  amount?: number | null;
  currency?: string | null;
  invoiceId?: string | null;
}

/** What an event changes, and how the history names it (null: a status-only event). */
export function eventChange(
  event: StripeEvent,
  object: Record<string, unknown>,
  before: BillingRow,
  prices: BillingPrices,
): EventDecision {
  switch (event.type) {
    case 'checkout.session.completed': {
      const subscription = typeof object.subscription === 'string' ? object.subscription : null;
      return { change: subscription ? { stripeSubscriptionId: subscription } : {}, activity: null };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const s = object as unknown as StripeSubscription;
      const deleted = event.type === 'customer.subscription.deleted';
      // A deleted event for a subscription this organization replaced since
      // says nothing about the one it has now.
      if (
        before.stripeSubscriptionId &&
        before.stripeSubscriptionId !== s.id &&
        (deleted || event.type === 'customer.subscription.updated')
      ) {
        return { change: {}, activity: null };
      }
      const plan = planOfSubscription(s, prices) ?? (before.plan === 'none' ? null : before.plan);
      const status = deleted ? 'canceled' : s.status;
      const seat = seatItemOf(s, prices);
      const change: EventDecision['change'] = {
        ...(plan ? { plan } : {}),
        status,
        stripeSubscriptionId: s.id,
        ...(typeof seat?.quantity === 'number' ? { billedSeats: seat.quantity } : {}),
        ...(periodStartOf(s, prices) ? { periodAnchor: periodStartOf(s, prices)! } : {}),
        trialEndsAt: s.trial_end ? new Date(s.trial_end * 1000) : null,
      };
      return { change, activity: subscriptionActivity(before, plan, status, event.type) };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const failed = event.type === 'invoice.payment_failed';
      return {
        change: {},
        activity: failed ? 'payment_failed' : 'payment',
        amount: Number((failed ? object.amount_due : object.amount_paid) ?? 0),
        currency: typeof object.currency === 'string' ? object.currency : null,
        invoiceId: typeof object.id === 'string' ? object.id : null,
      };
    }
    default:
      return { change: {}, activity: null };
  }
}

function subscriptionActivity(
  before: BillingRow,
  plan: string | null,
  status: string,
  type: string,
): string | null {
  const was = standingOf(before.plan, before.status);
  const now = standingOf(plan, status);
  if (!isActive(now) && isActive(was)) return 'cancelled';
  if (now.kind === 'trial' && was.kind !== 'trial') return 'trial_started';
  if (now.kind === 'paid' && (was.kind === 'none' || was.kind === 'trial')) return 'started';
  if (now.kind === 'paid' && was.kind === 'inactive') return 'started';
  if (isActive(now) && isActive(was) && 'plan' in was && 'plan' in now && was.plan !== now.plan) {
    return PLAN_RANK[now.plan] > PLAN_RANK[was.plan] ? 'upgraded' : 'downgraded';
  }
  return type === 'customer.subscription.created' ? 'started' : null;
}

/** A warning in plain words: what happened, what it means, what to do. */
export function warningWords(s: Standings, warning: Warning, reportedUnits: number) {
  const used = formatHours(s.row.usedSeconds / HOUR_SECONDS);
  const allowance = formatHours(s.row.allowanceSeconds / HOUR_SECONDS);
  const hours = `${used} of ${allowance} computer hours`;
  const resumes = formatDay(s.period.end);
  const allowing = s.billing.overagePolicy === 'allow';
  switch (warning.kind) {
    case '75':
      return {
        subject: 'Three quarters of your computer hours are used',
        paragraphs: [
          `Your organization has used ${hours} this period.`,
          'Nothing has changed yet. This is so the rest of the period is not a surprise.',
        ],
      };
    case '90':
      return {
        subject: 'More than 90% of your computer hours are used',
        paragraphs: [
          `Your organization has used ${hours} this period.`,
          allowing
            ? `Work goes on past the allowance at $${OVERAGE_USD_PER_HOUR.toFixed(2)} a computer hour, up to your spending limit of ${formatUsd(s.ceilingUsd)}.`
            : `New work stops when the allowance is used, until ${resumes}. An owner or admin can allow overage at $${OVERAGE_USD_PER_HOUR.toFixed(2)} a computer hour instead.`,
        ],
      };
    case 'stopped':
      return {
        subject: 'New computer work has stopped for this period',
        paragraphs: [
          warning.wall === 'ceiling'
            ? `Your organization's overage reached its spending limit of ${formatUsd(s.ceilingUsd)}.`
            : warning.wall === 'trial'
              ? `Your organization has used the ${TRIAL_HOURS} computer hours the trial includes.`
              : `Your organization has used ${hours} this period, and its settings stop new work at the allowance.`,
          'Work that was already running was not interrupted.',
          warning.wall === 'ceiling'
            ? `To start work again, raise the spending limit, or wait until ${resumes}.`
            : warning.wall === 'trial'
              ? 'To keep working, start the paid plan now.'
              : `To keep working, allow overage at $${OVERAGE_USD_PER_HOUR.toFixed(2)} a computer hour, or wait until ${resumes}.`,
        ],
      };
    case 'overage':
      return {
        subject: `$${warning.stepUsd} of overage so far this period`,
        paragraphs: [
          `Your organization has used ${hours} this period, and the overage comes to ${formatUsd(unitsUsd(reportedUnits))} so far.`,
          `Overage stops at your spending limit of ${formatUsd(s.ceilingUsd)}. An owner or admin can change the limit, or stop at the allowance instead.`,
        ],
      };
  }
}

/** Team is the plan above Pro. */
const PLAN_RANK = { pro: 1, team: 2 } as const;
