import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqliteDB from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoachRepository } from '../../src/database/CoachRepository';
import { Database } from '../../src/database/Database';
import { ReflectionRepository, type ReflectionCommit } from '../../src/database/ReflectionRepository';
import { applyTransition } from '../../src/coach/CoachLifecycle';
import type { CoachObservation } from '../../src/coach/CoachModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { REFLECTION_PROMPT_VERSION } from '../../src/reflection/ReflectionPrompt';
import { accepted, coachAction, memory, message } from '../coach/helpers';

/**
 * Integration tests against real SQLite. Self-skips when the native binary is
 * built for Electron's ABI instead of Node's (run with `npm run test:db`).
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-coach-probe-')), 'probe.db');
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
const day12 = periodContaining('day', new Date(2026, 9, 12));

function commit(reportId: string, overrides: Partial<ReflectionCommit> = {}): ReflectionCommit {
  return {
    reportId,
    period: day12,
    coveredUntil: at(12, '22:05'),
    model: 'gemini-test-001',
    attemptCount: 1,
    headline: 'Project X took your morning.',
    narrative: 'You started with a long stretch on Project X.',
    carryForward: null,
    coach: { actionIds: [], followups: [], uncertainty: [], noActionReason: null, question: null },
    insights: [],
    dataSnapshot: {
      period: day12,
      coveredUntil: at(12, '22:05'),
      isPartial: true,
      priorities: [],
      activePriorityIds: [],
      activities: [],
      notes: [],
      userContextIncluded: false,
      previousReportId: null,
    },
    metricsSnapshot: {},
    nowIso: at(12, '22:06'),
    ...overrides,
  };
}

suite('CoachRepository (SQLite)', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let repo: CoachRepository;
  let reflections: ReflectionRepository;

  const openReport = (id: string) =>
    reflections.createGenerating({
      id,
      period: day12,
      coveredUntil: at(12, '22:05'),
      trigger: 'scheduled',
      inputSchemaVersion: 2,
      outputSchemaVersion: 2,
      promptVersion: REFLECTION_PROMPT_VERSION,
      model: 'gemini-test',
      nowIso: at(12, '22:05'),
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-coach-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database(dbPath);
    repo = new CoachRepository(db);
    reflections = new ReflectionRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh database is at v15 with the coach tables and the daily-intelligence columns', () => {
    const raw = new BetterSqliteDB(dbPath, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(17);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['coach_actions', 'coach_action_events', 'coach_memory', 'coach_messages', 'coach_settings']) expect(tables).toContain(t);
    const columns = (raw.prepare(`PRAGMA table_info(reflection_reports)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['narrative', 'coach_json']));
    raw.close();
  });

  it('stores an action whole and reads it back exactly', () => {
    openReport('report-12');
    const observation: CoachObservation = {
      kind: 'executed',
      observedAt: at(13, '09:46'),
      window: { start: at(13, '05:00'), end: at(13, '12:00') },
      final: false,
      focusSessionIds: ['focus-1'],
      activityIds: ['ai-13-0'],
      focusMinutes: 45,
      matchedMinutes: 45,
      plannedMinutes: 45,
      interruptions: 1,
      facts: ['Focus session “Project X” ran 45m of 45m planned, 1 interruption.'],
    };
    const action = coachAction({
      description: 'Before opening anything else.',
      priorityId: 'pr-1',
      evidence: [{ kind: 'metric', metricKey: 'thread.project-x.minutes', label: 'Time on “Project X”', value: '2h 52m' }],
      sourceMetricKeys: ['thread.project-x.minutes'],
      sourceActivityIds: ['ai-12-0'],
      observation,
      linkedFocusSessionId: 'focus-1',
      userEdited: true,
      snoozeCount: 1,
    });
    repo.insertAction(action);
    expect(repo.getAction(action.id)).toEqual(action);
    expect(repo.getAction('missing')).toBeNull();
  });

  it('persists every step of the lifecycle and keeps the audit trail', () => {
    openReport('report-12');
    const suggested = coachAction();
    repo.insertAction(suggested);

    const steps = [
      applyTransition(suggested, { type: 'accept' }, at(12, '22:10')),
    ];
    steps.push(applyTransition(steps[0], { type: 'execution', execution: 'done', reasonCode: null, note: null }, at(13, '10:00')));
    steps.push(applyTransition(steps[1], { type: 'outcome', outcome: 'did_not_work', reasonCode: 'too_difficult', note: 'Too long for one sitting' }, at(13, '21:00')));
    steps.forEach((step, index) => {
      repo.updateAction(step);
      repo.insertActionEvent({
        id: `e${index}`,
        actionId: step.id,
        type: ['accept', 'execution', 'outcome'][index],
        fromStatus: index === 0 ? 'suggested' : steps[index - 1].status,
        toStatus: step.status,
        detail: index === 2 ? { reasonCode: 'too_difficult' } : null,
        createdAt: step.updatedAt,
      });
    });

    // Done, and still a bad recommendation: the two facts are separate columns.
    expect(repo.getAction(suggested.id)).toMatchObject({
      status: 'closed',
      execution: 'done',
      executionSource: 'user',
      outcome: 'did_not_work',
      reasonCode: 'too_difficult',
      note: 'Too long for one sitting',
      acceptedAt: at(12, '22:10'),
      executedAt: at(13, '10:00'),
      outcomeAt: at(13, '21:00'),
      closedAt: at(13, '21:00'),
    });
    expect(repo.listActionEvents(suggested.id).map((e) => [e.type, e.fromStatus, e.toStatus, e.detail])).toEqual([
      ['accept', 'suggested', 'accepted', null],
      ['execution', 'accepted', 'review', null],
      ['outcome', 'review', 'closed', { reasonCode: 'too_difficult' }],
    ]);
  });

  it('lists actions newest first, by time and by report', () => {
    openReport('report-12');
    const old = coachAction({ reportId: null, createdAt: at(1), updatedAt: at(1) });
    const first = coachAction({ title: 'First' });
    const second = coachAction({ title: 'Second', createdAt: at(12, '22:00') });
    const later = coachAction({ title: 'Later', reportId: null, source: 'conversation', createdAt: at(13, '08:00') });
    for (const a of [old, first, second, later]) repo.insertAction(a);

    expect(repo.listActions(at(10)).map((a) => a.title)).toEqual(['Later', 'Second', 'First']);
    expect(repo.listActionsByReport('report-12').map((a) => a.title)).toEqual(['First', 'Second']);
  });

  it('refuses a state the model does not know', () => {
    expect(() => repo.insertAction({ ...coachAction({ reportId: null }), status: 'done' as never })).toThrow();
    expect(() => repo.insertAction({ ...coachAction({ reportId: null }), outcome: 'amazing' as never })).toThrow();
  });

  it('a transaction is all or nothing, and nests', () => {
    expect(() =>
      repo.transaction(() => {
        repo.insertAction(coachAction({ reportId: null }));
        repo.transaction(() => repo.insertMemory(memory('Mornings are classes until 11.')));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.listActions(at(1))).toEqual([]);
    expect(repo.listMemories()).toEqual([]);
  });

  it('keeps memory small, resolvable and removable', () => {
    const kept = memory('Mornings are classes until 11.');
    const resolved = memory('The billing fix is waiting on a reply.', { kind: 'open_loop', source: 'coach', createdAt: at(11), updatedAt: at(11) });
    const removed = memory('Prefers working after dinner.', { kind: 'preference', createdAt: at(12), updatedAt: at(12) });
    for (const m of [kept, resolved, removed]) repo.insertMemory(m);

    repo.updateMemory({ ...resolved, status: 'resolved', updatedAt: at(13) });
    repo.updateMemory({ ...removed, status: 'removed', updatedAt: at(13) });

    // "Forget this" really forgets: a removed memory is never listed again.
    expect(repo.listMemories().map((m) => [m.text, m.status])).toEqual([
      ['The billing fix is waiting on a reply.', 'resolved'],
      ['Mornings are classes until 11.', 'active'],
    ]);
    expect(repo.getMemory(kept.id)).toEqual(kept);
  });

  it('keeps the conversation in order and prunes the oldest turns', () => {
    for (let i = 1; i <= 6; i++) {
      repo.insertMessage(message(i % 2 ? 'user' : 'coach', `turn ${i}`, at(13, `08:0${i}`), i === 2 ? { kind: 'question', targetKey: 't:project-x', aboutActionId: 'a1' } : null));
    }
    expect(repo.listMessages(3).map((m) => m.text)).toEqual(['turn 4', 'turn 5', 'turn 6']);
    expect(repo.listMessages(50)[1]).toMatchObject({ role: 'coach', meta: { kind: 'question', targetKey: 't:project-x' } });
    repo.pruneMessages(2);
    expect(repo.listMessages(50).map((m) => m.text)).toEqual(['turn 5', 'turn 6']);
  });

  it('stores the reflection time and the day boundary', () => {
    expect(repo.getSettings()).toEqual({ reflectionMinutes: 1320, dayStartMinutes: 0, notifyDailyReflection: true });
    repo.saveSettings({ reflectionMinutes: 1290, dayStartMinutes: 240, notifyDailyReflection: false }, at(12));
    db.close();
    db = new Database(dbPath);
    expect(new CoachRepository(db).getSettings()).toEqual({ reflectionMinutes: 1290, dayStartMinutes: 240, notifyDailyReflection: false });
  });

  it('a report, its coach block and its actions are committed together', () => {
    openReport('report-12');
    const action = coachAction();
    reflections.commitReport(
      commit('report-12', {
        coach: { actionIds: [action.id], followups: [], uncertainty: ['Not sure about the afternoon.'], noActionReason: null, question: null },
        alongside: () => repo.insertAction(action),
      }),
    );
    const report = reflections.getCurrentReport('day', day12.key)!;
    expect(report).toMatchObject({
      status: 'fresh',
      narrative: 'You started with a long stretch on Project X.',
      coach: { actionIds: [action.id], uncertainty: ['Not sure about the afternoon.'] },
    });
    expect(repo.listActionsByReport('report-12')).toHaveLength(1);
  });

  it('if the coach\'s writes fail, the report is not committed either — and the earlier one stays', () => {
    openReport('first');
    reflections.commitReport(commit('first', { headline: 'The afternoon report.' }));
    const kept = accepted({ reportId: 'first' });
    repo.insertAction(kept);

    openReport('second');
    expect(() =>
      reflections.commitReport(
        commit('second', {
          headline: 'The evening report.',
          alongside: () => {
            repo.insertAction(coachAction({ reportId: 'second' }));
            repo.insertMemory(memory('A phantom memory.'));
            throw new Error('disk full');
          },
        }),
      ),
    ).toThrow('disk full');

    expect(reflections.getCurrentReport('day', day12.key)).toMatchObject({ id: 'first', status: 'fresh', headline: 'The afternoon report.' });
    expect(reflections.getReportById('second')!.status).toBe('generating');
    expect(repo.listActions(at(1)).map((a) => a.id)).toEqual([kept.id]);
    expect(repo.listMemories()).toEqual([]);
  });

  it('migrates a v14 database: earlier reflections are kept, the coach starts empty', () => {
    openReport('old-day');
    reflections.commitReport(
      commit('old-day', { carryForward: { text: 'Keep a morning block for Project X.', sourceMetricKeys: [], sourceActivityIds: [], evidence: [] }, coach: null, narrative: null }),
    );
    db.close();

    // Rebuild what a v14 database looked like.
    const raw = new BetterSqliteDB(dbPath);
    raw.exec(`
      DROP TABLE coach_action_events;
      DROP TABLE coach_actions;
      DROP TABLE coach_memory;
      DROP TABLE coach_messages;
      DROP TABLE coach_settings;
      ALTER TABLE reflection_reports DROP COLUMN narrative;
      ALTER TABLE reflection_reports DROP COLUMN coach_json;
    `);
    raw.pragma('user_version = 14');
    raw.close();

    db = new Database(dbPath);
    const check = new BetterSqliteDB(dbPath, { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(17);
    check.close();

    expect(new ReflectionRepository(db).getCurrentReport('day', day12.key)).toMatchObject({
      id: 'old-day',
      narrative: null,
      coach: null,
      carryForward: { text: 'Keep a morning block for Project X.' },
    });
    const migrated = new CoachRepository(db);
    expect(migrated.listActions(at(1))).toEqual([]);
    expect(migrated.getSettings().reflectionMinutes).toBe(1320);
    // Re-opening does not re-run the migration.
    migrated.insertMemory(memory('Mornings are classes until 11.'));
    db.close();
    db = new Database(dbPath);
    expect(new CoachRepository(db).listMemories()).toHaveLength(1);
  });
});
