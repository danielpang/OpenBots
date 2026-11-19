import { eq } from 'drizzle-orm';
import { schema } from '@openbots/server/db/client';
import { ORIGIN, createTestApp, type TestApp } from '@openbots/server/test-app';
import { managedExtensions } from '../index.js';
import { createAccount, emailTo, mailbox, signIn, sessionOf, type Mailbox } from '../testing.js';
import type { BillingConfig } from './service.js';
import type { BillingStripe, StripeEvent, StripeSubscription } from './stripe.js';
import { signWebhook } from './stripe.js';

// A Stripe for billing's tests (not built): it keeps what it was asked to do
// and answers like Stripe for the calls billing makes. Nothing reaches Stripe.

export const PRICES = { pro: 'price_pro', team: 'price_team', overage: 'price_overage' };
export const WEBHOOK_SECRET = 'whsec_test_secret';

export interface FakeStripe extends BillingStripe {
  calls: { op: string; params: unknown }[];
  subscriptions: BillingStripe['subscriptions'] & { all: Map<string, StripeSubscription> };
  meter: { identifier: string; value: number; customer: string }[];
  /** Makes the next meter event fail, as a network error would. */
  failMeter: number;
  /** Forgets the identifiers seen, for a test that starts a period over. */
  forget(): void;
}

export function fakeStripe(): FakeStripe {
  let n = 0;
  const next = (prefix: string) => `${prefix}_${++n}`;
  const calls: FakeStripe['calls'] = [];
  const all = new Map<string, StripeSubscription>();
  const seen = new Set<string>();
  const fake: FakeStripe = {
    calls,
    meter: [],
    failMeter: 0,
    forget: () => seen.clear(),
    customers: {
      async create(params) {
        calls.push({ op: 'customers.create', params });
        return { id: next('cus') };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.push({ op: 'checkout.create', params });
          const id = next('cs');
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.push({ op: 'portal.create', params });
          return { url: 'https://billing.stripe.test/portal' };
        },
      },
    },
    subscriptions: {
      all,
      async retrieve(id) {
        const s = all.get(id);
        if (!s) throw new Error(`No such subscription: ${id}`);
        return structuredClone(s);
      },
      async update(id, params) {
        calls.push({ op: 'subscriptions.update', params });
        const s = all.get(id);
        if (!s) throw new Error(`No such subscription: ${id}`);
        for (const item of params.items ?? []) {
          const existing = item.id ? s.items.data.find((i) => i.id === item.id) : undefined;
          if (existing) {
            if (item.price) existing.price = { id: item.price };
            if (typeof item.quantity === 'number') existing.quantity = item.quantity;
          } else if (item.price) {
            s.items.data.push({ id: next('si'), price: { id: item.price } });
          }
        }
        if (params.trial_end === 'now') s.status = 'active';
        if (params.metadata) s.metadata = { ...s.metadata, ...(params.metadata as object) };
        return structuredClone(s);
      },
    },
    billing: {
      meterEvents: {
        async create(params) {
          calls.push({ op: 'meterEvents.create', params });
          if (fake.failMeter > 0) {
            fake.failMeter--;
            throw new Error('connection reset');
          }
          // Stripe drops a repeated identifier.
          if (seen.has(params.identifier)) return {};
          seen.add(params.identifier);
          fake.meter.push({
            identifier: params.identifier,
            value: Number(params.payload.value),
            customer: params.payload.stripe_customer_id!,
          });
          return {};
        },
      },
    },
  };
  return fake;
}

/** A subscription as Stripe would hold it, with a seat line and the metered line. */
export function subscription(over: {
  id?: string;
  customer: string;
  plan?: 'pro' | 'team';
  seats?: number;
  status?: string;
  periodStart: Date;
  trialEnd?: Date | null;
}): StripeSubscription {
  const start = Math.floor(over.periodStart.getTime() / 1000);
  return {
    id: over.id ?? 'sub_1',
    status: over.status ?? 'active',
    customer: over.customer,
    metadata: { openbotsPlan: over.plan ?? 'pro' },
    items: {
      data: [
        { id: 'si_overage', price: { id: PRICES.overage }, current_period_start: start },
        {
          id: 'si_seat',
          price: { id: PRICES[over.plan ?? 'pro'] },
          quantity: over.seats ?? 1,
          current_period_start: start,
        },
      ],
    },
    trial_end: over.trialEnd ? Math.floor(over.trialEnd.getTime() / 1000) : null,
  };
}

/** A Stripe event, and its body and signature as the webhook receives them. */
export function stripeEvent(
  type: string,
  object: unknown,
  { id, created }: { id: string; created: Date },
): { event: StripeEvent; body: string; signature: string } {
  const event: StripeEvent = {
    id,
    type,
    created: Math.floor(created.getTime() / 1000),
    data: { object },
  };
  const body = JSON.stringify({ object: 'event', ...event });
  return { event, body, signature: signWebhook(body, WEBHOOK_SECRET) };
}

// --- An app with billing ---------------------------------------------------------

export interface BillingApp {
  t: TestApp;
  stripe: FakeStripe;
  mail: Mailbox;
  config: BillingConfig;
  clock: { now: Date };
  call(cookie: string | undefined, method: string, path: string, body?: unknown): Promise<Response>;
  /** A confirmed account, signed in, that made an organization; its session and ids. */
  founder(email: string, org: string): Promise<{ cookie: string; org: string; id: string }>;
  /** Invites `email` into the inviter's organization and accepts it. */
  invite(inviter: string, email: string, role?: string): Promise<{ cookie: string; id: string }>;
  /** Puts the organization on a plan, as the webhook would have. */
  onPlan(org: string, plan: Partial<typeof schema.organizationBilling.$inferInsert>): Promise<void>;
}

export async function billingApp(): Promise<BillingApp> {
  const stripe = fakeStripe();
  const mail = mailbox();
  const clock = { now: new Date('2026-11-20T12:00:00Z') };
  const config: BillingConfig = {
    enforce: true,
    stripe,
    webhookSecret: WEBHOOK_SECRET,
    prices: PRICES,
    meterEventName: 'openbots_computer_hours',
    email: emailTo(mail),
    now: () => clock.now,
  };
  const t = await createTestApp(
    { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' },
    { extensions: managedExtensions({ email: emailTo(mail), billing: config }) },
  );
  const call = async (cookie: string | undefined, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function account(email: string) {
    const res = await createAccount(t, email);
    if (!res.ok) throw new Error(`no account: ${res.status}`);
    await t.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, email.toLowerCase()));
    return sessionOf(await signIn(t, email))!;
  }
  return {
    t,
    stripe,
    mail,
    config,
    clock,
    call,
    async founder(email, name) {
      const cookie = await account(email);
      const res = await call(cookie, 'POST', '/organizations', { name });
      if (res.status !== 201) throw new Error(`no organization: ${res.status}`);
      const { id: org } = (await res.json()) as { id: string };
      return { cookie, org, id: await t.userId(email) };
    },
    async invite(inviter, email, role = 'member') {
      const res = await call(inviter, 'POST', '/organization/invitations', { email, role });
      const { id } = (await res.json()) as { id: string };
      const cookie = await account(email);
      const accepted = await call(cookie, 'POST', `/invitations/${id}/accept`);
      if (!accepted.ok) throw new Error(`not accepted: ${accepted.status}`);
      return { cookie, id: await t.userId(email) };
    },
    async onPlan(org, plan) {
      await t.db
        .insert(schema.organizationBilling)
        .values({ workspaceId: org, ...plan })
        .onConflictDoUpdate({ target: schema.organizationBilling.workspaceId, set: plan });
    },
  };
}
