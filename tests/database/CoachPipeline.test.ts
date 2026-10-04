import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { CoachRepository } from '../../src/database/CoachRepository';
import { Database } from '../../src/database/Database';
import { EditRepository } from '../../src/database/EditRepository';
import { EventRepository } from '../../src/database/EventRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import { ReflectionRepository } from '../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { CoachService } from '../../src/coach/CoachService';
import type { FocusSession } from '../../src/focus/FocusModels';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { toReflectionActivities } from '../../src/reflection/ReflectionActivities';
import { ReflectionAnnotator } from '../../src/reflection/ReflectionAnnotator';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG, type TaxonomyNames } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionService } from '../../src/reflection/ReflectionService';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { modelAction, modelChat, modelDay } from '../coach/helpers';
import { ScriptedGemini } from '../intelligence/helpers';

/**
 * End-to-end over real SQLite, wired exactly like `main.ts`:
 *
 *   raw events + AI activities + Focus sessions + priorities
 *     → verified timeline → metrics → ONE (scripted) Gemini request
 *     → report + tracked action, one transaction
 *     → user decision → Focus session → observed execution → stated outcome
 *     → the next day's request carries that record → conversation → memory
 *
 * …and all of it survives a restart. Self-skips if the native binary ABI does
 * not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-coach-e2e-probe-')), 'probe.db');
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

const local = (day: number, hhmm = '00:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, day, h, m);
};
const iso = (day: number, hhmm = '00:00') => local(day, hhmm).toISOString();
const day = (d: number) => periodContaining('day', local(d));

interface Block {
  hhmm: string;
  minutes: number;
  title: string;
  app: string;
  url?: string;
  contextId: string;
  areaId: string;
  intentId: string;
  qualityId: string;
}

const X = (hhmm: string, minutes: number): Block => ({
  hhmm, minutes, title: 'Implement Project X sync engine', app: 'VS Code',
  contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused',
});
const Y = (hhmm: string, minutes: number): Block => ({ ...X(hhmm, minutes), title: 'Fix Project Y billing bug' });
const RESEARCH = (hhmm: string, minutes: number): Block => ({
  hhmm, minutes, title: 'Research offline sync approaches', app: 'Chrome', url: 'developer.mozilla.org',
  contextId: 'learning', areaId: 'area_work', intentId: 'intent_research', qualityId: 'quality_routine',
});
const BROWSING = (hhmm: string, minutes: number): Block => ({
  hhmm, minutes, title: 'Browse videos and feeds', app: 'Chrome', url: 'youtube.com',
  contextId: 'browsing', areaId: 'area_leisure', intentId: 'intent_consume', qualityId: 'quality_distracting',
});

const WORKDAY: Block[] = [
  X('09:00', 80), X('10:30', 60),
  RESEARCH('13:00', 20), Y('13:22', 25), X('13:50', 12), BROWSING('14:05', 10),
  Y('14:17', 30), RESEARCH('14:50', 15), X('15:08', 20),
];

function wire(dbPath: string, gemini: ScriptedGemini, clock: { now: Date }) {
  const db = new Database(dbPath);
  const events = new EventRepository(db);
  const activityRules = new ActivityRuleRepository(db);
  const categorizationRepo = new CategorizationRepository(db);
  const focus = new FocusRepository(db);
  const intelligenceRepo = new IntelligenceRepository(db);
  const profiles = new UserProfileRepository(db, () => clock.now);
  const aiSource = new IntelligenceTimelineSource(intelligenceRepo);
  const categorization = new CategorizationService(activityRules, categorizationRepo, focus, events, aiSource);
  const timeline = new TimelineService(new SessionService(events), new EditRepository(db), activityRules, categorization, aiSource);

  const reflectionRepo = new ReflectionRepository(db);
  const coachRepo = new CoachRepository(db);
  const taxonomy = (): TaxonomyNames => {
    const names = (d: 'area' | 'intent' | 'quality') =>
      Object.fromEntries(categorizationRepo.listDimensionsByType(d).map((x) => [x.id, x.name]));
    return {
      contexts: Object.fromEntries(activityRules.listActivities().map((a) => [a.id, a.name])),
      areas: names('area'),
      intents: names('intent'),
      qualities: names('quality'),
    };
  };
  const metrics = new ReflectionMetricsService(
    {
      getActivities: (from, to) => toReflectionActivities(timeline.getByRange(from, to), { start: from, end: to }),
      focus,
      taxonomy,
      firstEventAt: () => events.getFirstEventStart(),
    },
    reflectionRepo,
    { config: DEFAULT_REFLECTION_CONFIG, now: () => clock.now, yieldToEventLoop: async () => {} },
  );
  const userContext = new UserProfileContextProvider(profiles);
  let service: ReflectionService | null = null;
  const coach = new CoachService({
    repo: coachRepo,
    gemini,
    reflections: reflectionRepo,
    metrics,
    focus,
    userContext,
    priorities: () => service?.syncPriorities() ?? reflectionRepo.listPriorities(),
    now: () => clock.now,
  });
  service = new ReflectionService({
    repo: reflectionRepo,
    gemini,
    metrics,
    annotator: new ReflectionAnnotator({ gemini, repo: reflectionRepo, now: () => clock.now }),
    userContext,
    profiles,
    taxonomy,
    coach,
    dailyReflectionMinutes: () => coach.getSettings().reflectionMinutes,
    now: () => clock.now,
    sleep: async () => {},
  });

  /** Raw events + the AI activities the intelligence layer would have persisted. */
  function seedDay(d: number, blocks: Block[] = WORKDAY): void {
    const runId = `run-${d}`;
    intelligenceRepo.createRun({ id: runId, windowStart: iso(d), windowEnd: iso(d + 1), model: 'test-model', promptVersion: 'test', schemaVersion: 1, nowIso: iso(d + 1) });
    const create = blocks.map((b, index) => {
      const start = local(d, b.hhmm);
      const startedAt = start.toISOString();
      const endedAt = new Date(start.getTime() + b.minutes * 60_000).toISOString();
      const eventId = events.insert({ watcher: 'window', startedAt, endedAt, app: b.app, title: `${b.title} — window`, url: b.url ?? null });
      return {
        id: `ai-${d}-${index}`, startedAt, endedAt, eventIds: [eventId], title: b.title, summary: null,
        contextId: b.contextId, areaId: b.areaId, intentId: b.intentId, qualityId: b.qualityId, confidence: 0.9, uncertainty: [],
      };
    });
    intelligenceRepo.commitRun({
      runId, windowStart: iso(d), windowEnd: iso(d + 1), model: 'test-model', attemptCount: 1, outputJson: '{}',
      plan: { create, extend: [], detach: [], userProtectedEventIds: [] }, nowIso: iso(d + 1),
    });
    metrics.invalidate();
  }

  return { db, profiles, focus, service: service!, coach, coachRepo, reflectionRepo, metrics, seedDay };
}

