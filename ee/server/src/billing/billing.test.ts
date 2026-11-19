import { randomUUID } from 'node:crypto';
import type { ComputerUsageEvent } from '@openbots/server';
import { schema } from '@openbots/server/db/client';
import { inWorkspace } from '@openbots/server/db/scope';
import { useTestComputer, type TestComputer } from '@openbots/server/test-computer';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computerServices, computerUseScope } from '@openbots/server/services/computer';
import { settleComputerUses } from '@openbots/server/services/computer-use';
import { HOUR_SECONDS } from './plans.js';
import { billingApp, PRICES, stripeEvent, subscription, type BillingApp } from './testing.js';

// Billing end to end on the PGlite harness, with a fake Stripe (plan 21.10):
// the ledger and its period totals, overage told to Stripe once and only
// ever upwards, warnings once, the four checks through the API, the routes'
// roles and audit rows, seat sync, and the webhook's signature, idempotency
// and ordering.

const H = HOUR_SECONDS;
const ANCHOR = new Date('2026-11-01T00:00:00Z');

describe('billing', () => {
  let b: BillingApp;
  let computer: TestComputer;
  let ada: { cookie: string; org: string; id: string };

  beforeAll(async () => {
    b = await billingApp();
    computer = await useTestComputer(b.t.ownerDeps);
    ada = await b.founder('ada@example.com', 'Acme');
  });
  afterAll(async () => {
    await computer.close();
    await b.t.close();
  });
  beforeEach(async () => {
    b.clock.now = new Date('2026-11-20T12:00:00Z');
    b.stripe.calls.length = 0;
    b.stripe.meter.length = 0;
    // Each test starts the period over, so its report numbers begin again.
    b.stripe.forget();
    // Stripe holds no subscription a test did not give it.
    b.stripe.subscriptions.all.clear();
    b.mail.sent.length = 0;
    await b.t.db.delete(schema.billingPeriods);
    await b.t.db.delete(schema.billingUsage);
    await b.t.db.delete(schema.billingMemberLimits);
    await b.t.db.delete(schema.organizationBilling);
    await b.t.db.delete(schema.billingEvents);
  });

  const usage = (
    org: string,
    ownerId: string,
    seconds: number,
    end = b.clock.now,
    intervalId = randomUUID(),
  ): ComputerUsageEvent => ({
    intervalId,
    workspaceId: org,
    ownerId,
    computerId: randomUUID(),
    provider: 'sprites',
    startedAt: new Date(end.getTime() - seconds * 1000),
    endedAt: end,
    seconds,
  });
  const record = (event: ComputerUsageEvent) =>
    inWorkspace(event.workspaceId, () => b.t.deps.extensions!.onComputerUsage!(event, b.t.deps));
  const period = async (org: string, start = ANCHOR) =>
    (
      await b.t.db
        .select()
        .from(schema.billingPeriods)
        .where(
          and(
            eq(schema.billingPeriods.workspaceId, org),
            eq(schema.billingPeriods.periodStart, start),
          ),
        )
    )[0];
  const pro = (over: Partial<typeof schema.organizationBilling.$inferInsert> = {}) =>
    b.onPlan(ada.org, {
      plan: 'pro',
      status: 'active',
      stripeCustomerId: 'cus_acme',
      stripeSubscriptionId: 'sub_acme',
      billedSeats: 1,
      periodAnchor: ANCHOR,
      ...over,
    });
  const json = async <T>(res: Response | Promise<Response>, status = 200) => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as T;
  };
  const code = async (res: Response | Promise<Response>) =>
    ((await (await res).json()) as { code?: string }).code;

  describe('the ledger', () => {
    it('adds each closed interval once, with who used it, to its period', async () => {
      await pro();
      const event = usage(ada.org, ada.id, 1800);
      await record(event);
      await record(event); // the same close, told twice
      expect(await period(ada.org)).toMatchObject({
        usedSeconds: 1800,
        allowanceSeconds: 100 * H,
        plan: 'pro',
        baseSeats: 1,
      });
      const rows = await b.t.db.select().from(schema.billingUsage);
      expect(rows).toEqual([
        expect.objectContaining({ userId: ada.id, userName: 'ada', seconds: 1800 }),
      ]);
    });

    it('splits an interval that crosses the period’s end between the two periods', async () => {
      await pro();
      b.clock.now = new Date('2026-12-01T00:30:00Z');
      await record(usage(ada.org, ada.id, 3600));
      expect((await period(ada.org))?.usedSeconds).toBe(1800);
      expect((await period(ada.org, new Date('2026-12-01T00:00:00Z')))?.usedSeconds).toBe(1800);
    });
  });

  describe('overage', () => {
    it('reports only the excess, in whole units, once, and only ever upwards', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 100 });
      await record(usage(ada.org, ada.id, 100 * H)); // the allowance, exactly
      expect(b.stripe.meter).toEqual([]);
      await record(usage(ada.org, ada.id, 3600 + 35)); // one hour and 35 seconds over
      expect(b.stripe.meter).toEqual([
        {
          identifier: `${ada.org}:${ANCHOR.toISOString()}:1`,
          value: 100,
          customer: 'cus_acme',
        },
      ]);
      await record(usage(ada.org, ada.id, 1)); // 36 seconds over now: one more unit
      expect(b.stripe.meter.map((m) => m.value)).toEqual([100, 1]);
      expect((await period(ada.org))?.reportedUnits).toBe(101);
    });

    it('stays exact when many intervals close at once', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 100 });
      await record(usage(ada.org, ada.id, 100 * H));
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => record(usage(ada.org, ada.id, 360 + i))),
      );
      const row = await period(ada.org);
      const sum = b.stripe.meter.reduce((a, m) => a + m.value, 0);
      expect(sum).toBe(row!.reportedUnits);
      expect(row!.reportedUnits).toBe(Math.floor((row!.usedSeconds - 100 * H) / 36));
      expect(new Set(b.stripe.meter.map((m) => m.identifier)).size).toBe(b.stripe.meter.length);
    });

    it('gives a claim back when Stripe does not hear it, and catches up on the next close', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 100 });
      await record(usage(ada.org, ada.id, 100 * H));
      b.stripe.failMeter = 1;
      await record(usage(ada.org, ada.id, 3600));
      expect(b.stripe.meter).toEqual([]);
      expect((await period(ada.org))?.reportedUnits).toBe(0);
      await record(usage(ada.org, ada.id, 36));
      expect(b.stripe.meter.map((m) => m.value)).toEqual([101]);
    });

    it('never tells Stripe about more than the ceiling, and nothing on the stop policy', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 1 }); // $1 is 5 hours
      await record(usage(ada.org, ada.id, 110 * H));
      expect(b.stripe.meter.map((m) => m.value)).toEqual([500]);
      await b.t.db.delete(schema.billingPeriods);
      await b.t.db.delete(schema.billingUsage);
      b.stripe.meter.length = 0;
      b.stripe.forget();
      await pro({ overagePolicy: 'stop' });
      await record(usage(ada.org, ada.id, 110 * H));
      expect(b.stripe.meter).toEqual([]);
    });
    it('never bills time absorbed past the ceiling once the ceiling is raised', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 1 }); // $1 is 5 hours
      await record(usage(ada.org, ada.id, 110 * H)); // 5 hours past the ceiling, absorbed
      expect(b.stripe.meter.map((m) => m.value)).toEqual([500]);
      await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { ceilingUsd: 100 }));
      await record(usage(ada.org, ada.id, 36)); // one unit after the raise
      expect(b.stripe.meter.map((m) => m.value)).toEqual([500, 1]);
    });

    it('never bills time used past the allowance on the stop policy once overage is allowed', async () => {
      await pro({ overagePolicy: 'stop', ceilingUsd: 100 });
      await record(usage(ada.org, ada.id, 110 * H)); // running work went 10 hours past it
      await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { overagePolicy: 'allow' }));
      await record(usage(ada.org, ada.id, 36));
      expect(b.stripe.meter.map((m) => m.value)).toEqual([1]);
      const tab = await json<{ usage: { overageUsd: number } }>(
        b.call(ada.cookie, 'GET', '/billing'),
      );
      expect(tab.usage.overageUsd).toBe(0);
    });
  });

  describe('warnings', () => {
    it('emails owners and admins at 75% and 90% and when work stops, each once a period', async () => {
      await pro();
      const subjects = () => b.mail.sent.map((m) => m.subject);
      await record(usage(ada.org, ada.id, 75 * H));
      await record(usage(ada.org, ada.id, 60));
      expect(subjects()).toEqual(['Three quarters of your computer hours are used']);
      await record(usage(ada.org, ada.id, 15 * H));
      await record(usage(ada.org, ada.id, 10 * H));
      await record(usage(ada.org, ada.id, H));
      expect(subjects()).toEqual([
        'Three quarters of your computer hours are used',
        'More than 90% of your computer hours are used',
        'New computer work has stopped for this period',
      ]);
      const stopped = b.mail.sent.at(-1)!;
      expect(stopped.to).toBe('ada@example.com');
      expect(stopped.text).toContain('http://localhost:3000/settings/billing');
      expect(stopped.text).toContain('was not interrupted');
      expect(stopped.text).not.toMatch(/[–—]/);
    });

    it('emails every $50 of overage', async () => {
      await pro({ overagePolicy: 'allow', ceilingUsd: 1000 });
      await record(usage(ada.org, ada.id, 100 * H));
      b.mail.sent.length = 0;
      await record(usage(ada.org, ada.id, 249 * H)); // $49.80
      expect(b.mail.sent).toEqual([]);
      await record(usage(ada.org, ada.id, 2 * H)); // $50.20
      expect(b.mail.sent.map((m) => m.subject)).toEqual(['$50 of overage so far this period']);
    });
  });

  describe('whether work starts', () => {
    const start = (cookie: string) => b.call(cookie, 'POST', '/computer/start');

    it('refuses with no plan, saying how to start one', async () => {
      const res = await start(ada.cookie);
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ code: 'BILLING_REQUIRED' });
    });

    it('starts within the allowance, and stops at it on the stop policy', async () => {
      await pro();
      expect((await start(ada.cookie)).status).toBe(200);
      await record(usage(ada.org, ada.id, 100 * H));
      const res = await start(ada.cookie);
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        code: 'PLAN_ALLOWANCE_REACHED',
        title: expect.stringContaining('work starts again on December 1'),
      });
      // Allowed, it meters; at the ceiling it stops again.
      await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { overagePolicy: 'allow' }));
      expect((await start(ada.cookie)).status).toBe(200);
      await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { ceilingUsd: 0 }));
      expect(await code(start(ada.cookie))).toBe('SPENDING_CEILING_REACHED');
    });

    it('counts work in flight, so a full allowance cannot be outrun by starting more', async () => {
      await pro();
      await record(usage(ada.org, ada.id, 100 * H - 60));
      const [row] = await b.t.db.select().from(schema.computers);
      await b.t.db.insert(schema.computerUsageIntervals).values({
        workspaceId: ada.org,
        computerId: row!.id,
        ownerId: ada.id,
        provider: 'docker',
        reason: 'run',
        startedAt: new Date(b.clock.now.getTime() - 120_000),
        seenAt: b.clock.now,
      });
      try {
        expect(await code(start(ada.cookie))).toBe('PLAN_ALLOWANCE_REACHED');
      } finally {
        await b.t.db.delete(schema.computerUsageIntervals);
      }
    });

    it('does not bill work in flight on the stop policy when overage is allowed during it', async () => {
      await pro({ overagePolicy: 'stop', ceilingUsd: 100 });
      await record(usage(ada.org, ada.id, 100 * H));
      const [row] = await b.t.db.select().from(schema.computers);
      // A run that began at the allowance, an hour ago, still going.
      await b.t.db.insert(schema.computerUsageIntervals).values({
        workspaceId: ada.org,
        computerId: row!.id,
        ownerId: ada.id,
        provider: 'docker',
        reason: 'run',
        startedAt: new Date(b.clock.now.getTime() - H * 1000),
        seenAt: b.clock.now,
      });
      try {
        await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { overagePolicy: 'allow' }));
        // It ends a minute later: only that minute was used with overage allowed.
        b.clock.now = new Date(b.clock.now.getTime() + 60_000);
        await record(usage(ada.org, ada.id, H + 60));
        expect(b.stripe.meter.map((m) => m.value)).toEqual([1]);
      } finally {
        await b.t.db.delete(schema.computerUsageIntervals);
      }
    });

    it('refuses a new run and a manual wake at the allowance, while a run already working goes on', async () => {
      await pro();
      const bot = { id: randomUUID(), ownerId: ada.id, workspaceId: ada.org };
      const use = computerUseScope(b.t.deps, 'run');
      const working = computerServices(b.t.deps, {
        bot,
        runId: randomUUID(),
        recordStep: async () => {},
        use,
      });
      await inWorkspace(ada.org, () => working.agent());
      await record(usage(ada.org, ada.id, 100 * H));
      // The organization is out of hours: the run under way still gets the computer.
      await inWorkspace(ada.org, () => working.agent());
      const fresh = computerServices(b.t.deps, {
        bot,
        runId: randomUUID(),
        recordStep: async () => {},
      });
      await expect(inWorkspace(ada.org, () => fresh.agent())).rejects.toMatchObject({
        status: 402,
        code: 'PLAN_ALLOWANCE_REACHED',
      });
      expect(await code(b.call(ada.cookie, 'POST', '/computer/wake'))).toBe(
        'PLAN_ALLOWANCE_REACHED',
      );
      await use.end();
      await settleComputerUses();
      await b.t.db.delete(schema.computerUsageIntervals);
    });

    it('stops a trial at its 20 hours', async () => {
      await pro({ status: 'trialing', trialEndsAt: new Date('2026-11-15T00:00:00Z') });
      await record(usage(ada.org, ada.id, 20 * H));
      expect((await period(ada.org))?.allowanceSeconds).toBe(20 * H);
      expect(await code(start(ada.cookie))).toBe('TRIAL_HOURS_REACHED');
    });

    it('refuses new work once the subscription no longer pays', async () => {
      await pro({ status: 'unpaid' });
      expect(await code(start(ada.cookie))).toBe('BILLING_INACTIVE');
      await pro({ status: 'past_due' });
      expect((await start(ada.cookie)).status).toBe(200);
    });
  });

  describe('member caps and personal limits', () => {
    let bea: { cookie: string; id: string };
    beforeAll(async () => {
      bea = await b.invite(ada.cookie, 'bea@example.com');
    });

    it('lets owners and admins cap a member, and the member set their own limit under it', async () => {
      await pro({ plan: 'team', billedSeats: 2 });
      expect(
        await code(b.call(bea.cookie, 'PUT', `/billing/members/${ada.id}/cap`, { capHours: 1 })),
      ).toBe('FORBIDDEN');
      await json(b.call(ada.cookie, 'PUT', `/billing/members/${bea.id}/cap`, { capHours: 2 }));
      const above = await b.call(bea.cookie, 'PUT', '/billing/limit', { personalHours: 3 });
      expect(above.status).toBe(400);
      expect(await above.json()).toMatchObject({ code: 'ABOVE_MEMBER_CAP' });
      const me = await json<{ capHours: number; personalHours: number }>(
        b.call(bea.cookie, 'PUT', '/billing/limit', { personalHours: 1.5 }),
      );
      expect(me).toMatchObject({ capHours: 2, personalHours: 1.5 });

      await record(usage(ada.org, bea.id, 1.5 * H));
      const res = await b.call(bea.cookie, 'POST', '/computer/start');
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        code: 'MEMBER_CAP_REACHED',
        title: expect.stringContaining('you set as your own limit'),
      });
      // Ada has no cap and the pool has room.
      expect((await b.call(ada.cookie, 'POST', '/computer/start')).status).toBe(200);

      const audit = await b.t.db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.workspaceId, ada.org));
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['billing.member_cap', 'billing.personal_limit']),
      );
    });

    it('shows a member their own line and an admin everyone', async () => {
      await pro({ plan: 'team', billedSeats: 2 });
      await record(usage(ada.org, bea.id, 3 * H));
      const mine = await json<{ members: { userId: string }[]; canManage: boolean }>(
        b.call(bea.cookie, 'GET', '/billing'),
      );
      expect(mine.canManage).toBe(false);
      expect(mine.members.map((m) => m.userId)).toEqual([bea.id]);
      const all = await json<{
        members: { userId: string; usedHours: number }[];
        seats: { monthlyTotalUsd: number };
        usage: { allowanceHours: number };
      }>(b.call(ada.cookie, 'GET', '/billing'));
      expect(all.members.map((m) => m.userId).sort()).toEqual([ada.id, bea.id].sort());
      expect(all.members.find((m) => m.userId === bea.id)?.usedHours).toBe(3);
      expect(all.seats.monthlyTotalUsd).toBe(36);
      expect(all.usage.allowanceHours).toBe(200);
    });

    it('keeps money settings to owners and admins', async () => {
      for (const [method, path, body] of [
        ['PATCH', '/billing/settings', { overagePolicy: 'allow' }],
        ['POST', '/billing/checkout', { plan: 'team' }],
        ['POST', '/billing/portal', undefined],
      ] as const) {
        expect((await b.call(bea.cookie, method, path, body)).status, path).toBe(403);
      }
    });
  });

  describe('Stripe', () => {
    it('starts a 14 day trial through Checkout with a card, both lines, and the policy chosen', async () => {
      const res = await json<{ url: string }>(
        b.call(ada.cookie, 'POST', '/billing/checkout', { plan: 'pro', overagePolicy: 'allow' }),
      );
      expect(res.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      const session = b.stripe.calls.find((c) => c.op === 'checkout.create')!.params as {
        line_items: unknown[];
        payment_method_collection: string;
        subscription_data: { trial_period_days?: number };
        customer: string;
      };
      expect(session.payment_method_collection).toBe('always');
      expect(session.subscription_data.trial_period_days).toBe(14);
      expect(session.line_items).toEqual([
        { price: PRICES.pro, quantity: 2 }, // Ada and Bea
        { price: PRICES.overage },
      ]);
      const [row] = await b.t.db
        .select()
        .from(schema.organizationBilling)
        .where(eq(schema.organizationBilling.workspaceId, ada.org));
      // Nothing is bought yet: only the customer and the policy are kept.
      expect(row).toMatchObject({
        plan: 'none',
        stripeCustomerId: session.customer,
        overagePolicy: 'allow',
      });
    });

    it('changes a live subscription in place, and never makes a second one for an unpaid one', async () => {
      await pro();
      b.stripe.subscriptions.all.set(
        'sub_acme',
        subscription({ id: 'sub_acme', customer: 'cus_acme', seats: 2, periodStart: ANCHOR }),
      );
      expect(await json(b.call(ada.cookie, 'POST', '/billing/checkout', { plan: 'team' }))).toEqual(
        { changed: true },
      );
      expect(b.stripe.subscriptions.all.get('sub_acme')!.items.data[1]!.price.id).toBe(PRICES.team);
      const [change] = await b.t.db
        .select()
        .from(schema.billingEvents)
        .where(eq(schema.billingEvents.workspaceId, ada.org));
      expect(change).toMatchObject({ activity: 'upgraded', fromPlan: 'pro', toPlan: 'team' });
      expect(b.stripe.calls.some((c) => c.op === 'checkout.create')).toBe(false);

      await pro({ status: 'unpaid' });
      expect(await code(b.call(ada.cookie, 'POST', '/billing/checkout', { plan: 'pro' }))).toBe(
        'SUBSCRIPTION_UNPAID',
      );
      expect(b.stripe.calls.some((c) => c.op === 'checkout.create')).toBe(false);
    });

    it('answers 503 for checkout and the portal without Stripe, while the settings still work', async () => {
      const stripe = b.config.stripe;
      b.config.stripe = null;
      try {
        expect(await code(b.call(ada.cookie, 'POST', '/billing/checkout', { plan: 'pro' }))).toBe(
          'BILLING_NOT_CONFIGURED',
        );
        expect((await b.call(ada.cookie, 'POST', '/billing/portal')).status).toBe(503);
        await json(b.call(ada.cookie, 'PATCH', '/billing/settings', { ceilingUsd: 12 }));
      } finally {
        b.config.stripe = stripe;
      }
    });

    describe('the webhook', () => {
      const send = (body: string, signature: string) =>
        b.t.app.request('/api/v1/billing/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
          body,
        });
      const billingRow = async () =>
        (
          await b.t.db
            .select()
            .from(schema.organizationBilling)
            .where(eq(schema.organizationBilling.workspaceId, ada.org))
        )[0];

      it('refuses a wrong or missing signature and changes nothing', async () => {
        await b.onPlan(ada.org, { stripeCustomerId: 'cus_acme' });
        const sub = subscription({ customer: 'cus_acme', periodStart: ANCHOR });
        const { body } = stripeEvent('customer.subscription.created', sub, {
          id: 'evt_1',
          created: ANCHOR,
        });
        expect((await send(body, 't=1,v1=forged')).status).toBe(400);
        expect(
          (await b.t.app.request('/api/v1/billing/webhook', { method: 'POST', body })).status,
        ).toBe(400);
        expect((await billingRow())?.plan).toBe('none');
        expect(await b.t.db.select().from(schema.billingEvents)).toEqual([]);
      });

      it('records a purchase once, however often Stripe delivers it', async () => {
        await b.onPlan(ada.org, { stripeCustomerId: 'cus_acme' });
        const sub = subscription({
          id: 'sub_acme',
          customer: 'cus_acme',
          status: 'trialing',
          seats: 2,
          periodStart: ANCHOR,
          trialEnd: new Date('2026-11-15T00:00:00Z'),
        });
        const { body, signature } = stripeEvent('customer.subscription.created', sub, {
          id: 'evt_created',
          created: ANCHOR,
        });
        for (let i = 0; i < 3; i++) expect((await send(body, signature)).status).toBe(200);
        expect(await billingRow()).toMatchObject({
          plan: 'pro',
          status: 'trialing',
          stripeSubscriptionId: 'sub_acme',
          billedSeats: 2,
          periodAnchor: ANCHOR,
        });
        const events = await b.t.db.select().from(schema.billingEvents);
        expect(events).toEqual([
          expect.objectContaining({ stripeEventId: 'evt_created', activity: 'trial_started' }),
        ]);
      });

      it('keeps the newest state when events arrive out of order', async () => {
        await b.onPlan(ada.org, { stripeCustomerId: 'cus_acme' });
        const newer = stripeEvent(
          'customer.subscription.updated',
          subscription({
            id: 'sub_acme',
            customer: 'cus_acme',
            plan: 'team',
            seats: 3,
            periodStart: ANCHOR,
          }),
          { id: 'evt_newer', created: new Date('2026-11-10T00:00:00Z') },
        );
        const older = stripeEvent(
          'customer.subscription.updated',
          subscription({
            id: 'sub_acme',
            customer: 'cus_acme',
            plan: 'pro',
            seats: 1,
            periodStart: ANCHOR,
          }),
          { id: 'evt_older', created: new Date('2026-11-05T00:00:00Z') },
        );
        expect((await send(newer.body, newer.signature)).status).toBe(200);
        expect((await send(older.body, older.signature)).status).toBe(200);
        expect(await billingRow()).toMatchObject({ plan: 'team', billedSeats: 3 });
      });

      it('keeps the subscription as Stripe has it when two events of one second arrive swapped', async () => {
        await b.onPlan(ada.org, { stripeCustomerId: 'cus_acme' });
        const second = new Date('2026-11-10T00:00:00Z');
        const paid = subscription({ id: 'sub_acme', customer: 'cus_acme', periodStart: ANCHOR });
        b.stripe.subscriptions.all.set('sub_acme', paid);
        // Checkout: made incomplete, paid, active, all within one second.
        const created = stripeEvent(
          'customer.subscription.created',
          { ...paid, status: 'incomplete' },
          { id: 'evt_created', created: second },
        );
        const updated = stripeEvent('customer.subscription.updated', paid, {
          id: 'evt_updated',
          created: second,
        });
        expect((await send(updated.body, updated.signature)).status).toBe(200);
        expect((await send(created.body, created.signature)).status).toBe(200);
        expect(await billingRow()).toMatchObject({ plan: 'pro', status: 'active' });
      });

      it('ignores an event for a customer no organization has', async () => {
        const { body, signature } = stripeEvent(
          'customer.subscription.deleted',
          subscription({ customer: 'cus_stranger', periodStart: ANCHOR }),
          { id: 'evt_stranger', created: ANCHOR },
        );
        expect((await send(body, signature)).status).toBe(200);
        expect(await b.t.db.select().from(schema.billingEvents)).toEqual([]);
      });

      it('stops the organization’s computers when the subscription stops paying, keeping its data', async () => {
        await pro();
        expect((await b.call(ada.cookie, 'POST', '/computer/start')).status).toBe(200);
        const { body, signature } = stripeEvent(
          'customer.subscription.updated',
          subscription({
            id: 'sub_acme',
            customer: 'cus_acme',
            status: 'unpaid',
            periodStart: ANCHOR,
          }),
          { id: 'evt_unpaid', created: new Date('2026-11-19T00:00:00Z') },
        );
        expect((await send(body, signature)).status).toBe(200);
        const computers = await b.t.db
          .select()
          .from(schema.computers)
          .where(eq(schema.computers.workspaceId, ada.org));
        expect(computers.length).toBeGreaterThan(0);
        expect(computers.every((c) => c.status === 'stopped')).toBe(true);
        expect(await code(b.call(ada.cookie, 'POST', '/computer/start'))).toBe('BILLING_INACTIVE');
      });
    });

    describe('seats', () => {
      it('follows active members: a join prorated with its hours, a suspension at renewal', async () => {
        const carl = await b.founder('carl@example.com', 'Carl Co');
        await b.onPlan(carl.org, {
          plan: 'team',
          status: 'active',
          stripeCustomerId: 'cus_carl',
          stripeSubscriptionId: 'sub_carl',
          billedSeats: 2,
          periodAnchor: ANCHOR,
        });
        b.stripe.subscriptions.all.set(
          'sub_carl',
          subscription({
            id: 'sub_carl',
            customer: 'cus_carl',
            plan: 'team',
            seats: 2,
            periodStart: ANCHOR,
          }),
        );
        const updates = () =>
          b.stripe.calls
            .filter((c) => c.op === 'subscriptions.update')
            .map((c) => c.params as { items: { quantity: number }[]; proration_behavior: string })
            .map((p) => [p.items[0]!.quantity, p.proration_behavior]);
        // Two members: the minimum, nothing to change.
        const dee = await b.invite(carl.cookie, 'dee@example.com');
        expect(updates()).toEqual([]);
        // A third: charged prorated now, and its share of hours added.
        await b.invite(carl.cookie, 'eli@example.com');
        expect(updates()).toEqual([[3, 'create_prorations']]);
        const row = await period(carl.org);
        // Ten and a half days of thirty left: 35 hours.
        expect(row).toMatchObject({ paidSeats: 3, allowanceSeconds: 200 * H + 35 * H });
        // A suspension: fewer seats from renewal, no credit now.
        await json(
          b.call(carl.cookie, 'PATCH', `/organization/members/${dee.id}`, { suspended: true }),
        );
        expect(updates().at(-1)).toEqual([2, 'none']);
        // Back within the period: the seat was paid for, so no second charge.
        await json(
          b.call(carl.cookie, 'PATCH', `/organization/members/${dee.id}`, { suspended: false }),
        );
        expect(updates().at(-1)).toEqual([3, 'none']);
        expect((await period(carl.org))?.allowanceSeconds).toBe(235 * H);
        // Leaving: fewer seats from renewal.
        expect(
          (await b.call(carl.cookie, 'DELETE', `/organization/members/${dee.id}`)).status,
        ).toBe(204);
        expect(updates().at(-1)).toEqual([2, 'none']);
      });

      it('grants the hours of Team’s minimum seat once, when Pro becomes Team mid-period', async () => {
        const hal = await b.founder('hal@example.com', 'Hal Co');
        await b.onPlan(hal.org, {
          plan: 'pro',
          status: 'active',
          stripeCustomerId: 'cus_hal',
          stripeSubscriptionId: 'sub_hal',
          billedSeats: 1,
          periodAnchor: ANCHOR,
        });
        b.stripe.subscriptions.all.set(
          'sub_hal',
          subscription({ id: 'sub_hal', customer: 'cus_hal', seats: 1, periodStart: ANCHOR }),
        );
        await json(b.call(hal.cookie, 'GET', '/billing'));
        expect(
          await json(b.call(hal.cookie, 'POST', '/billing/checkout', { plan: 'team' })),
        ).toEqual({ changed: true });
        await json(b.call(hal.cookie, 'GET', '/billing'));
        // Team bills two seats from now: the second one's share of the period.
        expect(await period(hal.org)).toMatchObject({ paidSeats: 2, allowanceSeconds: 135 * H });
        // A second member fills the seat already paid; a third is one new seat.
        await b.invite(hal.cookie, 'fay@example.com');
        await b.invite(hal.cookie, 'gus@example.com');
        const seats = b.stripe.calls
          .filter((c) => c.op === 'subscriptions.update')
          .map((c) => (c.params as { items: { quantity?: number }[] }).items[0]!.quantity);
        expect(seats).toEqual([2, 3]);
        expect((await period(hal.org))?.allowanceSeconds).toBe(170 * H);
      });
    });
  });
});
