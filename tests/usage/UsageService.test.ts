import { describe, expect, it } from 'vitest';
import { UNKNOWN_APP_NAME, type UsageAggregateRow, type UsageWindow } from '../../src/usage/UsageModels';
import { UsageService, buildUsageReport, changeOf } from '../../src/usage/UsageService';
import { registerUsageIpc } from '../../src/usage/usageIpc';
import { FakeUsageSource, HOUR, MIN, row } from './helpers';

/** Wednesday 14 October 2026, 3 PM local. */
const NOW = new Date(2026, 9, 14, 15, 0);
const local = (month: number, day: number, hour = 0) => new Date(2026, month - 1, day, hour).toISOString();

const WEEK: UsageWindow = {
  type: 'week',
  period: { start: local(10, 12), end: local(10, 19) },
  current: { start: local(10, 12), end: NOW.toISOString() },
  previous: { start: local(10, 5), end: local(10, 7, 15) },
  inProgress: true,
};

function report(current: UsageAggregateRow[], previous: UsageAggregateRow[] = [], trackingSince: string | null = local(1, 1)) {
  return buildUsageReport({ window: WEEK, current, previous, trackingSince, generatedAt: NOW.toISOString() });
}

describe('totals and shares', () => {
  const r = report([
    row('Brave', 'chatgpt.com', 3 * HOUR),
    row('Brave', 'youtube.com', 1 * HOUR),
    row('Brave', null, 30 * MIN),
    row('VS Code', null, 5 * HOUR),
    row('Slack', null, 30 * MIN),
  ]);

  it('tracked time is every pair counted once', () => {
    expect(r.trackedMs).toBe(10 * HOUR);
  });

  it("a browser's time includes its websites; website time is never added on top", () => {
    expect(r.apps.find((a) => a.name === 'Brave')?.ms).toBe(4.5 * HOUR);
    expect(r.websiteMs).toBe(4 * HOUR);
    expect(r.totals.outsideWebsites?.currentMs).toBe(6 * HOUR);
    expect(r.websiteMs + r.totals.outsideWebsites!.currentMs).toBe(r.trackedMs);
  });

  it('every share is of total tracked time', () => {
    expect(r.apps.map((a) => [a.name, a.share])).toEqual([
      ['VS Code', 0.5],
      ['Brave', 0.45],
      ['Slack', 0.05],
    ]);
    expect(r.websites.map((w) => [w.name, w.share])).toEqual([
      ['chatgpt.com', 0.3],
      ['youtube.com', 0.1],
    ]);
  });

  it('application shares add up to the whole; website shares to the time on websites', () => {
    const sum = (items: { share: number }[]) => items.reduce((total, item) => total + item.share, 0);
    expect(sum(r.apps)).toBeCloseTo(1, 10);
    expect(sum(r.websites)).toBeCloseTo(r.websiteMs / r.trackedMs, 10);
  });

  it('item durations add up to the totals exactly, fractional milliseconds included', () => {
    const odd = report([row('A', 'a.com', 1000.4), row('A', 'b.com', 1000.4), row('B', null, 1000.4), row('B', 'a.com', 0.2)]);
    expect(odd.apps.reduce((total, a) => total + a.ms, 0)).toBe(odd.trackedMs);
    expect(odd.websites.reduce((total, w) => total + w.ms, 0)).toBe(odd.websiteMs);
    expect(Number.isInteger(odd.trackedMs)).toBe(true);
  });
});

