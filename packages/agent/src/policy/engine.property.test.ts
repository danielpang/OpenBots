import {
  PolicyDecisionSchema,
  RunSourceSchema,
  RunTriggerSchema,
  ToolGroupNameSchema,
  type PolicyDecision,
} from '@openbots/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type PolicyInput } from './engine.js';

// Properties of the policy engine (plan 8, T5, P2). The unit tests beside
// this file pin single cases; these say what must hold for every tool,
// trigger and setting, which is where a rule added later can go wrong.

const rank: Record<PolicyDecision, number> = { auto: 0, ask: 1, deny: 2 };
const decision = fc.constantFrom(...PolicyDecisionSchema.options);
const group = fc.constantFrom(...ToolGroupNameSchema.options);
const trigger = fc.constantFrom(...RunTriggerSchema.options);

/** Tools with rules of their own, and names the engine has never seen. */
const toolName = fc.oneof(
  fc.constantFrom('bash', 'write_file', 'send_email', 'http_request', 'web_fetch', 'read_file'),
  fc.constantFrom('code_task', 'browser_click', 'github__create_issue', 'notes__search'),
  fc.stringMatching(/^[a-z_]{1,12}$/),
  // Names every object inherits: a lookup by name must not find them.
  fc.constantFrom('constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'),
);
const args = fc.record(
  {
    method: fc.constantFrom('GET', 'POST', 'DELETE', 'head'),
    url: fc.constantFrom('https://api.example.com/x?q=1', 'https://evil.test/', 'not a url'),
  },
  { requiredKeys: [] },
);
const facts = fc.record(
  {
    group,
    annotations: fc.record(
      { readOnlyHint: fc.boolean(), destructiveHint: fc.boolean() },
      { requiredKeys: [] },
    ),
    connector: fc.record(
      {
        slug: fc.constant('github'),
        approvalOverride: fc.option(decision, { nil: null }),
        hintsTrusted: fc.boolean(),
      },
      { requiredKeys: ['slug'] },
    ),
  },
  { requiredKeys: ['group'] },
);
const decisions = fc.dictionary(toolName, decision, { maxKeys: 3 });
const groups = fc.dictionary(group, decision);
const override = fc.record({ default: decision, groups, tools: decisions }, { requiredKeys: [] });
const toolPolicy = fc.record(
  {
    tools: decisions,
    groups,
    triggers: fc.dictionary(trigger, override),
    httpAllowlist: fc.subarray(['api.example.com', '*.example.com']),
  },
  { requiredKeys: [] },
);
const input: fc.Arbitrary<PolicyInput> = fc.record(
  {
    toolName,
    args,
    facts,
    trigger,
    source: fc.constantFrom(...RunSourceSchema.options),
    toolPolicy,
  },
  { requiredKeys: ['toolName', 'args', 'facts', 'trigger'] },
);

describe('evaluatePolicy', () => {
  it('is never looser with a trigger override than without it', () => {
    fc.assert(
      fc.property(input, override, (base, triggerOverride) => {
        const without = evaluatePolicy({ ...base, triggerOverride: null });
        const withIt = evaluatePolicy({ ...base, triggerOverride });
        expect(rank[withIt.decision]).toBeGreaterThanOrEqual(rank[without.decision]);
      }),
      { numRuns: 500 },
    );
  });

  it('never lets a second override undo a stricter first one', () => {
    // Two endpoints' overrides are not combined in the product, but the rule
    // is the same one: an override that denies a tool denies it whatever
    // else the override says for groups or the default.
    fc.assert(
      fc.property(input, override, (base, extra) => {
        const triggerOverride = {
          ...extra,
          tools: { ...extra.tools, [base.toolName]: 'deny' as const },
        };
        expect(evaluatePolicy({ ...base, triggerOverride }).decision).toBe('deny');
      }),
    );
  });

  it('ends on the last step of its trace, which starts with the default rule', () => {
    fc.assert(
      fc.property(input, fc.option(override, { nil: null }), (base, triggerOverride) => {
        const { decision: result, reason, trace } = evaluatePolicy({ ...base, triggerOverride });
        expect(PolicyDecisionSchema.options).toContain(result);
        expect(trace.length).toBeGreaterThan(0);
        expect(['default', 'annotations']).toContain(trace[0]!.rule);
        expect(trace.at(-1)).toMatchObject({ decision: result, why: reason });
        // Once the trigger rules start, each one only raises the decision.
        const first = trace.findIndex((step) => step.rule === 'trigger');
        if (first === -1) return;
        for (let i = first; i < trace.length; i++) {
          expect(trace[i]!.rule).toBe('trigger');
          expect(rank[trace[i]!.decision]).toBeGreaterThan(rank[trace[i - 1]!.decision]);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('asks before a tool that changes something when a webhook or a Bot started the run', () => {
    // P2: what a webhook or another Bot wrote is data, not instructions. With
    // no settings of the owner's, nothing with side effects runs unasked.
    const changing = fc.constantFrom(
      'bash',
      'write_file',
      'edit_file',
      'delete_file',
      'send_email',
    );
    fc.assert(
      fc.property(
        changing,
        trigger,
        fc.constantFrom('bot', 'webhook'),
        group,
        (name, on, source, g) => {
          const result = evaluatePolicy({
            toolName: name,
            args: {},
            facts: { group: g },
            trigger: on,
            source,
          });
          expect(result.decision).not.toBe('auto');
        },
      ),
    );
  });

  it('gives the same answer for the same input', () => {
    fc.assert(
      fc.property(input, (base) => {
        expect(evaluatePolicy(base)).toEqual(evaluatePolicy(structuredClone(base)));
      }),
    );
  });
});
