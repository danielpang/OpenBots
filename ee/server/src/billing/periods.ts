// Billing periods (plan 21.10): monthly from an anchor, Stripe's own period
// start once there is a subscription, so the allowance and the invoice cover
// the same days. Pure date arithmetic in UTC, so it is tested without a
// database and the gate, the ledger and the Billing tab cannot disagree.

export interface Period {
  start: Date;
  end: Date;
}

/**
 * `anchor` plus `months`, keeping the anchor's day where the month has it
 * and clamping to the month's last day where it does not: an anchor on
 * 31 January gives 28 (or 29) February, then 31 March. Always counted from
 * the anchor, never from the previous result, so a short month does not
 * pull every later period earlier.
 */
export function addMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The period that holds `at`: before the anchor too, counting back. */
export function periodAt(anchor: Date, at: Date): Period {
  let n =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth());
  while (addMonths(anchor, n).getTime() > at.getTime()) n--;
  while (addMonths(anchor, n + 1).getTime() <= at.getTime()) n++;
  return { start: addMonths(anchor, n), end: addMonths(anchor, n + 1) };
}

export interface PeriodShare extends Period {
  seconds: number;
}

/**
 * Splits an interval's seconds between the periods its wall clock span
 * crosses, in proportion to the time in each. The core's `seconds` can be
 * less than the span (time another interval of the computer already
 * counted), so the share, not the span, is split. Rounded to whole seconds
 * by largest remainder, so the parts add up to exactly `seconds`: a split
 * never adds or loses a second. A span of no length goes to the period of
 * its end.
 */
export function splitAcrossPeriods(
  anchor: Date,
  startedAt: Date,
  endedAt: Date,
  seconds: number,
): PeriodShare[] {
  const start = startedAt.getTime();
  const end = Math.max(endedAt.getTime(), start);
  const total = Math.max(0, Math.round(seconds));
  if (end === start) return [{ ...periodAt(anchor, endedAt), seconds: total }];
  const parts: (Period & { exact: number })[] = [];
  let period = periodAt(anchor, new Date(start));
  for (;;) {
    const from = Math.max(start, period.start.getTime());
    const to = Math.min(end, period.end.getTime());
    if (to > from) parts.push({ ...period, exact: (total * (to - from)) / (end - start) });
    if (period.end.getTime() >= end) break;
    period = periodAt(anchor, period.end);
  }
  const floors = parts.map((p) => Math.floor(p.exact));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = parts
    .map((p, i) => ({ i, rest: p.exact - floors[i]! }))
    .sort((a, b) => b.rest - a.rest || b.i - a.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]!++;
    left--;
  }
  return parts.map((p, i) => ({ start: p.start, end: p.end, seconds: floors[i]! }));
}
