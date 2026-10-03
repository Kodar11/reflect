import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import type { ReconcilePlan } from '../../src/intelligence/IntelligenceModels';

/**
 * Integration tests for the intelligence tables against real better-sqlite3.
 * Self-skips if the native binary ABI does not match Node (see
 * EventRepository.test.ts).
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-intel-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
  }
})();

const suite = nativeOk ? describe : describe.skip;

const iso = (hhmm: string) => `2026-03-02T${hhmm}:00.000Z`;
const WS = iso('09:00');
const WE = iso('10:00');

const interpretation = {
  title: 'Implement Reflect Gemini integration',
  summary: 'Worked on the pipeline.',
  contextId: 'coding',
  areaId: 'area_work',
  intentId: 'intent_create',
  qualityId: 'quality_focused',
  confidence: 0.91,
  uncertainty: ['Project name inferred from window title'],
};

function emptyPlan(): ReconcilePlan {
  return { create: [], extend: [], detach: [], userProtectedEventIds: [] };
}

suite('IntelligenceRepository (SQLite)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let events: EventRepository;
  let repo: IntelligenceRepository;
  let ids: number[];

  function startRun(id: string, start = WS, end = WE) {
    repo.createRun({ id, windowStart: start, windowEnd: end, model: 'gemini-test', promptVersion: 'p1', schemaVersion: 1, nowIso: iso('10:02') });
  }
  function commit(runId: string, plan: ReconcilePlan, start = WS, end = WE) {
    repo.commitRun({ runId, windowStart: start, windowEnd: end, model: 'gemini-test-001', attemptCount: 1, outputJson: '{"schemaVersion":1}', plan, nowIso: iso('10:03') });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-intel-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database(dbPath);
    events = new EventRepository(db);
    repo = new IntelligenceRepository(db);
    ids = [
      events.insert({ watcher: 'window', startedAt: iso('09:00'), endedAt: iso('09:20'), app: 'VS Code', title: 'a.ts' }),
      events.insert({ watcher: 'window', startedAt: iso('09:20'), endedAt: iso('09:40'), app: 'Chrome', url: 'react.dev' }),
      events.insert({ watcher: 'window', startedAt: iso('09:40'), endedAt: iso('09:58'), app: 'VS Code', title: 'b.ts' }),
      events.insert({ watcher: 'window', startedAt: iso('10:00'), endedAt: iso('10:30'), app: 'VS Code', title: 'c.ts' }),
    ];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migration v10 creates the intelligence tables, indexes and rule source', () => {
    const raw = new BetterSqliteDB(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(12);
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%intelligence%'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'intelligence_runs',
        'intelligence_activities',
        'intelligence_activity_events',
        'idx_intelligence_runs_succeeded_window',
        'idx_intelligence_runs_status',
        'idx_intelligence_runs_window',
        'idx_intelligence_activities_started_at',
        'idx_intelligence_activity_events_event_id',
      ]),
    );
    // The events table gained no AI columns.
    const eventCols = (raw.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(eventCols).toEqual(['id', 'watcher', 'started_at', 'ended_at', 'app', 'browser', 'title', 'url', 'payload', 'created_at']);
    raw.close();
  });

  it('seeded rules are system rules; saved rules are user rules and keep their source', () => {
    const rules = new ActivityRuleRepository(db);
    expect(rules.listRules().map((r) => [r.id, r.source])).toEqual(
      expect.arrayContaining([['rule_coding', 'system'], ['rule_chatgpt', 'system']]),
    );

    rules.saveRule({ id: 'rule_mine', activityId: 'coding', conditions: '[]', enabled: 1, priority: 10, areaId: null, intentId: null, qualityId: null });
    // Toggling a seeded rule through the UI does not turn it into user knowledge.
    rules.saveRule({ id: 'rule_coding', activityId: 'coding', conditions: '[]', enabled: 0, priority: 0, areaId: null, intentId: null, qualityId: null });

    const bySource = new Map(rules.listRules().map((r) => [r.id, r.source]));
    expect(bySource.get('rule_mine')).toBe('user');
    expect(bySource.get('rule_coding')).toBe('system');
  });

  it('creates a new activity with its event associations', () => {
    startRun('run-1');
    commit('run-1', {
      ...emptyPlan(),
      create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }],
    });

    const [activity] = repo.getActivitiesByIds(['ai-1']);
    expect(activity).toMatchObject({
      id: 'ai-1',
      startedAt: iso('09:00'),
      endedAt: iso('09:58'),
      ...interpretation,
      sourceRunId: 'run-1',
      userLocked: false,
      supersededAt: null,
    });
    expect(repo.getActivityEventIds('ai-1')).toEqual(ids.slice(0, 3));
    expect(repo.getActiveMemberships(ids)).toEqual(
      ids.slice(0, 3).map((eventId) => ({ eventId, activityId: 'ai-1', userLocked: false })),
    );
    expect(repo.listRecentRuns(5)[0]).toMatchObject({ id: 'run-1', status: 'succeeded', model: 'gemini-test-001', attemptCount: 1 });
  });

  it('survives an application restart', () => {
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });
    db.close();

    db = new Database(dbPath);
    repo = new IntelligenceRepository(db);

    expect(repo.hasSucceededRun(WS, WE)).toBe(true);
    expect(repo.getActivitiesByIds(['ai-1'])[0].title).toBe(interpretation.title);
    expect(repo.getActivityEventIds('ai-1')).toEqual(ids.slice(0, 3));
  });

  it('continues an existing activity: same id, more events, refreshed envelope', () => {
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });

    startRun('run-2', iso('10:00'), iso('11:00'));
    commit(
      'run-2',
      { ...emptyPlan(), extend: [{ activityId: 'ai-1', addEventIds: [ids[2], ids[3]], ...interpretation, summary: 'Kept going.' }] },
      iso('10:00'),
      iso('11:00'),
    );

    const [activity] = repo.getActivitiesByIds(['ai-1']);
    expect(activity).toMatchObject({ startedAt: iso('09:00'), endedAt: iso('10:30'), summary: 'Kept going.', sourceRunId: 'run-1' });
    expect(repo.getActivityEventIds('ai-1')).toEqual(ids); // re-adding ids[2] is a no-op
    expect(repo.listContinuityActivities(iso('12:00'), iso('10:15'), 2).map((a) => a.id)).toEqual(['ai-1']);
    expect(repo.listContinuityActivities(iso('12:00'), iso('11:00'), 2)).toEqual([]);
  });

  it('one successful run per window; a forced re-run supersedes the old one', () => {
    startRun('run-1');
    commit('run-1', emptyPlan());
    expect(repo.hasSucceededRun(WS, WE)).toBe(true);
    expect(repo.hasSucceededRun(WS, iso('10:30'))).toBe(false);

    // The idempotency key is enforced by the database itself.
    startRun('run-dup');
    const raw = new BetterSqliteDB(dbPath);
    expect(() => raw.prepare("UPDATE intelligence_runs SET status = 'succeeded' WHERE id = 'run-dup'").run()).toThrow(/UNIQUE/);
    raw.close();

    commit('run-dup', emptyPlan());
    const status = new Map(repo.listRecentRuns(5).map((r) => [r.id, r.status]));
    expect(status.get('run-1')).toBe('superseded');
    expect(status.get('run-dup')).toBe('succeeded');
  });

  it('supersedes an activity whose events were all re-assigned, and only then', () => {
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });

    startRun('run-2');
    commit('run-2', {
      ...emptyPlan(),
      create: [{ id: 'ai-2', startedAt: iso('09:20'), endedAt: iso('09:58'), eventIds: [ids[1], ids[2]], ...interpretation, title: 'Research' }],
      detach: [{ activityId: 'ai-1', eventIds: [ids[1], ids[2]] }],
    });
    let [first] = repo.getActivitiesByIds(['ai-1']);
    expect(first).toMatchObject({ supersededAt: null, endedAt: iso('09:20') }); // shrunk, not deleted
    expect(repo.getActivityEventIds('ai-1')).toEqual([ids[0]]);

    startRun('run-3');
    commit('run-3', {
      ...emptyPlan(),
      create: [{ id: 'ai-3', startedAt: iso('09:00'), endedAt: iso('09:20'), eventIds: [ids[0]], ...interpretation }],
      detach: [{ activityId: 'ai-1', eventIds: [ids[0]] }],
    });
    [first] = repo.getActivitiesByIds(['ai-1']);
    expect(first.supersededAt).toBe(iso('10:03'));
    expect(repo.getActiveMemberships(ids).map((m) => m.activityId).sort()).toEqual(['ai-2', 'ai-2', 'ai-3']);
  });

  it('locked activities cannot be extended, detached from, or superseded', () => {
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });

    expect(repo.lockActivitiesForEvents([ids[1]], iso('10:05'))).toBe(1);
    expect(repo.lockActivitiesForEvents([ids[1]], iso('10:06'))).toBe(0); // already locked
    expect(repo.getActivitiesByIds(['ai-1'])[0].userLocked).toBe(true);
    expect(repo.getActiveMemberships([ids[0]])[0].userLocked).toBe(true);

    startRun('run-2');
    commit('run-2', { ...emptyPlan(), detach: [{ activityId: 'ai-1', eventIds: ids.slice(0, 3) }] });
    expect(repo.getActivityEventIds('ai-1')).toEqual(ids.slice(0, 3));
    expect(repo.getActivitiesByIds(['ai-1'])[0].supersededAt).toBeNull();

    startRun('run-3', iso('10:00'), iso('11:00'));
    expect(() =>
      commit('run-3', { ...emptyPlan(), extend: [{ activityId: 'ai-1', addEventIds: [ids[3]], ...interpretation, title: 'Overwritten' }] }, iso('10:00'), iso('11:00')),
    ).toThrow(/locked/);
    expect(repo.getActivitiesByIds(['ai-1'])[0].title).toBe(interpretation.title);
  });

  it('a failed commit rolls back completely', () => {
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });

    startRun('run-2');
    expect(() =>
      commit('run-2', {
        ...emptyPlan(),
        detach: [{ activityId: 'ai-1', eventIds: ids.slice(0, 3) }],
        create: [
          { id: 'ai-2', startedAt: iso('09:00'), endedAt: iso('09:20'), eventIds: [ids[0]], ...interpretation },
          // Unknown classification id → foreign key violation mid-transaction.
          { id: 'ai-3', startedAt: iso('09:20'), endedAt: iso('09:40'), eventIds: [ids[1]], ...interpretation, areaId: 'area_invented' },
        ],
      }),
    ).toThrow(/FOREIGN KEY/);

    expect(repo.getActivitiesByIds(['ai-2', 'ai-3'])).toEqual([]);
    expect(repo.getActivityEventIds('ai-1')).toEqual(ids.slice(0, 3));
    expect(repo.getActivitiesByIds(['ai-1'])[0].supersededAt).toBeNull();
    expect(repo.listRecentRuns(5).find((r) => r.id === 'run-2')!.status).toBe('running');
  });

  it('tracks failures and interrupted runs without touching activities', () => {
    startRun('run-1');
    repo.recordAttempt('run-1', 3, iso('10:03'));
    repo.failRun('run-1', 'validation', 'unknown event id 999', iso('10:03'));
    startRun('run-2');
    repo.failRun('run-2', 'network', 'offline', iso('10:04'));
    startRun('run-3');

    expect(repo.countFailedRuns(WS, WE, ['validation', 'malformed_output'])).toBe(1);
    expect(repo.hasSucceededRun(WS, WE)).toBe(false);
    expect(repo.failInterruptedRuns(iso('11:00'))).toBe(1);
    expect(repo.listRecentRuns(5).find((r) => r.id === 'run-1')).toMatchObject({
      status: 'failed', attemptCount: 3, errorCategory: 'validation', error: 'unknown event id 999', outputJson: null,
    });
    expect(repo.listRecentRuns(5).find((r) => r.id === 'run-3')!.status).toBe('failed');
  });

  it('raw events are never modified by intelligence writes', () => {
    const before = events.getAll();
    startRun('run-1');
    commit('run-1', { ...emptyPlan(), create: [{ id: 'ai-1', startedAt: iso('09:00'), endedAt: iso('09:58'), eventIds: ids.slice(0, 3), ...interpretation }] });
    repo.lockActivitiesForEvents(ids, iso('10:05'));

    expect(events.getAll()).toEqual(before);
    expect(events.getOverlapping(iso('09:30'), iso('10:10')).map((e) => e.id)).toEqual([ids[1], ids[2], ids[3]]);
  });
});
