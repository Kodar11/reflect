import { describe, it, expect } from 'vitest';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';
import { REFLECTION_PROMPT_VERSION } from '../../src/reflection/ReflectionPrompt';
import {
  browsing,
  iso,
  local,
  makeReflectionHarness,
  modelInsight,
  modelReflection,
  projectY,
  seedThreads,
  workday,
  type HarnessOptions,
} from './helpers';

/**
 * Two full working weeks: Mon Oct 5 – Fri Oct 9 and Mon Oct 12 – Fri Oct 16.
 * "Now" defaults to Mon Oct 19, 09:00 — both weeks are closed.
 */
const twoWeeks = () => [5, 6, 7, 8, 9, 12, 13, 14, 15, 16].flatMap(workday);
const week41 = periodContaining('week', local(7));
const week42 = periodContaining('week', local(14));

function harness(options: HarnessOptions = {}) {
  const h = makeReflectionHarness({ activities: twoWeeks(), now: local(19, '09:00'), priorities: ['Launching Project X'], ...options });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0]?.id ?? 'none' });
  return { ...h, priorityId: priorities[0]?.id as string };
}

/** A grounded weekly reflection for `period`. */
const weekly = (period = week42, priorityId = 'pr-id-0001') =>
  modelReflection(period, {
    headline: 'Project X received consistent attention this week, while your afternoons moved between threads.',
    insights: [
      modelInsight({
        type: 'progress',
        title: 'Project X moved forward on 5 days',
        observation: 'You spent 14h 20m on Project X across 5 days.',
        interpretation: 'It was your most consistently worked thread.',
        metricKeys: ['thread.project-x.minutes', 'thread.project-x.active_days'],
      }),
      modelInsight({
        type: 'priority_alignment',
        title: 'Your stated priority received most of your time',
        observation: '63% of your tracked time went toward launching Project X.',
        interpretation: 'What you said matters and where your time went lined up.',
        relevance: 'Launching Project X is the priority you stated.',
        metricKeys: [`priority.${priorityId}.share`],
        priorityIds: [priorityId],
      }),
      modelInsight({
        type: 'recurring_behavior',
        title: 'Your longest blocks started before noon',
        observation: 'On 5 of 5 days your longest block started before noon.',
        interpretation: 'Sustained work clustered in your mornings.',
        metricKeys: ['pattern.longest_block_before_noon_days'],
      }),
    ],
    carryForward: {
      text: 'Keep a morning block for Project X before switching threads.',
      sourceMetricKeys: ['pattern.longest_block_before_noon_days'],
      sourceActivityRefs: [],
    },
  });

