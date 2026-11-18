import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chainLimitsFor, DEFAULT_CHAIN_LIMITS, withinChainLimits } from './limits.js';

// The loop guards (plan 7) are what stops two Bots answering each other for
// ever, so they must hold for every chat setting and every chain.

const limits = fc.record({
  maxChainDepth: fc.integer({ min: 1, max: 50 }),
  botRunBudget: fc.integer({ min: 1, max: 200 }),
  budgetWindowMs: fc.constant(DEFAULT_CHAIN_LIMITS.budgetWindowMs),
});
const candidate = fc.record({
  depth: fc.integer({ min: 1, max: 100 }),
  botTriggered: fc.boolean(),
  recentBotRuns: fc.nat({ max: 400 }),
});

describe('chainLimitsFor', () => {
  it('returns positive whole limits whatever the chat settings hold', () => {
    fc.assert(
      fc.property(fc.anything(), (settings) => {
        const result = chainLimitsFor(settings);
        for (const value of Object.values(result)) {
          expect(Number.isInteger(value) && value > 0).toBe(true);
        }
      }),
    );
  });

  it('ignores a limit that is not a positive whole number', () => {
    const bad = fc.oneof(
      fc.integer({ max: 0 }),
      fc.double({ noInteger: true }),
      fc.string(),
      fc.constant(null),
    );
    fc.assert(
      fc.property(bad, bad, (depth, budget) => {
        expect(chainLimitsFor({ max_chain_depth: depth, bot_run_budget: budget })).toEqual(
          DEFAULT_CHAIN_LIMITS,
        );
      }),
    );
  });
});

describe('withinChainLimits', () => {
  it('stops every chain past the depth limit, whoever started the run', () => {
    fc.assert(
      fc.property(candidate, limits, (run, chain) => {
        const result = withinChainLimits(run, chain);
        if (run.depth > chain.maxChainDepth) expect(result).toEqual({ ok: false, reason: 'depth' });
      }),
    );
  });

  it('never charges the owner’s own messages to the Bot budget', () => {
    fc.assert(
      fc.property(candidate, limits, (run, chain) => {
        const result = withinChainLimits({ ...run, botTriggered: false }, chain);
        expect(result.ok).toBe(run.depth <= chain.maxChainDepth);
      }),
    );
  });

  it('stays stopped as a chain gets deeper or a chat busier', () => {
    fc.assert(
      fc.property(
        candidate,
        limits,
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        (run, chain, d, r) => {
          if (withinChainLimits(run, chain).ok) return;
          const later = { ...run, depth: run.depth + d, recentBotRuns: run.recentBotRuns + r };
          expect(withinChainLimits(later, chain).ok).toBe(false);
        },
      ),
    );
  });

  it('allows at most the budget of Bot started runs in a window', () => {
    fc.assert(
      fc.property(limits, (chain) => {
        let started = 0;
        for (let i = 0; i < chain.botRunBudget + 20; i++) {
          const run = { depth: 1, botTriggered: true, recentBotRuns: started };
          if (withinChainLimits(run, chain).ok) started++;
        }
        expect(started).toBe(chain.botRunBudget);
      }),
    );
  });
});