function focusRow(d: number, hhmm: string, minutes: number, overrides: Partial<FocusSession> = {}): FocusSession {
  const start = local(d, hhmm);
  const startedAt = start.toISOString();
  const endedAt = new Date(start.getTime() + minutes * 60_000).toISOString();
  return {
    id: `focus-${d}`,
    profileId: 'default-deep-work',
    task: 'Project X',
    notes: null,
    mode: 'countdown',
    plannedDurationMinutes: 45,
    state: 'completed',
    startedAt,
    endedAt,
    pausedAt: null,
    totalPauseMs: 0,
    elapsedMs: minutes * 60_000,
    blockingLeaseId: null,
    endReason: 'completed',
    endNote: null,
    blockingConfig: null,
    createdAt: startedAt,
    updatedAt: endedAt,
    ...overrides,
  };
}

suite('Coach pipeline (SQLite, end to end)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('observes a day, recommends, tracks the commitment through Focus, learns the outcome — across a restart', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-coach-e2e-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    const clock = { now: local(1, '08:00') };
    let app = wire(dbPath, gemini, clock);

    app.profiles.saveProfile(
      { roles: ['Software Developer'], description: 'I am building Project X.', currentWork: ['Project X'], priorities: ['Launching Project X'], interests: [], additionalContext: null },
      'completed',
    );
    for (const d of [5, 6, 7, 8, 9, 12]) app.seedDay(d);

    // ── Mon Oct 12, 10:05 PM: the day's intelligence. One request (after the
    //    one-off thread linking), one transaction.
    clock.now = local(12, '22:05');
    const priorityId = app.service.syncPriorities()[0].id;
    const linking = {
      items: [
        { ref: 'i1', thread: 'Project X', priorityId },
        { ref: 'i2', thread: 'Project Y', priorityId: null },
        { ref: 'i3', thread: 'Research', priorityId: null },
        { ref: 'i4', thread: null, priorityId: null },
      ],
    };
    gemini.push(linking, modelDay(day(12), { actions: [modelAction({ priorityId })] }));
    expect(await app.service.generate(day(12), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(gemini.requests).toHaveLength(2);

    const report12 = app.reflectionRepo.getCurrentReport('day', day(12).key)!;
    const [action] = app.coachRepo.listActionsByReport(report12.id);
    expect(report12.coach!.actionIds).toEqual([action.id]);
    expect(action).toMatchObject({
      status: 'suggested',
      priorityId,
      targetKey: `p:${priorityId}`,
      targetStart: iso(13, '05:00'),
      focusMinutes: 45,
    });
    // The evidence resolves to real, stored activity.
    expect(action.evidence.map((e) => e.kind)).toEqual(['metric', 'priority']);
    expect(action.evidence[0]).toMatchObject({ metricKey: 'thread.project-x.minutes', value: '2h 52m' });

    // ── The user accepts.
    clock.now = local(12, '22:10');
    expect(app.coach.decide(action.id, 'accept')).toMatchObject({ ok: true, action: { statusLine: 'Accepted · Tomorrow · morning' } });

    // ── Tue: a real Focus session on it, 45 minutes, one interruption.
    app.seedDay(13, [X('09:00', 45), Y('10:00', 50), RESEARCH('13:00', 40)]);
    app.focus.insertSession(focusRow(13, '09:00', 45));
    app.focus.insertInterruption({ id: 'int-1', sessionId: 'focus-13', type: 'pause', reason: null, occurredAt: iso(13, '09:20'), idleMs: null, createdAt: iso(13, '09:20') });

    clock.now = local(13, '09:50');
    expect(await app.coach.observe()).toBe(1);
    expect(app.coachRepo.getAction(action.id)).toMatchObject({ status: 'review', execution: 'done', executionSource: 'observed', outcome: null });
    expect(app.coach.getState().commitments[0]).toMatchObject({
      pending: 'outcome',
      statusLine: 'Carried out (observed) — did it help?',
      observation: { kind: 'executed', facts: expect.arrayContaining(['Focus session “Project X” ran 45m of 45m planned, 1 interruption.']) },
    });

    // ── Restart. Everything the Coach knows is in SQLite.
    app.db.close();
    app = wire(dbPath, gemini, clock);
    expect(app.coach.getState().commitments[0]).toMatchObject({ id: action.id, pending: 'outcome' });

    clock.now = local(13, '18:00');
    expect(app.coach.reportOutcome(action.id, 'worked', { note: 'Merged the sync engine' })).toMatchObject({ ok: true });
    expect(app.coachRepo.listActionEvents(action.id).map((e) => e.type)).toEqual(['suggested', 'accept', 'observe', 'outcome']);

    // ── Tue 10:05 PM: the next daily pass is given the record, and follows up.
    clock.now = local(13, '22:05');
    gemini.push(
      modelDay(day(13), {
        followups: [{ actionRef: 'k1', note: 'The Focus session ran 45m of the 45m planned, with 1 interruption, and you said it worked.', learned: 'A morning block on Project X is realistic for you.' }],
        actions: [],
        noActionReason: 'The morning block is working; nothing needs changing.',
        memoryUpdates: [{ op: 'add', kind: 'conclusion', text: 'A morning Focus block on Project X was carried out and helped.', memoryRef: null, metricKeys: [], activityRefs: [], actionRefs: ['k1'] }],
      }),
    );
    expect(await app.service.generate(day(13), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });

    const dailyPrompt = gemini.requests[gemini.requests.length - 1].prompt;
    expect(dailyPrompt).toContain('"execution":"carried out (observed by Reflect)"');
    expect(dailyPrompt).toContain('"outcome":"the user said it worked"');
    expect(dailyPrompt).toContain('"userNote":"Merged the sync engine"');
    // Tuesday's own Focus session is deterministic evidence too.
    expect(dailyPrompt).toContain('"value":"45m of 45m planned · 1 interruption · ran its full planned time"');

    const report13 = app.reflectionRepo.getCurrentReport('day', day(13).key)!;
    expect(report13.coach).toMatchObject({
      actionIds: [],
      followups: [{ actionId: action.id, title: action.title, learned: 'A morning block on Project X is realistic for you.' }],
      noActionReason: 'The morning block is working; nothing needs changing.',
    });
    expect(app.coachRepo.listMemories()).toMatchObject([
      { kind: 'conclusion', source: 'coach', sourceRef: report13.id, targetKey: `p:${priorityId}`, text: 'A morning Focus block on Project X was carried out and helped.' },
    ]);

    // ── The conversation reads the same record, and writes to the same memory.
    clock.now = local(14, '08:00');
    gemini.push(
      modelChat({
        reply: 'Last time, the morning block on Project X ran 45m as planned and you said it worked.',
        memoryUpdates: [{ op: 'add', kind: 'preference', text: 'Prefers to start the day with Project X before anything else.', memoryRef: null }],
      }),
    );
    const chat = await app.coach.chat('What did I decide for Project X? I prefer to start the day with Project X before anything else.');
    expect(chat.ok).toBe(true);
    const chatPrompt = gemini.requests[gemini.requests.length - 1].prompt;
    expect(chatPrompt).toContain('"decision":"accepted"');
    // Tuesday's reflection is part of the context.
    expect(chatPrompt).toContain('Tue, Oct 13: Project X took your morning; the afternoon moved between threads.');
    expect(chatPrompt).toContain('"text":"A morning Focus block on Project X was carried out and helped."');

    const state = app.coach.getState();
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'coach']);
    expect(state.memory.map((m) => [m.kind, m.source])).toEqual([
      ['preference', 'user'],
      ['conclusion', 'coach'],
    ]);
    expect(state.recent[0]).toMatchObject({ id: action.id, statusLine: 'Carried out · it worked' });

    app.db.close();
  });

  it('a failed coach write rolls back the whole daily commit', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-coach-e2e-'));
    const gemini = new ScriptedGemini();
    const clock = { now: local(1, '08:00') };
    const app = wire(path.join(dir, 'test.db'), gemini, clock);
    app.profiles.saveProfile({ roles: [], description: null, currentWork: ['Project X'], priorities: ['Launching Project X'], interests: [], additionalContext: null }, 'completed');
    for (const d of [5, 6, 7, 8, 9, 12]) app.seedDay(d);

    clock.now = local(12, '22:05');
    const priorityId = app.service.syncPriorities()[0].id;
    const linking = { items: [{ ref: 'i1', thread: 'Project X', priorityId }, { ref: 'i2', thread: 'Project Y', priorityId: null }, { ref: 'i3', thread: 'Research', priorityId: null }, { ref: 'i4', thread: null, priorityId: null }] };

    // The memory insert fails after the action was inserted.
    const insertMemory = app.coachRepo.insertMemory.bind(app.coachRepo);
    app.coachRepo.insertMemory = () => {
      throw new Error('disk full');
    };
    gemini.push(
      linking,
      modelDay(day(12), {
        memoryUpdates: [{ op: 'add', kind: 'open_loop', text: 'The Project Y billing fix was started and left unfinished.', memoryRef: null, metricKeys: ['thread.project-y.minutes'], activityRefs: [], actionRefs: [] }],
      }),
    );
    expect(await app.service.generate(day(12), { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category: 'persistence' });

    expect(app.reflectionRepo.getCurrentReport('day', day(12).key)).toBeNull();
    expect(app.coachRepo.listActions(iso(1))).toEqual([]);
    expect(app.coachRepo.listMessages(50)).toEqual([]);
    const view = await app.service.getView('day', iso(12, '12:00'));
    expect(view.generation).toMatchObject({ state: 'failed', errorCategory: 'persistence' });

    // Recoverable: the next attempt succeeds and stores everything.
    app.coachRepo.insertMemory = insertMemory;
    clock.now = local(12, '22:10');
    gemini.push(modelDay(day(12)));
    expect(await app.service.generate(day(12), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded' });
    expect(app.coachRepo.listActions(iso(1))).toHaveLength(1);
    app.db.close();
  });
});