describe('ReflectionService.generate', () => {
  it('runs the whole pipeline and persists a structured, evidence-backed report', async () => {
    const h = harness({ script: [] });
    h.gemini.push(weekly(week42, h.priorityId));

    const result = await h.service.generate(week42, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 3 });

    const report = h.repo.getCurrentReport('week', week42.key)!;
    expect(report).toMatchObject({
      status: 'fresh',
      trigger: 'scheduled',
      headline: 'Project X received consistent attention this week, while your afternoons moved between threads.',
      coveredUntil: week42.end,
      promptVersion: REFLECTION_PROMPT_VERSION,
      model: 'test-model-001',
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
    });
    // Observation / interpretation / evidence stay separate — not one paragraph.
    expect(report.insights[1]).toMatchObject({
      type: 'priority_alignment',
      observation: '63% of your tracked time went toward launching Project X.',
      interpretation: 'What you said matters and where your time went lined up.',
      relevance: 'Launching Project X is the priority you stated.',
      sourceMetricKeys: [`priority.${h.priorityId}.share`],
    });
    expect(report.insights[1].evidence[0]).toMatchObject({ kind: 'priority', priorityId: h.priorityId, value: '63%' });
    expect(report.insights.every((i) => /^id-\d+$/.test(i.id))).toBe(true); // backend-generated ids
    expect(report.carryForward!.text).toBe('Keep a morning block for Project X before switching threads.');

    // The evidence the report was written from is snapshotted with it.
    expect(report.metricsSnapshot!['time.tracked_minutes'].display).toBe('22h 40m');
    expect(report.metricsSnapshot!['prev.time.tracked_minutes'].display).toBe('22h 40m');
    expect(report.dataSnapshot).toMatchObject({ isPartial: false, userContextIncluded: true, previousReportId: null });
    expect(report.dataSnapshot!.priorities[0].text).toBe('Launching Project X');
  });

  it('sends the model deterministic evidence, the user context and the priorities — never raw events', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });

    const { prompt, systemInstruction } = h.gemini.requests[0];
    expect(systemInstruction).toContain('You are Reflect, a personal activity reflection system.');
    expect(prompt).toContain('Who the user is: Software Developer');
    expect(prompt).toContain(`{"id":"${h.priorityId}","text":"Launching Project X"`);
    expect(prompt).toContain('{"key":"time.tracked_minutes","label":"Total tracked time","value":"22h 40m"}');
    expect(prompt).toContain('"thread":"Project X"');
    expect(prompt).toContain('what pattern is emerging?');
    expect(prompt).not.toMatch(/eventIds|payload|watcher/);
  });

  it('does not call Gemini when the period holds too little data', async () => {
    const h = makeReflectionHarness({ activities: [projectY(13, '09:00', 12)], now: local(19, '09:00') });
    const result = await h.service.generate(week42, { trigger: 'scheduled' });
    expect(result).toEqual({ status: 'skipped', reason: 'insufficient_data', period: week42 });
    expect(h.gemini.requests).toHaveLength(0);
    expect(h.repo.getLatestAttempt('week', week42.key)!.status).toBe('insufficient_data');

    const view = await h.service.getView('week', iso(14));
    expect(view.report).toBeNull();
    expect(view.generation.state).toBe('insufficient_data');
    expect(view.sufficiency).toEqual({ enough: false, message: 'Not enough activity this week to reflect on yet.' });
    expect(view.canRefresh).toBe(false);
  });

  it('refuses future periods and periods before tracking began', async () => {
    const h = harness();
    expect((await h.service.generate(shiftPeriod(week42, 2), { trigger: 'manual' })).status).toBe('skipped');
    expect(await h.service.generate(shiftPeriod(week41, -4), { trigger: 'scheduled' })).toMatchObject({ status: 'skipped', reason: 'no_data' });
    expect(h.gemini.requests).toHaveLength(0);
  });

  it('missing API key: clear, non-fatal, nothing written', async () => {
    const h = harness();
    h.gemini.configured = false;
    const result = await h.service.generate(week42, { trigger: 'manual' });
    expect(result).toMatchObject({ status: 'failed', category: 'missing_api_key', reportId: null });
    expect(h.repo.reports).toEqual([]);
    const view = await h.service.getView('week', iso(14));
    expect(view.configured).toBe(false);
    expect(view.refreshBlockedReason).toBe('not_configured');
    expect(view.live!.metrics[0]).toEqual({ key: 'time.tracked_minutes', label: 'Total tracked time', display: '22h 40m' });
  });

  it('retries with the validation problems as feedback', async () => {
    const h = harness();
    const bad = weekly(week42, h.priorityId);
    (bad.insights as Record<string, unknown>[])[0].observation = 'You spent 99h on Project X.';
    h.gemini.push(bad, weekly(week42, h.priorityId));

    const result = await h.service.generate(week42, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 2, insightCount: 3 });
    expect(h.sleeps).toEqual([1000]);
    expect(h.gemini.requests[1].prompt).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
    expect(h.gemini.requests[1].prompt).toContain('number(s) "99" not found in its cited evidence');
  });

  it('retries malformed JSON', async () => {
    const h = harness();
    h.gemini.push('{not json', weekly(week42, h.priorityId));
    expect(await h.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('after exhausting retries, keeps only the insights that fully validated', async () => {
    const h = harness();
    const bad = () => {
      const r = weekly(week42, h.priorityId);
      (r.insights as Record<string, unknown>[])[2].interpretation = 'You were tired in the afternoons.';
      return r;
    };
    h.gemini.push(bad(), bad(), bad());

    const result = await h.service.generate(week42, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 3, insightCount: 2 });
    const report = h.repo.getCurrentReport('week', week42.key)!;
    expect(report.insights.map((i) => i.type)).toEqual(['progress', 'priority_alignment']);
    expect(JSON.stringify(report.insights)).not.toContain('tired');
  });

  it('a failed generation never replaces the previous valid reflection', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const before = h.repo.getCurrentReport('week', week42.key)!;

    // Force a regeneration that is rejected outright on every attempt.
    const wrongPeriod = weekly(week41, h.priorityId);
    h.gemini.push(wrongPeriod, wrongPeriod, wrongPeriod);
    h.repo.markStale(before.id, 'activity_changed', iso(19));
    const result = await h.service.generate(week42, { trigger: 'manual' });

    expect(result).toMatchObject({ status: 'failed', category: 'validation', attempts: 3 });
    const after = h.repo.getCurrentReport('week', week42.key)!;
    expect(after.id).toBe(before.id);
    expect(after.headline).toBe(before.headline);
    expect(after.insights).toHaveLength(3);

    const view = await h.service.getView('week', iso(14));
    expect(view.report!.id).toBe(before.id);
    expect(view.generation).toMatchObject({
      state: 'failed',
      errorCategory: 'validation',
      message: 'The generated reflection did not pass Reflect’s evidence checks and was discarded.',
    });
  });

  it('gives up immediately on a non-retryable Gemini error and keeps retrying transient ones', async () => {
    const permanent = harness();
    permanent.gemini.push(new GeminiError('api', 'Gemini API error (400): bad request', false, 400));
    expect(await permanent.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category: 'api', attempts: 1 });

    const transient = harness();
    const down = new GeminiError('network', 'Gemini network error: offline', true);
    transient.gemini.push(down, down, down);
    expect(await transient.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({
      status: 'failed',
      category: 'network',
      attempts: 3,
    });
    expect(transient.sleeps).toEqual([1000, 4000]);
    expect(transient.repo.getLatestAttempt('week', week42.key)).toMatchObject({ status: 'failed', errorCategory: 'network' });
    expect(transient.repo.getCurrentReport('week', week42.key)).toBeNull();
  });

  it('a persistence failure fails the run and leaves the earlier report intact', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId), weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const before = h.repo.getCurrentReport('week', week42.key)!;
    h.repo.markStale(before.id, 'activity_changed', iso(19));

    h.repo.failNextCommit = true;
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'persistence' });
    expect(h.repo.getCurrentReport('week', week42.key)!.id).toBe(before.id);
  });

  it('shares one in-flight generation between concurrent requests', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    const [a, b] = await Promise.all([
      h.service.generate(week42, { trigger: 'scheduled' }),
      h.service.generate(week42, { trigger: 'manual' }),
    ]);
    expect(a).toBe(b);
    expect(h.gemini.requests).toHaveLength(1);
  });
});

