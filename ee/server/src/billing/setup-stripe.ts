import { PLAN_IDS, PLANS, OVERAGE_USD_PER_HOUR, type PlanId } from './plans.js';
import { DEFAULT_METER_EVENT } from './service.js';

// Makes what billing needs in a Stripe account, idempotently, and prints the
// settings to give the server (plan 21.10):
//
//   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @openbots/ee-server setup-stripe \
//     [--app-url https://app.example.com]
//
// One product per plan with a monthly seat price, one product for computer
// hours with a metered price on one meter both plans share, and with
// --app-url the webhook endpoint. Every amount comes from plans.ts, so a
// pricing change is an edit there and this script again: prices cannot
// change in Stripe, so a new amount is a new price that takes the lookup key
// over, and subscriptions already sold keep theirs. Running it again creates
// nothing that is already right.
//
// A script, never server start: billing objects made by every deploy would
// turn a wrong key into objects in the wrong account.

export const SEAT_LOOKUP_KEY = (plan: PlanId) => `openbots_${plan}_seat`;
export const OVERAGE_LOOKUP_KEY = 'openbots_computer_hours_overage';
/** The events the webhook folds in (billing/service.ts `eventChange`). */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

interface Price {
  id: string;
  active: boolean;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
}

/** The Stripe calls the script makes. The SDK's client fits it. */
export interface SetupStripe {
  billing: {
    meters: {
      list(params: { status: 'active'; limit: number }): Promise<{
        data: { id: string; event_name: string }[];
      }>;
      create(params: Record<string, unknown>): Promise<{ id: string; event_name: string }>;
    };
  };
  products: {
    list(params: { active: boolean; limit: number }): Promise<{
      data: { id: string; metadata: Record<string, string> }[];
    }>;
    create(params: Record<string, unknown>): Promise<{ id: string }>;
  };
  prices: {
    list(params: { lookup_keys: string[]; limit: number }): Promise<{ data: Price[] }>;
    create(params: Record<string, unknown>): Promise<Price>;
  };
  webhookEndpoints: {
    list(params: { limit: number }): Promise<{ data: { id: string; url: string }[] }>;
    create(params: Record<string, unknown>): Promise<{ id: string; secret?: string }>;
  };
}

/** The env values to set, by name. The secret key is never printed. */
export async function setupStripe(
  stripe: SetupStripe,
  { appUrl, log = console.log }: { appUrl?: string; log?: (line: string) => void } = {},
): Promise<Record<string, string>> {
  const env: Record<string, string> = { STRIPE_METER_EVENT: DEFAULT_METER_EVENT };
  const meter = await ensureMeter(stripe, log);
  for (const plan of PLAN_IDS) {
    const product = await ensureProduct(
      stripe,
      `openbots_${plan}`,
      `OpenBots ${PLANS[plan].name}`,
      log,
    );
    const price = await ensurePrice(
      stripe,
      {
        lookup_key: SEAT_LOOKUP_KEY(plan),
        product,
        currency: 'usd',
        unit_amount: Math.round(PLANS[plan].perSeatUsd * 100),
        nickname: `${PLANS[plan].name} seat`,
        recurring: { interval: 'month', usage_type: 'licensed' },
      },
      log,
    );
    env[`STRIPE_PRICE_${plan.toUpperCase()}`] = price.id;
  }
  const hours = await ensureProduct(
    stripe,
    'openbots_computer_hours',
    'OpenBots computer hours',
    log,
  );
  // A unit is a hundredth of a computer hour: a fifth of a cent, so an hour
  // is exactly the plan's price and Stripe rounds nothing.
  const unitCents = String((OVERAGE_USD_PER_HOUR * 100) / 100);
  const overage = await ensurePrice(
    stripe,
    {
      lookup_key: OVERAGE_LOOKUP_KEY,
      product: hours,
      currency: 'usd',
      unit_amount_decimal: unitCents,
      nickname: 'Computer hours past the allowance (per hundredth of an hour)',
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    },
    log,
  );
  env.STRIPE_PRICE_OVERAGE = overage.id;
  if (appUrl) {
    const secret = await ensureWebhook(
      stripe,
      `${appUrl.replace(/\/$/, '')}/api/v1/billing/webhook`,
      log,
    );
    if (secret) env.STRIPE_WEBHOOK_SECRET = secret;
  }
  return env;
}

async function ensureMeter(stripe: SetupStripe, log: (line: string) => void) {
  const { data } = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  const found = data.find((m) => m.event_name === DEFAULT_METER_EVENT);
  if (found) {
    log(`Meter ${DEFAULT_METER_EVENT} is there (${found.id}).`);
    return found;
  }
  const meter = await stripe.billing.meters.create({
    display_name: 'OpenBots computer hours (hundredths)',
    event_name: DEFAULT_METER_EVENT,
    default_aggregation: { formula: 'sum' },
    // The two keys billing sends: the customer and the units.
    customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
    value_settings: { event_payload_key: 'value' },
  });
  log(`Made the meter ${DEFAULT_METER_EVENT} (${meter.id}).`);
  return meter;
}

async function ensureProduct(
  stripe: SetupStripe,
  key: string,
  name: string,
  log: (line: string) => void,
): Promise<string> {
  const { data } = await stripe.products.list({ active: true, limit: 100 });
  const found = data.find((p) => p.metadata.openbots === key);
  if (found) return found.id;
  const product = await stripe.products.create({ name, metadata: { openbots: key } });
  log(`Made the product ${name} (${product.id}).`);
  return product.id;
}

async function ensurePrice(
  stripe: SetupStripe,
  spec: Record<string, unknown> & { lookup_key: string },
  log: (line: string) => void,
): Promise<Price> {
  const { data } = await stripe.prices.list({ lookup_keys: [spec.lookup_key], limit: 1 });
  const found = data[0];
  const same =
    found?.active &&
    (spec.unit_amount !== undefined
      ? found.unit_amount === spec.unit_amount
      : Number(found.unit_amount_decimal) === Number(spec.unit_amount_decimal));
  if (found && same) {
    log(`Price ${spec.lookup_key} is right (${found.id}).`);
    return found;
  }
  const price = await stripe.prices.create({ ...spec, transfer_lookup_key: true });
  log(`${found ? 'Replaced' : 'Made'} the price ${spec.lookup_key} (${price.id}).`);
  return price;
}

async function ensureWebhook(stripe: SetupStripe, url: string, log: (line: string) => void) {
  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = data.find((e) => e.url === url);
  if (found) {
    log(
      `The webhook for ${url} is there (${found.id}). Stripe shows its signing secret only when it is made; roll it in the dashboard if it is lost.`,
    );
    return null;
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: 'OpenBots billing',
  });
  log(`Made the webhook for ${url} (${endpoint.id}).`);
  return endpoint.secret ?? null;
}
