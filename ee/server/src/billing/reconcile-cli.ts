// `pnpm --filter @openbots/ee-server reconcile --since 2026-11-01 --until 2026-12-01 [--csv usage.csv]`:
// compares the billing ledger with what Fly billed for Sprites in the window
// (billing/reconcile.ts) and prints the differences. It changes nothing.
// Reads DATABASE_URL, and OPENBOTS_SPRITES_TOKEN unless --csv names an export.
import { readFileSync } from 'node:fs';
import { loadConfig } from '@openbots/server/config';
import { createDb } from '@openbots/server/db/client';
import { scopedDb } from '@openbots/server/db/scope';
import { csvUsageSource, reconcile, spritesUsageSource } from './reconcile.js';

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : undefined;
};
const since = new Date(arg('since') ?? '');
const until = new Date(arg('until') ?? '');
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
  console.error('reconcile: give --since and --until as dates, the first before the second');
  process.exit(1);
}
const config = loadConfig();
const csv = arg('csv');
const token = process.env.OPENBOTS_SPRITES_TOKEN;
if (!csv && !token) {
  console.error('reconcile: set OPENBOTS_SPRITES_TOKEN, or give --csv with an export');
  process.exit(1);
}
const source = csv
  ? csvUsageSource(readFileSync(csv, 'utf8'))
  : spritesUsageSource({ token: token! });
const db = scopedDb(createDb(config.databaseUrl, { max: 1 }));
const found = await reconcile(db, source, since, until, {
  namePrefix: process.env.OPENBOTS_SPRITES_NAME_PREFIX || 'ob',
});
const h = (n: number) => n.toFixed(2);
if (!found.length) console.log('reconcile: the ledger and the provider agree.');
for (const d of found) {
  console.log(
    d.workspaceId
      ? `${d.workspaceId}: ledger ${h(d.ledgerHours)} h, provider ${h(d.providerHours)} h, ${
          d.overMeteredHours > 0
            ? `over metered by ${h(d.overMeteredHours)} h: do not bill past the provider`
            : `under metered by ${h(-d.overMeteredHours)} h`
        }`
      : `No organization: ${d.sprites!.length} Sprites billed for ${h(d.providerHours)} h (${d.sprites!.join(', ')})`,
  );
}
process.exit(found.some((d) => d.overMeteredHours > 0) ? 2 : 0);
