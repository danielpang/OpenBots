import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Db } from '@openbots/server/db/client';
import {
  DEFAULT_OVERAGE_POLICY,
  overagePolicyOf,
  periodAllowanceSeconds,
  periodPlan,
  standingOf,
  type OveragePolicy,
  type Standing,
} from './plans.js';
import { periodAt, type Period } from './periods.js';

// The billing tables (core schema, drizzle/0045), read and written in the
// organization's scope: every query names the organization, and row-level
// security holds it there underneath. Checks followed by writes are single
// statements or conditional updates, so two processes closing intervals at
// once cannot both claim the same overage report or warning.

export interface BillingRow {
  workspaceId: string;
  plan: string;
  status: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billedSeats: number | null;
  overagePolicy: OveragePolicy;
  ceilingUsd: number | null;
  periodAnchor: Date | null;
  trialEndsAt: Date | null;
  lastEventAt: number | null;
}

/** An organization with no row has no plan; absence is the default, not an error. */
export async function billingFor(db: Db, workspaceId: string): Promise<BillingRow> {
  const [row] = await db
    .select()
    .from(schema.organizationBilling)
    .where(eq(schema.organizationBilling.workspaceId, workspaceId));
  if (!row) {
    return {
      workspaceId,
      plan: 'none',
      status: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      billedSeats: null,
      overagePolicy: DEFAULT_OVERAGE_POLICY,
      ceilingUsd: null,
      periodAnchor: null,
      trialEndsAt: null,
      lastEventAt: null,
    };
  }
  return {
    workspaceId,
    plan: row.plan,
    status: row.status,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    billedSeats: row.billedSeats,
    overagePolicy: overagePolicyOf(row.overagePolicy),
    ceilingUsd: row.ceilingUsd === null ? null : Number(row.ceilingUsd),
    periodAnchor: row.periodAnchor,
    trialEndsAt: row.trialEndsAt,
    lastEventAt: row.lastEventAt === null ? null : Number(row.lastEventAt),
  };
}

export type BillingChange = Partial<
  Pick<
    BillingRow,
    | 'plan'
    | 'status'
    | 'stripeCustomerId'
    | 'stripeSubscriptionId'
    | 'billedSeats'
    | 'overagePolicy'
    | 'ceilingUsd'
    | 'periodAnchor'
    | 'trialEndsAt'
  >
>;

/**
 * Writes the organization's billing row: only the fields given (null clears
 * one). With `eventAt` (a Stripe event's `created`), the write is a no-op
 * when a newer event was folded in already, so a redelivered or late event
 * never undoes a later one. Answers whether it wrote.
 */
export async function setBilling(
  db: Db,
  workspaceId: string,
  change: BillingChange,
  eventAt?: number,
): Promise<boolean> {
  const values = Object.fromEntries(
    Object.entries(change).filter(([, value]) => value !== undefined),
  ) as BillingChange;
  const t = schema.organizationBilling;
  const rows = await db
    .insert(t)
    .values({ workspaceId, ...values, ...(eventAt === undefined ? {} : { lastEventAt: eventAt }) })
    .onConflictDoUpdate({
      target: t.workspaceId,
      set: {
        ...values,
        updatedAt: new Date(),
        ...(eventAt === undefined
          ? {}
          : { lastEventAt: sql`greatest(coalesce(${t.lastEventAt}, 0), ${eventAt})` }),
      },
      ...(eventAt === undefined
        ? {}
        : { setWhere: sql`${t.lastEventAt} is null or ${t.lastEventAt} <= ${eventAt}` }),
    })
    .returning({ workspaceId: t.workspaceId });
  return rows.length > 0;
}

/** Active members: the seats an organization holds. Suspended members are not counted. */
export async function activeMembers(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Owners and admins who are not suspended, with an address: who hears about money. */
export async function billingContacts(db: Db, workspaceId: string) {
  return db
    .select({ email: schema.users.email, name: schema.users.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        inArray(schema.workspaceMembers.role, ['owner', 'admin']),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    );
}

/** The anchor periods count from: Stripe's period start, else the organization's creation. */
export async function anchorFor(db: Db, billing: BillingRow): Promise<Date> {
  if (billing.periodAnchor) return billing.periodAnchor;
  const [row] = await db
    .select({ createdAt: schema.workspaces.createdAt })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, billing.workspaceId));
  return row?.createdAt ?? new Date(0);
}

