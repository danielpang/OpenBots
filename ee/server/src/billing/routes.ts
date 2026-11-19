import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv, CurrentUser } from '@openbots/server/context';
import { schema } from '@openbots/server/db/client';
import { DomainError, notFound } from '@openbots/server/errors';
import { requireAdmin, requireManaged, requireUser } from '@openbots/server/middleware/auth';
import {
  adminProblems,
  authenticated,
  authProblems,
  createRouter,
  problemResponse,
} from '@openbots/server/openapi';
import { recordAudit, userActor } from '@openbots/server/services/audit';
import { isOrgAdmin } from '@openbots/server/workspace';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { errorText } from '../email.js';
import {
  billableSeats,
  formatHours,
  HOUR_SECONDS,
  HOURS_PER_SEAT,
  isPlanId,
  monthlyTotalUsd,
  OVERAGE_USD_PER_HOUR,
  overageSeconds,
  personalLimitRefusal,
  PLAN_IDS,
  PLANS,
  reportableUnits,
  standingName,
  stoppedBy,
  TRIAL_DAYS,
  TRIAL_HOURS,
  unitsUsd,
} from './plans.js';
import type { Billing } from './service.js';
import {
  activeMembers,
  billingActivity,
  billingFor,
  memberLimits,
  recordBillingEvent,
  setBilling,
  setMemberLimit,
  usageByMember,
} from './store.js';
import { overageItemOf, seatItemOf, verifyWebhook } from './stripe.js';

// The managed service's billing routes (plan 21.10), under /api/v1:
//
// - GET /billing: the plan, seats and their total, this period's allowance,
//   use, overage and limits, and who used what (owners and admins see every
//   member, a member their own line).
// - PATCH /billing/settings: overage policy and spending ceiling (owners, admins).
// - PUT /billing/members/{id}/cap: a member's computer hours cap (owners, admins).
// - PUT /billing/limit: the caller's own limit, never above their cap.
// - POST /billing/checkout: a trial or a plan through Stripe Checkout, or a
//   change to the subscription there is (owners, admins).
// - POST /billing/portal: Stripe's portal for cards and invoices (owners, admins).
// - POST /billing/webhook: Stripe's events, signature verified on the raw body.
//
// Every change to a money setting is audited. Without Stripe the settings
// still work, and checkout and the portal answer 503.

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});
const iso = (date: Date | null) => (date ? date.toISOString() : null);
const hours = (seconds: number) => Number(formatHours(seconds / HOUR_SECONDS));

const PlanIdSchema = z.enum(['pro', 'team']).openapi('BillingPlanId');
const PolicySchema = z.enum(['stop', 'allow']).openapi('OveragePolicy');
const HoursSchema = z.number().min(0).max(100_000).multipleOf(0.1);

const MemberUsageSchema = z
  .object({
    userId: z.uuid(),
    name: z.string().nullable(),
    usedHours: z.number(),
    capHours: z.number().nullable().openapi({ description: 'Set by an owner or admin' }),
    personalHours: z.number().nullable().openapi({ description: 'Set by the member' }),
  })
  .openapi('MemberUsage');

const BillingSchema = z
  .object({
    plan: z.object({
      kind: z.enum(['none', 'trial', 'paid', 'inactive']),
      id: PlanIdSchema.nullable(),
      name: z.string(),
      status: z.string().nullable().openapi({ description: "Stripe's subscription status" }),
      trialEndsAt: z.iso.datetime().nullable(),
    }),
    seats: z.object({
      active: z.number().int(),
      billed: z.number().int().nullable(),
      perSeatUsd: z.number().nullable(),
      monthlyTotalUsd: z
        .number()
        .nullable()
        .openapi({ description: 'The next invoice, before overage' }),
    }),
    period: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
    usage: z.object({
      allowanceHours: z.number(),
      usedHours: z.number(),
      overageHours: z.number(),
      overageUsd: z.number().openapi({ description: 'What the overage comes to so far' }),
      stopped: z
        .enum(['trial', 'allowance', 'ceiling', 'inactive', 'none'])
        .nullable()
        .openapi({ description: 'What stops new work now, if anything' }),
    }),
    overage: z.object({
      policy: PolicySchema,
      usdPerHour: z.number(),
      ceilingUsd: z.number(),
      ceilingIsDefault: z.boolean().openapi({ description: 'The monthly seat total' }),
    }),
    me: MemberUsageSchema,
    members: z
      .array(MemberUsageSchema)
      .openapi({ description: 'Every member for owners and admins; the caller alone otherwise' }),
    activity: z.array(
      z.object({
        activity: z.string(),
        fromPlan: z.string().nullable(),
        toPlan: z.string().nullable(),
        amountTotal: z.number().nullable(),
        currency: z.string().nullable(),
        occurredAt: z.iso.datetime(),
      }),
    ),
    catalog: z.array(
      z.object({
        id: PlanIdSchema,
        name: z.string(),
        perSeatUsd: z.number(),
        minimumSeats: z.number().int(),
        hoursPerSeat: z.number(),
        summary: z.string(),
        monthlyTotalUsd: z.number().openapi({ description: 'For the active members now' }),
      }),
    ),
    trial: z.object({ days: z.number().int(), hours: z.number(), available: z.boolean() }),
    canManage: z.boolean(),
    stripe: z.boolean().openapi({ description: 'Checkout and the portal work on this server' }),
    enforced: z.boolean().openapi({ description: 'False only on a development server' }),
  })
  .openapi('Billing');

