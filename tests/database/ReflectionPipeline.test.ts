import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';
import { EditRepository } from '../../src/database/EditRepository';
import { ActivityRuleRepository } from '../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';
import { FocusRepository } from '../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../src/database/IntelligenceRepository';
import { ReflectionRepository } from '../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../src/database/UserProfileRepository';
import { CategorizationService } from '../../src/categorization/CategorizationService';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { IntelligenceTimelineSource } from '../../src/intelligence/IntelligenceTimelineSource';
import { toReflectionActivities } from '../../src/reflection/ReflectionActivities';
import { ReflectionAnnotator } from '../../src/reflection/ReflectionAnnotator';
import { affectedRange } from '../../src/reflection/ReflectionChanges';
import { ReflectionHistory } from '../../src/reflection/ReflectionHistory';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG, type TaxonomyNames } from '../../src/reflection/ReflectionModels';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../src/reflection/ReflectionScheduler';
import { ReflectionService } from '../../src/reflection/ReflectionService';
import { SessionService } from '../../src/session/SessionService';
import { TimelineService } from '../../src/timeline/TimelineService';
import { ScriptedGemini } from '../intelligence/helpers';

/**
 * End-to-end over real SQLite, wired exactly like `main.ts`:
 *
 *   user profile + priorities + raw events + persisted AI activities
 *     + classification + historical baseline
 *   → verified timeline → reflection metrics → (scripted) Gemini
 *   → validated report → persisted → read model for the UI.
 *
 * Self-skips if the native binary ABI does not match Node.
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflect-e2e-probe-')), 'probe.db');
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

/** Project X in the morning, a fragmented afternoon across Project Y, research and browsing. */
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
  const service = new ReflectionService({
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

  /** Raw events + the AI activities the intelligence layer would have persisted. */
  function seedDay(day: number, blocks: Block[] = WORKDAY): void {
    const runId = `run-${day}`;
    intelligenceRepo.createRun({
      id: runId,
      windowStart: iso(day),
      windowEnd: iso(day + 1),
      model: 'test-model',
      promptVersion: 'test',
      schemaVersion: 2,
      nowIso: iso(day + 1),
    });
    const create = blocks.map((b, index) => {
      const start = local(day, b.hhmm);
      const startedAt = start.toISOString();
      const endedAt = new Date(start.getTime() + b.minutes * 60_000).toISOString();
      const eventId = events.insert({ watcher: 'window', startedAt, endedAt, app: b.app, title: `${b.title} — window`, url: b.url ?? null });
      return {
        id: `ai-${day}-${index}`,
        startedAt,
        endedAt,
        eventIds: [eventId],
        title: b.title,
        summary: null,
        contextId: b.contextId,
        areaId: b.areaId,
        intentId: b.intentId,
        qualityId: b.qualityId,
        confidence: 0.9,
        uncertainty: [],
      };
    });
    intelligenceRepo.commitRun({
      runId,
      windowStart: iso(day),
      windowEnd: iso(day + 1),
      model: 'test-model',
      attemptCount: 1,
      outputJson: '{}',
      plan: { create, extend: [], detach: [], userProtectedEventIds: [] },
      nowIso: iso(day + 1),
    });
  }

  return { db, events, profiles, timeline, categorization, service, metrics, reflectionRepo, seedDay };
}

suite('Reflection pipeline (SQLite, end to end)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('understands the user\'s week: priority → observed activity → pattern → carry-forward → next week', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflect-e2e-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    const clock = { now: local(1, '08:00') };
    let app = wire(dbPath, gemini, clock);

    // ── "My current priority is launching Project X." ──
    app.profiles.saveProfile(
      {
        roles: ['Software Developer'],
        description: 'I am building Project X.',
        currentWork: ['Project X', 'Project Y maintenance'],
        priorities: ['Launching Project X'],
        interests: ['Gaming'],
        additionalContext: null,
      },
      'completed',
    );

    // ── Reflect observes several days of activity ──
    // Week 41 (Oct 5–7): three working days. Week 42 (Oct 12–16): five.
    for (const day of [5, 6, 7, 12, 13, 14, 15, 16]) app.seedDay(day);

    // The reflection sees exactly what the Timeline shows: AI activities with
    // their classification, never raw window titles.
    const tuesday = toReflectionActivities(app.timeline.getByRange(iso(13), iso(14)));
    expect(tuesday).toHaveLength(9);
    expect(tuesday[0]).toMatchObject({
      id: 'ai-13-0',
      title: 'Implement Project X sync engine',
      durationMinutes: 80,
      contextId: 'coding',
      areaId: 'area_work',
      qualityId: 'quality_focused',
      source: 'ai',
    });

    clock.now = local(19, '00:05'); // Monday, just after week 42 closed
    const priorityId = app.service.syncPriorities()[0].id;
    const week41 = periodContaining('week', local(7));
    const week42 = periodContaining('week', local(14));

    /** Thread + priority linking: one cached decision per activity signature. */
    const linking = {
      items: [
        { ref: 'i1', thread: 'Project X', priorityId },
        { ref: 'i2', thread: 'Project Y', priorityId: null },
        { ref: 'i3', thread: 'Research', priorityId: null },
        { ref: 'i4', thread: null, priorityId: null },
      ],
    };

    // ── Week 41: the first week Reflect has tracked ──
    gemini.push(linking, {
      schemaVersion: 2,
      periodType: 'week',
      periodStart: week41.start,
      periodEnd: week41.end,
      headline: 'Project X led your first tracked week, with afternoons split across threads.',
      insights: [
        {
          type: 'progress',
          title: 'Project X moved forward on 3 days',
          observation: 'You spent 8h 36m on Project X across 3 days.',
          interpretation: 'It was the thread you returned to every working day.',
          relevance: null,
          suggestedAction: null,
          metricKeys: ['thread.project-x.minutes', 'thread.project-x.active_days'],
          activityRefs: [],
          priorityIds: [],
          confidence: 0.9,
        },
        {
          type: 'fragmentation',
          title: 'Afternoons were where the switching happened',
          observation: 'All 18 context switches happened in the afternoon.',
          interpretation: 'Mornings held long blocks; afternoons moved between Project X, Project Y and research.',
          relevance: null,
          suggestedAction: null,
          metricKeys: ['daypart.afternoon.switches'],
          activityRefs: [],
          priorityIds: [],
          confidence: 0.8,
        },
      ],
      carryForward: {
        text: 'Protect a dedicated Project X block before switching projects.',
        sourceMetricKeys: ['daypart.afternoon.switches'],
        sourceActivityRefs: [],
      },
    });
    expect(await app.service.generate(week41, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', insightCount: 2 });
    expect(gemini.requests[1].prompt).toContain('This is the first week Reflect has tracked.');
    expect(gemini.requests[1].prompt).toContain('COMPARISONS\nNone available.');

    // ── Week 42: deterministic metrics, baseline and week-over-week change ──
    gemini.push({
      schemaVersion: 2,
      periodType: 'week',
      periodStart: week42.start,
      periodEnd: week42.end,
      headline:
        'Project X received consistent attention this week, but your afternoons became more fragmented as you switched between projects.',
      insights: [
        {
          type: 'progress',
          title: 'Project X moved forward every working day',
          observation: 'You spent 14h 20m on Project X across 5 days, in 20 sessions.',
          interpretation: 'It was your most sustained thread of the week.',
          relevance: null,
          suggestedAction: null,
          metricKeys: ['thread.project-x.minutes', 'thread.project-x.active_days', 'thread.project-x.sessions'],
          activityRefs: ['a1'],
          priorityIds: [],
          confidence: 0.92,
        },
        {
          type: 'priority_alignment',
          title: 'Most of your time went toward your stated priority',
          observation: '63% of your tracked time was linked to launching Project X; Project Y took 4h 35m.',
          interpretation: 'Your priority received the largest share, while Project Y still held a substantial part of your implementation time.',
          relevance: 'Launching Project X is the priority you told Reflect about.',
          suggestedAction: null,
          metricKeys: [`priority.${priorityId}.share`, 'thread.project-y.minutes'],
          activityRefs: [],
          priorityIds: [priorityId],
          confidence: 0.88,
        },
        {
          type: 'recurring_behavior',
          title: 'Your longest blocks started before noon',
          observation: 'On 5 of 5 days your longest uninterrupted block started before noon.',
          interpretation: 'Sustained work consistently happened in your first work block of the day.',
          relevance: null,
          suggestedAction: null,
          metricKeys: ['pattern.longest_block_before_noon_days'],
          activityRefs: [],
          priorityIds: [],
          confidence: 0.86,
        },
        {
          type: 'change_over_time',
          title: 'More afternoon switching than the week before',
          observation: 'Afternoon context switches went from 18 to 30, as tracked time rose by +9h 4m (+67%).',
          interpretation: 'You worked on two more days, and the afternoon pattern you saw last week continued on each of them.',
          relevance: null,
          suggestedAction: null,
          metricKeys: ['daypart.afternoon.switches', 'prev.daypart.afternoon.switches', 'delta.time.tracked_minutes'],
          activityRefs: [],
          priorityIds: [],
          confidence: 0.8,
        },
      ],
      carryForward: {
        text: 'Protect a dedicated Project X block before switching projects.',
        sourceMetricKeys: ['pattern.longest_block_before_noon_days', 'daypart.afternoon.switches'],
        sourceActivityRefs: [],
      },
    });
    const result = await app.service.generate(week42, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 4 });

    // Gemini received structured evidence — computed deterministically — and
    // last week's structured reflection, so it can say what actually changed.
    const prompt = gemini.requests[2].prompt;
    expect(gemini.requests).toHaveLength(3); // linking was cached: no second linking call
    expect(prompt).toContain('{"key":"time.tracked_minutes","label":"Total tracked time","value":"22h 40m"}');
    expect(prompt).toContain('{"key":"thread.project-x.minutes","label":"Time on “Project X”","value":"14h 20m"}');
    expect(prompt).toContain(`"label":"Share of tracked time linked to the priority “Launching Project X”","value":"63%"`);
    expect(prompt).toContain('{"key":"time.tracked_minutes","label":"Total tracked time","now":"22h 40m","previous":"13h 36m","change":"+9h 4m (+67%)"}');
    expect(prompt).toContain('PREVIOUS REFLECTION (Oct 5 – Oct 11)');
    expect(prompt).toContain('"carryForward":"Protect a dedicated Project X block before switching projects."');
    expect(prompt).toContain('{"type":"fragmentation","title":"Afternoons were where the switching happened","timesSurfaced":1}');
    expect(prompt).toContain('Not enough history yet for a personal baseline.');
    expect(prompt).not.toContain('— window'); // raw window titles never leave the timeline

    // ── The report is persisted and remains available later ──
    app.db.close();
    app = wire(dbPath, gemini, clock);

    const view = await app.service.getView('week', iso(14));
    expect(view.period).toMatchObject({ key: '2026-W42', title: 'Last week', range: 'Oct 12 – Oct 18', isClosed: true });
    expect(view.report).toMatchObject({
      status: 'fresh',
      headline:
        'Project X received consistent attention this week, but your afternoons became more fragmented as you switched between projects.',
      isPartial: false,
    });
    expect(view.report!.insights.map((i) => i.type)).toEqual(['progress', 'priority_alignment', 'recurring_behavior', 'change_over_time']);
    expect(view.report!.carryForward!.text).toBe('Protect a dedicated Project X block before switching projects.');
    expect(view.report!.supportingMetrics.map((m) => `${m.label}: ${m.display}`)).toEqual([
      'Total tracked time: 22h 40m',
      'Focused time (Deep Work + Focused): 18h 55m',
      'Time linked to the priority “Launching Project X”: 14h 20m',
      'Longest uninterrupted block (Project X, Mon, Oct 12, 9:00 AM): 1h 20m',
      'Context switches: 30',
      'Days with tracked activity: 5',
    ]);
    expect(view.live).toBeNull(); // a closed period with a report is served from persistence
    expect(gemini.requests).toHaveLength(3); // opening the tab never calls Gemini

    // ── The user can inspect why Reflect said this ──
    const progress = view.report!.insights[0];
    const activityEvidence = progress.evidence.find((e) => e.kind === 'activity')!;
    expect(activityEvidence).toMatchObject({ activityId: 'ai-12-0', label: 'Implement Project X sync engine' });
    // …and the evidence points at a real block on the Timeline.
    const onTimeline = app.timeline.getByRange(activityEvidence.period!.start, activityEvidence.period!.end);
    expect(onTimeline.map((s) => s.id)).toContain(activityEvidence.activityId);
    expect(view.report!.insights[3].evidence.map((e) => e.kind)).toEqual(['metric', 'comparison', 'comparison']);
    expect(view.report!.insights[1].evidence[0]).toMatchObject({ kind: 'priority', priorityId, value: '63%' });

    // ── Structured history is queryable without scraping prose (future Coach) ──
    const history = new ReflectionHistory(app.reflectionRepo);
    expect(history.getPriorityAlignmentHistory('week').map((p) => [p.period.key, p.minutes, p.sharePercent])).toEqual([
      ['2026-W41', 516, 63],
      ['2026-W42', 860, 63],
    ]);
    expect(history.getBehaviorTrends('week', 'daypart.afternoon.switches').map((p) => p.value)).toEqual([18, 30]);
    expect(history.getCarryForwardHistory('week')).toHaveLength(2);
    expect(history.getInsightHistory('fragmentation').map((e) => e.period.key)).toEqual(['2026-W41']);

    // ── Feedback is recorded against the insight ──
    expect(app.service.submitFeedback(view.report!.insights[2].id, 'useful')).toBe(true);
    expect((await app.service.getView('week', iso(14))).report!.insights[2].feedback).toBe('useful');

    // ── A later user correction makes the report stale; it is never silently rewritten ──
    const projectYEvents = app.timeline
      .getByRange(week42.start, week42.end)
      .filter((s) => s.ai?.title === 'Fix Project Y billing bug')
      .flatMap((s) => s.events.map((e) => e.id));
    expect(projectYEvents).toHaveLength(10);
    const payload = { eventIds: projectYEvents, contextId: 'coding', areaId: 'area_personal', intentId: 'intent_create', qualityId: 'quality_routine', remember: false };
    app.categorization.saveOverride(payload.eventIds, payload, false);
    app.service.notifyDataChanged({ kind: 'timeline', range: affectedRange('categorization:saveOverride', payload, app.events) });

    const stale = await app.service.getView('week', iso(14));
    expect(stale.report).toMatchObject({ id: view.report!.id, status: 'stale', staleReason: 'activity_changed' });
    expect(stale.report!.headline).toBe(view.report!.headline);
    expect(stale.canRefresh).toBe(true);
    // The earlier week was not affected by that edit.
    expect((await app.service.getView('week', iso(7))).report!.status).toBe('fresh');

    app.db.close();
  });

  it('the scheduler fills the backlog once after a restart, and shows live numbers for today', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reflect-e2e-'));
    const dbPath = path.join(dir, 'test.db');
    const gemini = new ScriptedGemini();
    const clock = { now: local(15, '08:00') };
    let app = wire(dbPath, gemini, clock);
    for (const day of [13, 14, 15]) app.seedDay(day); // Tue, Wed, Thu
    app.db.close();

    // Reflect was offline; it starts again on Thursday afternoon.
    clock.now = local(15, '16:00');
    app = wire(dbPath, gemini, clock);
    const scheduler = new ReflectionScheduler(app.service);
    scheduler.start();

    const nothing = (period: ReturnType<typeof periodContaining>) => ({
      schemaVersion: 2,
      periodType: period.type,
      periodStart: period.start,
      periodEnd: period.end,
      headline: 'Nothing unusual stood out.',
      insights: [],
      carryForward: null,
    });
    const linking = { items: [1, 2, 3, 4].map((n) => ({ ref: `i${n}`, thread: null, priorityId: null })) };
    const wednesday = periodContaining('day', local(14));
    gemini.push(linking, nothing(shiftPeriod(wednesday, -1)), nothing(wednesday));

    const cycle = await scheduler.runCycle();
    expect(cycle.results.map((r) => `${r.period.key}:${r.status}`)).toEqual([
      '2026-10-13:succeeded',
      '2026-10-14:succeeded',
    ]);
    expect((await scheduler.runCycle()).results).toEqual([]); // nothing is regenerated

    // A block the user added by hand is replayed by the timeline engine into
    // every range query. Reflection must still count it exactly once, on its day.
    app.timeline.apply('create_offline', { startedAt: iso(14, '18:00'), endedAt: iso(14, '19:00'), title: 'Whiteboard session' });
    app.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(14, '18:00'), end: iso(14, '19:00') } });
    const tracked = async (type: 'day' | 'week', day: number) =>
      (await app.metrics.computeCore(periodContaining(type, local(day)), periodContaining(type, local(day)).end, [])).metrics[
        'time.tracked_minutes'
      ].value;
    expect(await tracked('day', 13)).toBe(272);
    expect(await tracked('day', 14)).toBe(332); // 272 + the 60-minute offline block
    expect(await tracked('day', 15)).toBe(272);
    expect(await tracked('week', 14)).toBe(3 * 272 + 60);
    // …and Wednesday's reflection is now stale, because its day really changed.
    expect((await app.service.getView('day', iso(14, '12:00'))).report).toMatchObject({ status: 'stale', staleReason: 'activity_changed' });
    expect((await app.service.getView('day', iso(13, '12:00'))).report!.status).toBe('fresh');

    // Today is still running: deterministic numbers, no model call.
    const calls = gemini.requests.length;
    const today = await app.service.getView('day');
    expect(today.period).toMatchObject({ title: 'Today', isCurrent: true });
    expect(today.report).toBeNull();
    expect(today.live!.metrics.slice(0, 2).map((m) => m.display)).toEqual(['4h 32m', '3h 47m']);
    expect(gemini.requests.length).toBe(calls);

    // An earlier day's reflection is loaded from persistence.
    expect((await app.service.getView('day', iso(13, '12:00'))).report!.headline).toBe('Nothing unusual stood out.');
    app.db.close();
  });
});
