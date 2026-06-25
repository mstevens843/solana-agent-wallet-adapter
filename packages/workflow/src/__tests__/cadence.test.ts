import { describe, expect, it } from 'vitest';

import {
  clampedMonthlyDate,
  exhaustionReason,
  latestDueOccurrence,
  nextFutureOccurrence,
  parseLocalTime,
  previewUpcoming,
  type CadenceFields,
} from '../cadence.js';

const ANCHOR = '2026-01-01T00:00:00.000Z';

function weekly(overrides: Partial<CadenceFields> = {}): CadenceFields {
  return {
    cadence: 'weekly',
    dayOfWeek: 5,
    localTime: '10:00',
    createdAt: ANCHOR,
    ...overrides,
  };
}

function monthly(overrides: Partial<CadenceFields> = {}): CadenceFields {
  return {
    cadence: 'monthly',
    dayOfMonth: 15,
    localTime: '09:00',
    createdAt: ANCHOR,
    ...overrides,
  };
}

function intervalDays(overrides: Partial<CadenceFields> = {}): CadenceFields {
  return {
    cadence: 'interval_days',
    intervalDays: 3,
    createdAt: ANCHOR,
    ...overrides,
  };
}

describe('parseLocalTime', () => {
  it('parses HH:MM strings', () => {
    expect(parseLocalTime('10:30')).toEqual({ hour: 10, minute: 30 });
    expect(parseLocalTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects invalid values', () => {
    expect(parseLocalTime(undefined)).toBeNull();
    expect(parseLocalTime('')).toBeNull();
    expect(parseLocalTime('25:00')).toBeNull();
    expect(parseLocalTime('10:60')).toBeNull();
    expect(parseLocalTime('abc')).toBeNull();
  });
});

describe('clampedMonthlyDate', () => {
  it('clamps day-31 to Feb 28 in non-leap years', () => {
    const d = clampedMonthlyDate(2026, 1, 31, 9, 0); // 2026 = non-leap
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(28);
  });

  it('clamps day-31 to Feb 29 in leap years', () => {
    const d = clampedMonthlyDate(2024, 1, 31, 9, 0); // 2024 = leap
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(29);
  });

  it('preserves valid days', () => {
    const d = clampedMonthlyDate(2026, 5, 10, 14, 30);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});

describe('nextFutureOccurrence — weekly', () => {
  it('returns the next Friday at 10:00 strictly after now', () => {
    // Mon 2026-05-04 09:00 UTC
    const now = new Date('2026-05-04T09:00:00.000Z');
    const result = nextFutureOccurrence(weekly(), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getTime()).toBeGreaterThan(now.getTime());
    expect(result!.dueAt.getDay()).toBe(5); // Friday
  });

  it('skips current candidate when it equals now and pushes to next week', () => {
    // Pick a moment exactly equal to candidate to confirm <= now logic
    const now = new Date('2026-05-08T10:00:00.000Z'); // Friday at the cadence time
    const result = nextFutureOccurrence(weekly(), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('nextFutureOccurrence — monthly', () => {
  it('returns the next 15th at 09:00 strictly after now', () => {
    const now = new Date('2026-05-10T00:00:00.000Z');
    const result = nextFutureOccurrence(monthly(), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getDate()).toBe(15);
  });

  it('rolls over month when current month 15th has passed', () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    const result = nextFutureOccurrence(monthly(), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getMonth()).toBe(5); // June (0-indexed)
    expect(result!.dueAt.getDate()).toBe(15);
  });

  it('handles dayOfMonth=31 in February by clamping', () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const result = nextFutureOccurrence(monthly({ dayOfMonth: 31 }), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getMonth()).toBe(1); // Feb
    expect(result!.dueAt.getDate()).toBe(28); // 2026 is non-leap
  });
});

describe('nextFutureOccurrence — interval cadences', () => {
  it('advances by intervalDays', () => {
    const sched = intervalDays({ startAt: '2026-05-01T00:00:00.000Z' });
    const now = new Date('2026-05-01T00:00:00.000Z');
    const result = nextFutureOccurrence(sched, now);
    expect(result).not.toBeNull();
    // anchor itself is not in future, so next = anchor + intervalDays * 1 = +3 days
    expect(result!.dueAt.toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('advances by intervalHours', () => {
    const sched: CadenceFields = {
      cadence: 'interval_hours',
      intervalHours: 6,
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const now = new Date('2026-05-01T00:00:00.000Z');
    const result = nextFutureOccurrence(sched, now);
    expect(result!.dueAt.toISOString()).toBe('2026-05-01T06:00:00.000Z');
  });

  it('advances by intervalMinutes', () => {
    const sched: CadenceFields = {
      cadence: 'interval_minutes',
      intervalMinutes: 30,
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const now = new Date('2026-05-01T00:00:00.000Z');
    const result = nextFutureOccurrence(sched, now);
    expect(result!.dueAt.toISOString()).toBe('2026-05-01T00:30:00.000Z');
  });
});

describe('latestDueOccurrence', () => {
  it('returns the most recent due weekly occurrence at or before now', () => {
    // Sat 2026-05-09 12:00 UTC; weekly Friday 10:00
    const now = new Date('2026-05-09T12:00:00.000Z');
    const result = latestDueOccurrence(weekly(), now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getDay()).toBe(5);
    expect(result!.dueAt.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('returns the first scheduled occurrence (in the future) when startAt has not arrived', () => {
    // When startAt is in the future, the helper returns the first scheduled occurrence;
    // the caller is responsible for the "is this due yet" check (dueAt > now → not due).
    const sched = weekly({ startAt: '2027-01-01T00:00:00.000Z' });
    const now = new Date('2026-05-09T12:00:00.000Z');
    const result = latestDueOccurrence(sched, now);
    expect(result).not.toBeNull();
    expect(result!.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('expiresAt', () => {
  it('blocks nextFutureOccurrence when next is past expiry', () => {
    const sched = weekly({
      startAt: '2026-05-04T00:00:00.000Z',
      expiresAt: '2026-05-09T11:00:00.000Z',
    });
    // First Friday after start = 2026-05-08 10:00 (before expiry, ok)
    const now = new Date('2026-05-09T12:00:00.000Z');
    const result = nextFutureOccurrence(sched, now);
    // Next would be 2026-05-15, past expiry → null
    expect(result).toBeNull();
  });

  it('still allows nextFutureOccurrence when next is before expiry', () => {
    const sched = weekly({
      startAt: '2026-05-04T00:00:00.000Z',
      expiresAt: '2026-06-01T00:00:00.000Z',
    });
    const now = new Date('2026-05-09T12:00:00.000Z');
    const result = nextFutureOccurrence(sched, now);
    expect(result).not.toBeNull();
    // Local-time semantics: assert it's a Friday at the cadence time, before expiry
    expect(result!.dueAt.getDay()).toBe(5);
    expect(result!.dueAt.getHours()).toBe(10);
    expect(result!.dueAt.getMinutes()).toBe(0);
    expect(result!.dueAt.getTime()).toBeLessThan(new Date('2026-06-01T00:00:00.000Z').getTime());
    expect(result!.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('blocks latestDueOccurrence when latest is past expiry', () => {
    const sched = weekly({
      startAt: '2026-05-04T00:00:00.000Z',
      expiresAt: '2026-05-08T09:00:00.000Z', // before any 10:00 Friday
    });
    const now = new Date('2026-05-09T12:00:00.000Z');
    const result = latestDueOccurrence(sched, now);
    // Latest would be 2026-05-08 10:00, past expiry → null
    expect(result).toBeNull();
  });
});

describe('exhaustionReason', () => {
  it('reports max_occurrences when reached', () => {
    const sched = weekly({ maxOccurrences: 3, occurrencesCreated: 3 });
    expect(exhaustionReason(sched, new Date(ANCHOR))).toBe('max_occurrences');
  });

  it('reports expired when expiresAt has passed', () => {
    const sched = weekly({ expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(exhaustionReason(sched, new Date('2026-05-01T00:00:00.000Z'))).toBe('expired');
  });

  it('returns null when neither condition met', () => {
    const sched = weekly({ maxOccurrences: 5, occurrencesCreated: 2 });
    expect(exhaustionReason(sched, new Date(ANCHOR))).toBeNull();
  });

  it('does not report exhaustion when occurrencesCreated less than max', () => {
    const sched = weekly({ maxOccurrences: 10, occurrencesCreated: 9 });
    expect(exhaustionReason(sched, new Date(ANCHOR))).toBeNull();
  });
});

describe('previewUpcoming', () => {
  it('returns the requested number of future occurrences', () => {
    const sched = weekly();
    const now = new Date('2026-05-04T00:00:00.000Z');
    const results = previewUpcoming(sched, now, 5);
    expect(results).toHaveLength(5);
    // Each should be 7 days after the previous
    for (let i = 1; i < results.length; i += 1) {
      const delta = results[i]!.dueAt.getTime() - results[i - 1]!.dueAt.getTime();
      expect(delta).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it('stops early when maxOccurrences reached', () => {
    const sched = weekly({ maxOccurrences: 3, occurrencesCreated: 1 });
    const now = new Date('2026-05-04T00:00:00.000Z');
    const results = previewUpcoming(sched, now, 5);
    expect(results).toHaveLength(2); // only 2 more allowed before hitting max
  });

  it('stops early when expiresAt cuts off the future window', () => {
    const sched = weekly({ expiresAt: '2026-05-22T00:00:00.000Z' });
    const now = new Date('2026-05-04T00:00:00.000Z');
    const results = previewUpcoming(sched, now, 10);
    // Fridays after 2026-05-04 before 2026-05-22: May 8, May 15 (May 22 is Friday but >= expiry)
    expect(results.length).toBeLessThanOrEqual(2);
    for (const r of results) {
      expect(r.dueAt.getTime()).toBeLessThan(new Date('2026-05-22T00:00:00.000Z').getTime());
    }
  });

  it('returns empty array for count <= 0', () => {
    expect(previewUpcoming(weekly(), new Date(), 0)).toEqual([]);
    expect(previewUpcoming(weekly(), new Date(), -1)).toEqual([]);
  });

  it('handles interval cadences', () => {
    const sched: CadenceFields = {
      cadence: 'interval_hours',
      intervalHours: 6,
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const now = new Date('2026-05-01T00:00:00.000Z');
    const results = previewUpcoming(sched, now, 4);
    expect(results).toHaveLength(4);
    expect(results[0]!.dueAt.toISOString()).toBe('2026-05-01T06:00:00.000Z');
    expect(results[1]!.dueAt.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(results[2]!.dueAt.toISOString()).toBe('2026-05-01T18:00:00.000Z');
    expect(results[3]!.dueAt.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });
});

describe('timezone-aware cadence', () => {
  // All assertions are absolute UTC instants, so they are independent of the
  // process timezone — that determinism is the whole point of the feature.
  const NY = 'America/New_York'; // EST = UTC-5 (winter), EDT = UTC-4 (summer)

  it('weekly 09:00 in a winter (EST) timezone resolves to 14:00 UTC', () => {
    const sched = weekly({ dayOfWeek: 5, localTime: '09:00', timezone: NY, createdAt: '2026-01-01T00:00:00.000Z' });
    const now = new Date('2026-01-05T12:00:00.000Z'); // Monday
    const next = nextFutureOccurrence(sched, now);
    expect(next).not.toBeNull();
    // Next Friday is 2026-01-09; 09:00 EST = 14:00 UTC.
    expect(next!.dueAt.toISOString()).toBe('2026-01-09T14:00:00.000Z');
    expect(next!.key).toBe('2026-01-09');
  });

  it('weekly 09:00 in a summer (EDT) timezone resolves to 13:00 UTC', () => {
    const sched = weekly({ dayOfWeek: 5, localTime: '09:00', timezone: NY, createdAt: '2026-01-01T00:00:00.000Z' });
    const now = new Date('2026-07-06T12:00:00.000Z'); // Monday
    const next = nextFutureOccurrence(sched, now);
    // Next Friday is 2026-07-10; 09:00 EDT = 13:00 UTC.
    expect(next!.dueAt.toISOString()).toBe('2026-07-10T13:00:00.000Z');
  });

  it('keeps the wall-clock time stable across a DST transition (monthly 15th)', () => {
    const sched = monthly({ dayOfMonth: 15, localTime: '09:00', timezone: NY, createdAt: '2026-01-20T00:00:00.000Z' });
    const now = new Date('2026-01-20T00:00:00.000Z');
    const runs = previewUpcoming(sched, now, 4).map((o) => o.dueAt.toISOString());
    // Feb 15 is EST (14:00 UTC); DST starts Mar 8, so Mar/Apr 15 are EDT (13:00 UTC).
    expect(runs).toEqual([
      '2026-02-15T14:00:00.000Z',
      '2026-03-15T13:00:00.000Z',
      '2026-04-15T13:00:00.000Z',
      '2026-05-15T13:00:00.000Z',
    ]);
  });

  it('clamps day-of-month to the last zone-local day in short months', () => {
    const sched = monthly({ dayOfMonth: 31, localTime: '09:00', timezone: NY, createdAt: '2026-02-01T00:00:00.000Z' });
    const now = new Date('2026-02-01T00:00:00.000Z');
    const next = nextFutureOccurrence(sched, now);
    // Feb 2026 has 28 days; 09:00 EST = 14:00 UTC.
    expect(next!.dueAt.toISOString()).toBe('2026-02-28T14:00:00.000Z');
    expect(next!.key).toBe('2026-02-28');
  });

  it('latestDueOccurrence returns the most recent zone-local run', () => {
    const sched = weekly({ dayOfWeek: 5, localTime: '09:00', timezone: NY, createdAt: '2026-01-01T00:00:00.000Z' });
    // Just after Friday 2026-01-09 09:00 EST (14:00 UTC).
    const now = new Date('2026-01-09T15:00:00.000Z');
    const latest = latestDueOccurrence(sched, now);
    expect(latest!.dueAt.toISOString()).toBe('2026-01-09T14:00:00.000Z');
  });

  it('interval_days applies the zone-local time-of-day to the anchor', () => {
    // Anchor is 2026-01-01 09:00 EST (= 14:00 UTC); time-of-day re-anchors to 09:00 NY.
    const sched = intervalDays({
      intervalDays: 3,
      localTime: '09:00',
      timezone: NY,
      startAt: '2026-01-01T14:00:00.000Z',
      createdAt: '2026-01-01T14:00:00.000Z',
    });
    const now = new Date('2026-01-01T00:00:00.000Z');
    const next = nextFutureOccurrence(sched, now);
    expect(next!.dueAt.toISOString()).toBe('2026-01-01T14:00:00.000Z');
    expect(next!.key).toBe('2026-01-01');
  });

  it('falls back to environment-local behavior when timezone is invalid', () => {
    const withBad = weekly({ dayOfWeek: 5, localTime: '10:00', timezone: 'Not/AZone' });
    const valid = weekly({ dayOfWeek: 5, localTime: '10:00' });
    const now = new Date('2026-05-04T09:00:00.000Z');
    // An unknown timezone must not throw — it degrades to the legacy path.
    expect(nextFutureOccurrence(withBad, now)!.dueAt.toISOString())
      .toBe(nextFutureOccurrence(valid, now)!.dueAt.toISOString());
  });
});