export type PeriodRow = typeof schema.billingPeriods.$inferSelect;

/**
 * The period's row, made when first needed with its allowance fixed from
 * the plan and seats then: the seats Stripe bills, or the active members
 * without a subscription. Two makers at once: one inserts, both read it.
 */
export async function ensurePeriod(
  db: Db,
  billing: BillingRow,
  period: Period,
  seats: () => Promise<number>,
): Promise<PeriodRow> {
  const t = schema.billingPeriods;
  const where = and(eq(t.workspaceId, billing.workspaceId), eq(t.periodStart, period.start));
  const [found] = await db.select().from(t).where(where);
  if (found) return found;
  const standing = standingOf(billing.plan, billing.status);
  const base = billing.billedSeats ?? (await seats());
  await db
    .insert(t)
    .values({
      workspaceId: billing.workspaceId,
      periodStart: period.start,
      periodEnd: period.end,
      plan: periodPlan(standing),
      baseSeats: base,
      paidSeats: base,
      allowanceSeconds: periodAllowanceSeconds(standing, base),
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(t).where(where);
  return row!;
}

/** The period holding `at`, made if needed. */
export async function periodRowAt(
  db: Db,
  billing: BillingRow,
  at: Date,
): Promise<{ period: Period; row: PeriodRow }> {
  const period = periodAt(await anchorFor(db, billing), at);
  const row = await ensurePeriod(db, billing, period, () => activeMembers(db, billing.workspaceId));
  return { period, row };
}

/**
 * Raises a period's allowance when its plan changed or a seat was added:
 * the allowance only ever grows within a period. Conditional on the row
 * still holding what the caller read, so two raises at once both land.
 */
export async function raiseAllowance(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  change: { addSeconds?: number; paidSeats?: number; plan?: string; atLeastSeconds?: number },
): Promise<void> {
  const t = schema.billingPeriods;
  await db
    .update(t)
    .set({
      allowanceSeconds: sql`greatest(${t.allowanceSeconds} + ${change.addSeconds ?? 0}, ${change.atLeastSeconds ?? 0})`,
      ...(change.paidSeats === undefined
        ? {}
        : { paidSeats: sql`greatest(${t.paidSeats}, ${change.paidSeats})` }),
      ...(change.plan === undefined ? {} : { plan: change.plan }),
      updatedAt: new Date(),
    })
    .where(and(eq(t.workspaceId, workspaceId), eq(t.periodStart, periodStart)));
}

export interface UsageShare {
  intervalId: string;
  userId: string;
  userName: string | null;
  periodStart: Date;
  periodEnd: Date;
  seconds: number;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Adds one share of an interval to the ledger and its period's total, in
 * one transaction; false when that share is in the ledger already (the
 * close was told twice), so nothing is counted twice. The total moves with
 * `used = used + n`, which two closes at once cannot lose.
 */
export async function recordShare(
  db: Db,
  workspaceId: string,
  share: UsageShare,
  makePeriod: () => Promise<PeriodRow>,
): Promise<boolean> {
  await makePeriod();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.billingUsage)
      .values({
        workspaceId,
        intervalId: share.intervalId,
        periodStart: share.periodStart,
        userId: share.userId,
        userName: share.userName,
        seconds: share.seconds,
        startedAt: share.startedAt,
        endedAt: share.endedAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingUsage.id });
    if (!inserted.length) return false;
    const t = schema.billingPeriods;
    await tx
      .update(t)
      .set({ usedSeconds: sql`${t.usedSeconds} + ${share.seconds}`, updatedAt: new Date() })
      .where(and(eq(t.workspaceId, workspaceId), eq(t.periodStart, share.periodStart)));
    return true;
  });
}

/**
 * Claims the right to tell Stripe about overage up to `units`: one
 * conditional update, so of two closes at once only one moves the mark and
 * takes the next sequence number; the other sees nothing new to report.
 * Monotonic: the mark never moves down. Null when there is nothing new.
 */