describe('ReflectionService — personal context, novelty, feedback', () => {
  it('the next period sees the previous reflection and what was already surfaced', async () => {
    const h = harness();
    h.gemini.push(weekly(week41, h.priorityId), weekly(week42, h.priorityId));
    await h.service.generate(week41, { trigger: 'scheduled' });
    const first = h.repo.getCurrentReport('week', week41.key)!;
    h.service.submitFeedback(first.insights[2].id, 'useful');

    await h.service.generate(week42, { trigger: 'scheduled' });
    const prompt = h.gemini.requests[1].prompt;
    expect(prompt).toContain('PREVIOUS REFLECTION (Oct 5 – Oct 11)');
    expect(prompt).toContain('"carryForward":"Keep a morning block for Project X before switching threads."');
    expect(prompt).toContain('PREVIOUSLY SURFACED (recent periods)');
    expect(prompt).toContain('{"type":"recurring_behavior","title":"Your longest blocks started before noon","timesSurfaced":1}');
    expect(prompt).toContain('FEEDBACK HISTORY\n- recurring_behavior: 1 useful, 0 not useful, 0 marked inaccurate');
    expect(h.repo.getCurrentReport('week', week42.key)!.dataSnapshot!.previousReportId).toBe(first.id);
  });

  it('says so when there is no history to compare with', async () => {
    const h = makeReflectionHarness({ activities: [12, 13, 14].flatMap(workday), now: local(19, '09:00') });
    h.gemini.push(modelReflection(week42, { headline: 'Nothing unusual stood out this week.', insights: [] }));
    await h.service.generate(week42, { trigger: 'scheduled' });

    const prompt = h.gemini.requests[0].prompt;
    expect(prompt).toContain('This is the first week Reflect has tracked. Comparisons will appear as more history accumulates.');
    expect(prompt).toContain('COMPARISONS\nNone available.');
    expect(prompt).toContain('No current priorities are stated, so priority alignment cannot be assessed.');
    const view = await h.service.getView('week', iso(14));
    expect(view.report!.insights).toEqual([]);
    expect(view.report!.notes[0]).toMatch(/first week Reflect has tracked/);
  });

  it('records, changes and clears feedback', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const insightId = h.repo.getCurrentReport('week', week42.key)!.insights[0].id;

    expect(h.service.submitFeedback(insightId, 'useful')).toBe(true);
    expect((await h.service.getView('week', iso(14))).report!.insights[0].feedback).toBe('useful');
    h.service.submitFeedback(insightId, 'inaccurate');
    expect((await h.service.getView('week', iso(14))).report!.insights[0].feedback).toBe('inaccurate');
    h.service.submitFeedback(insightId, null);
    expect((await h.service.getView('week', iso(14))).report!.insights[0].feedback).toBeNull();

    expect(h.service.submitFeedback('no-such-insight', 'useful')).toBe(false);
    expect(h.service.submitFeedback(insightId, 'five-stars' as never)).toBe(false);
  });
});

