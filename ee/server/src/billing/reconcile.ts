import { spriteName } from '@openbots/computer';
import { schema, type Db } from '@openbots/server/db/client';
import { forEachWorkspace } from '@openbots/server/db/scope';
import { and, eq } from 'drizzle-orm';
import { HOUR_SECONDS } from './plans.js';
import { ledgerSecondsBetween } from './store.js';

// Reconciliation (plan 21.10): what the ledger says each organization used
// against what Fly billed us for its Sprites over the same window. The rule
// it watches: never bill a customer for more hours than the provider billed
// us. It reports and never corrects: a discrepancy has a cause, and quietly
// changing a customer's usage to match an invoice would hide it.
//
// The ledger side counts usage by when it ended, the provider side by when
// the machine was awake, so an interval straddling the window's edge lands
// on one side only: small differences at the edges are expected, not bills.

/** What the provider billed for one Sprite in a window. */
export interface ProviderUsage {
  /**
   * The Sprite's name, as Fly knows it: `<prefix>-<computer id without dashes>`, or the
   * machine key in place of the id after a full reset.
   */
  name: string;
  /** Seconds it was awake and billed. */
  awakeSeconds: number;
}

/**
 * Where the provider's figures come from: its usage API, or an export
 * someone downloaded. `until` is required: comparing a closed window to an
 * open one would report every organization as over metered.
 */
export interface ProviderUsageSource {
  usageBetween(since: Date, until: Date): Promise<ProviderUsage[]>;
}

export interface Discrepancy {
  workspaceId: string | null;
  /** Sprites the provider billed that no organization's computer is or was (retired). */
  sprites?: string[];
  ledgerHours: number;
  providerHours: number;
  /** Positive when the ledger counted more than the provider billed: the one that must not be billed. */
  overMeteredHours: number;
}

/** Differences smaller than this, either way, are the window's edges, not findings. */
export const RECONCILE_TOLERANCE_HOURS = 0.25;

/**
 * Every organization whose ledger and the provider disagree by more than
 * the tolerance, the over metered first, and the Sprites no organization
 * owns. Runs in each organization's scope in turn.
 */
export async function reconcile(
  db: Db,
  source: ProviderUsageSource,
  since: Date,
  until: Date,
  { namePrefix = 'ob' }: { namePrefix?: string } = {},
): Promise<Discrepancy[]> {
  const billed = new Map<string, number>();
  for (const row of await source.usageBetween(since, until)) {
    billed.set(row.name, (billed.get(row.name) ?? 0) + row.awakeSeconds);
  }
  const found: Discrepancy[] = [];
  const claimed = new Set<string>();
  await forEachWorkspace(db, async (workspaceId) => {
    let providerSeconds = 0;
    for (const name of await spritesOf(db, workspaceId, namePrefix)) {
      if (!billed.has(name)) continue;
      claimed.add(name);
      providerSeconds += billed.get(name)!;
    }
    const ledgerSeconds = await ledgerSecondsBetween(db, workspaceId, since, until);
    const ledgerHours = ledgerSeconds / HOUR_SECONDS;
    const providerHours = providerSeconds / HOUR_SECONDS;
    const over = ledgerHours - providerHours;
    if (Math.abs(over) > RECONCILE_TOLERANCE_HOURS) {
      found.push({ workspaceId, ledgerHours, providerHours, overMeteredHours: over });
    }
  });
  const orphans = [...billed.keys()].filter((name) => !claimed.has(name));
  if (orphans.length) {
    const seconds = orphans.reduce((sum, name) => sum + billed.get(name)!, 0);
    // A machine we pay for and no organization is charged for: usually a
    // Sprite a deleted computer left behind.
    found.push({
      workspaceId: null,
      sprites: orphans,
      ledgerHours: 0,
      providerHours: seconds / HOUR_SECONDS,
      overMeteredHours: -seconds / HOUR_SECONDS,
    });
  }
  return found.sort((a, b) => b.overMeteredHours - a.overMeteredHours);
}