export function billingRoutes(billing: Billing) {
  const { config } = billing;

  async function summary(c: Context<AppEnv>) {
    const { db } = c.var.deps;
    const user: CurrentUser = c.var.user;
    const ws = user.workspaceId;
    const s = await billing.standings(db, ws);
    const active = await activeMembers(db, ws);
    const limits = await memberLimits(db, ws);
    const byMember = await usageByMember(db, ws, s.period.start);
    const admin = isOrgAdmin(user.role);
    const members = admin
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.workspaceMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
          .where(eq(schema.workspaceMembers.workspaceId, ws))
      : [{ id: user.id, name: user.name }];
    const lineFor = (id: string, name: string | null) => ({
      userId: id,
      name,
      usedHours: hours(byMember.find((m) => m.userId === id)?.seconds ?? 0),
      capHours: limits.get(id)?.capHours ?? null,
      personalHours: limits.get(id)?.personalHours ?? null,
    });
    const lines = members.map((m) => lineFor(m.id, m.name));
    // People who used hours this period and have since left still count.
    if (admin) {
      for (const m of byMember) {
        if (!lines.some((l) => l.userId === m.userId)) lines.push(lineFor(m.userId, m.name));
      }
    }
    const plan = 'plan' in s.standing ? s.standing.plan : null;
    const units = reportableUnits(s.row.usedSeconds, s.row.allowanceSeconds, s.ceilingUsd);
    const activity = admin ? await billingActivity(db, ws) : [];
    return {
      plan: {
        kind: s.standing.kind,
        id: plan,
        name: standingName(s.standing),
        status: s.billing.status,
        trialEndsAt: iso(s.billing.trialEndsAt),
      },
      seats: {
        active,
        billed: s.billing.billedSeats,
        perSeatUsd: plan ? PLANS[plan].perSeatUsd : null,
        monthlyTotalUsd: plan ? monthlyTotalUsd(plan, s.seats) : null,
      },
      period: { start: s.period.start.toISOString(), end: s.period.end.toISOString() },
      usage: {
        allowanceHours: hours(s.row.allowanceSeconds),
        usedHours: hours(s.row.usedSeconds),
        overageHours: hours(overageSeconds(s.row.usedSeconds, s.row.allowanceSeconds)),
        overageUsd: s.billing.overagePolicy === 'allow' ? unitsUsd(units) : 0,
        stopped: config.enforce
          ? stoppedBy({
              standing: s.standing,
              policy: s.billing.overagePolicy,
              ceilingUsd: s.ceilingUsd,
              allowanceSeconds: s.row.allowanceSeconds,
              usedSeconds: s.row.usedSeconds,
              periodEnd: s.period.end,
              now: billing.now(),
            })
          : null,
      },
      overage: {
        policy: s.billing.overagePolicy,
        usdPerHour: OVERAGE_USD_PER_HOUR,
        ceilingUsd: s.ceilingUsd,
        ceilingIsDefault: s.billing.ceilingUsd === null,
      },
      me: lines.find((l) => l.userId === user.id) ?? lineFor(user.id, user.name),
      members: lines,
      activity: activity.map((a) => ({
        activity: a.activity!,
        fromPlan: a.fromPlan,
        toPlan: a.toPlan,
        amountTotal: a.amountTotal === null ? null : Number(a.amountTotal),
        currency: a.currency,
        occurredAt: a.occurredAt.toISOString(),
      })),
      catalog: PLAN_IDS.map((id) => ({
        id,
        name: PLANS[id].name,
        perSeatUsd: PLANS[id].perSeatUsd,
        minimumSeats: PLANS[id].minimumSeats,
        hoursPerSeat: HOURS_PER_SEAT,
        summary: PLANS[id].summary,
        monthlyTotalUsd: monthlyTotalUsd(id, active),
      })),
      trial: {
        days: TRIAL_DAYS,
        hours: TRIAL_HOURS,
        available: !s.billing.stripeSubscriptionId && !s.billing.trialEndsAt,
      },
      canManage: admin,
      stripe: !!config.stripe,
      enforced: config.enforce,
    };
  }

  const audit = (
    c: Context<AppEnv>,
    action: string,
    metadata: Record<string, unknown>,
    target: { type: string; id: string },
  ) =>
    recordAudit(c.var.deps.db, {
      workspaceId: c.var.user.workspaceId,
      actor: userActor(c.var.user),
      action,
      targetType: target.type,
      targetId: target.id,
      metadata,
    });

  const noStripe = () =>
    new DomainError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not set up on this server.');

  return createRouter()
    .openapi(
      createRoute({
        method: 'get',
        path: '/billing',
        tags: ['billing'],
        summary: "The organization's plan, this period's usage and the spending limits",
        middleware: [requireManaged, requireUser] as const,
        security: authenticated,
        responses: { 200: json(BillingSchema, 'Billing'), ...authProblems },
      }),
      async (c) => c.json(await summary(c), 200),
    )
    .openapi(
      createRoute({
        method: 'patch',
        path: '/billing/settings',
        tags: ['billing'],
        summary: 'Set what happens past the allowance, and the spending limit on overage',
        description:
          '`ceilingUsd` null goes back to the default, the monthly seat total. Takes effect for new work.',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: body(
          z
            .strictObject({
              overagePolicy: PolicySchema.optional(),
              ceilingUsd: z.number().min(0).max(100_000).multipleOf(0.01).nullable().optional(),
            })
            .openapi('BillingSettings'),
        ),
        responses: {
          200: json(BillingSchema, 'Billing'),
          400: problemResponse('Invalid settings'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const patch = c.req.valid('json');
        const ws = c.var.user.workspaceId;
        const before = await billingFor(c.var.deps.db, ws);
        await setBilling(c.var.deps.db, ws, {
          ...(patch.overagePolicy ? { overagePolicy: patch.overagePolicy } : {}),
          ...(patch.ceilingUsd !== undefined ? { ceilingUsd: patch.ceilingUsd } : {}),
        });
        await audit(
          c,
          'billing.settings',
          {
            ...(patch.overagePolicy
              ? { overagePolicy: { from: before.overagePolicy, to: patch.overagePolicy } }
              : {}),
            ...(patch.ceilingUsd !== undefined
              ? { ceilingUsd: { from: before.ceilingUsd, to: patch.ceilingUsd } }
              : {}),
          },
          { type: 'organization', id: ws },
        );
        return c.json(await summary(c), 200);
      },
    )
    .openapi(
      createRoute({
        method: 'put',
        path: '/billing/members/{id}/cap',
        tags: ['billing'],
        summary: "Cap a member's computer hours a period",
        description: 'null removes the cap. A personal limit above a new cap counts as the cap.',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: {
          params: z.object({ id: z.uuid() }),
          ...body(z.strictObject({ capHours: HoursSchema.nullable() }).openapi('MemberCap')),
        },
        responses: {
          200: json(MemberUsageSchema, 'The member'),
          400: problemResponse('Invalid hours'),
          404: problemResponse('No such member'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const { db } = c.var.deps;
        const ws = c.var.user.workspaceId;
        const userId = c.req.valid('param').id;
        const [member] = await db
          .select({ id: schema.workspaceMembers.userId })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, ws),
              eq(schema.workspaceMembers.userId, userId),
            ),
          );
        if (!member) throw notFound('Member not found');
        const { capHours } = c.req.valid('json');
        const before = (await memberLimits(db, ws)).get(userId);
        await setMemberLimit(db, ws, userId, { capHours });
        await audit(
          c,
          'billing.member_cap',
          { from: before?.capHours ?? null, to: capHours },
          { type: 'user', id: userId },
        );
        const line = (await summary(c)).members.find((m) => m.userId === userId)!;
        return c.json(line, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'put',
        path: '/billing/limit',
        tags: ['billing'],
        summary: 'Set your own limit on computer hours a period',
        description:
          'null removes it. Never above the cap an owner or admin set (400 `ABOVE_MEMBER_CAP`).',
        middleware: [requireManaged, requireUser] as const,
        security: authenticated,
        request: body(
          z.strictObject({ personalHours: HoursSchema.nullable() }).openapi('PersonalLimit'),
        ),
        responses: {
          200: json(MemberUsageSchema, 'You'),
          400: problemResponse('Invalid hours, or above your cap'),
          ...authProblems,
        },
      }),
      async (c) => {
        const { db } = c.var.deps;
        const { workspaceId, id } = c.var.user;
        const { personalHours } = c.req.valid('json');
        const before = (await memberLimits(db, workspaceId)).get(id);
        const refusal = personalLimitRefusal(personalHours, before?.capHours ?? null);
        if (refusal) throw new DomainError(400, 'ABOVE_MEMBER_CAP', refusal);
        await setMemberLimit(db, workspaceId, id, { personalHours });
        await audit(
          c,
          'billing.personal_limit',
          { from: before?.personalHours ?? null, to: personalHours },
          { type: 'user', id },
        );
        return c.json((await summary(c)).me, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/billing/checkout',
        tags: ['billing'],
        summary: 'Start a trial or a plan, or change the plan',
        description:
          'Without a subscription: a Stripe Checkout address (`url`) for the plan, with a card and, the first time, a 14 day trial. With one: the subscription changes to the plan at once, prorated, and a trial ends now (`changed`). The overage policy chosen here is saved first.',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: body(
          z
            .strictObject({ plan: PlanIdSchema, overagePolicy: PolicySchema.optional() })
            .openapi('BillingCheckout'),
        ),
        responses: {
          200: json(
            z
              .object({ url: z.string().optional(), changed: z.boolean().optional() })
              .openapi('BillingCheckoutResult'),
            'Go to `url`, or the plan changed',
          ),
          502: problemResponse('Stripe did not answer as expected'),
          503: problemResponse('Payments are not set up on this server (`BILLING_NOT_CONFIGURED`)'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const { stripe, prices } = config;
        if (!stripe) throw noStripe();
        const { plan, overagePolicy } = c.req.valid('json');
        const price = prices[plan];
        if (!price || !isPlanId(plan)) throw noStripe();
        const { db, config: server } = c.var.deps;
        const ws = c.var.user.workspaceId;
        if (overagePolicy) await setBilling(db, ws, { overagePolicy });
        const current = await billingFor(db, ws);
        const seats = billableSeats(plan, await activeMembers(db, ws));
        const live =
          current.stripeSubscriptionId &&
          ['trialing', 'active', 'past_due'].includes(current.status ?? '');
        if (live) {
          const subscription = await stripe.subscriptions.retrieve(current.stripeSubscriptionId!);
          const seat = seatItemOf(subscription, prices);
          if (!seat)
            throw new DomainError(502, 'STRIPE_ERROR', 'The subscription has no seat line.');
          const metered = overageItemOf(subscription, prices);
          const updated = await stripe.subscriptions.update(subscription.id, {
            items: [
              { id: seat.id, price, quantity: seats },
              ...(prices.overage && !metered ? [{ price: prices.overage }] : []),
            ],
            proration_behavior: 'create_prorations',
            ...(subscription.status === 'trialing' ? { trial_end: 'now' as const } : {}),
            metadata: { openbotsOrganization: ws, openbotsPlan: plan },
          });
          const at = billing.now();
          // A change made here never goes through Checkout, so it is logged
          // here, under its own id, and Stripe's event for it adds nothing.
          await recordBillingEvent(db, {
            workspaceId: ws,
            stripeEventId: `openbots_change_${updated.id}_${plan}_${at.getTime()}`,
            type: 'subscription.changed',
            activity:
              current.plan === plan ? 'started' : plan === 'team' ? 'upgraded' : 'downgraded',
            fromPlan: current.plan,
            toPlan: plan,
            subscriptionId: updated.id,
            occurredAt: at,
          });
          await setBilling(
            db,
            ws,
            { plan, status: updated.status, billedSeats: seats },
            Math.floor(at.getTime() / 1000),
          );
          await audit(
            c,
            'billing.plan',
            { from: current.plan, to: plan },
            { type: 'organization', id: ws },
          );
          return c.json({ changed: true }, 200);
        }
        let customer = current.stripeCustomerId;
        if (!customer) {
          const [org] = await db
            .select({ name: schema.workspaces.name })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, ws));
          customer = (
            await stripe.customers.create({
              metadata: { openbotsOrganization: ws },
              ...(org ? { name: org.name } : {}),
            })
          ).id;
          await setBilling(db, ws, { stripeCustomerId: customer });
        }
        const base = server.publicUrl.replace(/\/$/, '');
        const trial = !current.stripeSubscriptionId && !current.trialEndsAt;
        const metadata = { openbotsOrganization: ws, openbotsPlan: plan };
        let session;
        try {
          session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer,
            client_reference_id: ws,
            // A card is required for the trial too.
            payment_method_collection: 'always',
            line_items: [
              { price, quantity: seats },
              // The metered line: without it, overage reported to the meter
              // would never reach an invoice.
              ...(prices.overage ? [{ price: prices.overage }] : []),
            ],
            subscription_data: {
              metadata,
              ...(trial ? { trial_period_days: TRIAL_DAYS } : {}),
            },
            metadata,
            success_url: `${base}/settings/billing?checkout=done`,
            cancel_url: `${base}/settings/billing?checkout=cancelled`,
          });
        } catch (error) {
          c.var.deps.logger.warn({ err: errorText(error), workspaceId: ws }, 'checkout failed');
          throw new DomainError(
            502,
            'STRIPE_ERROR',
            'Stripe did not start the checkout. Try again.',
          );
        }
        if (!session.url) {
          throw new DomainError(
            502,
            'STRIPE_ERROR',
            'Stripe did not start the checkout. Try again.',
          );
        }
        await audit(
          c,
          'billing.checkout',
          { plan, trial, ...(overagePolicy ? { overagePolicy } : {}) },
          { type: 'organization', id: ws },
        );
        return c.json({ url: session.url }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/billing/portal',
        tags: ['billing'],
        summary: "Stripe's billing portal: cards, invoices, cancelling",
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        responses: {
          200: json(z.object({ url: z.string() }).openapi('BillingPortal'), 'Go to `url`'),
          409: problemResponse('No payment details yet (`NO_BILLING_ACCOUNT`)'),
          503: problemResponse('Payments are not set up on this server (`BILLING_NOT_CONFIGURED`)'),
          ...adminProblems,
        },
      }),
      async (c) => {
        if (!config.stripe) throw noStripe();
        const ws = c.var.user.workspaceId;
        const current = await billingFor(c.var.deps.db, ws);
        if (!current.stripeCustomerId) {
          throw new DomainError(409, 'NO_BILLING_ACCOUNT', 'Start a trial or a plan first.');
        }
        const base = c.var.deps.config.publicUrl.replace(/\/$/, '');
        const session = await config.stripe.billingPortal.sessions.create({
          customer: current.stripeCustomerId,
          return_url: `${base}/settings/billing`,
        });
        return c.json({ url: session.url }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/billing/webhook',
        tags: ['billing'],
        summary: "Stripe's webhook",
        description:
          'Signature checked on the raw body (`Stripe-Signature`). The only place a purchase is recorded; a repeated event changes nothing.',
        middleware: [requireManaged] as const,
        responses: {
          200: json(z.object({ received: z.boolean() }), 'Received'),
          400: problemResponse('No signature, or a wrong one'),
          503: problemResponse('The webhook is not set up on this server'),
        },
      }),
      async (c) => {
        if (!config.webhookSecret) {
          throw new DomainError(503, 'BILLING_NOT_CONFIGURED', 'The webhook is not set up.');
        }
        const signature = c.req.header('stripe-signature');
        if (!signature) throw new DomainError(400, 'BAD_SIGNATURE', 'Missing signature');
        let event;
        try {
          event = await verifyWebhook(await c.req.text(), signature, config.webhookSecret);
        } catch {
          throw new DomainError(400, 'BAD_SIGNATURE', 'Invalid signature');
        }
        await billing.applyEvent(c.var.deps, event);
        return c.json({ received: true }, 200);
      },
    );
}
