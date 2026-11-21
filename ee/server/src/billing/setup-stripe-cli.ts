// `pnpm --filter @openbots/ee-server setup-stripe [--app-url <url>]`: makes
// billing's products, prices, meter and webhook in the Stripe account of
// STRIPE_SECRET_KEY (billing/setup-stripe.ts) and prints what to set.
import Stripe from 'stripe';
import { setupStripe, type SetupStripe } from './setup-stripe.js';

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error('Set STRIPE_SECRET_KEY first. Use a test mode key to try it out.');
  process.exit(1);
}
const at = process.argv.indexOf('--app-url');
const appUrl = at > -1 ? process.argv[at + 1] : undefined;
console.log(`Setting up Stripe (${key.startsWith('sk_live') ? 'live' : 'test'} mode).`);
const env = await setupStripe(new Stripe(key) as unknown as SetupStripe, {
  ...(appUrl ? { appUrl } : {}),
});
console.log('\nSet these on the managed server, with STRIPE_SECRET_KEY:\n');
for (const [name, value] of Object.entries(env)) console.log(`${name}=${value}`);
if (!appUrl) console.log('\nNo --app-url, so no webhook endpoint was made.');