export async function claimReport(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  units: number,
): Promise<{ previous: number; seq: number } | null> {
  const t = schema.billingPeriods;
  const rows = await db.execute<{ previous: number; seq: number }>(sql`
    with locked as (
      select reported_units from ${t}
      where workspace_id = ${workspaceId} and period_start = ${periodStart}
      for update
    )
    update ${t} p set reported_units = ${units}, report_seq = p.report_seq + 1, updated_at = now()
    from locked
    where p.workspace_id = ${workspaceId} and p.period_start = ${periodStart}
      and locked.reported_units < ${units}
    returning locked.reported_units as previous, p.report_seq as seq
  `);
  const row = rowsOf<{ previous: number | string; seq: number | string }>(rows)[0];
  return row ? { previous: Number(row.previous), seq: Number(row.seq) } : null;
}

/**
 * Gives back a claim Stripe never heard, unless a later claim moved past it:
 * then those units stay claimed and unreported, which undercharges, and
 * reconciliation finds it.
 */
export async function releaseReport(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  claimed: number,
  previous: number,
): Promise<void> {
  const t = schema.billingPeriods;
  await db
    .update(t)
    .set({ reportedUnits: previous })
    .where(
      and(
        eq(t.workspaceId, workspaceId),
        eq(t.periodStart, periodStart),
        eq(t.reportedUnits, claimed),
      ),
    );
}

export type WarningFlag = 'notified75' | 'notified90' | 'notifiedStopped';

/** Claims a warning for the period: true for exactly one caller, who then sends it. */
export async function claimWarning(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  flag: WarningFlag,
): Promise<boolean> {
  const t = schema.billingPeriods;
  const rows = await db
    .update(t)
    .set({ [flag]: true })
    .where(and(eq(t.workspaceId, workspaceId), eq(t.periodStart, periodStart), eq(t[flag], false)))
    .returning({ start: t.periodStart });
  return rows.length > 0;
}

/** Claims the overage warning for a $50 step past the last one sent. */
export async function claimOverageStep(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  stepUsd: number,
): Promise<boolean> {
  const t = schema.billingPeriods;
  const rows = await db
    .update(t)
    .set({ overageNotifiedUsd: stepUsd })
    .where(
      and(
        eq(t.workspaceId, workspaceId),
        eq(t.periodStart, periodStart),
        lt(t.overageNotifiedUsd, stepUsd),
      ),
    )
    .returning({ start: t.periodStart });
  return rows.length > 0;
}

/**
 * Seconds of computer use still open now, per member: intervals not closed
 * yet, up to their last heartbeat plus the time a dead process may go
 * unnoticed. Counted so the gate sees work in flight, not only work that
 * ended; never billed from (only closed intervals are).
 */
export async function inFlightSeconds(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<Map<string, number>> {
  const t = schema.computerUsageIntervals;
  const rows = await db
    .select({
      ownerId: t.ownerId,
      seconds: sql<number>`coalesce(sum(greatest(0, extract(epoch from (least(${now}::timestamptz, ${t.seenAt} + interval '3 minutes') - ${t.startedAt})))), 0)`,
    })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), isNull(t.endedAt)))
    .groupBy(t.ownerId);
  return new Map(rows.map((r) => [r.ownerId, Math.round(Number(r.seconds))]));
}

/** One member's ledger seconds in a period. */
export async function memberSeconds(
  db: Db,
  workspaceId: string,
  periodStart: Date,
  userId: string,
): Promise<number> {
  const t = schema.billingUsage;
  const [row] = await db
    .select({ seconds: sql<number>`coalesce(sum(${t.seconds}), 0)` })
    .from(t)
    .where(
      and(eq(t.workspaceId, workspaceId), eq(t.periodStart, periodStart), eq(t.userId, userId)),
    );
  return Number(row?.seconds ?? 0);
}

/**
 * Who used the period's hours: the live name first, so a rename shows,
 * and the name kept with the usage behind it, so someone who left still
 * has one.
 */
