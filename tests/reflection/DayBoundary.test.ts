import { describe, it, expect, afterEach } from 'vitest';
import {
  describePeriod,
  getDayStartMinutes,
  listDays,
  localDayKey,
  periodContaining,
  periodFromKey,
  setDayStartMinutes,
  shiftPeriod,
  startOfLocalDay,
  subBuckets,
} from '../../src/reflection/ReflectionPeriods';
import { iso, local, makeReflectionHarness, modelReflection, projectX, seedThreads, workday } from './helpers';

/**
 * The user's day does not have to end at midnight. With the day starting at
 * 4 AM, work done at 1 AM belongs to the day before — in every period, every
 * metric and every schedule.
 */
afterEach(() => setDayStartMinutes(0));

describe('day boundary — periods', () => {
  it('defaults to midnight', () => {
    expect(getDayStartMinutes()).toBe(0);
    expect(periodContaining('day', local(13, '01:30'))).toMatchObject({ key: '2026-10-13', start: iso(13), end: iso(14) });
  });

  it('an instant before the boundary belongs to the previous day', () => {
    setDayStartMinutes(4 * 60);
    expect(periodContaining('day', local(13, '01:30'))).toEqual({ type: 'day', key: '2026-10-12', start: iso(12, '04:00'), end: iso(13, '04:00') });
    expect(periodContaining('day', local(13, '03:59')).key).toBe('2026-10-12');
    expect(periodContaining('day', local(13, '04:00'))).toMatchObject({ key: '2026-10-13', start: iso(13, '04:00') });
    expect(localDayKey(local(13, '01:30'))).toBe('2026-10-12');
    expect(startOfLocalDay(local(13, '01:30')).toISOString()).toBe(iso(12, '04:00'));
  });

  it('weeks, months and years start at the same boundary', () => {
    setDayStartMinutes(4 * 60);
    // Mon Oct 12, 2 AM is still Sunday's week.
    expect(periodContaining('week', local(12, '02:00'))).toMatchObject({ key: '2026-W41', start: iso(5, '04:00'), end: iso(12, '04:00') });
    expect(periodContaining('week', local(12, '04:00')).key).toBe('2026-W42');
    // Oct 1, 2 AM is still September.
    expect(periodContaining('month', local(1, '02:00')).key).toBe('2026-09');
    expect(periodContaining('month', local(1, '05:00'))).toMatchObject({ key: '2026-10', start: iso(1, '04:00'), end: iso(32, '04:00') });
    expect(periodContaining('year', new Date(2026, 0, 1, 2)).key).toBe('2025');
  });

  it('a week ending Monday 4 AM is still labelled as ending on Sunday', () => {
    setDayStartMinutes(4 * 60);
    const week = periodContaining('week', local(7, '12:00'));
    expect(describePeriod(week, local(14, '12:00'))).toEqual({ title: 'Last week', range: 'Oct 5 – Oct 11' });
    expect(describePeriod(periodContaining('day', local(13, '01:30')), local(13, '01:30'))).toEqual({ title: 'Today', range: 'Mon, Oct 12' });
    expect(subBuckets(periodContaining('week', local(7, '12:00'))).map((b) => b.key)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
  });

  it('shifting works from a period\'s own start — no configuration needed (the renderer has none)', () => {
    setDayStartMinutes(4 * 60);
    const day = periodContaining('day', local(12, '12:00'));
    const week = periodContaining('week', local(12, '12:00'));
    setDayStartMinutes(0); // as in the renderer, which never sets it
    expect(shiftPeriod(day, 1)).toEqual({ type: 'day', key: '2026-10-13', start: iso(13, '04:00'), end: iso(14, '04:00') });
    expect(shiftPeriod(day, -1).key).toBe('2026-10-11');
    expect(shiftPeriod(week, 1)).toMatchObject({ key: '2026-W43', start: iso(19, '04:00'), end: iso(26, '04:00') });
  });

  it('keys round-trip, and days tile a range without gaps', () => {
    setDayStartMinutes(4 * 60);
    for (const [type, at] of [['day', local(13, '01:30')], ['week', local(12, '02:00')], ['month', local(1, '02:00')], ['year', local(13)]] as const) {
      const period = periodContaining(type, at);
      expect(periodFromKey(type, period.key)).toEqual(period);
    }
    const days = listDays(iso(12, '04:00'), iso(15, '04:00'));
    expect(days.map((d) => d.key)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(days[0].end).toBe(days[1].start);
  });

  it('clamps nonsense', () => {
    setDayStartMinutes(Number.NaN);
    expect(getDayStartMinutes()).toBe(0);
    setDayStartMinutes(-30);
    expect(getDayStartMinutes()).toBe(0);
    setDayStartMinutes(99 * 60);
    expect(getDayStartMinutes()).toBe(12 * 60);
  });
});

describe('day boundary — reflection', () => {
  it('counts late-night work toward the day it belongs to', async () => {
    setDayStartMinutes(4 * 60);
    const lateNight = projectX(13, '00:30', 60); // Tue 12:30 AM — still Monday's day
    const h = makeReflectionHarness({ activities: [...[5, 6, 7, 8, 9, 12].flatMap(workday), lateNight], now: local(13, '01:40') });
    seedThreads(h.repo, h.activities);

    const monday = periodContaining('day', local(13, '01:40'));
    expect(monday.key).toBe('2026-10-12');
    const core = await h.metrics.computeCore(monday, iso(13, '01:40'), []);
    // 4h 32m of the working day + the hour after midnight.
    expect(core.metrics['time.tracked_minutes'].display).toBe('5h 32m');
    expect(core.metrics['days.active'].value).toBe(1);

    const view = await h.service.getView('day', null);
    expect(view.period).toMatchObject({ key: '2026-10-12', title: 'Today', range: 'Mon, Oct 12', isCurrent: true });
  });

  it('a reflection time after midnight belongs to the day that is ending', async () => {
    setDayStartMinutes(4 * 60);
    const lateNight = projectX(13, '00:30', 60);
    const h = makeReflectionHarness({
      activities: [...[5, 6, 7, 8, 9, 12].flatMap(workday), lateNight],
      now: local(12, '22:30'),
      reflectionMinutes: 2 * 60, // "I reflect at 2 AM"
    });
    seedThreads(h.repo, h.activities);
    const keys = async () => (await h.service.pendingScheduledPeriods()).map((p) => `${p.type}:${p.key}`);

    // 10:30 PM: not yet — the day runs until 4 AM and is reflected on at 2.
    expect(await keys()).not.toContain('day:2026-10-12');
    expect(h.service.nextDailyReflectionAt().toISOString()).toBe(iso(13, '02:00'));
    expect((await h.service.getView('day', null)).dailyReflectionAt).toBe(iso(13, '02:00'));

    // 2:02 AM on the 13th: Monday's reflection is due, covering the work after midnight.
    h.setNow(local(13, '02:02'));
    expect((await keys()).at(-1)).toBe('day:2026-10-12');
    const monday = periodContaining('day', local(13, '02:02'));
    h.gemini.push(modelReflection(monday));
    expect(await h.service.generate(monday, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded' });
    expect(h.repo.getCurrentReport('day', '2026-10-12')!.metricsSnapshot!['time.tracked_minutes'].display).toBe('5h 32m');
    expect(await keys()).not.toContain('day:2026-10-12');
    expect(h.service.nextDailyReflectionAt().toISOString()).toBe(iso(14, '02:00'));
  });
});
