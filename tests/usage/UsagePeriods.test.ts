import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setDayStartMinutes } from '../../src/reflection/ReflectionPeriods';
import { parseUsageRequest, resolveUsageWindow } from '../../src/usage/UsagePeriods';

/**
 * Which ranges a usage request measures and compares. Instants are built with
 * local-time constructors, so every expectation holds in any timezone.
 */

/** A local instant in 2026 (month is 1-based). */
const at = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

afterEach(() => setDayStartMinutes(0));

describe('named periods — boundaries', () => {
  // Wednesday 14 October 2026, 3 PM.
  const now = new Date(2026, 9, 14, 15, 0);

  it('today is the local calendar day, measured up to now', () => {
    const w = resolveUsageWindow({ type: 'day' }, now);
    expect(w.period).toEqual({ start: at(10, 14), end: at(10, 15) });
    expect(w.current).toEqual({ start: at(10, 14), end: at(10, 14, 15) });
    expect(w.inProgress).toBe(true);
  });

  it('the week runs Monday to Sunday', () => {
    const w = resolveUsageWindow({ type: 'week' }, now);
    expect(w.period).toEqual({ start: at(10, 12), end: at(10, 19) });
    expect(new Date(w.period.start).getDay()).toBe(1);
  });

  it('a Sunday belongs to the week that began the Monday before', () => {
    const w = resolveUsageWindow({ type: 'week' }, new Date(2026, 9, 18, 23, 30));
    expect(w.period).toEqual({ start: at(10, 12), end: at(10, 19) });
  });

  it('month and year are the calendar month and year', () => {
    expect(resolveUsageWindow({ type: 'month' }, now).period).toEqual({ start: at(10, 1), end: at(11, 1) });
    expect(resolveUsageWindow({ type: 'year' }, now).period).toEqual({ start: at(1, 1), end: at(1, 1, 0, 0, 2027) });
  });

  it('never measures past now: the future is not zero usage', () => {
    for (const type of ['day', 'week', 'month', 'year'] as const) {
      expect(resolveUsageWindow({ type }, now).current.end).toBe(now.toISOString());
    }
  });

  it("follows the user's day boundary", () => {
    setDayStartMinutes(4 * 60);
    // 2 AM on the 14th is still the 13th.
    const w = resolveUsageWindow({ type: 'day' }, new Date(2026, 9, 14, 2, 0));
    expect(w.period).toEqual({ start: at(10, 13, 4), end: at(10, 14, 4) });
    expect(w.previous).toEqual({ start: at(10, 12, 4), end: at(10, 13, 2) });
  });
});

describe('named periods — the equivalent previous range', () => {
  const now = new Date(2026, 9, 14, 15, 0);

  it('today is compared with yesterday up to the same time', () => {
    expect(resolveUsageWindow({ type: 'day' }, now).previous).toEqual({ start: at(10, 13), end: at(10, 13, 15) });
  });

  it('a week in progress is compared with the same part of the previous week, not all of it', () => {
    const w = resolveUsageWindow({ type: 'week' }, now);
    expect(w.previous).toEqual({ start: at(10, 5), end: at(10, 7, 15) });
    const length = (r: { start: string; end: string }) => Date.parse(r.end) - Date.parse(r.start);
    expect(length(w.previous)).toBe(length(w.current));
  });

  it('a month is compared with the previous month up to the same day and time', () => {
    expect(resolveUsageWindow({ type: 'month' }, now).previous).toEqual({ start: at(9, 1), end: at(9, 14, 15) });
  });

  it('a day the previous month does not have stops at that month\'s end', () => {
    // 31 March → February has no 31st: the whole of February, and no more.
    const w = resolveUsageWindow({ type: 'month' }, new Date(2026, 2, 31, 10, 0));
    expect(w.previous).toEqual({ start: at(2, 1), end: at(3, 1) });
  });

  it('a year is compared with the previous year up to the same date', () => {
    expect(resolveUsageWindow({ type: 'year' }, now).previous).toEqual({
      start: at(1, 1, 0, 0, 2025),
      end: at(10, 14, 15, 0, 2025),
    });
  });

  it('crosses a year boundary', () => {
    const w = resolveUsageWindow({ type: 'month' }, new Date(2027, 0, 10, 9, 0));
    expect(w.previous).toEqual({ start: at(12, 1), end: at(12, 10, 9) });
  });
});

