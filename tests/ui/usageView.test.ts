import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_LIST,
  USAGE_LIST_INITIAL,
  barPercent,
  dateKey,
  defaultCustomRequest,
  describeChange,
  formatRange,
  formatShare,
  listRows,
  parseStoredRequest,
  periodNames,
  refreshIntervalMs,
  requestKey,
} from '../../src/ui/pages/Activity/usageView';
import { changeOf } from '../../src/usage/UsageService';
import { HOUR, MIN, NOW, WEEK_WINDOW, makeReport, manyApps } from './usageFixtures';

const local = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe('formatShare', () => {
  it('rounds to whole percent', () => {
    expect(formatShare(0.314)).toBe('31%');
    expect(formatShare(0.5)).toBe('50%');
    expect(formatShare(1)).toBe('100%');
  });

  it('never rounds something to nothing, or nearly everything to everything', () => {
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0.996)).toBe('>99%');
    expect(formatShare(0)).toBe('0%');
  });
});

describe('describeChange', () => {
  it('states the difference and the percentage', () => {
    expect(describeChange(changeOf(12 * HOUR, 8 * HOUR), 'Last week')).toMatchObject({
      direction: 'up',
      text: '+4h · +50%',
      label: '+4h (+50%) compared with 8h last week',
    });
    expect(describeChange(changeOf(6 * HOUR + 30 * MIN, 8 * HOUR), 'Yesterday')).toMatchObject({ direction: 'down', text: '−1h 30m · −19%' });
  });

  it('a zero baseline shows the increase and no invented percentage', () => {
    const c = describeChange(changeOf(2 * HOUR, 0), 'Last month');
    expect(c).toMatchObject({ direction: 'new', text: '+2h · new', percent: null });
    expect(c.text).not.toContain('%');
    expect(c.text).not.toMatch(/Infinity|NaN/);
  });

  it('usage that dropped to zero is a full decrease', () => {
    expect(describeChange(changeOf(0, 3 * HOUR), 'Last week').text).toBe('−3h · −100%');
  });

  it('says so when there is nothing to compare with', () => {
    expect(describeChange(null, 'Last year')).toMatchObject({ direction: 'none', text: '—', label: 'No earlier data to compare with last year' });
  });

  it('does not call a few seconds a change', () => {
    expect(describeChange(changeOf(HOUR + 10_000, HOUR), 'Yesterday')).toMatchObject({ direction: 'same', text: 'No change' });
    expect(describeChange(changeOf(0, 0), 'Yesterday').direction).toBe('same');
  });

  it('keeps extreme and tiny percentages readable', () => {
    expect(describeChange(changeOf(50 * HOUR, HOUR), 'Last week').percent).toBe('>999%');
    expect(describeChange(changeOf(100 * HOUR + MIN, 100 * HOUR), 'Last week').percent).toBe('+<1%');
  });
});

describe('formatRange', () => {
  it('whole days read as dates', () => {
    expect(formatRange({ start: local(10, 5), end: local(10, 12) }, NOW)).toBe('Mon, Oct 5 – Sun, Oct 11');
    expect(formatRange({ start: local(10, 13), end: local(10, 14) }, NOW)).toBe('Tue, Oct 13');
  });

  it('a range cut part-way says where it stops', () => {
    expect(formatRange(WEEK_WINDOW.current, NOW)).toBe('Mon, Oct 12 – Wed, Oct 14, 3:00 PM');
    expect(formatRange(WEEK_WINDOW.previous, NOW)).toBe('Mon, Oct 5 – Wed, Oct 7, 3:00 PM');
    expect(formatRange({ start: local(10, 14), end: local(10, 14, 15) }, NOW)).toBe('Wed, Oct 14, until 3:00 PM');
  });

  it('names the year when it is not this one', () => {
    expect(formatRange({ start: local(1, 1, 0, 0, 2025), end: local(10, 14, 15, 0, 2025) }, NOW)).toBe('Wed, Jan 1, 2025 – Tue, Oct 14, 2025, 3:00 PM');
  });
});

describe('period names', () => {
  it('names both sides of each comparison', () => {
    expect(periodNames('day')).toEqual({ current: 'Today', previous: 'Yesterday' });
    expect(periodNames('week')).toEqual({ current: 'This week', previous: 'Last week' });
    expect(periodNames('custom')).toEqual({ current: 'Selected range', previous: 'Preceding range' });
  });
});

