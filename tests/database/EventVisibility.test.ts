import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { EditRepository } from '../../src/database/EditRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository, type AnalysisWindow } from '../../src/database/IntelligenceRepository';
import { ReflectionRepository } from '../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceService } from '../../src/intelligence/IntelligenceService';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { activitySignature, createBlockDescriber, createEventLocator, toReflectionActivities } from '../../src/reflection/ReflectionActivities';
import { ReflectionAnnotator } from '../../src/reflection/ReflectionAnnotator';
import { EVENTS_REMOVED_HEADLINE, type RemovedEvents } from '../../src/reflection/ReflectionChanges';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import {
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionEvidence,
  type ReflectionInsight,
  type ReflectionPeriod,
  type TaxonomyNames,
} from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionService } from '../../src/reflection/ReflectionService';
import { EventVisibilityService } from '../../src/service/EventVisibilityService';
import { ExportService } from '../../src/service/ExportService';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ScriptedGemini, modelActivity, modelOutput } from '../intelligence/helpers';

/**
 * Hiding and permanently deleting a tracked event, end to end over real
 * SQLite, wired like `main.ts`:
 *
 *   raw events → sessions → AI activity → timeline → reflection → coach
 *
 * The point of every test here is the same: an event the user removed must
 * be gone from each of those layers, and nothing else may be disturbed.
 * Self-skips if the native binary ABI does not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-visibility-probe-')), 'probe.db');
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

// The export writes wherever the save dialog says.
const exportTarget = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: exportTarget.path }) },
}));

const local = (day: number, hhmm = '00:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, day, h, m);
};
const iso = (day: number, hhmm = '00:00') => local(day, hhmm).toISOString();

const SECRET_TITLE = 'Secret page';
const SECRET_URL = 'private.example/secret';
const AI_TITLE = 'Coding with a detour';

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
  const sessions = new SessionService(events);
  const timeline = new TimelineService(sessions, new EditRepository(db), activityRules, categorization, aiSource);
  const intelligence = new IntelligenceService({
    events,
    repo: intelligenceRepo,
    gemini,
    activityRules,
    categorization: categorizationRepo,
    focus,
    userContext: new UserProfileContextProvider(profiles),
    getUserEditedEventIds: (from, to) => timeline.getUserEditedEventIds(from, to),
    now: () => clock.now,
    sleep: async () => {},
  });

  const reflectionRepo = new ReflectionRepository(db);
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
      locateEvents: createEventLocator(events, timeline),
    },
    reflectionRepo,
    { config: DEFAULT_REFLECTION_CONFIG, now: () => clock.now, yieldToEventLoop: async () => {} },
  );
  const reflection = new ReflectionService({
    repo: reflectionRepo,
    gemini,
    metrics,
    annotator: new ReflectionAnnotator({ gemini, repo: reflectionRepo, now: () => clock.now }),
    userContext: new UserProfileContextProvider(profiles),
    profiles,
    taxonomy,
    now: () => clock.now,
    sleep: async () => {},
  });

  // The background rebuild is held back so a test decides when it runs.
  const coachCalls: RemovedEvents[] = [];
  const rebuilt: AnalysisWindow[] = [];
  const logs: string[] = [];
  let scheduled: (() => void) | null = null;
  let rebuilding: Promise<void> = Promise.resolve();
  const visibility = new EventVisibilityService({
    transaction: (fn) => db.transaction(fn),
    events,
    intelligence: intelligenceRepo,
    reflections: reflectionRepo,
    coach: {
      onEventsRemoved: (removed) => {
        coachCalls.push(removed);
        return 0;
      },
    },
    blocksHolding: createBlockDescriber(events, timeline),
    onRangeChanged: (range) => reflection.notifyDataChanged({ kind: 'timeline', range }),
    rebuild: (windows) => {
      rebuilding = (async () => {
        for (const w of windows) {
          rebuilt.push(w);
          await intelligence.analyzeWindow(w.start, w.end);
        }
      })();
      return rebuilding;
    },
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => clock.now,
    schedule: (run) => {
      scheduled = run;
      return 1;
    },
    cancel: () => {},
  });
  const runRebuild = async () => {
    const run = scheduled;
    scheduled = null;
    run?.();
    await new Promise((resolve) => setImmediate(resolve));
    await rebuilding;
  };

  return {
    db, events, sessions, timeline, intelligence, intelligenceRepo, categorization, categorizationRepo, reflectionRepo, reflection, metrics,
    visibility, coachCalls, rebuilt, logs, runRebuild,
    exports: new ExportService(timeline, events, sessions),
  };
}

type App = ReturnType<typeof wire>;

/**
 * Monday Oct 5:  A (code) → B (the private page) → C (code), analysed as ONE
 * AI activity, and D (chat) later in the day as another.
 */