describe('custom ranges', () => {
  it('covers both dates in full and is compared with the same number of days before', () => {
    const w = resolveUsageWindow({ type: 'custom', startDate: '2026-09-07', endDate: '2026-09-13' }, new Date(2026, 9, 14, 15, 0));
    expect(w.current).toEqual({ start: at(9, 7), end: at(9, 14) });
    expect(w.previous).toEqual({ start: at(8, 31), end: at(9, 7) });
    expect(w.inProgress).toBe(false);
  });

  it('a single day is compared with the day before', () => {
    const w = resolveUsageWindow({ type: 'custom', startDate: '2026-09-10', endDate: '2026-09-10' }, new Date(2026, 9, 14));
    expect(w.current).toEqual({ start: at(9, 10), end: at(9, 11) });
    expect(w.previous).toEqual({ start: at(9, 9), end: at(9, 10) });
  });

  it('a range that includes today stops at now, and so does its comparison', () => {
    const now = new Date(2026, 9, 14, 15, 0);
    const w = resolveUsageWindow({ type: 'custom', startDate: '2026-10-08', endDate: '2026-10-14' }, now);
    expect(w.inProgress).toBe(true);
    expect(w.period).toEqual({ start: at(10, 8), end: at(10, 15) });
    expect(w.current).toEqual({ start: at(10, 8), end: now.toISOString() });
    expect(w.previous).toEqual({ start: at(10, 1), end: at(10, 7, 15) });
  });

  it('a range that has not begun measures nothing on either side', () => {
    const w = resolveUsageWindow({ type: 'custom', startDate: '2026-11-01', endDate: '2026-11-03' }, new Date(2026, 9, 14));
    expect(w.current.end).toBe(w.current.start);
    expect(w.previous.end).toBe(w.previous.start);
  });
});

describe('parseUsageRequest', () => {
  it('accepts the named periods and nothing else by that name', () => {
    expect(parseUsageRequest({ type: 'week' })).toEqual({ type: 'week' });
    expect(parseUsageRequest({ type: 'decade' })).toBeNull();
    expect(parseUsageRequest(null)).toBeNull();
    expect(parseUsageRequest('week')).toBeNull();
  });

  it('accepts real calendar dates only', () => {
    expect(parseUsageRequest({ type: 'custom', startDate: '2026-02-01', endDate: '2026-02-28' })).toEqual({
      type: 'custom',
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(parseUsageRequest({ type: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' })).toBeNull();
    expect(parseUsageRequest({ type: 'custom', startDate: '2026-2-1', endDate: '2026-03-01' })).toBeNull();
    expect(parseUsageRequest({ type: 'custom', startDate: '2026-02-01' })).toBeNull();
  });

  it('puts reversed dates in order', () => {
    expect(parseUsageRequest({ type: 'custom', startDate: '2026-03-09', endDate: '2026-03-02' })).toEqual({
      type: 'custom',
      startDate: '2026-03-02',
      endDate: '2026-03-09',
    });
  });
});

describe('daylight saving time', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('a 23-hour day still starts and ends at local midnight', () => {
    // Clocks go forward on Sunday 8 March 2026.
    const w = resolveUsageWindow({ type: 'custom', startDate: '2026-03-08', endDate: '2026-03-08' }, new Date(2026, 5, 1));
    expect(w.current).toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
    expect(w.previous).toEqual({ start: '2026-03-07T05:00:00.000Z', end: '2026-03-08T05:00:00.000Z' });
  });

  it('compares the same wall-clock time across the change', () => {
    // Monday 3 PM after the change, against Sunday 3 PM... of the week before the change.
    const w = resolveUsageWindow({ type: 'week' }, new Date(2026, 2, 11, 15, 0));
    expect(new Date(w.previous.end).getHours()).toBe(15);
    expect(new Date(w.previous.start).getHours()).toBe(0);
    expect(w.previous.end).toBe(new Date(2026, 2, 4, 15, 0).toISOString());
  });
});
