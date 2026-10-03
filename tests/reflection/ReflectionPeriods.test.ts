import { describe, it, expect } from 'vitest';
import {
  describePeriod,
  formatClockMinutes,
  isCurrentPeriod,
  isFuturePeriod,
  isPeriodClosed,
  listDays,
  localDayKey,
  periodContaining,
  periodFromKey,
  previousPeriods,
  shiftPeriod,
  subBuckets,
} from '../../src/reflection/ReflectionPeriods';
import { REFLECTION_PERIOD_TYPES } from '../../src/reflection/ReflectionModels';

/** Local wall-clock parts of an ISO instant — boundaries are local by design. */
const parts = (isoString: string) => {
  const d = new Date(isoString);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
};

describe('reflection periods', () => {
  // Saturday, October 3rd 2026, mid-afternoon local time.
  const at = new Date(2026, 9, 3, 15, 30);

  it('a day is the local calendar day', () => {
    const day = periodContaining('day', at);
    expect(day.key).toBe('2026-10-03');
    expect(parts(day.start)).toEqual([2026, 10, 3, 0, 0, 0, 0]);
    expect(parts(day.end)).toEqual([2026, 10, 4, 0, 0, 0, 0]);
  });

  it('a week runs Monday to Sunday', () => {
    const week = periodContaining('week', at);
    expect(week.key).toBe('2026-W40');
    expect(parts(week.start)).toEqual([2026, 9, 28, 0, 0, 0, 0]);
    expect(new Date(week.start).getDay()).toBe(1);
    expect(parts(week.end)).toEqual([2026, 10, 5, 0, 0, 0, 0]);

    // Sunday still belongs to the week that began the previous Monday.
    expect(periodContaining('week', new Date(2026, 9, 4, 23, 59)).key).toBe('2026-W40');
    expect(periodContaining('week', new Date(2026, 9, 5, 0, 0)).key).toBe('2026-W41');
  });

  it('a month is the calendar month and a year the calendar year', () => {
    const month = periodContaining('month', at);
    expect(month.key).toBe('2026-10');
    expect(parts(month.start)).toEqual([2026, 10, 1, 0, 0, 0, 0]);
    expect(parts(month.end)).toEqual([2026, 11, 1, 0, 0, 0, 0]);

    const year = periodContaining('year', at);
    expect(year.key).toBe('2026');
    expect(parts(year.start)).toEqual([2026, 1, 1, 0, 0, 0, 0]);
    expect(parts(year.end)).toEqual([2027, 1, 1, 0, 0, 0, 0]);
  });

  it('handles month lengths, leap years and year boundaries', () => {
    expect(parts(periodContaining('month', new Date(2028, 1, 10)).end)).toEqual([2028, 3, 1, 0, 0, 0, 0]); // leap February
    expect(parts(shiftPeriod(periodContaining('month', new Date(2026, 0, 15)), -1).start)).toEqual([2025, 12, 1, 0, 0, 0, 0]);
    expect(shiftPeriod(periodContaining('day', new Date(2026, 11, 31)), 1).key).toBe('2027-01-01');
  });

  it('labels weeks by ISO week-year across a year boundary', () => {
    // Thu Jan 1 2026 belongs to ISO week 1 of 2026, which starts Mon Dec 29 2025.
    const week = periodContaining('week', new Date(2026, 0, 1));
    expect(week.key).toBe('2026-W01');
    expect(parts(week.start)).toEqual([2025, 12, 29, 0, 0, 0, 0]);
    // Fri Jan 1 2027 still belongs to ISO week 53 of 2026.
    expect(periodContaining('week', new Date(2027, 0, 1)).key).toBe('2026-W53');
  });

  it('keeps local boundaries whatever the timezone offset or DST', () => {
    // Every day of 2026: starts at local midnight, ends at the next local
    // midnight, and consecutive days tile the year without gap or overlap.
    let day = periodContaining('day', new Date(2026, 0, 1, 12));
    for (let i = 0; i < 365; i++) {
      const start = new Date(day.start);
      expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
      const next = shiftPeriod(day, 1);
      expect(next.start).toBe(day.end);
      expect(localDayKey(next.start)).toBe(next.key);
      day = next;
    }
    expect(day.key).toBe('2027-01-01');

    // Every week is exactly seven calendar days, Monday to Monday.
    let week = periodContaining('week', new Date(2026, 0, 1));
    for (let i = 0; i < 53; i++) {
      expect(new Date(week.start).getDay()).toBe(1);
      expect(listDays(week.start, week.end)).toHaveLength(7);
      week = shiftPeriod(week, 1);
    }
  });

  it('shifts and lists previous periods, most recent first', () => {
    const week = periodContaining('week', at);
    expect(shiftPeriod(week, -1).key).toBe('2026-W39');
    expect(shiftPeriod(week, 2).key).toBe('2026-W42');
    expect(previousPeriods(week, 3).map((p) => p.key)).toEqual(['2026-W39', '2026-W38', '2026-W37']);
    expect(previousPeriods(periodContaining('month', at), 2).map((p) => p.key)).toEqual(['2026-09', '2026-08']);
  });

  it('distinguishes current, closed and future periods (partial current periods stay open)', () => {
    const today = periodContaining('day', at);
    expect(isCurrentPeriod(today, at)).toBe(true);
    expect(isPeriodClosed(today, at)).toBe(false);
    expect(isPeriodClosed(today, new Date(2026, 9, 4, 0, 0))).toBe(true); // closes exactly at the boundary
    expect(isPeriodClosed(shiftPeriod(today, -1), at)).toBe(true);
    expect(isFuturePeriod(shiftPeriod(today, 1), at)).toBe(true);
    expect(isCurrentPeriod(periodContaining('year', at), at)).toBe(true);
  });

  it('round-trips period keys and rejects malformed ones', () => {
    for (const type of REFLECTION_PERIOD_TYPES) {
      const period = periodContaining(type, at);
      expect(periodFromKey(type, period.key)).toEqual(period);
    }
    expect(periodFromKey('week', '2026-W01')!.key).toBe('2026-W01');
    expect(periodFromKey('day', '2026-13-40')).toBeNull();
    expect(periodFromKey('week', 'nonsense')).toBeNull();
    expect(periodFromKey('month', '2026-10-03')).toBeNull();
  });

  it('splits a period into its natural sub-buckets', () => {
    expect(subBuckets(periodContaining('day', at))).toEqual([]);

    const days = subBuckets(periodContaining('week', at));
    expect(days.map((b) => b.key)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    expect(days[0].label).toBe('Mon, Sep 28');

    // October 2026: Thu 1st … Sat 31st → five Monday-based weeks, clipped to the month.
    const weeks = subBuckets(periodContaining('month', at));
    expect(weeks.map((b) => b.label)).toEqual(['Oct 1–Oct 4', 'Oct 5–Oct 11', 'Oct 12–Oct 18', 'Oct 19–Oct 25', 'Oct 26–Oct 31']);
    expect(weeks[0].start).toBe(periodContaining('month', at).start);
    expect(weeks[weeks.length - 1].end).toBe(periodContaining('month', at).end);

    const months = subBuckets(periodContaining('year', at));
    expect(months).toHaveLength(12);
    expect(months[9]).toMatchObject({ key: '2026-10', label: 'October' });
  });

  it('describes periods relative to now', () => {
    expect(describePeriod(periodContaining('day', at), at)).toEqual({ title: 'Today', range: 'Sat, Oct 3' });
    expect(describePeriod(shiftPeriod(periodContaining('day', at), -1), at).title).toBe('Yesterday');
    expect(describePeriod(periodContaining('week', at), at)).toEqual({ title: 'This week', range: 'Sep 28 – Oct 4' });
    expect(describePeriod(shiftPeriod(periodContaining('week', at), -1), at).title).toBe('Last week');
    expect(describePeriod(shiftPeriod(periodContaining('week', at), -3), at).title).toBe('Week of Sep 7');
    expect(describePeriod(periodContaining('month', at), at)).toEqual({ title: 'This month', range: 'October 2026' });
    expect(describePeriod(shiftPeriod(periodContaining('month', at), -2), at).title).toBe('August 2026');
    expect(describePeriod(periodContaining('year', at), at)).toEqual({ title: 'This year', range: '2026' });
  });

  it('formats clock times', () => {
    expect(formatClockMinutes(0)).toBe('12:00 AM');
    expect(formatClockMinutes(13 * 60 + 10)).toBe('1:10 PM');
    expect(formatClockMinutes(12 * 60)).toBe('12:00 PM');
  });
});
