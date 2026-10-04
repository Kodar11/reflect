import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqliteDB from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppSettingsStore, DEFAULT_APP_SETTINGS } from '../../src/background/AppSettings';
import { BackgroundRepository } from '../../src/database/BackgroundRepository';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';

/**
 * Integration tests against real SQLite. Self-skips when the native binary is
 * built for Electron's ABI instead of Node's (run with `npm run test:db`).
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bg-probe-')), 'probe.db');
    new Database(p).close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
  }
})();

const suite = nativeOk ? describe : describe.skip;

const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 5, h, m, s).toISOString();

suite('BackgroundRepository (SQLite)', () => {
  let dir: string;
  let file: string;
  let db: Database;
  let repo: BackgroundRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bg-'));
    file = path.join(dir, 'test.db');
    db = new Database(file);
    repo = new BackgroundRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh database is at schema v16 with the background tables', () => {
    const raw = new BetterSqliteDB(file, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(16);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['app_settings', 'tracking_pauses', 'notification_log']));
    raw.close();
  });

  it('upgrades a v15 database without touching existing data', () => {
    db.prepare(`INSERT INTO events (watcher, started_at, ended_at, app) VALUES ('window', @s, @e, 'Code')`).run({ s: at(9), e: at(9, 30) });
    db.close();
    const raw = new BetterSqliteDB(file);
    raw.exec('DROP TABLE app_settings; DROP TABLE tracking_pauses; DROP TABLE notification_log;');
    raw.pragma('user_version = 15');
    raw.close();

    db = new Database(file);
    repo = new BackgroundRepository(db);
    expect(repo.getSettings()).toEqual(DEFAULT_APP_SETTINGS);
    expect(new EventRepository(db).getAll()).toHaveLength(1);
    const check = new BetterSqliteDB(file, { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(16);
    check.close();
  });

  it('settings default to everything on and survive closing and reopening the database', () => {
    expect(repo.getSettings()).toEqual(DEFAULT_APP_SETTINGS);

    const store = new AppSettingsStore(repo);
    store.update({
      startWithWindows: false,
      widgetEnabled: false,
      widgetPosition: { x: 320, y: 48 },
      notificationsEnabled: false,
      trackingPause: { since: at(9), until: at(10) },
    });
    db.close();

    // The app restarts: the main process reads the same values with no window open.
    db = new Database(file);
    expect(new AppSettingsStore(new BackgroundRepository(db)).get()).toEqual({
      startWithWindows: false,
      widgetEnabled: false,
      widgetPosition: { x: 320, y: 48 },
      notificationsEnabled: false,
      trackingPause: { since: at(9), until: at(10) },
    });
  });

  it('a corrupted settings row falls back to the defaults', () => {
    db.prepare(`INSERT INTO app_settings (id, data, updated_at) VALUES (1, '{not json', @now)`).run({ now: at(9) });
    expect(repo.getSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('a notification key can be claimed exactly once — also across restarts', () => {
    expect(repo.claim('reflection-ready:2026-10-04', 'reflection-ready', at(9))).toBe(true);
    expect(repo.claim('reflection-ready:2026-10-04', 'reflection-ready', at(9, 5))).toBe(false);
    expect(repo.claim('reflection-ready:2026-10-05', 'reflection-ready', at(22))).toBe(true);

    db.close();
    db = new Database(file);
    expect(new BackgroundRepository(db).claim('reflection-ready:2026-10-04', 'reflection-ready', at(23))).toBe(false);
  });

  it('adds up the paused time inside a range, clipped to it', () => {
    repo.recordPause(at(9), at(9, 30));
    repo.recordPause(at(13), at(15));
    repo.recordPause(at(16), at(16)); // empty: ignored
    repo.recordPause(at(18), at(17)); // inverted: ignored

    expect(repo.pausedMsBetween(at(0), at(23))).toBe(150 * 60_000);
    expect(repo.pausedMsBetween(at(14), at(23))).toBe(60 * 60_000);
    expect(repo.pausedMsBetween(at(9, 10), at(9, 20))).toBe(10 * 60_000);
    expect(repo.pausedMsBetween(at(10), at(12))).toBe(0);
  });
});

suite('EventRepository — background status reads (SQLite)', () => {
  let dir: string;
  let db: Database;
  let events: EventRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bg-ev-'));
    db = new Database(path.join(dir, 'test.db'));
    events = new EventRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sums tracked time inside a range, clipping events that cross its edges', () => {
    expect(events.sumTrackedMs(at(0), at(23))).toBe(0);
    events.insert({ watcher: 'window', app: 'Code', startedAt: at(8), endedAt: at(9, 30) });
    events.insert({ watcher: 'window', app: 'Chrome', startedAt: at(9, 30), endedAt: at(10) });
    events.insert({ watcher: 'window', app: 'Slack', startedAt: at(12), endedAt: at(12, 0, 30) });

    expect(events.sumTrackedMs(at(0), at(23))).toBe(2 * 3_600_000 + 30_000);
    // "Today" starting at 09:00: the first event counts only from then.
    expect(events.sumTrackedMs(at(9), at(23))).toBe(3_600_000 + 30_000);
    expect(events.sumTrackedMs(at(9, 45), at(12, 0, 10))).toBe(15 * 60_000 + 10_000);
  });

  it('returns the most recently updated event', () => {
    expect(events.getLatest()).toBeNull();
    const first = events.insert({ watcher: 'window', app: 'Code', startedAt: at(8), endedAt: at(8, 10) });
    events.insert({ watcher: 'window', app: 'Chrome', startedAt: at(8, 10), endedAt: at(8, 20) });
    expect(events.getLatest()?.app).toBe('Chrome');
    events.updateEndedAt(first, at(8, 40));
    expect(events.getLatest()?.app).toBe('Code');
  });
});