export async function usageByMember(db: Db, workspaceId: string, periodStart: Date) {
  const u = schema.billingUsage;
  const rows = await db
    .select({
      userId: u.userId,
      name: sql<string | null>`coalesce(max(${schema.users.name}), max(${u.userName}))`,
      seconds: sql<number>`sum(${u.seconds})`,
    })
    .from(u)
    .leftJoin(schema.users, eq(schema.users.id, u.userId))
    .where(and(eq(u.workspaceId, workspaceId), eq(u.periodStart, periodStart)))
    .groupBy(u.userId)
    .orderBy(desc(sql`sum(${u.seconds})`));
  return rows.map((r) => ({ userId: r.userId, name: r.name, seconds: Number(r.seconds) }));
}

/** Ledger seconds per organization with usage that ended inside a window: reconciliation. */
export async function ledgerSecondsBetween(
  db: Db,
  workspaceId: string,
  since: Date,
  until: Date,
): Promise<number> {
  const u = schema.billingUsage;
  const [row] = await db
    .select({ seconds: sql<number>`coalesce(sum(${u.seconds}), 0)` })
    .from(u)
    .where(and(eq(u.workspaceId, workspaceId), gt(u.endedAt, since), lt(u.endedAt, until)));
  return Number(row?.seconds ?? 0);
}

export interface MemberLimits {
  capHours: number | null;
  personalHours: number | null;
}

export async function memberLimits(
  db: Db,
  workspaceId: string,
): Promise<Map<string, MemberLimits>> {
  const t = schema.billingMemberLimits;
  const rows = await db.select().from(t).where(eq(t.workspaceId, workspaceId));
  return new Map(
    rows.map((r) => [
      r.userId,
      {
        capHours: r.capHours === null ? null : Number(r.capHours),
        personalHours: r.personalHours === null ? null : Number(r.personalHours),
      },
    ]),
  );
}

export async function setMemberLimit(
  db: Db,
  workspaceId: string,
  userId: string,
  change: Partial<MemberLimits>,
): Promise<void> {
  const t = schema.billingMemberLimits;
  await db
    .insert(t)
    .values({ workspaceId, userId, ...change })
    .onConflictDoUpdate({
      target: [t.workspaceId, t.userId],
      set: { ...change, updatedAt: new Date() },
    });
}

export interface BillingEventInput {
  workspaceId: string;
  stripeEventId: string;
  type: string;
  activity: string | null;
  fromPlan?: string | null;
  toPlan?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  occurredAt: Date;
}

/** Records one event; false when this id was recorded already, so the caller stops there. */
export async function recordBillingEvent(db: Db, input: BillingEventInput): Promise<boolean> {
  const rows = await db
    .insert(schema.billingEvents)
    .values({
      workspaceId: input.workspaceId,
      stripeEventId: input.stripeEventId,
      type: input.type,
      activity: input.activity,
      fromPlan: input.fromPlan ?? null,
      toPlan: input.toPlan ?? null,
      amountTotal: input.amountTotal ?? null,
      currency: input.currency ?? null,
      subscriptionId: input.subscriptionId ?? null,
      invoiceId: input.invoiceId ?? null,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: schema.billingEvents.id });
  return rows.length > 0;
}

/** Whether an event id is recorded already (idempotency for events that write no line). */
export async function eventSeen(db: Db, stripeEventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.billingEvents.id })
    .from(schema.billingEvents)
    .where(eq(schema.billingEvents.stripeEventId, stripeEventId));
  return !!row;
}

/** The subscription's history, newest first, for the Billing tab. */
export async function billingActivity(db: Db, workspaceId: string, limit = 20) {
  const t = schema.billingEvents;
  return db
    .select({
      activity: t.activity,
      fromPlan: t.fromPlan,
      toPlan: t.toPlan,
      amountTotal: t.amountTotal,
      currency: t.currency,
      occurredAt: t.occurredAt,
    })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), sql`${t.activity} is not null`))
    .orderBy(desc(t.occurredAt))
    .limit(limit);
}

/** The standing, from a row. */
export const standingFor = (billing: BillingRow): Standing =>
  standingOf(billing.plan, billing.status);

/** postgres.js answers an array of rows, PGlite `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}