describe('ReflectionService — priorities are time-aware', () => {
  it('normalizes the stated priorities and exposes them with their status', () => {
    const h = harness();
    expect(h.service.getPriorities()).toMatchObject([{ text: 'Launching Project X', status: 'active', possiblyStale: false }]);
    expect(h.priorityId).toMatch(/^pr-/);
  });

  it('uses no priorities at all when onboarding was skipped', async () => {
    const h = makeReflectionHarness({ activities: twoWeeks(), now: local(19, '09:00') });
    expect(h.service.getPriorities()).toEqual([]);
    h.gemini.push(modelReflection(week42, { insights: [] }));
    await h.service.generate(week42, { trigger: 'scheduled' });
    expect(h.gemini.requests[0].prompt).toContain('USER CONTEXT\nNot provided.');
    expect(h.gemini.requests[0].prompt).toContain('CURRENT PRIORITIES\nNone stated.');
  });

  it('a removed priority stops applying from now on, without rewriting the past', () => {
    const h = harness();
    h.profiles.updateProfile({ priorities: ['Learn Rust'] });
    h.service.notifyDataChanged({ kind: 'profile' });

    const all = h.repo.listPriorities();
    expect(all.find((p) => p.text === 'Launching Project X')).toMatchObject({ status: 'archived', activeUntil: iso(19, '09:00') });
    expect(all.find((p) => p.text === 'Learn Rust')).toMatchObject({ status: 'active', activeFrom: iso(19, '09:00') });
    // The visible list no longer shows the archived one.
    expect(h.service.getPriorities().map((p) => p.text)).toEqual(['Learn Rust']);
  });

  it('a priority not reconfirmed for a long time is flagged, not silently trusted', async () => {
    const h = harness();
    h.setNow(local(19 + 90, '09:00'));
    expect(h.service.getPriorities()[0].possiblyStale).toBe(true);
  });

  it('lets the user mark a priority completed or paused', () => {
    const h = harness();
    expect(h.service.setPriorityStatus(h.priorityId, 'completed')[0]).toMatchObject({ status: 'completed' });
    expect(h.repo.listPriorities()[0].activeUntil).toBe(iso(19, '09:00'));
    // Still stated in the profile → the next sync does not silently reactivate it.
    expect(h.service.syncPriorities()[0].status).toBe('completed');
    expect(h.service.setPriorityStatus(h.priorityId, 'active')[0]).toMatchObject({ status: 'active' });
  });
});