describe('ranking', () => {
  it('orders by time, most first, and breaks ties by name', () => {
    const r = report([row('Zed', null, HOUR), row('Arc', null, HOUR), row('Code', null, 2 * HOUR)]);
    expect(r.apps.map((a) => a.name)).toEqual(['Code', 'Arc', 'Zed']);
  });

  it('shows at most five in the overview and keeps every item in the full list', () => {
    const r = report(Array.from({ length: 8 }, (_, i) => row(`App ${i}`, null, (10 - i) * HOUR)));
    expect(r.topApps.map((a) => a.name)).toEqual(['App 0', 'App 1', 'App 2', 'App 3', 'App 4']);
    expect(r.apps).toHaveLength(8);
  });

  it('merges the same website opened in two browsers', () => {
    const r = report([row('Brave', 'github.com', HOUR), row('Chrome', 'github.com', 2 * HOUR, { url: 4 })]);
    expect(r.websites).toHaveLength(1);
    expect(r.websites[0]).toMatchObject({ name: 'github.com', ms: 3 * HOUR, opens: 5 });
  });

  it('names an application the tracker could not identify', () => {
    const r = report([row(null, null, HOUR), row('  ', null, HOUR)]);
    expect(r.apps).toHaveLength(1);
    expect(r.apps[0]).toMatchObject({ key: '', name: UNKNOWN_APP_NAME, ms: 2 * HOUR });
  });

  it('leaves out pairs with no time in the range', () => {
    expect(report([row('Ghost', 'ghost.io', 0), row('Real', null, HOUR)]).apps.map((a) => a.name)).toEqual(['Real']);
  });
});

describe('negligible usage', () => {
  // 20 h tracked → a thousandth is 72 s.
  const r = report([
    row('Main', null, 20 * HOUR - 2 * MIN - 70_000 - 20_000),
    row('Brief', null, 70_000),
    row('Two', null, 2 * MIN),
    row('Blip', 'blip.io', 20_000),
  ]);

  it('is under a minute or under a thousandth of tracked time, whichever is larger', () => {
    expect(r.negligibleBelowMs).toBe(72_000);
    expect(Object.fromEntries(r.apps.map((a) => [a.name, a.negligible]))).toEqual({ Main: false, Two: false, Brief: true, Blip: true });
  });

  it('stays out of the overview', () => {
    expect(r.topApps.map((a) => a.name)).toEqual(['Main', 'Two']);
  });

  it('is still listed and still counted in every total', () => {
    expect(r.apps.map((a) => a.name)).toEqual(['Main', 'Two', 'Brief', 'Blip']);
    expect(r.trackedMs).toBe(20 * HOUR);
    expect(r.websites).toHaveLength(1);
  });

  it('with only negligible usage, the overview shows what there is', () => {
    const tiny = report([row('A', null, 20_000), row('B', null, 10_000)]);
    expect(tiny.negligibleBelowMs).toBe(MIN);
    expect(tiny.topApps.map((a) => a.name)).toEqual(['A', 'B']);
  });
});

describe('comparison with the previous range', () => {
  it('gives previous, current, difference and percentage', () => {
    expect(changeOf(12 * HOUR, 8 * HOUR)).toEqual({ currentMs: 12 * HOUR, previousMs: 8 * HOUR, deltaMs: 4 * HOUR, percent: 50 });
    expect(changeOf(6 * HOUR, 8 * HOUR)).toMatchObject({ deltaMs: -2 * HOUR, percent: -25 });
  });

  it('a zero baseline has a difference and no percentage', () => {
    expect(changeOf(2 * HOUR, 0)).toEqual({ currentMs: 2 * HOUR, previousMs: 0, deltaMs: 2 * HOUR, percent: null });
    expect(changeOf(0, 0)).toMatchObject({ deltaMs: 0, percent: null });
  });

  it('zero usage now is a full decrease, stated as such', () => {
    expect(changeOf(0, 3 * HOUR)).toEqual({ currentMs: 0, previousMs: 3 * HOUR, deltaMs: -3 * HOUR, percent: -100 });
  });

  const r = report(
    [row('Brave', 'chatgpt.com', 12 * HOUR), row('VS Code', null, 4 * HOUR), row('Figma', null, 2 * HOUR)],
    [row('Brave', 'chatgpt.com', 8 * HOUR), row('VS Code', null, 6 * HOUR), row('Netflix', null, 3 * HOUR)],
  );

  it('compares the totals', () => {
    expect(r.totals.tracked).toEqual({ currentMs: 18 * HOUR, previousMs: 17 * HOUR, deltaMs: HOUR, percent: (1 / 17) * 100 });
    expect(r.totals.websites).toMatchObject({ currentMs: 12 * HOUR, previousMs: 8 * HOUR, percent: 50 });
    expect(r.totals.outsideWebsites).toMatchObject({ currentMs: 6 * HOUR, previousMs: 9 * HOUR });
  });

  it('compares each item with itself in the previous range', () => {
    expect(r.websites[0].change).toMatchObject({ previousMs: 8 * HOUR, deltaMs: 4 * HOUR, percent: 50 });
    expect(r.apps.find((a) => a.name === 'VS Code')?.change).toMatchObject({ deltaMs: -2 * HOUR });
    expect(r.apps.find((a) => a.name === 'Figma')?.change).toEqual({ currentMs: 2 * HOUR, previousMs: 0, deltaMs: 2 * HOUR, percent: null });
  });

  it('lists the largest differences, including what is no longer used at all', () => {
    expect(r.movers.map((m) => [m.name, m.kind, m.change?.deltaMs])).toEqual([
      ['Brave', 'app', 4 * HOUR],
      ['chatgpt.com', 'website', 4 * HOUR],
      ['Netflix', 'app', -3 * HOUR],
      // Equal differences: the one with more time now comes first.
      ['VS Code', 'app', -2 * HOUR],
      ['Figma', 'app', 2 * HOUR],
    ]);
    expect(r.movers.find((m) => m.name === 'Netflix')).toMatchObject({ ms: 0, share: 0, change: { percent: -100 } });
    expect(r.apps.some((a) => a.name === 'Netflix')).toBe(false);
  });

  it('does not report differences too small to matter', () => {
    const steady = report([row('A', null, 10 * HOUR), row('B', null, HOUR + 20_000)], [row('A', null, 10 * HOUR), row('B', null, HOUR)]);
    expect(steady.movers).toEqual([]);
  });
});

