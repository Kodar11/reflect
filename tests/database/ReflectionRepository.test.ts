import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqliteDB from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { ReflectionRepository, type NewReflectionReport, type ReflectionCommit } from '../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import type { ReflectionInsight, ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';
import { planPrioritySync } from '../../src/reflection/ReflectionPriorities';
import { REFLECTION_PROMPT_VERSION } from '../../src/reflection/ReflectionPrompt';

/**
 * Integration tests against real SQLite. Self-skips when the native binary is
 * built for Electron's ABI instead of Node's (run with `npm run test:db`).
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflection-probe-')), 'probe.db');
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

const at = (day: number, hhmm = '00:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, day, h, m).toISOString();
};
const week42 = periodContaining('week', new Date(2026, 9, 14));
const week41 = shiftPeriod(week42, -1);

function attempt(id: string, period: ReflectionPeriod = week42, nowIso = at(19, '00:05')): NewReflectionReport {
  return {
    id,
    period,
    coveredUntil: period.end,
    trigger: 'scheduled',
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    promptVersion: REFLECTION_PROMPT_VERSION,
    model: 'gemini-test',
    nowIso,
  };
}

function insight(id: string, overrides: Partial<ReflectionInsight> = {}): ReflectionInsight {
  return {
    id,
    type: 'progress',
    title: 'Project X moved forward',
    observation: 'You spent 14h 20m on Project X across 5 days.',
    interpretation: 'It was your most consistently worked thread.',
    relevance: 'Launching Project X is the priority you stated.',
    suggestedAction: null,
    confidence: 0.85,
    evidence: [
      { kind: 'metric', metricKey: 'thread.project-x.minutes', label: 'Time on “Project X”', value: '14h 20m' },
      { kind: 'activity', activityId: 'ai-1', label: 'Implement Project X sync engine', value: '1h 20m', period: { start: at(12, '09:00'), end: at(12, '10:20') } },
    ],
    sourceActivityIds: ['ai-1'],
    sourceMetricKeys: ['thread.project-x.minutes'],
    claimSignature: 'progress|thread.project-x.minutes',
    createdAt: at(19, '00:06'),
    ...overrides,
  };
}

function commit(reportId: string, insights: ReflectionInsight[], period: ReflectionPeriod = week42, nowIso = at(19, '00:06')): ReflectionCommit {
  return {
    reportId,
    period,
    coveredUntil: period.end,
    model: 'gemini-test-001',
    attemptCount: 1,
    headline: 'Project X received consistent attention this week.',
    carryForward: {
      text: 'Keep a morning block for Project X.',
      sourceMetricKeys: ['pattern.longest_block_before_noon_days'],
      sourceActivityIds: [],
      evidence: [{ kind: 'metric', metricKey: 'pattern.longest_block_before_noon_days', label: 'Days whose longest block started before noon', value: '5 of 5 days' }],
    },
    insights,
    dataSnapshot: {
      period,
      coveredUntil: period.end,
      isPartial: false,
      priorities: [{ id: 'pr-1', text: 'Launching Project X', activeFrom: at(1), possiblyStale: false }],
      activePriorityIds: ['pr-1'],
      activities: [{ id: 'ai-1', startedAt: at(12, '09:00'), endedAt: at(12, '10:20'), minutes: 80, title: 'Implement Project X sync engine', thread: 'Project X', priorityId: 'pr-1' }],
      notes: [],
      userContextIncluded: true,
      previousReportId: null,
    },
    metricsSnapshot: {
      'time.tracked_minutes': { key: 'time.tracked_minutes', label: 'Total tracked time', value: 1360, unit: 'minutes', display: '22h 40m', group: 'time' },
    },
    nowIso,
  };
}

suite('ReflectionRepository (integration, real SQLite)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let repo: ReflectionRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflection-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database(dbPath);
    repo = new ReflectionRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Generate + commit in one go. */
  function save(id: string, insights: ReflectionInsight[], period = week42, nowIso = at(19, '00:06')) {
    repo.createGenerating(attempt(id, period, nowIso));
    repo.commitReport(commit(id, insights, period, nowIso));
  }

  it('saves a report with its insights linked, in order, and reads it back across a restart', () => {
    save('r1', [insight('i1'), insight('i2', { type: 'fragmentation', title: 'Afternoons were fragmented', claimSignature: 'fragmentation|behavior.switches' })]);

    db.close();
    db = new Database(dbPath);
    repo = new ReflectionRepository(db);

    const report = repo.getCurrentReport('week', week42.key)!;
    expect(report).toMatchObject({
      id: 'r1',
      status: 'fresh',
      period: week42,
      coveredUntil: week42.end,
      headline: 'Project X received consistent attention this week.',
      model: 'gemini-test-001',
      promptVersion: REFLECTION_PROMPT_VERSION,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      generatedAt: at(19, '00:06'),
      needsVerification: false,
    });
    expect(report.insights.map((i) => [i.id, i.type])).toEqual([['i1', 'progress'], ['i2', 'fragmentation']]);
    // Structured fields survive the round trip — not one blob of prose.
    expect(report.insights[0]).toEqual({ ...insight('i1'), feedback: null });
    expect(report.carryForward!.evidence[0].value).toBe('5 of 5 days');
    expect(report.metricsSnapshot!['time.tracked_minutes'].display).toBe('22h 40m');
    expect(report.dataSnapshot!.priorities[0].text).toBe('Launching Project X');
    expect(repo.getReportById('r1')!.id).toBe('r1');
    expect(repo.getReportById('nope')).toBeNull();
  });

  it('stores no raw event payloads', () => {
    save('r1', [insight('i1')]);
    const raw = new BetterSqliteDB(dbPath);
    const columns = ['reflection_reports', 'reflection_insights'].flatMap((t) =>
      (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
    );
    raw.close();
    for (const banned of ['payload', 'url', 'event_ids', 'title_raw']) expect(columns).not.toContain(banned);
  });

  it('regeneration supersedes the previous report instead of overwriting it', () => {
    save('r1', [insight('i1')]);
    save('r2', [insight('i3', { title: 'A fresh look' })], week42, at(19, '08:00'));

    expect(repo.getCurrentReport('week', week42.key)!.id).toBe('r2');
    const old = repo.getReportById('r1')!;
    expect(old.status).toBe('superseded');
    expect(old.insights[0].title).toBe('Project X moved forward'); // untouched
    expect(repo.listCurrentReports('week', 10).map((r) => r.id)).toEqual(['r2']);
  });

  it('a failed attempt leaves the current report exactly as it was', () => {
    save('r1', [insight('i1')]);
    repo.createGenerating(attempt('r2', week42, at(19, '08:00')));
    repo.recordAttempt('r2', 3, at(19, '08:01'));
    repo.failReport('r2', 'validation', 'insight 1: number "99" not found', at(19, '08:01'));

    expect(repo.getCurrentReport('week', week42.key)!.id).toBe('r1');
    expect(repo.getLatestAttempt('week', week42.key)).toMatchObject({ id: 'r2', status: 'failed', errorCategory: 'validation', attemptCount: 3 });
    expect(repo.countFailedReports('week', week42.key, ['validation', 'malformed_output'])).toBe(1);
    expect(repo.countFailedReports('week', week42.key, ['network'])).toBe(0);
    // A finished attempt cannot be failed afterwards.
    repo.failReport('r1', 'internal', 'late', at(19, '09:00'));
    expect(repo.getReportById('r1')!.status).toBe('fresh');
  });

  it('commit is all-or-nothing', () => {
    save('r1', [insight('i1')]);
    repo.createGenerating(attempt('r2', week42, at(19, '08:00')));
    // Duplicate insight id → the insert fails → the whole commit rolls back.
    expect(() => repo.commitReport(commit('r2', [insight('i1')], week42, at(19, '08:01')))).toThrow();
    expect(repo.getCurrentReport('week', week42.key)!.id).toBe('r1');
    expect(repo.getReportById('r2')!.status).toBe('generating');
    expect(() => repo.commitReport(commit('never-started', [insight('ix')]))).toThrow(/is not being generated/);
  });

  it('a successful report clears earlier failed and insufficient attempts; failures are pruned', () => {
    repo.recordInsufficient(attempt('thin', week42, at(15)));
    repo.recordInsufficient(attempt('thin-2', week42, at(16))); // replaces the earlier marker
    expect(repo.getReportById('thin')).toBeNull();
    expect(repo.getLatestAttempt('week', week42.key)!.status).toBe('insufficient_data');

    for (let i = 0; i < 8; i++) {
      repo.createGenerating(attempt(`f${i}`, week42, at(17, `0${i}:00`)));
      repo.failReport(`f${i}`, 'network', 'offline', at(17, `0${i}:01`));
    }
    repo.createGenerating(attempt('prune-trigger', week42, at(18)));
    const raw = new BetterSqliteDB(dbPath);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM reflection_reports WHERE status = 'failed'`).get() as { n: number }).n).toBe(5);
    raw.close();

    repo.commitReport(commit('prune-trigger', [insight('i1')], week42, at(18, '00:01')));
    const raw2 = new BetterSqliteDB(dbPath);
    expect(raw2.prepare(`SELECT id, status FROM reflection_reports`).all()).toEqual([{ id: 'prune-trigger', status: 'fresh' }]);
    raw2.close();
  });

  it('interrupted generations are failed on recovery', () => {
    repo.createGenerating(attempt('stuck'));
    expect(repo.failInterruptedReports(at(19, '09:00'))).toBe(1);
    expect(repo.getReportById('stuck')).toMatchObject({ status: 'failed', error: 'Interrupted before completion' });
    expect(repo.failInterruptedReports(at(19, '09:01'))).toBe(0);
  });

  it('marks a report stale without touching its content, and flags reports for re-verification', () => {
    save('r41', [insight('a1')], week41, at(12, '00:05'));
    save('r42', [insight('b1')], week42);

    // A change on Oct 13 only concerns week 42.
    expect(repo.flagForVerification({ start: at(13, '09:00'), end: at(13, '10:00') }, at(19, '10:00'))).toBe(1);
    expect(repo.getCurrentReport('week', week42.key)!.needsVerification).toBe(true);
    expect(repo.getCurrentReport('week', week41.key)!.needsVerification).toBe(false);
    repo.clearVerification('r42');
    expect(repo.getCurrentReport('week', week42.key)!.needsVerification).toBe(false);
    // A global change concerns everything.
    expect(repo.flagForVerification(null, at(19, '10:00'))).toBe(2);

    expect(repo.markStale('r42', 'activity_changed', at(19, '11:00'))).toBe(true);
    const stale = repo.getCurrentReport('week', week42.key)!;
    expect(stale).toMatchObject({ status: 'stale', staleReason: 'activity_changed', staleAt: at(19, '11:00'), needsVerification: false });
    expect(stale.headline).toBe('Project X received consistent attention this week.');
    expect(repo.markStale('r42', 'again', at(19, '12:00'))).toBe(false); // already stale

    // Regenerating a stale report makes the period fresh again.
    save('r42b', [insight('b2')], week42, at(19, '12:00'));
    expect(repo.getCurrentReport('week', week42.key)).toMatchObject({ id: 'r42b', status: 'fresh', staleReason: null });
  });

  it('retrieves historical reports, newest period first', () => {
    const day = periodContaining('day', new Date(2026, 9, 16));
    save('r41', [insight('a1')], week41, at(12, '00:05'));
    save('r42', [insight('b1')], week42);
    save('d16', [insight('c1')], day, at(17, '00:05'));

    expect(repo.listCurrentReports('week', 10).map((r) => r.id)).toEqual(['r42', 'r41']);
    expect(repo.listCurrentReports('week', 10, week42.start).map((r) => r.id)).toEqual(['r41']);
    expect(repo.listCurrentReports('week', 1).map((r) => r.id)).toEqual(['r42']);
    expect(repo.listCurrentReports(null, 10).map((r) => r.id)).toEqual(['d16', 'r42', 'r41']);
    expect(repo.listReportedPeriods()).toEqual([day, week42, week41]);
    expect(repo.getCurrentReport('week', '2026-W01')).toBeNull();
    expect(repo.getLatestAttempt('month', '2026-10')).toBeNull();
  });

  it('saves, replaces and clears feedback; feedback follows its insight', () => {
    save('r1', [insight('i1'), insight('i2', { type: 'recurring_behavior', claimSignature: 'recurring_behavior|x' })]);

    expect(repo.setFeedback('i1', 'useful', 'f1', at(19, '10:00'))).toBe(true);
    expect(repo.setFeedback('i2', 'not_useful', 'f2', at(19, '10:01'))).toBe(true);
    expect(repo.setFeedback('i2', 'inaccurate', 'f3', at(19, '10:02'))).toBe(true); // one feedback per insight
    expect(repo.setFeedback('missing', 'useful', 'f4', at(19, '10:03'))).toBe(false);

    expect(repo.getCurrentReport('week', week42.key)!.insights.map((i) => i.feedback)).toEqual(['useful', 'inaccurate']);
    expect(repo.listFeedback(at(1))).toEqual([
      { insightId: 'i2', insightType: 'recurring_behavior', feedbackType: 'inaccurate', createdAt: at(19, '10:02') },
      { insightId: 'i1', insightType: 'progress', feedbackType: 'useful', createdAt: at(19, '10:00') },
    ]);
    expect(repo.listFeedback(at(19, '10:01'))).toHaveLength(1);

    repo.setFeedback('i1', null, 'f5', at(19, '10:05'));
    expect(repo.getCurrentReport('week', week42.key)!.insights[0].feedback).toBeNull();

    // Only the documented feedback values are storable.
    expect(() => repo.setFeedback('i1', 'five_stars' as never, 'f6', at(19, '10:06'))).toThrow();
  });

  it('normalizes priorities into intervals', () => {
    const options = { nowIso: at(10), confirmedAt: at(9), initialActiveFrom: at(1) };
    repo.applyPrioritySync(planPrioritySync([], ['Launching Project X', 'Finish my degree'], options), ['pr-1', 'pr-2'], at(10));
    expect(repo.listPriorities()).toEqual([
      { id: 'pr-1', text: 'Launching Project X', normalizedKey: 'launching project x', status: 'active', activeFrom: at(1), activeUntil: null, lastConfirmedAt: at(9) },
      { id: 'pr-2', text: 'Finish my degree', normalizedKey: 'finish my degree', status: 'active', activeFrom: at(1), activeUntil: null, lastConfirmedAt: at(9) },
    ]);

    // The degree is dropped from the profile; Project X is reconfirmed.
    const later = { nowIso: at(20), confirmedAt: at(20), initialActiveFrom: at(1) };
    repo.applyPrioritySync(planPrioritySync(repo.listPriorities(), ['Launching Project X'], later), [], at(20));
    const [x, degree] = repo.listPriorities();
    expect(x).toMatchObject({ status: 'active', lastConfirmedAt: at(20) });
    expect(degree).toMatchObject({ status: 'archived', activeUntil: at(20) });

    expect(repo.setPriorityStatus('pr-1', 'completed', at(22))).toMatchObject({ status: 'completed', activeUntil: at(22) });
    expect(repo.setPriorityStatus('pr-1', 'active', at(23))).toMatchObject({ status: 'active', activeUntil: null, lastConfirmedAt: at(23) });
    expect(repo.setPriorityStatus('missing', 'paused', at(23))).toBeNull();
  });

  it('caches thread / priority decisions per activity signature', () => {
    repo.upsertAnnotations(
      [
        { signature: 'implement project x sync engine|coding', thread: 'Project X', priorityId: 'pr-1', checkedPriorityIds: ['pr-1'] },
        { signature: 'watch videos|browsing', thread: null, priorityId: null, checkedPriorityIds: ['pr-1'] },
      ],
      at(10),
    );
    repo.upsertAnnotations([{ signature: 'fix project y billing bug|coding', thread: 'Project Y', priorityId: null, checkedPriorityIds: ['pr-1'] }], at(11));
    // Re-evaluated against a second priority.
    repo.upsertAnnotations([{ signature: 'watch videos|browsing', thread: null, priorityId: null, checkedPriorityIds: ['pr-1', 'pr-2'] }], at(12));

    expect(repo.getAnnotations(['implement project x sync engine|coding', 'watch videos|browsing', 'unknown'])).toEqual([
      { signature: 'implement project x sync engine|coding', thread: 'Project X', priorityId: 'pr-1', checkedPriorityIds: ['pr-1'] },
      { signature: 'watch videos|browsing', thread: null, priorityId: null, checkedPriorityIds: ['pr-1', 'pr-2'] },
    ]);
    expect(repo.listThreadLabels(10)).toEqual(['Project Y', 'Project X']);
    expect(repo.getAnnotations([])).toEqual([]);
  });

  it('deleting a report removes its insights and their feedback', () => {
    save('r1', [insight('i1')]);
    repo.setFeedback('i1', 'useful', 'f1', at(19, '10:00'));
    const raw = new BetterSqliteDB(dbPath);
    raw.pragma('foreign_keys = ON');
    raw.prepare(`DELETE FROM reflection_reports WHERE id = 'r1'`).run();
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM reflection_insights`).get() as { n: number }).n).toBe(0);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM reflection_feedback`).get() as { n: number }).n).toBe(0);
    raw.close();
  });
});

suite('Database migration v12 → v13 (reflection)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds the reflection tables to an existing database and keeps its data', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflection-migration-'));
    const dbPath = path.join(dir, 'test.db');

    // Build a v12 database: the current schema minus what v13 adds.
    const seeded = new Database(dbPath);
    new UserProfileRepository(seeded).saveProfile(
      { roles: ['Founder'], description: null, currentWork: [], priorities: ['Launching Project X'], interests: [], additionalContext: null },
      'completed',
    );
    seeded.close();
    const raw = new BetterSqliteDB(dbPath);
    raw.exec(`
      DROP TABLE reflection_feedback;
      DROP TABLE reflection_insights;
      DROP TABLE reflection_reports;
      DROP TABLE reflection_priorities;
      DROP TABLE reflection_activity_annotations;
      INSERT INTO events (watcher, started_at, ended_at, app) VALUES ('window', '2026-10-05T09:00:00.000Z', '2026-10-05T10:00:00.000Z', 'VS Code');
    `);
    raw.pragma('user_version = 12');
    raw.close();

    const migrated = new Database(dbPath);
    const check = new BetterSqliteDB(dbPath);
    expect(check.pragma('user_version', { simple: true })).toBe(13);
    const tables = (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['reflection_reports', 'reflection_insights', 'reflection_feedback', 'reflection_priorities', 'reflection_activity_annotations']) {
      expect(tables).toContain(t);
    }
    expect((check.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(1);
    check.close();

    // Existing data is intact, and onboarding priorities were not altered.
    expect(new UserProfileRepository(migrated).getProfile()).toMatchObject({ priorities: ['Launching Project X'], onboardingStatus: 'completed' });
    expect(new ReflectionRepository(migrated).listPriorities()).toEqual([]);
    migrated.close();

    // Re-opening never re-runs the migration or wipes anything.
    const reopened = new Database(dbPath);
    const repo = new ReflectionRepository(reopened);
    repo.recordInsufficient(attempt('thin'));
    reopened.close();
    const again = new Database(dbPath);
    expect(new ReflectionRepository(again).getLatestAttempt('week', week42.key)!.id).toBe('thin');
    again.close();
  });
});