describe('listRows — expand, show all, search', () => {
  const apps = makeReport({ current: manyApps(25) }).apps;

  it('collapsed by default: no rows', () => {
    expect(listRows(apps, COLLAPSED_LIST, '')).toMatchObject({ rows: [], visible: false, remaining: 0, matched: 25 });
  });

  it('expanded: the ten most used, with the rest one step away', () => {
    const view = listRows(apps, { open: true, showAll: false }, '');
    expect(view.rows).toHaveLength(USAGE_LIST_INITIAL);
    expect(view.rows.map((r) => r.name)).toEqual(apps.slice(0, 10).map((a) => a.name));
    expect(view.remaining).toBe(15);
  });

  it('show all: every item', () => {
    const view = listRows(apps, { open: true, showAll: true }, '');
    expect(view.rows).toHaveLength(25);
    expect(view.remaining).toBe(0);
  });

  it('a short list has nothing more to show', () => {
    expect(listRows(apps.slice(0, 4), { open: true, showAll: false }, '')).toMatchObject({ remaining: 0 });
  });

  it('search looks through every item, not only the ten on screen', () => {
    const view = listRows(apps, { open: true, showAll: false }, 'app 2');
    expect(view.rows.map((r) => r.name)).toEqual(['App 20', 'App 21', 'App 22', 'App 23', 'App 24', 'App 25']);
    expect(view).toMatchObject({ matched: 6, remaining: 0, searching: true });
  });

  it('search shows its matches even when the list is collapsed', () => {
    expect(listRows(apps, COLLAPSED_LIST, 'APP 03')).toMatchObject({ visible: true, matched: 1 });
  });

  it('search ignores case and surrounding spaces, and can match nothing', () => {
    expect(listRows(apps, COLLAPSED_LIST, '  aPp 07 ').rows.map((r) => r.name)).toEqual(['App 07']);
    expect(listRows(apps, COLLAPSED_LIST, 'zzz')).toMatchObject({ rows: [], matched: 0, visible: true });
  });
});

describe('bars', () => {
  it('are proportional to the longest of the list', () => {
    expect(barPercent(5 * HOUR, 10 * HOUR)).toBe(50);
    expect(barPercent(10 * HOUR, 10 * HOUR)).toBe(100);
  });

  it('give a sliver of time a sliver of bar — no minimum width', () => {
    expect(barPercent(30_000, 10 * HOUR)).toBeLessThan(0.1);
    expect(barPercent(0, 10 * HOUR)).toBe(0);
    expect(barPercent(HOUR, 0)).toBe(0);
  });
});

describe('requests', () => {
  it('offers the last seven days as the first custom range', () => {
    expect(defaultCustomRequest(NOW)).toEqual({ type: 'custom', startDate: '2026-10-08', endDate: '2026-10-14' });
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('restores a stored period and ignores anything else', () => {
    expect(parseStoredRequest('{"type":"month"}')).toEqual({ type: 'month' });
    expect(parseStoredRequest('{"type":"custom","startDate":"2026-09-01","endDate":"2026-09-07"}')).toEqual({
      type: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    });
    expect(parseStoredRequest('{"type":"custom","startDate":"soon"}')).toBeNull();
    expect(parseStoredRequest('not json')).toBeNull();
    expect(parseStoredRequest(null)).toBeNull();
  });

  it('identifies a request by what it asks for', () => {
    expect(requestKey({ type: 'week' })).toBe('week');
    expect(requestKey({ type: 'custom', startDate: '2026-09-01', endDate: '2026-09-07' })).toBe('custom:2026-09-01:2026-09-07');
  });

  it('keeps a running period fresh and leaves a finished one alone', () => {
    expect(refreshIntervalMs({ ...WEEK_WINDOW, type: 'day' })).toBe(30_000);
    expect(refreshIntervalMs(WEEK_WINDOW)).toBe(60_000);
    expect(refreshIntervalMs({ ...WEEK_WINDOW, type: 'year' })).toBe(300_000);
    expect(refreshIntervalMs({ ...WEEK_WINDOW, type: 'custom', inProgress: false })).toBeNull();
  });
});
