import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { schema } from '@openbots/server/db/client';
import { inWorkspace } from '@openbots/server/db/scope';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR_SECONDS } from './plans.js';
import { billingApp, type BillingApp } from './testing.js';

// Billing keeps to the organization (plan 21.3, 21.10), as the core's
// routes/org-isolation.test.ts walks the core's routes. Every billing route
// in ee/server/openapi.json is tried by Bob, an owner of organization B, and
// by Carol, an owner of B who is also a member of A, working in B. Neither
// may read or change anything of A's: each answer leaves A's markers out, and
// A's rows are as they were.

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

const operations = Object.entries(spec.paths)
  .filter(([path]) => path.startsWith('/api/v1/billing'))
  .flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ method, path })));

const BODIES: Record<string, unknown> = {
  'patch /api/v1/billing/settings': { overagePolicy: 'allow', ceilingUsd: 999 },
  'put /api/v1/billing/members/{id}/cap': { capHours: 1 },
  'put /api/v1/billing/limit': { personalHours: 1 },
  'post /api/v1/billing/checkout': { plan: 'team' },
};

describe('billing is isolated between organizations', () => {
  let b: BillingApp;
  let alice: { cookie: string; org: string; id: string };
  let bob: { cookie: string; org: string; id: string };
  let carolInB: string;
  const snapshot = async () => ({
    billing: await b.t.db
      .select()
      .from(schema.organizationBilling)
      .where(eq(schema.organizationBilling.workspaceId, alice.org)),
    limits: await b.t.db
      .select()
      .from(schema.billingMemberLimits)
      .where(eq(schema.billingMemberLimits.workspaceId, alice.org)),
    periods: await b.t.db
      .select()
      .from(schema.billingPeriods)
      .where(eq(schema.billingPeriods.workspaceId, alice.org)),
  });

  beforeAll(async () => {
    b = await billingApp();
    alice = await b.founder('alice@example.com', 'Alpha');
    const carol = await b.invite(alice.cookie, 'carol@example.com');
    bob = await b.founder('bob@example.com', 'Bravo');
    // Carol is in A as a member, and owns nothing there; in B she is an owner.
    await b.t.addMember(carol.id, bob.org, 'owner');
    carolInB = carol.cookie;
    await b.t.switchOrganization(carolInB, bob.org);
    await b.onPlan(alice.org, {
      plan: 'team',
      status: 'active',
      stripeCustomerId: 'cus_alpha_marker',
      stripeSubscriptionId: 'sub_alpha_marker',
      billedSeats: 2,
      ceilingUsd: 77,
      periodAnchor: new Date('2026-11-01T00:00:00Z'),
    });
    await b.t.db
      .insert(schema.billingMemberLimits)
      .values({ workspaceId: alice.org, userId: alice.id, capHours: 42 });
    await inWorkspace(alice.org, () =>
      b.t.deps.extensions!.onComputerUsage!(
        {
          intervalId: randomUUID(),
          workspaceId: alice.org,
          ownerId: alice.id,
          computerId: randomUUID(),
          provider: 'sprites',
          startedAt: new Date('2026-11-20T08:00:00Z'),
          endedAt: new Date('2026-11-20T12:00:00Z'),
          seconds: 4 * HOUR_SECONDS,
        },
        b.t.deps,
      ),
    );
  });
  afterAll(() => b.t.close());

  it('covers every billing route', () => {
    expect(operations.length).toBeGreaterThanOrEqual(7);
  });

  it.each(operations)('$method $path reaches nothing of A', async ({ method, path }) => {
    const before = await snapshot();
    for (const cookie of [bob.cookie, carolInB]) {
      const res = await b.call(
        cookie,
        method.toUpperCase(),
        path.replace('/api/v1', '').replace('{id}', alice.id),
        BODIES[`${method} ${path}`],
      );
      const text = await res.text();
      for (const marker of [alice.org, 'alice@example.com', 'cus_alpha_marker', '"capHours":42']) {
        expect(text, `${method} ${path}`).not.toContain(marker);
      }
      if (path.includes('{id}')) expect(res.status).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('gives B its own figures, none of A’s usage', async () => {
    const own = (await (await b.call(bob.cookie, 'GET', '/billing')).json()) as {
      usage: { usedHours: number };
      members: { userId: string }[];
    };
    expect(own.usage.usedHours).toBe(0);
    expect(own.members.map((m) => m.userId)).not.toContain(alice.id);
  });
});
