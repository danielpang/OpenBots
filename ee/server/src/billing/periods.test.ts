import { describe, expect, it } from 'vitest';
import { addMonths, periodAt, splitAcrossPeriods } from './periods.js';

// Monthly periods from an anchor, and an interval's seconds split where it
// crosses one's end (plan 21.10).

const d = (iso: string) => new Date(iso);

describe('periods', () => {
  it('keeps the anchor’s day, clamped in short months, counted from the anchor', () => {
    const anchor = d('2026-01-31T10:00:00Z');
    expect(addMonths(anchor, 1)).toEqual(d('2026-02-28T10:00:00Z'));
    expect(addMonths(anchor, 2)).toEqual(d('2026-03-31T10:00:00Z'));
    expect(addMonths(anchor, 13)).toEqual(d('2027-02-28T10:00:00Z'));
    expect(addMonths(d('2028-01-31T00:00:00Z'), 1)).toEqual(d('2028-02-29T00:00:00Z'));
    expect(addMonths(anchor, -2)).toEqual(d('2025-11-30T10:00:00Z'));
  });

  it('finds the period holding a moment, before the anchor too', () => {
    const anchor = d('2026-01-31T10:00:00Z');
    expect(periodAt(anchor, d('2026-03-05T00:00:00Z'))).toEqual({
      start: d('2026-02-28T10:00:00Z'),
      end: d('2026-03-31T10:00:00Z'),
    });
    expect(periodAt(anchor, d('2026-03-31T10:00:00Z')).start).toEqual(d('2026-03-31T10:00:00Z'));
    expect(periodAt(anchor, d('2026-03-31T09:59:59Z')).start).toEqual(d('2026-02-28T10:00:00Z'));
    expect(periodAt(anchor, d('2025-12-31T09:00:00Z'))).toEqual({
      start: d('2025-11-30T10:00:00Z'),
      end: d('2025-12-31T10:00:00Z'),
    });
  });
});

describe('splitting an interval at a period boundary', () => {
  const anchor = d('2026-11-01T00:00:00Z');

  it('keeps an interval inside one period whole', () => {
    expect(
      splitAcrossPeriods(anchor, d('2026-11-10T00:00:00Z'), d('2026-11-10T01:00:00Z'), 3600),
    ).toEqual([{ start: anchor, end: d('2026-12-01T00:00:00Z'), seconds: 3600 }]);
  });

  it('splits in proportion to the time on each side, adding up exactly', () => {
    const parts = splitAcrossPeriods(
      anchor,
      d('2026-11-30T23:00:00Z'),
      d('2026-12-01T01:00:00Z'),
      7200,
    );
    expect(parts).toEqual([
      { start: anchor, end: d('2026-12-01T00:00:00Z'), seconds: 3600 },
      { start: d('2026-12-01T00:00:00Z'), end: d('2027-01-01T00:00:00Z'), seconds: 3600 },
    ]);
  });

  it('splits only the seconds the interval counted, and rounds without losing one', () => {
    // Half the span on each side, 101 seconds counted: the odd one goes to the later period.
    const parts = splitAcrossPeriods(
      anchor,
      d('2026-11-30T23:59:00Z'),
      d('2026-12-01T00:01:00Z'),
      101,
    );
    expect(parts.map((p) => p.seconds)).toEqual([50, 51]);
    expect(parts.reduce((a, p) => a + p.seconds, 0)).toBe(101);
  });

  it('crosses several periods when it must', () => {
    const parts = splitAcrossPeriods(
      anchor,
      d('2026-10-31T12:00:00Z'),
      d('2026-12-01T12:00:00Z'),
      1000,
    );
    expect(parts.map((p) => p.start)).toEqual([
      d('2026-10-01T00:00:00Z'),
      d('2026-11-01T00:00:00Z'),
      d('2026-12-01T00:00:00Z'),
    ]);
    expect(parts.reduce((a, p) => a + p.seconds, 0)).toBe(1000);
  });

  it('puts an instant, or a span that ends before it starts, in the period of its end', () => {
    expect(
      splitAcrossPeriods(anchor, d('2026-12-01T00:00:00Z'), d('2026-12-01T00:00:00Z'), 5),
    ).toEqual([{ start: d('2026-12-01T00:00:00Z'), end: d('2027-01-01T00:00:00Z'), seconds: 5 }]);
  });

  it('adds up exactly for any split', () => {
    for (let i = 0; i < 200; i++) {
      const start = d('2026-11-30T00:00:00Z').getTime() + Math.floor(Math.random() * 86_400_000);
      const length = Math.floor(Math.random() * 3 * 86_400_000);
      const seconds = Math.floor(Math.random() * (length / 1000 + 1));
      const parts = splitAcrossPeriods(anchor, new Date(start), new Date(start + length), seconds);
      expect(parts.reduce((a, p) => a + p.seconds, 0)).toBe(seconds);
      expect(parts.every((p) => p.seconds >= 0)).toBe(true);
    }
  });
});