async function seedMorning(app: App, gemini: ScriptedGemini) {
  const A = app.events.insert({ watcher: 'window', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:20'), app: 'Code.exe', title: 'App.tsx - reflect - Visual Studio Code' });
  const B = app.events.insert({ watcher: 'window', startedAt: iso(5, '09:20'), endedAt: iso(5, '09:30'), app: 'Google Chrome', browser: 'Chrome', url: SECRET_URL, title: SECRET_TITLE });
  const C = app.events.insert({ watcher: 'window', startedAt: iso(5, '09:30'), endedAt: iso(5, '09:58'), app: 'Code.exe', title: 'Service.ts - reflect - Visual Studio Code' });
  const D = app.events.insert({ watcher: 'window', startedAt: iso(5, '11:00'), endedAt: iso(5, '11:30'), app: 'Slack', title: 'team-channel' });

  gemini.push(
    modelOutput(
      [modelActivity({ eventIds: [A, B, C], title: AI_TITLE, summary: `Coding, with a visit to the ${SECRET_TITLE}.`, startedAt: iso(5, '09:00'), endedAt: iso(5, '09:58') })],
      [],
      [iso(5, '09:00'), iso(5, '10:00')],
    ),
    modelOutput(
      [modelActivity({ eventIds: [D], title: 'Team chat', summary: 'Caught up with the team.', startedAt: iso(5, '11:00'), endedAt: iso(5, '11:30') })],
      [],
      [iso(5, '11:00'), iso(5, '12:00')],
    ),
  );
  expect((await app.intelligence.analyzeWindow(iso(5, '09:00'), iso(5, '10:00'))).status).toBe('succeeded');
  expect((await app.intelligence.analyzeWindow(iso(5, '11:00'), iso(5, '12:00'))).status).toBe('succeeded');

  const blocks = app.timeline.getByRange(iso(5), iso(6));
  const coding = blocks.find((b) => b.ai?.title === AI_TITLE)!;
  const chat = blocks.find((b) => b.ai?.title === 'Team chat')!;
  expect(coding.events.map((e) => e.id)).toEqual([A, B, C]);
  return { A, B, C, D, codingId: coding.id, chatId: chat.id };
}

function insight(id: string, title: string, evidence: ReflectionEvidence[], sourceActivityIds: string[] = []): ReflectionInsight {
  return {
    id,
    type: 'progress',
    title,
    observation: title,
    interpretation: 'It mattered.',
    relevance: null,
    confidence: 0.8,
    evidence,
    sourceActivityIds,
    sourceMetricKeys: [],
    claimSignature: `sig-${id}`,
    identityKey: `identity-${id}`,
    subjectKey: null,
    thread: null,
    priorityId: null,
    continuity: 'new',
    magnitude: null,
    createdAt: iso(6, '00:05'),
  };
}

/** The reports Reflection would have written from that day: the day itself and its week. */
function seedReports(app: App, ids: Awaited<ReturnType<typeof seedMorning>>): { day: ReflectionPeriod; week: ReflectionPeriod } {
  const day = periodContaining('day', local(5, '12:00'));
  const week = periodContaining('week', local(5, '12:00'));
  const nowIso = iso(6, '00:05');
  const base = { trigger: 'scheduled' as const, inputSchemaVersion: 1, outputSchemaVersion: 1, promptVersion: 'test', model: 'test-model', nowIso };
  const codingEvidence: ReflectionEvidence = {
    kind: 'activity',
    activityId: ids.codingId,
    eventIds: [ids.A, ids.B, ids.C],
    label: AI_TITLE,
    value: '58m',
    period: { start: iso(5, '09:00'), end: iso(5, '09:58') },
  };
  const chatEvidence: ReflectionEvidence = {
    kind: 'activity',
    activityId: ids.chatId,
    eventIds: [ids.D],
    label: 'Team chat',
    value: '30m',
    period: { start: iso(5, '11:00'), end: iso(5, '11:30') },
  };
  const trackedEvidence: ReflectionEvidence = { kind: 'metric', metricKey: 'time.tracked_minutes', label: 'Tracked time', value: '1h 28m' };

  app.reflectionRepo.createGenerating({ ...base, id: 'report-day', period: day, coveredUntil: day.end });
  app.reflectionRepo.commitReport({
    reportId: 'report-day',
    period: day,
    coveredUntil: day.end,
    model: 'test-model',
    attemptCount: 1,
    headline: `A coding morning with a detour to the ${SECRET_TITLE}.`,
    narrative: `You coded, then read the ${SECRET_TITLE}, then chatted.`,
    carryForward: { text: `Skip the ${SECRET_TITLE} tomorrow.`, sourceMetricKeys: [], sourceActivityIds: [ids.codingId], evidence: [codingEvidence] },
    coach: null,
    insights: [
      insight('insight-detour', `The ${SECRET_TITLE} interrupted your coding`, [codingEvidence], [ids.codingId]),
      insight('insight-chat', 'A half hour went to team chat', [chatEvidence], [ids.chatId]),
    ],
    dataSnapshot: {
      period: day,
      coveredUntil: day.end,
      isPartial: false,
      priorities: [],
      activePriorityIds: [],
      activities: [
        { id: ids.codingId, startedAt: iso(5, '09:00'), endedAt: iso(5, '09:58'), minutes: 58, title: AI_TITLE, thread: null, priorityId: null, eventIds: [ids.A, ids.B, ids.C] },
        { id: ids.chatId, startedAt: iso(5, '11:00'), endedAt: iso(5, '11:30'), minutes: 30, title: 'Team chat', thread: null, priorityId: null, eventIds: [ids.D] },
      ],
      notes: [],
      userContextIncluded: false,
      previousReportId: null,
    },
    metricsSnapshot: {},
    nowIso,
  });

  // The week's report only ever quoted a number: it never saw the event's activity.
  app.reflectionRepo.createGenerating({ ...base, id: 'report-week', period: week, coveredUntil: iso(6, '00:05') });
  app.reflectionRepo.commitReport({
    reportId: 'report-week',
    period: week,
    coveredUntil: iso(6, '00:05'),
    model: 'test-model',
    attemptCount: 1,
    headline: 'A quiet start to the week.',
    narrative: null,
    carryForward: null,
    coach: null,
    insights: [insight('insight-week', 'About an hour and a half tracked so far', [trackedEvidence])],
    dataSnapshot: {
      period: week,
      coveredUntil: iso(6, '00:05'),
      isPartial: true,
      priorities: [],
      activePriorityIds: [],
      activities: [],
      notes: [],
      userContextIncluded: false,
      previousReportId: null,
    },
    metricsSnapshot: {},
    nowIso,
  });
  return { day, week };
}

const idsOf = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

suite('Event visibility (SQLite, end to end)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fresh = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-visibility-'));
    return path.join(dir, 'test.db');
  };

  it('migration: every existing event stays visible, with the id it had', () => {
    const dbPath = fresh();
    const raw = new BetterSqliteDB(dbPath);
    raw.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, watcher TEXT NOT NULL, started_at DATETIME NOT NULL, ended_at DATETIME NOT NULL,
        app TEXT, browser TEXT, title TEXT, url TEXT, payload TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO events (id, watcher, started_at, ended_at, app, title) VALUES
        (7,  'window', '2026-10-05T09:00:00.000Z', '2026-10-05T09:20:00.000Z', 'Code.exe', 'App.tsx'),
        (12, 'window', '2026-10-05T09:20:00.000Z', '2026-10-05T09:30:00.000Z', 'Chrome', 'Docs');
    `);
    raw.pragma('user_version = 17');
    raw.close();

    const db = new Database(dbPath);
    const events = new EventRepository(db);
    expect(idsOf(events.getAll())).toEqual([7, 12]);
    expect(events.findIncludingHidden([7, 12]).map((e) => e.hiddenAt)).toEqual([null, null]);
    expect(events.listHidden()).toEqual([]);
    db.close();

    const check = new BetterSqliteDB(dbPath);
    expect(check.pragma('user_version', { simple: true })).toBe(18);
    expect(check.prepare('SELECT id, title, hidden_at FROM events ORDER BY id').all()).toEqual([
      { id: 7, title: 'App.tsx', hidden_at: null },
      { id: 12, title: 'Docs', hidden_at: null },
    ]);
    check.close();
    new Database(dbPath).close(); // idempotent
  });

  it('hiding an event removes it from every layer, leaves its neighbours alone, and survives a restart', async () => {
    const dbPath = fresh();
    const gemini = new ScriptedGemini();
    const clock = { now: local(6, '08:00') };
    let app = wire(dbPath, gemini, clock);
    const ids = await seedMorning(app, gemini);
    const { A, B, C, D } = ids;
    const { day, week } = seedReports(app, ids);
    const signature = activitySignature({ title: AI_TITLE, contextId: 'coding' });
    app.reflectionRepo.upsertAnnotations(
      [
        { signature, thread: 'Secret reading', priorityId: null, checkedPriorityIds: [], source: 'model' },
        { signature: activitySignature({ title: 'Team chat', contextId: 'coding' }), thread: 'Team', priorityId: null, checkedPriorityIds: [], source: 'model' },
      ],
      iso(6, '00:05'),
    );
    const neighboursBefore = app.events.getByIds([A, C, D]);
    expect(app.events.sumTrackedMs(iso(5), iso(6))).toBe(88 * 60_000);

    // ── hide B ──
    const result = app.visibility.hide([B]);
    expect(result).toEqual({ ok: true, eventIds: [B], updating: true });

    // Raw event queries: gone from every user-facing read, still stored.
    expect(idsOf(app.events.getAll())).toEqual([A, C, D]);
    expect(idsOf(app.events.getByRange(iso(5), iso(6)))).toEqual([A, C, D]);
    expect(idsOf(app.events.getOverlapping(iso(5, '09:00'), iso(5, '10:00')))).toEqual([A, C]);
    expect(app.events.getByIds([B])).toEqual([]);
    expect(app.events.sumTrackedMs(iso(5), iso(6))).toBe(78 * 60_000);
    expect(app.events.getLatest()?.id).toBe(D);
    expect(app.events.findIncludingHidden([B])[0]).toMatchObject({ id: B, title: SECRET_TITLE, hiddenAt: clock.now.toISOString() });
    expect(idsOf(app.events.listHidden())).toEqual([B]);

    // The neighbours are byte-for-byte what the tracker stored.
    expect(app.events.getByIds([A, C, D])).toEqual(neighboursBefore);

    // Sessions are rebuilt from A + C; B is in none of them.
    const sessions = app.sessions.getByRange(iso(5), iso(6));
    expect(idsOf(sessions.flatMap((s) => s.events))).toEqual([A, C, D]);
    expect(sessions.find((s) => s.events.some((e) => e.id === A))!.events.map((e) => e.id)).toEqual([A, C]);

    // Timeline: the activity that was written with B as evidence is no longer
    // shown. A + C are a plain session; the unrelated AI activity is untouched.
    let blocks = app.timeline.getByRange(iso(5), iso(6));
    expect(idsOf(blocks.flatMap((b) => b.events))).toEqual([A, C, D]);
    expect(blocks.some((b) => b.ai?.title === AI_TITLE)).toBe(false);
    expect(blocks.find((b) => b.events.some((e) => e.id === A))!.ai).toBeUndefined();
    expect(blocks.find((b) => b.events.some((e) => e.id === D))).toMatchObject({ id: ids.chatId, ai: { title: 'Team chat' } });
    expect(JSON.stringify(blocks)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(blocks)).not.toContain(SECRET_URL);

    // AI layer: no ghost reference, and only the affected window is redone.
    expect(app.intelligenceRepo.getActiveMemberships([A, B, C])).toEqual([]);
    expect(app.intelligenceRepo.getActivitiesByIds([ids.codingId])[0].supersededAt).not.toBeNull();
    expect(app.intelligenceRepo.getActivityEventIds(ids.codingId)).toEqual([A, C]);
    expect(app.intelligenceRepo.hasSucceededRun(iso(5, '09:00'), iso(5, '10:00'))).toBe(false);
    expect(app.intelligenceRepo.hasSucceededRun(iso(5, '11:00'), iso(5, '12:00'))).toBe(true);

    // Classification never sees it.
    expect(app.categorization.getResolvedEventClassifications([A, B, C]).map((c) => c.eventId).sort()).toEqual([A, C]);

    // Reflection: the day's report was written from B's activity → stale, and
    // nothing in it still cites or retells it. The other insight is kept.
    const dayReport = app.reflectionRepo.getCurrentReport('day', day.key)!;
    expect(dayReport).toMatchObject({ status: 'stale', staleReason: 'events_removed', headline: EVENTS_REMOVED_HEADLINE, narrative: null, carryForward: null });
    expect(dayReport.insights.map((i) => i.id)).toEqual(['insight-chat']);
    expect(dayReport.dataSnapshot!.activities.map((a) => a.id)).toEqual([ids.chatId]);
    expect(JSON.stringify(dayReport)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(dayReport)).not.toContain(AI_TITLE);
    // The week's report never saw that activity: it is re-checked, not rewritten.
    const weekReport = app.reflectionRepo.getCurrentReport('week', week.key)!;
    expect(weekReport).toMatchObject({ status: 'fresh', headline: 'A quiet start to the week.', needsVerification: true });
    expect(weekReport.insights).toHaveLength(1);

    // A stored evidence reference no longer resolves to the hidden event.
    expect(createEventLocator(app.events, app.timeline)([B])).toEqual([]);
    const resolved = await app.reflection.resolveEvidence({ eventIds: [A, B, C], activityId: ids.codingId, period: { start: iso(5, '09:00'), end: iso(5, '09:58') } });
    const resolvedBlock = app.timeline.getByRange(iso(5), iso(6)).find((b) => b.id === resolved?.activityId)!;
    expect(resolvedBlock.events.map((e) => e.id)).toEqual([A, C]);

    // What Reflection and the Coach are given is what the Timeline shows.
    const activities = await app.metrics.loadRawActivities(iso(5), iso(6));
    expect(activities.reduce((sum, a) => sum + a.durationMinutes, 0)).toBeCloseTo(78);
    expect(JSON.stringify(activities)).not.toContain(SECRET_URL);
    expect(JSON.stringify(activities)).not.toContain(AI_TITLE);
    expect(app.coachCalls).toHaveLength(1);
    expect(app.coachCalls[0]).toMatchObject({ eventIds: [B], ranges: [{ start: iso(5, '09:20'), end: iso(5, '09:30') }] });
    expect(app.coachCalls[0].activityIds).toContain(ids.codingId);
    expect(app.coachCalls[0].activityIds).not.toContain(ids.chatId);

    // The link cached for that activity is not offered to the model again.
    expect(app.reflectionRepo.getAnnotations([signature])).toEqual([]);
    expect(app.reflectionRepo.listThreadLabels(10)).toEqual(['Team']);

    // Nothing sensitive in the log.
    expect(app.logs.join('\n')).not.toContain(SECRET_TITLE);
    expect(app.logs.join('\n')).not.toContain(SECRET_URL);

    // ── the background rebuild: only the affected window, without B ──
    gemini.push(modelOutput([modelActivity({ eventIds: [A, C], title: 'Coding', summary: 'Worked on the app.', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:58') })], [], [iso(5, '09:00'), iso(5, '10:00')]));
    const requestsBefore = gemini.requests.length;
    await app.runRebuild();
    expect(app.rebuilt).toEqual([{ start: iso(5, '09:00'), end: iso(5, '10:00') }]);
    expect(gemini.requests).toHaveLength(requestsBefore + 1);
    expect(gemini.requests[requestsBefore].prompt).not.toContain(SECRET_TITLE);
    expect(gemini.requests[requestsBefore].prompt).not.toContain(SECRET_URL);
    blocks = app.timeline.getByRange(iso(5), iso(6));
    expect(blocks.map((b) => [b.ai?.title, b.events.map((e) => e.id)])).toEqual([
      ['Coding', [A, C]],
      ['Team chat', [D]],
    ]);

    // ── restart ──
    app.db.close();
    app = wire(dbPath, gemini, clock);
    expect(idsOf(app.events.getAll())).toEqual([A, C, D]);
    expect(idsOf(app.events.listHidden())).toEqual([B]);
    expect(idsOf(app.timeline.getByRange(iso(5), iso(6)).flatMap((b) => b.events))).toEqual([A, C, D]);
    expect(app.reflectionRepo.getCurrentReport('day', day.key)!.status).toBe('stale');

    // ── restore ──
    expect(app.visibility.unhide([B])).toEqual({ ok: true, eventIds: [B], updating: true });
    expect(idsOf(app.events.getAll())).toEqual([A, B, C, D]);
    expect(app.events.listHidden()).toEqual([]);
    expect(app.events.getByIds([B])[0]).toMatchObject({ id: B, title: SECRET_TITLE, url: SECRET_URL });
    // The analysis made without it no longer stands; it is redone with B back.
    expect(app.intelligenceRepo.hasSucceededRun(iso(5, '09:00'), iso(5, '10:00'))).toBe(false);
    gemini.push(modelOutput([modelActivity({ eventIds: [A, B, C], title: 'Coding and reading', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:58') })], [], [iso(5, '09:00'), iso(5, '10:00')]));
    await app.runRebuild();
    expect(app.timeline.getByRange(iso(5), iso(6)).find((b) => b.events.some((e) => e.id === B))!.events.map((e) => e.id)).toEqual([A, B, C]);

    // Hiding something already hidden, or unknown, changes nothing.
    expect(app.visibility.unhide([B])).toEqual({ ok: true, eventIds: [], updating: false });
    expect(app.visibility.hide([987654])).toEqual({ ok: true, eventIds: [], updating: false });
    app.db.close();
  });

  it('hiding several events at once keeps what lies between and around them', async () => {
    const dbPath = fresh();
    const gemini = new ScriptedGemini();
    const clock = { now: local(6, '08:00') };
    const app = wire(dbPath, gemini, clock);
    const { A, B, C, D, codingId, chatId } = await seedMorning(app, gemini);
    const kept = app.events.getByIds([A, C]);

    expect(app.visibility.hide([B, D, B])).toMatchObject({ ok: true, eventIds: [B, D] });

    expect(idsOf(app.events.getAll())).toEqual([A, C]);
    expect(idsOf(app.events.listHidden())).toEqual([B, D]);
    expect(app.events.getByIds([A, C])).toEqual(kept);
    const blocks = app.timeline.getByRange(iso(5), iso(6));
    expect(blocks.map((b) => b.events.map((e) => e.id))).toEqual([[A, C]]);
    expect(blocks[0].ai).toBeUndefined();
    // Both activities held a hidden event, so both analyses are redone.
    expect(app.intelligenceRepo.getActivitiesByIds([codingId, chatId]).every((a) => a.supersededAt !== null)).toBe(true);
    expect(app.coachCalls[0].activityIds.sort()).toEqual([codingId, chatId].sort());
    app.db.close();
  });

  it('permanent deletion removes the row and what was written from it, and it cannot come back', async () => {
    const dbPath = fresh();
    const gemini = new ScriptedGemini();
    const clock = { now: local(6, '08:00') };
    let app = wire(dbPath, gemini, clock);
    const ids = await seedMorning(app, gemini);
    const { A, B, C, D } = ids;
    const { day } = seedReports(app, ids);
    app.categorization.saveEventClassification({ eventId: B, contextId: 'browsing', areaId: 'area_leisure', intentId: 'intent_consume', qualityId: 'quality_distracting', source: 'user_override', ruleId: null });
    app.categorization.saveEventClassification({ eventId: D, contextId: 'meetings', areaId: 'area_work', intentId: 'intent_communicate', qualityId: 'quality_routine', source: 'user_override', ruleId: null });
    const untouched = app.events.getByIds([A, C, D]);

    expect(app.visibility.deletePermanently([B])).toEqual({ ok: true, eventIds: [B], updating: true });

    // The raw event is gone — not hidden.
    expect(app.events.findIncludingHidden([B])).toEqual([]);
    expect(app.events.listHidden()).toEqual([]);
    expect(idsOf(app.events.getAll())).toEqual([A, C, D]);
    expect(app.events.getByIds([A, C, D])).toEqual(untouched);

    // Everything derived from it went with it; nothing unrelated did.
    const raw = new BetterSqliteDB(dbPath, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(B)).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM event_classifications WHERE event_id = ?').get(B)).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM event_classifications WHERE event_id = ?').get(D)).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM intelligence_activity_events WHERE event_id = ?').get(B)).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM intelligence_activities WHERE id = ?').get(ids.codingId)).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM intelligence_activities WHERE id = ? AND superseded_at IS NULL').get(ids.chatId)).toEqual({ n: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM intelligence_runs WHERE output_json LIKE '%' || ? || '%'`).get(SECRET_TITLE)).toEqual({ n: 0 });
    const everything = JSON.stringify(
      ['intelligence_activities', 'intelligence_runs', 'reflection_reports', 'reflection_insights', 'reflection_activity_annotations', 'event_classifications', 'events'].map((table) =>
        raw.prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
    expect(everything).not.toContain(SECRET_TITLE);
    expect(everything).not.toContain(SECRET_URL);
    expect(everything).not.toContain(AI_TITLE);
    raw.close();

    const dayReport = app.reflectionRepo.getCurrentReport('day', day.key)!;
    expect(dayReport).toMatchObject({ status: 'stale', staleReason: 'events_removed' });
    expect(dayReport.insights.map((i) => i.id)).toEqual(['insight-chat']);
    expect(app.timeline.getByRange(iso(5), iso(6)).some((b) => b.ai?.title === AI_TITLE)).toBe(false);

    // ── restart, then reprocessing: it does not come back ──
    app.db.close();
    app = wire(dbPath, gemini, clock);
    expect(app.events.findIncludingHidden([B])).toEqual([]);
    gemini.push(modelOutput([modelActivity({ eventIds: [A, C], title: 'Coding', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:58') })], [], [iso(5, '09:00'), iso(5, '10:00')]));
    const requestsBefore = gemini.requests.length;
    expect((await app.intelligence.analyzeWindow(iso(5, '09:00'), iso(5, '10:00'))).status).toBe('succeeded');
    expect(gemini.requests[requestsBefore].prompt).not.toContain(SECRET_TITLE);
    expect(idsOf(app.timeline.getByRange(iso(5), iso(6)).flatMap((b) => b.events))).toEqual([A, C, D]);

    // A deleted id is never handed to another event — not even the newest one's.
    const last = app.events.insert({ watcher: 'window', startedAt: iso(5, '12:00'), endedAt: iso(5, '12:05'), app: 'Code.exe', title: 'later' });
    expect(app.visibility.deletePermanently([last])).toMatchObject({ ok: true, eventIds: [last] });
    const next = app.events.insert({ watcher: 'window', startedAt: iso(5, '12:05'), endedAt: iso(5, '12:10'), app: 'Code.exe', title: 'later still' });
    expect(next).toBeGreaterThan(last);
    expect(app.visibility.unhide([B])).toEqual({ ok: true, eventIds: [], updating: false });
    app.db.close();
  });

  it('a hidden event can still be deleted for good', async () => {
    const dbPath = fresh();
    const gemini = new ScriptedGemini();
    const app = wire(dbPath, gemini, { now: local(6, '08:00') });
    const { A, B, C, D, codingId } = await seedMorning(app, gemini);

    app.visibility.hide([B]);
    expect(app.visibility.deletePermanently([B])).toMatchObject({ ok: true, eventIds: [B] });

    expect(app.events.listHidden()).toEqual([]);
    expect(app.events.findIncludingHidden([B])).toEqual([]);
    expect(idsOf(app.events.getAll())).toEqual([A, C, D]);
    // The retired activity was only kept as history; deletion removes that too.
    expect(app.intelligenceRepo.getActivitiesByIds([codingId])).toEqual([]);
    app.db.close();
  });

  it('tracking that is still running on a hidden or deleted event does not bring it back', () => {
    const dbPath = fresh();
    const app = wire(dbPath, new ScriptedGemini(), { now: local(6, '08:00') });
    const open = app.events.insert({ watcher: 'window', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:00'), app: 'Google Chrome', title: SECRET_TITLE });
    const gone = app.events.insert({ watcher: 'browser', startedAt: iso(5, '09:00'), endedAt: iso(5, '09:00'), app: 'Google Chrome', url: SECRET_URL });

    app.visibility.hide([open]);
    app.visibility.deletePermanently([gone]);
    // The heartbeat keeps flushing the events it has open.
    app.events.updateEndedAt(open, iso(5, '09:10'));
    app.events.updateEndedAt(gone, iso(5, '09:10'));

    expect(app.events.getAll()).toEqual([]);
    expect(app.events.sumTrackedMs(iso(5), iso(6))).toBe(0);
    expect(app.events.getFirstEventStart()).toBeNull();
    expect(app.events.listHidden().map((e) => [e.id, e.endedAt])).toEqual([[open, iso(5, '09:10')]]);
    expect(app.events.findIncludingHidden([gone])).toEqual([]);
    app.db.close();
  });

  it('exports contain no hidden event', async () => {
    const dbPath = fresh();
    const gemini = new ScriptedGemini();
    const app = wire(dbPath, gemini, { now: local(6, '08:00') });
    const { A, B, C, D } = await seedMorning(app, gemini);
    app.visibility.hide([B]);

    const read = async (run: () => Promise<{ success: boolean }>, name: string) => {
      exportTarget.path = path.join(dir, name);
      expect((await run()).success).toBe(true);
      return fs.readFileSync(exportTarget.path, 'utf8');
    };

    const activityJson = await read(() => app.exports.exportActivity('json'), 'activity.json');
    expect(idsOf(JSON.parse(activityJson))).toEqual([A, C, D]);
    const files = [
      activityJson,
      await read(() => app.exports.exportActivity('csv'), 'activity.csv'),
      await read(() => app.exports.exportSessions('json'), 'sessions.json'),
      await read(() => app.exports.exportSessions('csv'), 'sessions.csv'),
      await read(() => app.exports.exportTimeline('json'), 'timeline.json'),
      await read(() => app.exports.exportTimeline('csv'), 'timeline.csv'),
    ];
    for (const content of files) {
      expect(content).not.toContain(SECRET_TITLE);
      expect(content).not.toContain(SECRET_URL);
      expect(content).not.toContain(AI_TITLE);
    }
    expect(files[0]).toContain('team-channel');
    app.db.close();
  });
});