describe('how far back the data goes', () => {
  const current = [row('A', null, HOUR)];

  it('tracking that began before the previous range: full comparison', () => {
    expect(report(current, [row('A', null, HOUR)], local(9, 1)).history).toBe('full');
  });

  it('tracking that began inside the previous range: compared, and flagged as partial', () => {
    const r = report(current, [row('A', null, 30 * MIN)], local(10, 6));
    expect(r.history).toBe('partial');
    expect(r.totals.tracked).toMatchObject({ previousMs: 30 * MIN });
  });

  it('tracking that began after the previous range: no comparison, rather than "up from zero"', () => {
    const r = report(current, [], local(10, 12));
    expect(r.history).toBe('none');
    expect(r.totals).toEqual({ tracked: null, websites: null, outsideWebsites: null });
    expect(r.apps[0].change).toBeNull();
    expect(r.movers).toEqual([]);
  });

  it('nothing tracked at all', () => {
    const r = report([], [], null);
    expect(r).toMatchObject({ trackedMs: 0, websiteMs: 0, history: 'none', trackingSince: null, mostOpened: null });
    expect(r.apps).toEqual([]);
    expect(r.topWebsites).toEqual([]);
  });

  it('an empty period after a used one is zero, compared accurately', () => {
    const r = report([], [row('A', null, 5 * HOUR)]);
    expect(r.trackedMs).toBe(0);
    expect(r.totals.tracked).toEqual({ currentMs: 0, previousMs: 5 * HOUR, deltaMs: -5 * HOUR, percent: -100 });
    expect(r.apps).toEqual([]);
    expect(r.movers.map((m) => m.name)).toEqual(['A']);
  });
});

describe('most opened', () => {
  it('is the item brought to the front most often, application or website', () => {
    const r = report([
      row('VS Code', null, 6 * HOUR, { app: 40 }),
      row('Brave', 'chatgpt.com', 2 * HOUR, { app: 30, url: 55 }),
      row('Brave', 'docs.dev', HOUR, { app: 20, url: 12 }),
    ]);
    expect(r.apps.find((a) => a.name === 'Brave')?.opens).toBe(50);
    expect(r.mostOpened).toMatchObject({ kind: 'website', name: 'chatgpt.com', opens: 55 });
  });

  it('breaks a tie by time', () => {
    const r = report([row('Short', null, HOUR, { app: 9 }), row('Long', null, 2 * HOUR, { app: 9 })]);
    expect(r.mostOpened?.name).toBe('Long');
  });
});

