import type { EmailOptions } from '../email.js';
import { DEFAULT_METER_EVENT, type BillingConfig } from './service.js';
import { stripeClient } from './stripe.js';

// Billing's settings from the environment (.env.example, ee/README.md):
//
// - STRIPE_SECRET_KEY: Stripe's API key. Without it plans, limits and the
//   ledger still work from the database; checkout and the portal answer 503
//   and no overage is reported.
// - STRIPE_WEBHOOK_SECRET: verifies POST /api/v1/billing/webhook.
// - STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM: the seat prices; STRIPE_PRICE_OVERAGE:
//   the metered price on the meter both plans share; STRIPE_METER_EVENT: that
//   meter's event name (`openbots_computer_hours`). `setup-stripe` makes them.
// - OPENBOTS_BILLING: `off` admits all computer work and records no usage,
//   for a development server; refused with NODE_ENV=production.

export function billingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  email: EmailOptions = {},
): BillingConfig {
  const off = env.OPENBOTS_BILLING === 'off';
  if (off && env.NODE_ENV === 'production') {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_BILLING: off gives every organization free computer time; not allowed with NODE_ENV=production',
    );
  }
  if (env.OPENBOTS_BILLING && env.OPENBOTS_BILLING !== 'on' && !off) {
    throw new Error('invalid configuration:\n  OPENBOTS_BILLING: on or off');
  }
  const key = env.STRIPE_SECRET_KEY?.trim();
  return {
    enforce: !off,
    stripe: key ? stripeClient(key) : null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    prices: {
      ...(env.STRIPE_PRICE_PRO ? { pro: env.STRIPE_PRICE_PRO.trim() } : {}),
      ...(env.STRIPE_PRICE_TEAM ? { team: env.STRIPE_PRICE_TEAM.trim() } : {}),
      ...(env.STRIPE_PRICE_OVERAGE ? { overage: env.STRIPE_PRICE_OVERAGE.trim() } : {}),
    },
    meterEventName: env.STRIPE_METER_EVENT?.trim() || DEFAULT_METER_EVENT,
    email,
  };
}
