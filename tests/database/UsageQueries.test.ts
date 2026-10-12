import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { UsageService } from '../../src/usage/UsageService';

/**
 * The usage aggregation against real SQLite: what is counted, clipped, and
 * how switches are counted. Self-skips when the native binary is built for
 * the other ABI — see `EventRepository.test.ts`; `npm run test:db` runs it.
 */
const nativeOk = (() => {
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const suite = nativeOk ? describe : describe.skip;

const MIN = 60_000;
/** A UTC instant on 14 October 2026. */
const t = (hhmm: string, day = 14) => `2026-10-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`;

suite('usage aggregation (integration, real SQLite)', () => {
  let dir: string;
  let db: Database;
  let repo: EventRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-usage-'));
    db = new Database(path.join(dir, 'test.db'));
    repo = new EventRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function add(from: string, to: string, app: string | null, url: string | null = null, title: string | null = null, watcher: 'window' | 'browser' = 'window') {
    return repo.insert({ watcher, startedAt: from, endedAt: to, app, url, title, browser: url ? 'Brave' : null });
  }

  const byPair = (from: string, to: string) =>
    Object.fromEntries(repo.aggregateUsage(from, to).map((r) => [`${r.app}|${r.url ?? ''}`, Math.round(r.ms)]));

  it('sums time per application and website pair', () => {
    add(t('09:00'), t('09:30'), 'VS Code');
    add(t('09:30'), t('09:40'), 'Brave', 'github.com');
    add(t('09:40'), t('10:00'), 'VS Code');
    add(t('10:00'), t('10:05'), 'Brave');

    expect(byPair(t('00:00'), t('23:59'))).toEqual({ 'VS Code|': 50 * MIN, 'Brave|github.com': 10 * MIN, 'Brave|': 5 * MIN });
  });

  it('returns nothing for a range with no events', () => {
    add(t('09:00'), t('09:30'), 'VS Code');
    expect(repo.aggregateUsage(t('00:00', 20), t('00:00', 21))).toEqual([]);
  });

  it('clips an event that crosses the range boundary to the part inside', () => {
    add(t('23:30', 13), t('00:20', 14), 'VS Code');
    add(t('23:50', 14), t('00:30', 15), 'Slack');

    expect(byPair(t('00:00', 14), t('00:00', 15))).toEqual({ 'VS Code|': 20 * MIN, 'Slack|': 10 * MIN });
    // The other side of each boundary gets the rest: nothing lost, nothing counted twice.
    expect(byPair(t('00:00', 13), t('00:00', 14))).toEqual({ 'VS Code|': 30 * MIN });
    expect(byPair(t('00:00', 15), t('00:00', 16))).toEqual({ 'Slack|': 30 * MIN });
  });

  it('measures an incomplete period only up to its end', () => {
    add(t('09:00'), t('11:00'), 'VS Code');
    expect(byPair(t('00:00'), t('10:00'))).toEqual({ 'VS Code|': 60 * MIN });
  });

  it('never counts the same instant twice when two events overlap', () => {
    add(t('09:00'), t('09:30'), 'VS Code');
    // Starts five minutes before the previous event's recorded end.
    add(t('09:25'), t('10:00'), 'Slack');

    const pairs = byPair(t('00:00'), t('23:59'));
    expect(pairs).toEqual({ 'VS Code|': 25 * MIN, 'Slack|': 35 * MIN });
    expect(pairs['VS Code|'] + pairs['Slack|']).toBe(60 * MIN);
  });

  it('counts foreground-window events only', () => {
    add(t('09:00'), t('10:00'), 'Brave', 'github.com');
    add(t('09:00'), t('10:00'), 'Brave', 'github.com', null, 'browser');
    expect(byPair(t('00:00'), t('23:59'))).toEqual({ 'Brave|github.com': 60 * MIN });
  });

  it('leaves out hidden events', () => {
    add(t('09:00'), t('09:30'), 'VS Code');
    const hidden = add(t('09:30'), t('10:00'), 'Brave', 'private.example');
    repo.hide([hidden], t('12:00'));

    expect(byPair(t('00:00'), t('23:59'))).toEqual({ 'VS Code|': 30 * MIN });
    expect(repo.usageTitles(t('00:00'), t('23:59'), 'website', 'private.example')).toEqual([]);
  });

  it('counts an open each time something comes to the front, not each title change', () => {
    add(t('09:00'), t('09:10'), 'VS Code', null, 'a.ts');
    add(t('09:10'), t('09:20'), 'VS Code', null, 'b.ts'); // same application: not a new open
    add(t('09:20'), t('09:30'), 'Brave', 'github.com', 'PR 1');
    add(t('09:30'), t('09:40'), 'Brave', 'github.com', 'PR 2'); // same site: not a new open
    add(t('09:40'), t('09:50'), 'Brave', 'docs.dev'); // same application, another site
    add(t('09:50'), t('10:00'), 'VS Code', null, 'a.ts');
    add(t('10:00'), t('10:10'), 'Brave', 'github.com');

    const rows = repo.aggregateUsage(t('00:00'), t('23:59'));
    const opens = (pick: (r: (typeof rows)[number]) => boolean, field: 'appOpens' | 'urlOpens') =>
      rows.filter(pick).reduce((total, r) => total + r[field], 0);

    expect(opens((r) => r.app === 'VS Code', 'appOpens')).toBe(2);
    expect(opens((r) => r.app === 'Brave', 'appOpens')).toBe(2);
    expect(opens((r) => r.url === 'github.com', 'urlOpens')).toBe(2);
    expect(opens((r) => r.url === 'docs.dev', 'urlOpens')).toBe(1);
    expect(opens((r) => r.url === null, 'urlOpens')).toBe(0);
  });

  it('counts what was already in front when the range began as one open', () => {
    add(t('08:00'), t('09:30'), 'VS Code');
    add(t('09:30'), t('10:00'), 'VS Code');
    const [row] = repo.aggregateUsage(t('09:00'), t('10:00'));
    expect(row).toMatchObject({ app: 'VS Code', appOpens: 1 });
    expect(Math.round(row.ms)).toBe(60 * MIN);
  });

  it('reports when each pair was last active', () => {
    add(t('09:00'), t('09:10'), 'VS Code');
    add(t('11:00'), t('11:10'), 'VS Code');
    expect(repo.aggregateUsage(t('00:00'), t('23:59'))[0].lastStartedAt).toBe(t('11:00'));
  });

  it('breaks an item down by window title', () => {
    add(t('09:00'), t('09:40'), 'VS Code', null, 'usage.ts');
    add(t('09:40'), t('09:50'), 'Brave', 'github.com', 'Pull requests');
    add(t('09:50'), t('10:00'), 'VS Code', null, 'report.tsx');
    add(t('10:00'), t('10:20'), 'VS Code', null, 'usage.ts');
    add(t('10:20'), t('10:30'), null, null, 'Lock screen');

    const titles = (kind: 'app' | 'website', key: string) =>
      Object.fromEntries(repo.usageTitles(t('00:00'), t('23:59'), kind, key).map((r) => [r.title, Math.round(r.ms)]));

    expect(titles('app', 'VS Code')).toEqual({ 'usage.ts': 60 * MIN, 'report.tsx': 10 * MIN });
    expect(titles('website', 'github.com')).toEqual({ 'Pull requests': 10 * MIN });
    expect(titles('app', 'Brave')).toEqual({ 'Pull requests': 10 * MIN });
    // The application the tracker could not name is addressed by the empty key.
    expect(titles('app', '')).toEqual({ 'Lock screen': 10 * MIN });
  });

  it('a year of history aggregates to one row per pair', () => {
    db.transaction(() => {
      for (let day = 0; day < 365; day++) {
        const base = Date.UTC(2025, 0, 1 + day, 9);
        for (let i = 0; i < 20; i++) {
          const from = new Date(base + i * 10 * MIN).toISOString();
          const to = new Date(base + (i + 1) * 10 * MIN).toISOString();
          repo.insert({ watcher: 'window', startedAt: from, endedAt: to, app: i % 2 ? 'Brave' : 'VS Code', url: i % 2 ? 'github.com' : null });
        }
      }
    });

    const rows = repo.aggregateUsage('2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows.reduce((total, r) => total + r.ms, 0)).toBe(365 * 200 * MIN);
    expect(rows.map((r) => r.appOpens)).toEqual([3650, 3650]);
  });

  it('end to end: a report over stored events, and again after one is hidden', () => {
    // Wednesday 14 October 2026, 3 PM local; events are placed relative to it.
    const now = new Date(2026, 9, 14, 15, 0);
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
    add(local(14, 9), local(14, 11), 'VS Code');
    const browsing = add(local(14, 11), local(14, 12), 'Brave', 'github.com');
    add(local(14, 14), local(14, 16), 'VS Code'); // still open: counted to 3 PM only
    add(local(13, 9), local(13, 10), 'VS Code'); // yesterday, before 3 PM
    add(local(13, 18), local(13, 20), 'Brave', 'youtube.com'); // yesterday, after the cut-off
    add(local(1, 9), local(1, 10), 'VS Code'); // tracking began well before yesterday

    const service = new UsageService(repo, () => now);
    const report = service.getReport({ type: 'day' });

    expect(report.trackedMs).toBe(240 * MIN);
    expect(report.apps.map((a) => [a.name, a.ms])).toEqual([
      ['VS Code', 180 * MIN],
      ['Brave', 60 * MIN],
    ]);
    expect(report.websites.map((w) => [w.name, w.ms, w.share])).toEqual([['github.com', 60 * MIN, 0.25]]);
    // Yesterday counts up to 3 PM only: the evening is not part of the comparison.
    expect(report.totals.tracked).toEqual({ currentMs: 240 * MIN, previousMs: 60 * MIN, deltaMs: 180 * MIN, percent: 300 });
    expect(report.websites[0].change).toEqual({ currentMs: 60 * MIN, previousMs: 0, deltaMs: 60 * MIN, percent: null });
    expect(report.history).toBe('full');

    repo.hide([browsing], now.toISOString());
    const after = service.getReport({ type: 'day' });
    expect(after.trackedMs).toBe(180 * MIN);
    expect(after.websites).toEqual([]);
  });
});