describe('UsageService', () => {
  it('reads the current and the previous range with the same query', () => {
    const source = new FakeUsageSource({
      [local(10, 12)]: [row('A', null, 12 * HOUR)],
      [local(10, 5)]: [row('A', null, 8 * HOUR)],
    });
    const r = new UsageService(source, () => NOW).getReport({ type: 'week' });

    expect(source.asked).toEqual([
      { from: local(10, 12), to: NOW.toISOString() },
      { from: local(10, 5), to: local(10, 7, 15) },
    ]);
    expect(r.window).toEqual(WEEK);
    expect(r.totals.tracked).toMatchObject({ currentMs: 12 * HOUR, previousMs: 8 * HOUR, deltaMs: 4 * HOUR, percent: 50 });
    expect(r.generatedAt).toBe(NOW.toISOString());
  });

  it('is deterministic: the same data and clock give the same report', () => {
    const make = () =>
      new UsageService(new FakeUsageSource({ [local(10, 14)]: [row('A', 'a.com', HOUR), row('B', null, HOUR)] }), () => NOW).getReport({ type: 'day' });
    expect(make()).toEqual(make());
  });

  it("an item's detail: its window titles by time, within the measured range", () => {
    const source = new FakeUsageSource({});
    source.titles = [
      { title: 'report.tsx', ms: 40 * MIN, lastStartedAt: '2026-10-14T05:00:00.000Z' },
      { title: 'usage.ts', ms: 90 * MIN, lastStartedAt: '2026-10-14T04:00:00.000Z' },
      { title: null, ms: 5 * MIN, lastStartedAt: '2026-10-14T03:00:00.000Z' },
      { title: '   ', ms: MIN, lastStartedAt: '2026-10-14T02:00:00.000Z' },
    ];
    const detail = new UsageService(source, () => NOW).getItemDetail({ type: 'day' }, 'app', 'VS Code');

    expect(source.titleQueries).toEqual([{ from: local(10, 14), to: NOW.toISOString(), kind: 'app', key: 'VS Code' }]);
    expect(detail.titles).toEqual([
      { title: 'usage.ts', ms: 90 * MIN },
      { title: 'report.tsx', ms: 40 * MIN },
    ]);
    expect(detail).toMatchObject({ titleCount: 2, latestTitle: 'report.tsx', lastActiveAt: '2026-10-14T05:00:00.000Z' });
  });

  it('shows the eight titles with the most time and says how many there were', () => {
    const source = new FakeUsageSource({});
    source.titles = Array.from({ length: 12 }, (_, i) => ({ title: `Title ${i}`, ms: (i + 1) * MIN, lastStartedAt: local(10, 14) }));
    const detail = new UsageService(source, () => NOW).getItemDetail({ type: 'day' }, 'app', 'X');
    expect(detail.titles).toHaveLength(8);
    expect(detail.titles[0].title).toBe('Title 11');
    expect(detail.titleCount).toBe(12);
  });
});

describe('usage IPC', () => {
  function channels(source = new FakeUsageSource({})) {
    const handlers = new Map<string, (payload?: any) => any>();
    registerUsageIpc(new UsageService(source, () => NOW), (key, handler) => handlers.set(key, handler));
    return handlers;
  }

  it('answers a valid request', () => {
    expect(channels().get('usage:getReport')!({ request: { type: 'month' } }).window.type).toBe('month');
  });

  it('rejects a period it does not know instead of guessing one', () => {
    const getReport = channels().get('usage:getReport')!;
    expect(() => getReport({ request: { type: 'forever' } })).toThrow('Invalid usage period');
    expect(() => getReport()).toThrow('Invalid usage period');
    expect(() => getReport({ request: { type: 'custom', startDate: 'yesterday', endDate: 'today' } })).toThrow('Invalid usage period');
  });

  it('rejects a malformed item', () => {
    const getItemDetail = channels().get('usage:getItemDetail')!;
    expect(() => getItemDetail({ request: { type: 'day' }, kind: 'folder', key: 'x' })).toThrow('Invalid usage item');
    expect(() => getItemDetail({ request: { type: 'day' }, kind: 'app', key: 7 })).toThrow('Invalid usage item');
    expect(getItemDetail({ request: { type: 'day' }, kind: 'app', key: '' })).toMatchObject({ kind: 'app', key: '', titles: [] });
  });
});
