import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { FocusRepository } from '../../src/database/FocusRepository';
import { compileBlockingConfig } from '../../src/focus/BlockingConfig';
import { DEFAULT_FOCUS_PREFERENCES, type FocusSession } from '../../src/focus/FocusModels';
import { FocusService } from '../../src/focus/FocusService';
import { FakeBlockingManager } from '../focus/helpers';

/**
 * Focus persistence against real SQLite: the v14 schema, the repository, and
 * the service writing through it. Self-skips if the native binary ABI does
 * not match the runtime (see EventRepository.test.ts); `npm run test:db`
 * runs it under Electron.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-focus-probe-')), 'probe.db');
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

const T0 = Date.parse('2026-03-02T09:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function columns(db: BetterSqliteDB.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: 'session-1',
    profileId: 'default-deep-work',
    task: 'Finish authentication',
    notes: null,
    mode: 'countdown',
    plannedDurationMinutes: 60,
    state: 'active',
    startedAt: iso(T0),
    endedAt: null,
    pausedAt: null,
    totalPauseMs: 0,
    elapsedMs: 0,
    blockingLeaseId: 'lease-1',
    endReason: null,
    endNote: null,
    blockingConfig: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

suite('Focus persistence (SQLite)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let repo: FocusRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-focus-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database(dbPath);
    repo = new FocusRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh database is at v14 with the Focus V2 columns and a default profile', () => {
    const raw = new BetterSqliteDB(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(14);
    expect(columns(raw, 'focus_sessions')).toEqual(expect.arrayContaining(['end_reason', 'end_note', 'blocking_config']));
    expect(columns(raw, 'focus_preferences')).toEqual(['id', 'data', 'updated_at']);
    raw.close();

    const profile = repo.getDefaultProfile();
    expect(profile?.name).toBe('Deep Work');
    // The seeded category rules resolve to something enforceable.
    const config = compileBlockingConfig(profile!);
    expect(config.enabled).toBe(true);
    expect(config.domains).toEqual(expect.arrayContaining(['instagram.com', 'netflix.com']));
  });

  it('migrates a v13 database in place: sessions are kept and end reasons back-filled', () => {
    db.close();
    const raw = new BetterSqliteDB(dbPath);
    raw.exec(`
      ALTER TABLE focus_sessions DROP COLUMN end_reason;
      ALTER TABLE focus_sessions DROP COLUMN end_note;
      ALTER TABLE focus_sessions DROP COLUMN blocking_config;
      DROP TABLE focus_preferences;
      INSERT INTO focus_sessions (id, profile_id, task, mode, planned_duration_minutes, state, started_at, ended_at, elapsed_ms, created_at, updated_at) VALUES
        ('done',    'default-deep-work', 'Old completed', 'countdown', 25, 'completed', '${iso(T0)}', '${iso(T0 + 25 * MIN)}', ${25 * MIN}, '${iso(T0)}', '${iso(T0)}'),
        ('dropped', 'default-deep-work', 'Old cancelled', 'countdown', 25, 'cancelled', '${iso(T0)}', '${iso(T0 + 5 * MIN)}',  ${5 * MIN},  '${iso(T0)}', '${iso(T0)}'),
        ('live',    'default-deep-work', 'Still open',    'stopwatch', NULL, 'active',  '${iso(T0)}', NULL, 0, '${iso(T0)}', '${iso(T0)}');
    `);
    raw.pragma('user_version = 13');
    raw.close();

    db = new Database(dbPath);
    new Database(dbPath).close(); // re-opening is a no-op
    repo = new FocusRepository(db);

    const check = new BetterSqliteDB(dbPath);
    expect(check.pragma('user_version', { simple: true })).toBe(14);
    expect(check.pragma('foreign_key_check')).toEqual([]);
    check.close();

    expect(repo.getSessionById('done')).toMatchObject({ state: 'completed', endReason: 'completed', task: 'Old completed', blockingConfig: null });
    expect(repo.getSessionById('dropped')).toMatchObject({ state: 'cancelled', endReason: 'ended-early' });
    expect(repo.getSessionById('live')).toMatchObject({ state: 'active', endReason: null });
    expect(repo.getPreferences()).toEqual(DEFAULT_FOCUS_PREFERENCES);
  });

  it('round-trips every session field, including the blocking snapshot', () => {
    const config = compileBlockingConfig(repo.getDefaultProfile()!);
    const stored = session({
      notes: 'context',
      state: 'cancelled',
      endedAt: iso(T0 + 17 * MIN),
      totalPauseMs: 3 * MIN,
      elapsedMs: 14 * MIN,
      blockingLeaseId: null,
      endReason: 'ended-early',
      endNote: 'Meeting',
      blockingConfig: config,
      updatedAt: iso(T0 + 17 * MIN),
    });
    repo.insertSession(stored);
    expect(repo.getSessionById('session-1')).toEqual(stored);

    const updated = { ...stored, endNote: 'Changed task', elapsedMs: 15 * MIN };
    repo.updateSession(updated);
    expect(repo.getSessionById('session-1')).toEqual(updated);
  });

  it('lists open sessions and deletes one that never started', () => {
    repo.insertSession(session({ id: 'planned', state: 'planned', startedAt: null, createdAt: iso(T0 + 2000) }));
    repo.insertSession(session({ id: 'paused', state: 'paused', pausedAt: iso(T0 + MIN), createdAt: iso(T0 + 1000) }));
    repo.insertSession(session({ id: 'ended', state: 'completed', endReason: 'completed', endedAt: iso(T0 + 60 * MIN) }));
    expect(repo.getOpenSessions().map((s) => s.id)).toEqual(['planned', 'paused']);

    repo.deleteSession('planned');
    expect(repo.getSessionById('planned')).toBeNull();
    expect(repo.getOpenSessions().map((s) => s.id)).toEqual(['paused']);
    expect(repo.getActiveSession()?.id).toBe('paused');
  });

  it('persists preferences, normalized, across reopen', () => {
    expect(repo.getPreferences()).toEqual(DEFAULT_FOCUS_PREFERENCES);
    repo.savePreferences({ ...DEFAULT_FOCUS_PREFERENCES, defaultProfileId: 'default-deep-work', idleThresholdSeconds: 300, notifyStart: true });
    repo.savePreferences({ ...repo.getPreferences(), idleAutoResume: false });

    db.close();
    db = new Database(dbPath);
    repo = new FocusRepository(db);
    expect(repo.getPreferences()).toEqual({
      ...DEFAULT_FOCUS_PREFERENCES,
      defaultProfileId: 'default-deep-work',
      idleThresholdSeconds: 300,
      notifyStart: true,
      idleAutoResume: false,
    });
  });

  it('falls back to defaults when stored preferences are corrupt', () => {
    db.prepare("INSERT INTO focus_preferences (id, data, updated_at) VALUES (1, '{broken', @now)").run({ now: iso(T0) });
    expect(repo.getPreferences()).toEqual(DEFAULT_FOCUS_PREFERENCES);
  });

  it('the service persists a whole session lifecycle that survives a restart', async () => {
    vi.useFakeTimers();
    const clock = { now: T0 };
    const blocking = new FakeBlockingManager();
    const service = new FocusService(repo, blocking, { now: () => clock.now });
    const advance = async (ms: number) => {
      for (let left = ms; left > 0; left -= 1000) {
        clock.now += 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
    };

    const dto = await service.start({ profileId: 'default-deep-work', task: 'Finish authentication', plannedDurationMinutes: 60 });
    await advance(10 * MIN);
    await service.pause('Meeting');
    await advance(5 * MIN);
    await service.resume();
    blocking.simulateBlockedAttempt(dto.session.id, 'discord.exe');
    await advance(2 * MIN);

    // "Crash": a new service over the same database, 30 seconds later.
    await service.shutdown();
    clock.now += 30_000;
    const blocking2 = new FakeBlockingManager();
    const restarted = new FocusService(new FocusRepository(db), blocking2, { now: () => clock.now });
    await restarted.reconcileActiveSession();

    const restored = restarted.getActiveSession();
    expect(restored?.session.id).toBe(dto.session.id);
    expect(restored?.isRunning).toBe(true);
    expect(restored?.blocking.status).toBe('active');
    expect(blocking2.leases[0].config).toEqual(blocking.leases[0].config);
    // 12 minutes worked; the pause and the restart did not use up the countdown.
    expect(restored?.remainingMs).toBe(48 * MIN);

    const challenge = await restarted.requestEnd();
    await restarted.confirmEnd({ token: challenge!.token, phrase: 'END', reason: 'Changed task' });

    const row = repo.getSessionById(dto.session.id)!;
    expect(row).toMatchObject({ state: 'cancelled', endReason: 'ended-early', endNote: 'Changed task', blockingLeaseId: null });
    expect(row.elapsedMs).toBe(12 * MIN);
    // What Reflection will need later is all here.
    expect(repo.getInterruptions(row.id).map((i) => i.type)).toEqual(['pause', 'resume', 'idle']);
    expect(repo.getBlockedAttempts(row.id)).toEqual([expect.objectContaining({ type: 'app', target: 'discord.exe' })]);
    expect(repo.getOpenSessions()).toEqual([]);
    expect(repo.getAllSessions(10).map((s) => s.id)).toEqual([row.id]);
  });
});