describe('ReflectionService.getView', () => {
  it('shows live deterministic numbers for today without ever calling Gemini', async () => {
    const h = harness({ activities: [...twoWeeks(), ...workday(19)], now: local(19, '16:00') });
    seedThreads(h.repo, h.activities, { 'Project X': h.priorityId });

    const view = await h.service.getView('day');
    expect(view.period).toMatchObject({ type: 'day', key: '2026-10-19', title: 'Today', isCurrent: true, isClosed: false, hasNext: false, hasPrevious: true });
    expect(view.report).toBeNull();
    expect(view.live!.metrics.map((m) => [m.key, m.display])).toEqual([
      ['time.tracked_minutes', '4h 32m'],
      ['time.focused_minutes', '3h 47m'],
      [`priority.${h.priorityId}.minutes`, '2h 52m'],
      ['block.longest_minutes', '1h 20m'],
      ['behavior.switches', '6'],
    ]);
    expect(view.sufficiency.enough).toBe(true);
    expect(view.canRefresh).toBe(true);
    expect(h.gemini.requests).toHaveLength(0);
  });

  it('loads a persisted historical report without recomputing or regenerating', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    const loadsAfterGeneration = h.dayLoads.length;

    const view = await h.service.getView('week', iso(14));
    expect(view.period).toMatchObject({ title: 'Last week', range: 'Oct 12 – Oct 18', isClosed: true, hasNext: true });
    expect(view.report).toMatchObject({ status: 'fresh', isPartial: false, generatedAt: iso(19, '09:00') });
    expect(view.report!.supportingMetrics.map((m) => m.key)).toContain('days.active');
    expect(view.live).toBeNull();
    expect(view.refreshBlockedReason).toBe('up_to_date');
    expect(h.dayLoads.length).toBe(loadsAfterGeneration); // served entirely from persistence
    expect(h.gemini.requests).toHaveLength(1);
    // Internal scoring never reaches the renderer.
    expect(JSON.stringify(view)).not.toContain('confidence');
  });

  it('shows deterministic numbers for a past period that has no reflection', async () => {
    const h = harness();
    const view = await h.service.getView('week', iso(7));
    expect(view.report).toBeNull();
    expect(view.generation.state).toBe('idle');
    expect(view.live!.metrics[0].display).toBe('22h 40m');
    expect(view.canRefresh).toBe(true); // the user may ask for it
  });

  it('throttles manual refreshes of a running period', async () => {
    const h = harness({ activities: [...twoWeeks(), ...workday(19), ...workday(20)], now: local(20, '16:00') });
    seedThreads(h.repo, h.activities, { 'Project X': h.priorityId });
    const week43 = periodContaining('week', local(20));
    const partial = () => modelReflection(week43, { headline: 'Project X led your week so far.', insights: [modelInsight()] });
    h.gemini.push(partial(), partial());

    expect((await h.service.generate(week43, { trigger: 'manual' })).status).toBe('succeeded');
    const first = h.repo.getCurrentReport('week', week43.key)!;
    expect(first.dataSnapshot!.isPartial).toBe(true);
    expect(h.gemini.requests[0].prompt).toContain('This period is still in progress');

    expect(await h.service.generate(week43, { trigger: 'manual' })).toMatchObject({ status: 'skipped', reason: 'throttled' });
    let view = await h.service.getView('week');
    expect(view.canRefresh).toBe(false);
    expect(view.refreshBlockedReason).toBe('cooldown');
    expect(view.refreshAvailableAt).toBe(iso(20, '16:15'));

    // After the cooldown the refresh supersedes the earlier report instead of mutating it.
    h.setNow(local(20, '16:20'));
    expect((await h.service.generate(week43, { trigger: 'manual' })).status).toBe('succeeded');
    view = await h.service.getView('week');
    expect(view.report!.id).not.toBe(first.id);
    expect(h.repo.getReportById(first.id)!.status).toBe('superseded');
    expect(h.repo.getReportById(first.id)!.headline).toBe('Project X led your week so far.');
  });
});