/**
 * The names of every Sprite an organization's computers have had. A computer
 * is named from its machine key once a full reset gave it one, else from its
 * id; the Sprite a reset retired keeps its old name, recorded on its
 * `retired_computers` row, and the member's usage before the reset was on it.
 */
async function spritesOf(db: Db, workspaceId: string, namePrefix: string): Promise<Set<string>> {
  const names = new Set<string>();
  const computers = await db
    .select({
      id: schema.computers.id,
      provider: schema.computers.provider,
      containerId: schema.computers.containerId,
      spec: schema.computers.spec,
    })
    .from(schema.computers)
    .where(eq(schema.computers.workspaceId, workspaceId));
  for (const computer of computers) {
    const machineKey = (computer.spec as { machineKey?: string } | null)?.machineKey;
    names.add(spriteName(machineKey ?? computer.id, namePrefix));
    if (computer.provider === 'sprites' && computer.containerId) names.add(computer.containerId);
  }
  const retired = await db
    .select({ providerRef: schema.retiredComputers.providerRef })
    .from(schema.retiredComputers)
    .where(
      and(
        eq(schema.retiredComputers.workspaceId, workspaceId),
        eq(schema.retiredComputers.provider, 'sprites'),
      ),
    );
  for (const { providerRef } of retired) names.add(providerRef);
  return names;
}

/**
 * A provider export as CSV: a header with `name` and `awake_seconds` (or
 * `awake_hours`) columns, one Sprite a line. For an invoice someone
 * downloaded, when the API is not the source.
 */
export function csvUsageSource(text: string): ProviderUsageSource {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = (header ?? '').split(',').map((c) => c.trim().toLowerCase());
  const name = columns.indexOf('name');
  const seconds = columns.indexOf('awake_seconds');
  const hours = columns.indexOf('awake_hours');
  if (name < 0 || (seconds < 0 && hours < 0)) {
    throw new Error('The CSV needs a name column and awake_seconds or awake_hours');
  }
  const rows = lines.filter(Boolean).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const value = Number(seconds >= 0 ? cells[seconds] : cells[hours]);
    if (!Number.isFinite(value)) throw new Error(`Not a number in: ${line}`);
    return { name: cells[name]!, awakeSeconds: seconds >= 0 ? value : value * HOUR_SECONDS };
  });
  return { usageBetween: async () => rows };
}

/**
 * The Sprites API as the source. UNVERIFIED: written without a Fly account
 * and without the usage pages of the Sprites docs (docs.fly.io was not
 * reachable), so the path (`GET /v1/usage?start=&end=`, ISO times) and the
 * answer's shape (`{ sprites: [{ name, awake_seconds }] }`) are assumptions
 * to check against the docs before relying on it. It refuses an answer of
 * any other shape rather than reading it as no usage, which would make every
 * organization look over metered or, worse, hide a real difference.
 */
export function spritesUsageSource({
  token,
  baseUrl = 'https://api.sprites.dev',
  fetch: doFetch = fetch,
}: {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): ProviderUsageSource {
  return {
    async usageBetween(since, until) {
      const url = new URL(`${baseUrl.replace(/\/+$/, '')}/v1/usage`);
      url.searchParams.set('start', since.toISOString());
      url.searchParams.set('end', until.toISOString());
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`The Sprites usage API answered ${res.status}`);
      const body = (await res.json()) as { sprites?: unknown };
      if (!Array.isArray(body.sprites)) {
        throw new Error('The Sprites usage API answered in a shape this does not know');
      }
      return body.sprites.map((row: unknown) => {
        const r = row as { name?: unknown; awake_seconds?: unknown };
        if (typeof r.name !== 'string' || typeof r.awake_seconds !== 'number') {
          throw new Error('The Sprites usage API answered in a shape this does not know');
        }
        return { name: r.name, awakeSeconds: r.awake_seconds };
      });
    },
  };
}
