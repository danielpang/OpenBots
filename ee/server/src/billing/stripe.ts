import Stripe from 'stripe';
import { isPlanId, type PlanId } from './plans.js';

// The part of Stripe billing uses, behind a narrow interface so tests stand
// in a fake and never call Stripe. The real client is the `stripe` SDK.
//
// Not @better-auth/stripe: it keeps its own subscription table keyed on a
// reference, one price per plan, and seats as the subscription's quantity,
// but nothing for a second, metered item on the same subscription, for
// prorating up while not crediting down within a period, or for reporting
// usage. All of that is this module's, so the plugin would have added a
// second record of the subscription without removing any of the work.

export interface StripeItem {
  id: string;
  price: { id: string };
  quantity?: number | null;
  current_period_start?: number;
  current_period_end?: number;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string> | null;
  items: { data: StripeItem[] };
  trial_start?: number | null;
  trial_end?: number | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  /** Seconds since the epoch. */
  created: number;
  data: { object: unknown };
}

/** The calls billing makes. The SDK's client fits it. */
export interface BillingStripe {
  customers: {
    create(params: { metadata: Record<string, string>; name?: string }): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscription>;
    update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<StripeSubscription>;
  };
  billing: {
    meterEvents: {
      create(params: {
        event_name: string;
        identifier: string;
        payload: Record<string, string>;
        timestamp?: number;
      }): Promise<unknown>;
    };
  };
}

/** The SDK's client for a secret key. */
export function stripeClient(secretKey: string): BillingStripe {
  return new Stripe(secretKey, { maxNetworkRetries: 2 }) as unknown as BillingStripe;
}

/**
 * Verifies a webhook's signature on the raw body and parses it. Throws on a
 * bad signature. Needs no network or key, only the endpoint's secret.
 */
const verifier = new Stripe('sk_verify_only');
export async function verifyWebhook(
  body: string,
  signature: string,
  secret: string,
): Promise<StripeEvent> {
  const event = await verifier.webhooks.constructEventAsync(body, signature, secret);
  return event as unknown as StripeEvent;
}

/** Signs a payload as Stripe would, for tests. */
export function signWebhook(payload: string, secret: string, timestamp?: number): string {
  return verifier.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

/** Price ids this deployment sells, from STRIPE_PRICE_*. */
export interface BillingPrices {
  pro?: string;
  team?: string;
  /** The metered overage price, on the one meter both plans share. */
  overage?: string;
}

export const customerId = (s: StripeSubscription) =>
  typeof s.customer === 'string' ? s.customer : s.customer.id;

/** The plan a seat price sells, if this deployment sells it. */
export function planOfPrice(prices: BillingPrices, priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === prices.pro) return 'pro';
  if (priceId === prices.team) return 'team';
  return null;
}

/**
 * The seat line, found by price, never by position: a subscription has two
 * lines and Stripe promises no order. A price this deployment no longer
 * sells still bills somebody, so a line that is not the overage stands in.
 */
export function seatItemOf(s: StripeSubscription, prices: BillingPrices): StripeItem | undefined {
  return (
    s.items.data.find((item) => planOfPrice(prices, item.price.id) !== null) ??
    s.items.data.find((item) => item.price.id !== prices.overage)
  );
}

export function overageItemOf(
  s: StripeSubscription,
  prices: BillingPrices,
): StripeItem | undefined {
  return prices.overage ? s.items.data.find((item) => item.price.id === prices.overage) : undefined;
}

/** The plan a subscription is for: its seat price, else what our metadata says. */
export function planOfSubscription(s: StripeSubscription, prices: BillingPrices): PlanId | null {
  const byPrice = planOfPrice(prices, seatItemOf(s, prices)?.price.id);
  if (byPrice) return byPrice;
  const meta = s.metadata?.openbotsPlan;
  return isPlanId(meta) ? meta : null;
}

/** When the subscription's current period began: on the item in current API versions. */
export function periodStartOf(s: StripeSubscription, prices: BillingPrices): Date | null {
  const seconds = seatItemOf(s, prices)?.current_period_start;
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}