describe('ReflectionService — staleness', () => {
  async function generated() {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    return h;
  }

  it('marks a report stale when its underlying activity meaningfully changed — without rewriting it', async () => {
    const h = await generated();
    const original = h.repo.getCurrentReport('week', week42.key)!;

    // The user re-classifies a chunk of that week on the Timeline.
    for (const a of h.activities) {
      if (a.thread === 'Project Y' && a.startedAt >= week42.start) a.areaId = 'area_personal';
    }
    h.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(13), end: iso(14) } });

    const view = await h.service.getView('week', iso(14));
    expect(view.report).toMatchObject({ id: original.id, status: 'stale', staleReason: 'activity_changed', headline: original.headline });
    expect(view.canRefresh).toBe(true);

    // Regeneration creates a new report; the stale one is kept as superseded.
    h.gemini.push(weekly(week42, h.priorityId));
    expect((await h.service.generate(week42, { trigger: 'manual' })).status).toBe('succeeded');
    expect((await h.service.getView('week', iso(14))).report!.status).toBe('fresh');
    expect(h.repo.getReportById(original.id)!.status).toBe('superseded');
  });

  it('stays fresh after a change that does not really alter the period', async () => {
    const h = await generated();
    h.activities.push(browsing(14, '21:00', 4));
    h.service.notifyDataChanged({ kind: 'timeline', range: null });

    expect(h.repo.getCurrentReport('week', week42.key)!.needsVerification).toBe(true);
    expect((await h.service.getView('week', iso(14))).report!.status).toBe('fresh');
    expect(h.repo.getCurrentReport('week', week42.key)!.needsVerification).toBe(false); // checked once, not on every visit
  });

  it('only re-checks reports whose period overlaps the change', async () => {
    const h = await generated();
    h.service.notifyDataChanged({ kind: 'timeline', range: { start: iso(6), end: iso(7) } }); // the week before
    expect(h.repo.getCurrentReport('week', week42.key)!.needsVerification).toBe(false);
  });

  it('a running period becomes stale when the priorities it was written against change', async () => {
    const h = harness({ activities: [...twoWeeks(), ...workday(19), ...workday(20)], now: local(20, '16:00') });
    seedThreads(h.repo, h.activities, { 'Project X': h.priorityId });
    const week43 = periodContaining('week', local(20));
    h.gemini.push(modelReflection(week43));
    await h.service.generate(week43, { trigger: 'manual' });

    h.profiles.updateProfile({ priorities: ['Launching Project X', 'Learn Rust'] });
    h.service.notifyDataChanged({ kind: 'profile' });

    const view = await h.service.getView('week');
    expect(view.report).toMatchObject({ status: 'stale', staleReason: 'priorities_changed' });
    // The closed week's reflection described the priorities of its own time.
    expect(h.repo.listCurrentReports('week', 10).filter((r) => r.status === 'stale')).toHaveLength(1);
  });
});

describe('ReflectionService — performance', () => {
  it('derives each closed day from the timeline once and reuses it across periods', async () => {
    const h = harness();
    await h.service.getView('week', iso(7));
    const afterFirst = h.dayLoads.length;
    expect(afterFirst).toBe(7);

    await h.service.getView('week', iso(7));
    await h.service.getView('day', iso(6));
    expect(h.dayLoads.length).toBe(afterFirst);

    // A timeline change drops the cache.
    h.service.notifyDataChanged({ kind: 'timeline', range: null });
    await h.service.getView('week', iso(7));
    expect(h.dayLoads.length).toBe(afterFirst + 7);
  });

  it('never loads anything from before tracking began', async () => {
    const h = harness();
    h.gemini.push(weekly(week41, h.priorityId));
    await h.service.generate(week41, { trigger: 'scheduled' });
    expect(Math.min(...h.dayLoads)).toBe(Date.parse(iso(5)));
  });
});

