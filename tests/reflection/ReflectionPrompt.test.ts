import { describe, it, expect } from 'vitest';
import { buildComparisons, computeMetrics } from '../../src/reflection/ReflectionMetrics';
import {
  DEFAULT_REFLECTION_CONFIG,
  type PeriodDataset,
  type ReflectionActivity,
  type ReflectionReport,
} from '../../src/reflection/ReflectionModels';
import { periodContaining, shiftPeriod } from '../../src/reflection/ReflectionPeriods';
import { prepareReflection, summarizeFeedback, type PreprocessContext } from '../../src/reflection/ReflectionPreprocessor';
import {
  REFLECTION_PROMPT_VERSION,
  buildReflectionPrompt,
  buildReflectionResponseSchema,
  buildReflectionRetryFeedback,
  buildReflectionSystemInstruction,
} from '../../src/reflection/ReflectionPrompt';
import { TAXONOMY, iso, local, priority, workday } from './helpers';

const p1 = priority('p1', 'Launch Project X', { activeFrom: iso(1) });
const period = periodContaining('week', local(14));
const linked = (list: ReflectionActivity[]) => list.map((a) => (a.thread === 'Project X' ? { ...a, priorityId: 'p1' } : a));

function dataset(overrides: Partial<PeriodDataset> = {}): PeriodDataset {
  const activities = linked([12, 13, 14].flatMap(workday));
  const core = computeMetrics({ period, activities, priorities: [p1], taxonomy: TAXONOMY, focus: [] });
  const previous = computeMetrics({ period, activities: linked([5, 6].flatMap(workday)), priorities: [p1], taxonomy: TAXONOMY, focus: [] });
  return {
    period,
    coveredUntil: period.end,
    isPartial: false,
    activities,
    priorities: [p1],
    metrics: {
      ...core,
      ...buildComparisons({
        current: core,
        previous,
        previousName: 'previous week',
        baselines: [],
        baselineUnit: 'week',
        minBaselinePeriods: 3,
        mode: 'full',
      }),
    },
    sufficiency: { enough: true, reason: null, message: null },
    notes: ['Not enough history yet for a personal baseline.'],
    hasPreviousComparison: true,
    baselinePeriodCount: 0,
    ...overrides,
  };
}

function context(overrides: Partial<PreprocessContext> = {}): PreprocessContext {
  return {
    userContext: {
      roles: ['Software Developer'],
      description: 'I build Project X.',
      currentWork: ['Project X'],
      priorities: ['Launch Project X'],
      interests: ['Gaming'],
      interpretationNotes: 'Gaming is a hobby.',
    },
    taxonomy: TAXONOMY,
    config: DEFAULT_REFLECTION_CONFIG,
    nowIso: iso(19, '00:05'),
    previousReport: null,
    history: [],
    feedback: [],
    learnedPatterns: [],
    ...overrides,
  };
}

function report(weeksBack: number, signature: string, title: string): ReflectionReport {
  const p = shiftPeriod(period, -weeksBack);
  return {
    id: `r-${weeksBack}`,
    period: p,
    coveredUntil: p.end,
    status: 'fresh',
    trigger: 'scheduled',
    headline: `Headline of week -${weeksBack}`,
    carryForward: { text: 'Protect a morning block for Project X.', sourceMetricKeys: [], sourceActivityIds: [], evidence: [] },
    insights: [
      {
        id: `i-${weeksBack}`,
        type: 'fragmentation',
        title,
        observation: 'Afternoon switching was high.',
        interpretation: 'Afternoons were fragmented.',
        relevance: null,
        confidence: 0.8,
        evidence: [],
        sourceActivityIds: [],
        sourceMetricKeys: ['daypart.afternoon.switches'],
        claimSignature: signature,
        identityKey: signature,
        subjectKey: null,
        thread: null,
        priorityId: null,
        continuity: 'new',
        magnitude: null,
        createdAt: p.end,
        feedback: null,
      },
    ],
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    promptVersion: REFLECTION_PROMPT_VERSION,
    model: 'test-model',
    attemptCount: 1,
    dataSnapshot: null,
    metricsSnapshot: null,
    error: null,
    errorCategory: null,
    staleReason: null,
    staleAt: null,
    needsVerification: false,
    generatedAt: p.end,
    createdAt: p.end,
    updatedAt: p.end,
  };
}

