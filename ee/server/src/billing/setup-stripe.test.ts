import { describe, expect, it } from 'vitest';
import {
  OVERAGE_LOOKUP_KEY,
  setupStripe,
  WEBHOOK_EVENTS,
  type SetupStripe,
} from './setup-stripe.js';

// The Stripe setup script against a fake account (plan 21.10): what it makes
// comes from plans.ts, and a second run makes nothing.

function fakeAccount() {
  let n = 0;
  const made: { kind: string; params: Record<string, unknown> }[] = [];
  const meters: { id: string; event_name: string }[] = [];
  const products: { id: string; metadata: Record<string, string> }[] = [];
  const prices: {
    id: string;
    active: boolean;
    unit_amount: number | null;
    unit_amount_decimal: string | null;
    lookup_key: string;
  }[] = [];
  const hooks: { id: string; url: string }[] = [];
  const stripe: SetupStripe = {
    billing: {
      meters: {
        list: async () => ({ data: meters }),
        create: async (params) => {
          made.push({ kind: 'meter', params });
          const meter = { id: `mtr_${++n}`, event_name: params.event_name as string };
          meters.push(meter);
          return meter;
        },
      },
    },
    products: {
      list: async () => ({ data: products }),
      create: async (params) => {
        made.push({ kind: 'product', params });
        const product = { id: `prod_${++n}`, metadata: params.metadata as Record<string, string> };
        products.push(product);
        return product;
      },
    },
    prices: {
      list: async ({ lookup_keys }) => ({
        data: prices.filter((p) => lookup_keys.includes(p.lookup_key) && p.active),
      }),
      create: async (params) => {
        made.push({ kind: 'price', params });
        for (const p of prices) if (p.lookup_key === params.lookup_key) p.active = false;
        const price = {
          id: `price_${++n}`,
          active: true,
          unit_amount: (params.unit_amount as number | undefined) ?? null,
          unit_amount_decimal: (params.unit_amount_decimal as string | undefined) ?? null,
          lookup_key: params.lookup_key as string,
        };
        prices.push(price);
        return price;
      },
    },
    webhookEndpoints: {
      list: async () => ({ data: hooks }),
      create: async (params) => {
        made.push({ kind: 'webhook', params });
        const hook = { id: `we_${++n}`, url: params.url as string, secret: 'whsec_made' };
        hooks.push(hook);
        return hook;
      },
    },
  };
  return { stripe, made };
}

describe('setup-stripe', () => {
  it('makes the seat prices, the metered overage price on one meter, and the webhook', async () => {
    const { stripe, made } = fakeAccount();
    const env = await setupStripe(stripe, { appUrl: 'https://app.example.com/', log: () => {} });
    const prices = made.filter((m) => m.kind === 'price').map((m) => m.params);
    expect(prices).toEqual([
      expect.objectContaining({ lookup_key: 'openbots_pro_seat', unit_amount: 2000 }),
      expect.objectContaining({ lookup_key: 'openbots_team_seat', unit_amount: 1800 }),
      expect.objectContaining({
        lookup_key: OVERAGE_LOOKUP_KEY,
        // A hundredth of an hour at $0.20 an hour: 0.2 cents.
        unit_amount_decimal: '0.2',
        recurring: { interval: 'month', usage_type: 'metered', meter: expect.any(String) },
      }),
    ]);
    const meter = made.find((m) => m.kind === 'meter')!.params;
    expect(meter).toMatchObject({
      event_name: 'openbots_computer_hours',
      customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
      value_settings: { event_payload_key: 'value' },
    });
    expect(made.find((m) => m.kind === 'webhook')!.params).toMatchObject({
      url: 'https://app.example.com/api/v1/billing/webhook',
      enabled_events: WEBHOOK_EVENTS,
    });
    expect(Object.keys(env).sort()).toEqual([
      'STRIPE_METER_EVENT',
      'STRIPE_PRICE_OVERAGE',
      'STRIPE_PRICE_PRO',
      'STRIPE_PRICE_TEAM',
      'STRIPE_WEBHOOK_SECRET',
    ]);
    expect(JSON.stringify(env)).not.toContain('sk_');
  });

  it('makes nothing the second time, and answers the same prices', async () => {
    const { stripe, made } = fakeAccount();
    const first = await setupStripe(stripe, { appUrl: 'https://app.example.com', log: () => {} });
    made.length = 0;
    const second = await setupStripe(stripe, { appUrl: 'https://app.example.com', log: () => {} });
    expect(made).toEqual([]);
    const { STRIPE_WEBHOOK_SECRET: _, ...rest } = first;
    expect(second).toEqual(rest);
  });
});
