import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PolicyDecisionSchema,
  resolveToolPolicy,
  RunTriggerSchema,
  stricterDecision,
  ToolGroupNameSchema,
  ToolPolicySchema,
  type PolicyDecision,
  type ToolPolicy,
} from './policy.js';

// Properties of the stored tool policy: statements that hold for every input,
// checked against generated ones rather than the cases someone thought of.

const decision = fc.constantFrom(...PolicyDecisionSchema.options);
const rank: Record<PolicyDecision, number> = { auto: 0, ask: 1, deny: 2 };

const toolName = fc.stringMatching(/^[a-z_]{1,12}$/);
const decisions = fc.dictionary(toolName, decision, { maxKeys: 4 });
const groups = fc.dictionary(fc.constantFrom(...ToolGroupNameSchema.options), decision);
const override = fc.record({ default: decision, groups, tools: decisions }, { requiredKeys: [] });
/** A policy the settings page could have stored. */
const toolPolicy: fc.Arbitrary<ToolPolicy> = fc.record(
  {
    tools: decisions,
    groups,
    triggers: fc.dictionary(fc.constantFrom(...RunTriggerSchema.options), override),
  },
  { requiredKeys: [] },
);

describe('stricterDecision', () => {
  it('is at least as strict as both sides, and is one of them', () => {
    fc.assert(
      fc.property(decision, decision, (a, b) => {
        const result = stricterDecision(a, b);
        expect(rank[result]).toBe(Math.max(rank[a], rank[b]));
      }),
    );
  });

  it('does not depend on the order or the grouping', () => {
    fc.assert(
      fc.property(decision, decision, decision, (a, b, c) => {
        expect(stricterDecision(a, b)).toBe(stricterDecision(b, a));
        expect(stricterDecision(stricterDecision(a, b), c)).toBe(
          stricterDecision(a, stricterDecision(b, c)),
        );
      }),
    );
  });
});

describe('resolveToolPolicy', () => {
  it('reads anything a database column could hold without throwing', () => {
    fc.assert(
      fc.property(fc.anything(), (stored) => {
        const policy = resolveToolPolicy(stored);
        expect(policy.httpAllowlist === null || Array.isArray(policy.httpAllowlist)).toBe(true);
        expect(typeof policy.tools).toBe('object');
        expect(typeof policy.coder).toBe('object');
      }),
    );
  });

  it('makes webhook and Bot started runs ask unless the owner set that default', () => {
    fc.assert(
      fc.property(fc.anything(), (stored) => {
        const { triggers } = resolveToolPolicy(stored);
        const parsed = ToolPolicySchema.safeParse(stored);
        for (const trigger of ['webhook', 'bot_dm'] as const) {
          const own = parsed.success ? parsed.data.triggers?.[trigger]?.default : undefined;
          expect(triggers[trigger]?.default).toBe(own ?? 'ask');
        }
      }),
    );
  });

  it('keeps every setting of a valid policy', () => {
    fc.assert(
      fc.property(toolPolicy, (stored) => {
        const policy = resolveToolPolicy(stored);
        expect(policy.tools).toEqual(stored.tools ?? {});
        expect(policy.groups).toEqual(stored.groups ?? {});
        for (const [trigger, own] of Object.entries(stored.triggers ?? {})) {
          const merged = policy.triggers[trigger as keyof typeof policy.triggers];
          expect(merged?.tools ?? {}).toEqual(own?.tools ?? {});
          expect(merged?.groups ?? {}).toEqual(own?.groups ?? {});
        }
      }),
    );
  });

  it('gives the same answer for a policy stored again from its resolved form', () => {
    fc.assert(
      fc.property(toolPolicy, (stored) => {
        const once = resolveToolPolicy(stored);
        const { httpAllowlist, ...rest } = once;
        const again = resolveToolPolicy(httpAllowlist ? { ...rest, httpAllowlist } : rest);
        expect(again).toEqual(once);
      }),
    );
  });
});
