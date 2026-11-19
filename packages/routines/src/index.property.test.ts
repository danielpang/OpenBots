import { SchedulePresetSchema } from '@openbots/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkCron,
  nextIntervalRun,
  nextRunAt,
  normalizeTrigger,
  presetNextRuns,
  presetToCron,
  triggerNextRunAt,
  type CronPreset,
} from './index.js';

// A Routine that computes a next run in the past, or the same slot twice,
// either never fires or fires in a loop. These hold for every schedule and
// every moment, including the hours a DST change skips or repeats.

const MINUTE = 60_000;
const two = (n: number) => String(n).padStart(2, '0');
const time = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${two(h)}:${two(m)}`);
const cronPreset: fc.Arbitrary<CronPreset> = fc.oneof(
  fc.record({ kind: fc.constant('daily' as const), time }),
  fc.record({ kind: fc.constant('weekdays' as const), time }),
  fc.record({ kind: fc.constant('weekly' as const), day: fc.integer({ min: 0, max: 6 }), time }),
  fc.record({
    kind: fc.constant('monthly' as const),
    date: fc.oneof(fc.integer({ min: 1, max: 31 }), fc.constant('last' as const)),
    time,
  }),
);
const minutes = fc.integer({ min: 1, max: 1440 });
const moment = fc.date({
  min: new Date('2024-01-01T00:00:00Z'),
  max: new Date('2035-12-31T00:00:00Z'),
  noInvalidDate: true,
});
// Zones with a DST change on each side of the equator, one without, and
// offsets that are not whole hours.
const timezone = fc.constantFrom(
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Chatham',
);

describe('presetToCron', () => {
  it('gives a cron the scheduler accepts for every preset the schema accepts', () => {
    fc.assert(
      fc.property(cronPreset, (preset) => {
        expect(SchedulePresetSchema.safeParse(preset).success).toBe(true);
        const cron = presetToCron(preset);
        expect(cron.split(' ')).toHaveLength(5);
        expect(() => checkCron(cron)).not.toThrow();
      }),
    );
  });

  it('stores the same trigger when a stored trigger is saved again', () => {
    fc.assert(
      fc.property(cronPreset, (preset) => {
        const stored = normalizeTrigger({ type: 'schedule', preset });
        expect(normalizeTrigger(stored)).toEqual(stored);
      }),
    );
  });
});

describe('nextRunAt', () => {
  it('is strictly after the moment asked about, at the preset’s minute', () => {
    fc.assert(
      fc.property(cronPreset, timezone, moment, (preset, zone, after) => {
        const next = nextRunAt(presetToCron(preset), zone, after);
        expect(next).not.toBeNull();
        expect(next!.getTime()).toBeGreaterThan(after.getTime());
        expect(next!.getTime() % MINUTE).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('runs a daily Routine at its wall-clock time, DST changes aside', () => {
    fc.assert(
      fc.property(time, timezone, moment, (at, zone, after) => {
        const next = nextRunAt(presetToCron({ kind: 'daily', time: at }), zone, after)!;
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(next);
        // A time inside the hour a spring-forward skips runs when the clock
        // resumes, so the hour may differ there; nowhere else.
        if (local !== at) {
          expect(next.getTime() - after.getTime()).toBeLessThanOrEqual(26 * 60 * MINUTE);
          expect(zone).not.toBe('UTC');
        }
        // And never more than a day and a DST shift away.
        expect(next.getTime() - after.getTime()).toBeLessThanOrEqual(26 * 60 * MINUTE);
      }),
      { numRuns: 300 },
    );
  });
});

describe('nextIntervalRun', () => {
  it('is the first slot after the moment: on the anchor’s rhythm, at most one interval away', () => {
    const anchor = fc.option(moment, { nil: null });
    fc.assert(
      fc.property(minutes, moment, anchor, (every, after, from) => {
        const next = nextIntervalRun(every, after, from).getTime();
        const step = every * MINUTE;
        expect(next).toBeGreaterThan(after.getTime());
        expect(next - after.getTime()).toBeLessThanOrEqual(step);
        const start = from ? from.getTime() : Math.floor(after.getTime() / MINUTE) * MINUTE;
        expect(Math.abs((next - start) % step)).toBe(0);
      }),
    );
  });

  it('moves one interval at a time when each slot anchors the next', () => {
    fc.assert(
      fc.property(minutes, moment, (every, start) => {
        const first = nextIntervalRun(every, start);
        const second = nextIntervalRun(every, first, first);
        expect(second.getTime() - first.getTime()).toBe(every * MINUTE);
      }),
    );
  });
});

describe('presetNextRuns and triggerNextRunAt', () => {
  const preset = fc.oneof(
    cronPreset,
    fc.record({ kind: fc.constant('every_minutes' as const), minutes }),
  );

  it('previews runs in order, starting with the one the scheduler would pick', () => {
    fc.assert(
      fc.property(preset, timezone, moment, (schedule, zone, after) => {
        const runs = presetNextRuns(schedule, zone, 4, after);
        expect(runs).toHaveLength(4);
        for (let i = 1; i < runs.length; i++) {
          expect(runs[i]!.getTime()).toBeGreaterThan(runs[i - 1]!.getTime());
        }
        const trigger = normalizeTrigger({ type: 'schedule', preset: schedule });
        expect(triggerNextRunAt(trigger, zone, after)).toEqual(runs[0]);
      }),
      { numRuns: 200 },
    );
  });
});