describe('ReflectionService.pendingScheduledPeriods', () => {
  const keys = async (h: ReturnType<typeof harness>) => (await h.service.pendingScheduledPeriods()).map((p) => `${p.type}:${p.key}`);

  it('lists closed periods without a report, oldest first, within the backlog window', async () => {
    // Mon Oct 19, 09:00. Tracking began Mon Oct 5.
    const h = harness();
    expect(await keys(h)).toEqual([
      'day:2026-10-16', // Fri (Sat/Sun are closed too, and get examined once)
      'day:2026-10-17',
      'day:2026-10-18',
      'week:2026-W41',
      'week:2026-W42',
    ]);
  });

  it('does not list a period that already has a report, or was found too thin', async () => {
    const h = harness();
    h.gemini.push(weekly(week42, h.priorityId));
    await h.service.generate(week42, { trigger: 'scheduled' });
    await h.service.generate(periodContaining('day', local(17)), { trigger: 'scheduled' }); // Saturday: nothing tracked
    await h.service.generate(periodContaining('day', local(18)), { trigger: 'scheduled' });

    expect(await keys(h)).toEqual(['day:2026-10-16', 'week:2026-W41']);
  });

  it('retries a transient failure but stops retrying output that keeps being rejected', async () => {
    const h = harness();
    const down = new GeminiError('network', 'offline', true);
    h.gemini.push(down, down, down);
    await h.service.generate(week42, { trigger: 'scheduled' });
    expect(await keys(h)).toContain('week:2026-W42');

    const wrong = weekly(week41, h.priorityId);
    for (let run = 0; run < 3; run++) {
      h.gemini.push(wrong, wrong, wrong);
      await h.service.generate(week42, { trigger: 'scheduled' });
    }
    expect(await keys(h)).not.toContain('week:2026-W42');
  });

  it('writes today\'s reflection once the daily reflection time has passed — and only once', async () => {
    const h = harness({ activities: [...twoWeeks(), ...workday(19)], now: local(19, '21:30') });
    seedThreads(h.repo, h.activities, { 'Project X': h.priorityId });
    const today = periodContaining('day', local(19));
    expect(await keys(h)).not.toContain('day:2026-10-19');

    h.setNow(local(19, '22:02'));
    expect((await keys(h)).at(-1)).toBe('day:2026-10-19');

    h.gemini.push(modelReflection(today));
    await h.service.generate(today, { trigger: 'scheduled' });
    h.setNow(local(19, '23:02'));
    expect(await keys(h)).not.toContain('day:2026-10-19');
  });

  it('replaces an earlier manual report of today at reflection time', async () => {
    const h = harness({ activities: [...twoWeeks(), ...workday(19)], now: local(19, '17:00') });
    seedThreads(h.repo, h.activities, { 'Project X': h.priorityId });
    const today = periodContaining('day', local(19));
    h.gemini.push(modelReflection(today));
    await h.service.generate(today, { trigger: 'manual' });

    h.setNow(local(19, '22:02'));
    expect(await keys(h)).toContain('day:2026-10-19');
  });

  it('finalizes a day once after midnight only if enough happened after its evening report', async () => {
    const quiet = harness({ activities: [...twoWeeks(), ...workday(19)], now: local(19, '22:02') });
    seedThreads(quiet.repo, quiet.activities, { 'Project X': quiet.priorityId });
    const day = periodContaining('day', local(19));
    quiet.gemini.push(modelReflection(day));
    await quiet.service.generate(day, { trigger: 'scheduled' });
    quiet.setNow(local(20, '00:02'));
    expect(await keys(quiet)).not.toContain('day:2026-10-19');

    const late = harness({ activities: [...twoWeeks(), ...workday(19), projectY(19, '22:30', 50)], now: local(19, '22:02') });
    seedThreads(late.repo, late.activities, { 'Project X': late.priorityId });
    late.gemini.push(modelReflection(day), modelReflection(day));
    await late.service.generate(day, { trigger: 'scheduled' });
    late.setNow(local(20, '00:02'));
    expect(await keys(late)).toContain('day:2026-10-19');

    await late.service.generate(day, { trigger: 'scheduled' });
    expect(late.repo.getCurrentReport('day', day.key)!.coveredUntil).toBe(day.end);
    expect(await keys(late)).not.toContain('day:2026-10-19'); // final now
  });

  it('plans nothing before any tracking exists', async () => {
    const h = makeReflectionHarness({ activities: [], now: local(19, '22:30') });
    expect(await h.service.pendingScheduledPeriods()).toEqual([]);
  });
});

describe('ReflectionService — recovery', () => {
  it('fails generations a previous process left running', async () => {
    const h = harness();
    h.repo.createGenerating({
      id: 'stuck',
      period: week42,
      coveredUntil: week42.end,
      trigger: 'scheduled',
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
      promptVersion: REFLECTION_PROMPT_VERSION,
      model: 'test-model',
      nowIso: iso(18),
    });
    expect((await h.service.getView('week', iso(14))).generation.state).toBe('generating');
    expect(h.service.recoverInterrupted()).toBe(1);
    expect(h.repo.getReportById('stuck')).toMatchObject({ status: 'failed', errorCategory: 'internal' });
  });
});