describe('prepareReflection', () => {
  it('builds a compact dataset: aliases, names, local times — no raw events', () => {
    const { input, activityByRef, snapshot } = prepareReflection(dataset(), context());
    expect(input.schemaVersion).toBe(3);
    expect(input.period).toMatchObject({ type: 'week', start: period.start, end: period.end, isPartial: false });
    expect(input.period.label).toBe('Last week (Oct 12 – Oct 18)');

    expect(input.activities[0]).toEqual({
      ref: 'a1',
      start: 'Mon, Oct 12, 9:00 AM',
      end: 'Mon, Oct 12, 10:20 AM',
      minutes: 80,
      title: 'Implement Project X sync engine',
      summary: null,
      context: 'Coding',
      area: 'Work',
      intent: 'Create',
      quality: 'Focused',
      thread: 'Project X',
      priorityId: 'p1',
      source: 'ai',
    });
    expect(activityByRef.get('a1')!.startedAt).toBe(iso(12, '09:00'));
    // Nothing resembling raw tracking data is part of the input or the snapshot.
    const serialized = JSON.stringify({ input, snapshot });
    for (const field of ['eventIds', 'payload', 'watcher', '"url"']) expect(serialized).not.toContain(field);
  });

  it('sends the user context and time-aware priorities', () => {
    const { input } = prepareReflection(dataset(), context());
    expect(input.userContext).toMatchObject({ roles: ['Software Developer'], additionalContext: 'Gaming is a hobby.' });
    expect(input.currentPriorities).toEqual([{ id: 'p1', text: 'Launch Project X', statedOn: 'Oct 1', possiblyStale: false }]);

    const stale = prepareReflection(
      dataset({ priorities: [{ ...p1, lastConfirmedAt: iso(-90) }] }),
      context(),
    ).input.currentPriorities[0];
    expect(stale.possiblyStale).toBe(true);
  });

  it('separates measurements from comparisons and groups each comparison on one line', () => {
    const { input } = prepareReflection(dataset(), context());
    expect(input.metrics.find((m) => m.key === 'time.tracked_minutes')).toEqual({
      key: 'time.tracked_minutes',
      label: 'Total tracked time',
      value: '13h 36m',
    });
    expect(input.metrics.some((m) => m.key.startsWith('prev.'))).toBe(false);
    expect(input.comparisons.find((c) => c.key === 'time.tracked_minutes')).toEqual({
      key: 'time.tracked_minutes',
      label: 'Total tracked time',
      now: '13h 36m',
      previous: '9h 4m',
      change: '+4h 32m (+50%)',
    });
    // A label that itself contains a dash keeps its full measure name.
    expect(input.comparisons.find((c) => c.key === 'daypart.morning.minutes')!.label).toBe('Tracked time — Morning (5 AM–12 PM)');
    expect(input.notes).toEqual(['Not enough history yet for a personal baseline.']);
  });

  it('caps the activity list but always keeps activities a metric points at', () => {
    const config = { ...DEFAULT_REFLECTION_CONFIG, maxPromptActivities: { day: 60, week: 4, month: 45, year: 45 } };
    const data = dataset();
    const { input, activityByRef } = prepareReflection(data, context({ config }));
    expect(input.activities).toHaveLength(4);
    const longest = data.metrics['block.longest_minutes'].activityIds![0];
    expect([...activityByRef.values()].some((a) => a.id === longest)).toBe(true);
    // Chronological, with consecutive aliases.
    expect(input.activities.map((a) => a.ref)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('carries the previous reflection and recently surfaced claims for novelty', () => {
    const signature = 'period|fragmentation|daypart.afternoon.switches';
    const rows = (r: ReflectionReport) =>
      r.insights.map((i) => ({
        period: r.period,
        reportId: r.id,
        insightId: i.id,
        type: i.type,
        title: i.title,
        identityKey: i.identityKey,
        subjectKey: i.subjectKey,
        thread: i.thread,
        priorityId: i.priorityId,
        continuity: i.continuity,
        magnitude: i.magnitude,
        feedback: null,
      }));
    const { input, history, snapshot } = prepareReflection(
      dataset(),
      context({
        previousReport: report(1, signature, 'Afternoons were fragmented'),
        history: [report(1, signature, 'Afternoons were fragmented'), report(2, signature, 'Afternoon switching'), report(3, 'period|advancing|x', 'X')].flatMap(rows),
      }),
    );
    expect(input.previousReflection).toEqual({
      periodLabel: 'Oct 5 – Oct 11',
      headline: 'Headline of week -1',
      carryForward: 'Protect a morning block for Project X.',
      insights: [{ type: 'fragmentation', title: 'Afternoons were fragmented', observation: 'Afternoon switching was high.' }],
    });
    // What continuity is judged against: each earlier insight, with how far back it was said.
    expect(history.filter((h) => h.identityKey === signature).map((h) => h.periodsBack)).toEqual([1, 2]);
    expect(input.previouslySurfaced[0]).toEqual({
      type: 'fragmentation',
      title: 'Afternoons were fragmented', // latest wording
      signature,
      timesSurfaced: 2,
    });
    expect(snapshot.previousReportId).toBe('r-1');
  });

  it('snapshots what the report was written from', () => {
    const { snapshot } = prepareReflection(dataset(), context());
    expect(snapshot.period).toEqual(period);
    expect(snapshot.priorities).toEqual([{ id: 'p1', text: 'Launch Project X', activeFrom: iso(1), possiblyStale: false }]);
    expect(snapshot.activePriorityIds).toEqual(['p1']);
    expect(snapshot.userContextIncluded).toBe(true);
    expect(snapshot.activities[0]).toMatchObject({ title: 'Implement Project X sync engine', minutes: 80, thread: 'Project X', priorityId: 'p1' });
  });

  it('summarizes feedback by insight type', () => {
    expect(
      summarizeFeedback([
        { insightId: 'a', insightType: 'recurring_behavior', feedbackType: 'useful', createdAt: iso(1) },
        { insightId: 'b', insightType: 'recurring_behavior', feedbackType: 'useful', createdAt: iso(2) },
        { insightId: 'c', insightType: 'fragmentation', feedbackType: 'inaccurate', createdAt: iso(3) },
      ]),
    ).toEqual(['fragmentation: 0 useful, 0 not useful, 1 marked inaccurate', 'recurring_behavior: 2 useful, 0 not useful, 0 marked inaccurate']);
  });
});

describe('reflection prompt', () => {
  it('establishes the non-negotiable philosophy in the system instruction', () => {
    const system = buildReflectionSystemInstruction();
    for (const phrase of [
      'You are Reflect, a personal activity reflection system.',
      'Do not judge the user.',
      'Do not assume leisure is bad.',
      'Do not infer psychology, motivation, mood, energy, health',
      'Do not invent causes.',
      'Use the user\'s own stated priorities as the reference frame',
      'Prefer evidence over advice.',
      'Do not repeat the same insight in different wording.',
      'The goal is to say what matters.',
      'You never calculate',
      'At most ONE carry-forward',
    ]) {
      expect(system).toContain(phrase);
    }
  });

  it('gives each period type its own purpose', () => {
    const base = prepareReflection(dataset(), context()).input;
    const promptFor = (type: 'day' | 'week' | 'month' | 'year') => buildReflectionPrompt({ ...base, period: { ...base.period, type } });
    expect(promptFor('day')).toContain('what actually happened today?');
    expect(promptFor('week')).toContain('what pattern is emerging?');
    expect(promptFor('month')).toContain('am I moving in the direction I care about?');
    expect(promptFor('year')).toContain('what trajectory am I actually building?');
  });

  it('lays out the evidence blocks', () => {
    const { input } = prepareReflection(dataset(), context({ learnedPatterns: ['VS Code + “GameTheory” is usually Personal · Create'] }));
    const prompt = buildReflectionPrompt(input);
    expect(prompt).toContain(`{"periodType":"week","periodStart":"${period.start}","periodEnd":"${period.end}"}`);
    expect(prompt).toContain('USER CONTEXT (provided by the user about themselves)');
    expect(prompt).toContain('{"id":"p1","text":"Launch Project X","statedOn":"Oct 1","possiblyStale":false}');
    expect(prompt).toContain('{"key":"time.tracked_minutes","label":"Total tracked time","value":"13h 36m"}');
    expect(prompt).toContain('COMPARISONS (cite a row by its key — that cites every value in the row; prev.<key>, delta.<key>, baseline.<key> or weekday.<key> cite one of them)');
    // Nothing was measured as a meaningful change: the model is told so, in as many words.
    expect(prompt).toContain('WHAT CHANGED VERSUS HISTORY\nNothing passed the test');
    expect(prompt).toContain('DATA NOTES (limits of what is known)\n- Not enough history yet for a personal baseline.');
    expect(prompt).toContain('LEARNED PATTERNS');
    expect(prompt).toContain('PREVIOUS REFLECTION\nNone.');
    expect(prompt).toContain('At most 5 insights. Fewer is fine; zero is fine.');
    // The user's priorities appear once, as time-aware priorities — not again as free text.
    expect(prompt).not.toContain('What matters most right now');
  });

  it('states absence explicitly instead of leaving it to be guessed', () => {
    const data = dataset({ priorities: [] });
    const core = Object.fromEntries(Object.entries(data.metrics).filter(([, m]) => m.group !== 'comparison'));
    const { input } = prepareReflection({ ...data, metrics: core }, context({ userContext: null }));
    const prompt = buildReflectionPrompt(input);
    expect(prompt).toContain('USER CONTEXT\nNot provided. Assume nothing about the user.');
    expect(prompt).toContain('CURRENT PRIORITIES\nNone stated.');
    expect(prompt).toContain('COMPARISONS\nNone available. Do not compare this period with any other.');
  });

  it('tells the model when the period is still running', () => {
    const { input } = prepareReflection(dataset({ isPartial: true, coveredUntil: iso(14, '15:00') }), context({ nowIso: iso(14, '15:00') }));
    expect(buildReflectionPrompt(input)).toContain('still in progress; the data covers it up to Wed, Oct 14, 3:00 PM');
  });

  it('constrains the response schema to the supplied priorities and insight types', () => {
    const schema = buildReflectionResponseSchema(['p1']) as any;
    const insight = schema.properties.insights.items;
    expect(insight.properties.type.enum).toContain('priority_alignment');
    expect(insight.properties.type.enum).toHaveLength(9);
    expect(insight.properties.priorityIds.items.enum).toEqual(['p1']);
    expect(schema.required).toEqual(['schemaVersion', 'periodType', 'periodStart', 'periodEnd', 'headline', 'narrative', 'insights', 'carryForward']);
    // Coaching is only part of the contract when a coach joins the request.
    expect(schema.properties.coach).toBeUndefined();
    // No canonical ids are requested from the model.
    expect(JSON.stringify(schema)).not.toContain('"id"');
  });

  it('feeds validation problems back on retry', () => {
    const feedback = buildReflectionRetryFeedback(['insight 1: metric "x" does not exist']);
    expect(feedback).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
    expect(feedback).toContain('- insight 1: metric "x" does not exist');
  });
});
