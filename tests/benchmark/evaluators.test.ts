import { describe, it, expect } from 'vitest';
import type { CoachAction } from '../../src/coach/CoachModels';
import type { Metric, ReflectionReport } from '../../src/reflection/ReflectionModels';
import { scoreClassification, type ClassificationSample, type PredictedLabels } from './evaluators/classification';
import { evaluateCoach } from './evaluators/coach';
import { assessCoach, opportunityOf, stateOf, summarizeCoachDimensions } from './evaluators/coachDimensions';
import { countVerdicts, evaluateDay, summarize } from './evaluators/index';
import { intersectionLength, normalize, temporalIou, totalLength } from './evaluators/intervals';
import { buildLeakDetector } from './evaluators/leakage';
import { evaluateReflection, progressLevel } from './evaluators/reflection';
import { boundariesOf, evaluateSegmentation, segmentFromEvents, type TimedEvent } from './evaluators/segmentation';
import { resolveMapping } from './evaluators/taxonomyMapping';
import { coverage, stem, streamOfText, verdictFromCoverage } from './evaluators/text';
import type { CapturedBlock, CapturedDay, CapturedTaxonomy } from './runner/capture';
import type { EvaluationOnly, EvaluationOnlyDay, ReflectInput } from './runner/dataset';

/**
 * The evaluators are the benchmark's measuring instruments, so they are
 * tested like one: on small hand-built cases whose right answer is obvious.
 * Pure — no database, no Gemini, no dataset files.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-09-01T09:00:00+05:30');
const at = (minutes: number) => T0 + minutes * MIN;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();
const MATCHING = { iouThreshold: 0.5, boundaryToleranceMs: 60_000, minOverlapMs: 60_000 };
const SEMANTIC = { passCoverage: 0.6, partialCoverage: 0.35 };

/** Three back-to-back 30-minute events, a gap, then two more. */
const EVENTS: TimedEvent[] = [
  { id: 1, startMs: at(0), endMs: at(30) },
  { id: 2, startMs: at(30), endMs: at(60) },
  { id: 3, startMs: at(60), endMs: at(90) },
  { id: 4, startMs: at(150), endMs: at(180) },
  { id: 5, startMs: at(180), endMs: at(210) },
];
const byId = new Map(EVENTS.map((e) => [e.id, e]));
const seg = (id: string, ids: number[]) => segmentFromEvents(id, ids, byId);

describe('intervals', () => {
  it('merges, measures and intersects interval sets', () => {
    expect(normalize([[10, 20], [0, 5], [5, 12], [30, 30]])).toEqual([[0, 20]]);
    expect(totalLength([[0, 10], [5, 15], [20, 25]])).toBe(20);
    expect(intersectionLength([[0, 10], [20, 30]], [[5, 25]])).toBe(10);
    expect(temporalIou([[0, 10]], [[5, 15]])).toBeCloseTo(5 / 15);
    expect(temporalIou([], [])).toBe(0);
  });
});

describe('segmentation metrics', () => {
  it('scores a perfect reconstruction perfectly', () => {
    const gt = [seg('g1', [1, 2, 3]), seg('g2', [4, 5])];
    const { metrics, matches } = evaluateSegmentation(gt, [seg('p1', [1, 2, 3]), seg('p2', [4, 5])], EVENTS, MATCHING);
    expect(matches.map((m) => [m.groundTruthId, m.predictedId, m.iou])).toEqual([['g1', 'p1', 1], ['g2', 'p2', 1]]);
    expect(metrics).toMatchObject({
      groundTruthCount: 2,
      predictedCount: 2,
      matchedCount: 2,
      precision: 1,
      recall: 1,
      f1: 1,
      meanIouMatched: 1,
      meanBestIou: 1,
      durationWeightedIou: 1,
      groundTruthCoverage: 1,
      overSegmentationRatio: 1,
      underSegmentationRatio: 1,
      boundaryPrecision: 1,
      boundaryRecall: 1,
      boundaryF1: 1,
      boundaryMaeMs: 0,
      durationAbsErrorMs: 0,
      durationRelError: 0,
    });
  });

  it('never looks at titles: only time and event ownership decide a match', () => {
    const gt = [seg('Client authentication bug', [1, 2, 3])];
    const pred = [seg('completely different wording', [1, 2, 3])];
    expect(evaluateSegmentation(gt, pred, EVENTS, MATCHING).metrics.f1).toBe(1);
  });

  it('measures under-segmentation when one block swallows two activities', () => {
    const gt = [seg('g1', [1, 2]), seg('g2', [3])];
    const { metrics, unmatchedGroundTruth } = evaluateSegmentation(gt, [seg('p1', [1, 2, 3])], EVENTS.slice(0, 3), MATCHING);
    // g1 vs p1: 60 of 90 minutes → IoU 0.667 (match). g2 vs p1: 30 of 90 → 0.333 (no match).
    expect(metrics.matchedCount).toBe(1);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.meanIouMatched).toBeCloseTo(2 / 3);
    expect(metrics.meanBestIou).toBeCloseTo((2 / 3 + 1 / 3) / 2);
    expect(metrics.underSegmentationRatio).toBe(2);
    expect(metrics.underSegmentedShare).toBe(1);
    expect(metrics.overSegmentationRatio).toBe(1);
    expect(metrics.groundTruthCoverage).toBe(1);
    // The boundary between g1 and g2 was missed.
    expect(metrics).toMatchObject({ groundTruthBoundaries: 1, predictedBoundaries: 0, boundaryRecall: 0, boundaryMaeMs: null });
    expect(unmatchedGroundTruth).toEqual(['g2']);
    // Matched pair: 90 predicted vs 60 true minutes.
    expect(metrics.durationAbsErrorMs).toBe(30 * MIN);
    expect(metrics.durationRelError).toBeCloseTo(0.5);
  });

  it('measures over-segmentation when one activity is cut in two', () => {
    const gt = [seg('g1', [1, 2, 3])];
    const { metrics, unmatchedPredicted } = evaluateSegmentation(gt, [seg('p1', [1]), seg('p2', [2, 3])], EVENTS.slice(0, 3), MATCHING);
    expect(metrics.matchedCount).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(1);
    expect(metrics.overSegmentationRatio).toBe(2);
    expect(metrics.overSegmentedShare).toBe(1);
    expect(metrics).toMatchObject({ groundTruthBoundaries: 0, predictedBoundaries: 1, boundaryPrecision: 0, boundaryRecall: 1 });
    expect(unmatchedPredicted).toEqual(['p1']);
  });

  it('handles an activity interleaved with a break (a break inside a work block)', () => {
    // Ground truth: work = events 1 and 3, break = event 2.
    const gt = [seg('work', [1, 3]), seg('break', [2])];
    expect(gt[0].intervals).toEqual([[at(0), at(30)], [at(60), at(90)]]);
    const merged = evaluateSegmentation(gt, [seg('p', [1, 2, 3])], EVENTS.slice(0, 3), MATCHING).metrics;
    expect(merged.matchedCount).toBe(1); // work: 60 of 90
    expect(merged.groundTruthBoundaries).toBe(2);
    expect(merged.boundaryRecall).toBe(0);
    const exact = evaluateSegmentation(gt, [seg('a', [1]), seg('b', [2]), seg('c', [3])], EVENTS.slice(0, 3), MATCHING).metrics;
    // The break is found exactly; the work block is split in two halves of IoU 0.5 each (one matches).
    expect(exact.matchedCount).toBe(2);
    expect(exact.boundaryRecall).toBe(1);
  });

  it('honours the configurable IoU threshold', () => {
    const gt = [seg('g1', [1, 2]), seg('g2', [3])];
    const pred = [seg('p1', [1, 2, 3])];
    expect(evaluateSegmentation(gt, pred, EVENTS.slice(0, 3), { ...MATCHING, iouThreshold: 0.7 }).metrics.matchedCount).toBe(0);
    expect(evaluateSegmentation(gt, pred, EVENTS.slice(0, 3), { ...MATCHING, iouThreshold: 0.3 }).metrics.matchedCount).toBe(1); // one-to-one
  });

  it('places boundaries where consecutive events change owner, and measures their distance', () => {
    expect(boundariesOf([seg('a', [1, 2]), seg('b', [3, 4, 5])], EVENTS)).toEqual([at(60)]);
    const gt = [seg('g1', [1, 2]), seg('g2', [3, 4, 5])];
    const { metrics } = evaluateSegmentation(gt, [seg('p1', [1]), seg('p2', [2, 3, 4, 5])], EVENTS, MATCHING);
    // Predicted boundary at 09:30, true boundary at 10:00: 30 minutes off, outside the 60s tolerance.
    expect(metrics).toMatchObject({ matchedBoundaries: 0, boundaryMaeMs: 30 * MIN });
    expect(evaluateSegmentation(gt, [seg('p1', [1]), seg('p2', [2, 3, 4, 5])], EVENTS, { ...MATCHING, boundaryToleranceMs: 31 * MIN }).metrics.matchedBoundaries).toBe(1);
  });

  it('counts a missing predicted block as lost coverage', () => {
    const { metrics } = evaluateSegmentation([seg('g1', [1, 2]), seg('g2', [4, 5])], [seg('p1', [1, 2])], EVENTS, MATCHING);
    expect(metrics.groundTruthCoverage).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
  });
});

// ── Classification ──────────────────────────────────────────────────────────

const TAXONOMY: CapturedTaxonomy = {
  contexts: [{ id: 'coding', name: 'Coding' }, { id: 'browsing', name: 'Browsing' }],
  areas: [{ id: 'area_work', name: 'Work' }, { id: 'area_personal', name: 'Personal' }, { id: 'area_leisure', name: 'Leisure' }],
  intents: ['Create', 'Learn', 'Research', 'Communicate', 'Plan', 'Organize', 'Consume', 'Manage'].map((name) => ({ id: `intent_${name.toLowerCase()}`, name })),
  qualities: [
    { id: 'quality_deep_work', name: 'Deep Work' },
    { id: 'quality_focused', name: 'Focused' },
    { id: 'quality_routine', name: 'Routine' },
    { id: 'quality_distracting', name: 'Distracting' },
    { id: 'quality_break_idle', name: 'Break / Idle' },
  ],
};
const PRIORITIES = [
  { id: 'pr-saas', text: 'Ship the SaaS MVP', status: 'active' as const },
  { id: 'pr-client', text: 'Complete existing client work', status: 'active' as const },
  { id: 'pr-leads', text: 'Generate new freelance leads', status: 'active' as const },
];
const USED = { context: ['Work', 'Leisure'], area: ['Own SaaS', 'Freelance', 'Plan', null], intent: ['Create', 'Review', 'Consume'], quality: ['Focused', 'Routine', 'Break-Idle'] };
const mapping = () => resolveMapping({ areas: TAXONOMY.areas, intents: TAXONOMY.intents, qualities: TAXONOMY.qualities, priorities: PRIORITIES }, USED);

const predicted = (over: Partial<Omit<PredictedLabels, 'names'>> = {}): PredictedLabels => {
  const p = { areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused', priorityId: 'pr-saas', contextName: 'Coding', ...over };
  return { ...p, names: { area: p.areaId, intent: p.intentId, quality: p.qualityId, priority: p.priorityId } };
};

describe('classification', () => {
  it('resolves the mapping against the live taxonomy and reports what it cannot resolve', () => {
    const resolved = mapping();
    expect(resolved.issues).toEqual([]);
    expect(resolved.dimensions.context.target).toBe('area');
    expect(resolved.dimensions.context.labels.get('Work')).toMatchObject({ kind: 'exact', acceptIds: ['area_work'] });
    expect(resolved.dimensions.quality.labels.get('Focused')).toMatchObject({ kind: 'ambiguous', acceptIds: ['quality_focused', 'quality_deep_work'] });
    expect(resolved.dimensions.area.labels.get('Freelance')!.acceptIds).toEqual(['pr-client', 'pr-leads']);
    expect(resolved.dimensions.area.labels.get('Plan')!.kind).toBe('unmappable');

    const missing = resolveMapping({ areas: TAXONOMY.areas, intents: TAXONOMY.intents.filter((i) => i.name !== 'Create'), qualities: TAXONOMY.qualities, priorities: [] }, { ...USED, intent: ['Create', 'Daydream'] });
    expect(missing.issues.join('\n')).toMatch(/intent="Create" maps to Reflect intent "Create", which does not exist/);
    expect(missing.issues.join('\n')).toMatch(/intent="Daydream" has no entry/);
    expect(missing.dimensions.intent.labels.get('Create')!.kind).toBe('unmappable');
  });

  it('scores each dimension independently, strict and lenient', () => {
    const samples: ClassificationSample[] = [
      // Everything right.
      { groundTruth: { context: 'Work', area: 'Own SaaS', intent: 'Create', quality: 'Focused' }, predicted: predicted(), weight: 1 },
      // "Deep Work" is accepted for Focused (ambiguous → lenient only); intent wrong.
      { groundTruth: { context: 'Work', area: 'Freelance', intent: 'Create', quality: 'Focused' }, predicted: predicted({ qualityId: 'quality_deep_work', intentId: 'intent_plan', priorityId: 'pr-leads' }), weight: 1 },
      // Leisure labelled as work and "distracting"; a priority was linked where none should be.
      { groundTruth: { context: 'Leisure', area: null, intent: 'Consume', quality: 'Break-Idle' }, predicted: predicted({ intentId: 'intent_consume', qualityId: 'quality_distracting' }), weight: 1 },
      // "Plan" area is unmappable; "Review" intent is judged against its accept-set.
      { groundTruth: { context: 'Work', area: 'Plan', intent: 'Review', quality: 'Routine' }, predicted: predicted({ intentId: 'intent_research', qualityId: 'quality_routine', priorityId: null }), weight: 1 },
    ];
    const scores = scoreClassification(samples, mapping());
    expect(scores.context).toMatchObject({ evaluated: 4, correct: 3, accuracy: 0.75, strictEvaluated: 4, strictAccuracy: 0.75 });
    expect(scores.area).toMatchObject({ evaluated: 3, correct: 2, unmappable: 1, strictEvaluated: 0, strictAccuracy: null });
    expect(scores.intent).toMatchObject({ evaluated: 4, correct: 3, strictEvaluated: 3, strictCorrect: 2, ambiguous: 1 });
    expect(scores.quality).toMatchObject({ evaluated: 4, correct: 3, strictEvaluated: 2, strictCorrect: 1, ambiguous: 2 });
    expect(scores.full).toMatchObject({ evaluated: 4, correct: 2, accuracy: 0.5 });
    expect(scores.confusion.quality['Break-Idle']).toEqual({ quality_distracting: 1 });
  });

  it('counts time with no predicted block as wrong, never as a match on "no value"', () => {
    const scores = scoreClassification([{ groundTruth: { context: 'Leisure', area: null, intent: 'Consume', quality: 'Break-Idle' }, predicted: null, weight: 10 }], mapping());
    expect(scores.area).toMatchObject({ evaluated: 10, correct: 0 });
    expect(scores.full.accuracy).toBe(0);
  });
});

// ── Text ────────────────────────────────────────────────────────────────────

describe('meaning without wording', () => {
  it('stems lightly', () => {
    expect([stem('planning'), stem('planned'), stem('plans')]).toEqual(['plan', 'plan', 'plan']);
    expect(stem('fragmented')).toBe(stem('fragment'));
  });

  it('accepts the same idea in different words', () => {
    const c = coverage(
      'Client work displaced planned product work.',
      'An urgent client issue consumed time that had initially been available for product development.',
    );
    expect(verdictFromCoverage(c.score, SEMANTIC)).toBe('PASS');
  });

  it('rejects an unrelated statement', () => {
    const c = coverage('Client work displaced planned product work.', 'You watched a PostgreSQL tutorial in the evening and took notes.');
    expect(verdictFromCoverage(c.score, SEMANTIC)).toBe('FAIL');
  });

  it('tells the two work streams apart', () => {
    expect(streamOfText('Protect a longer uninterrupted block for SaaS development tomorrow.')).toBe('Own SaaS');
    expect(streamOfText('Send the revised proposal to the prospect and ask for a decision.')).toBe('Freelance');
    expect(streamOfText('Take a walk.')).toBeNull();
  });

  it('reads the progress level of an assessment', () => {
    expect(progressLevel('no substantial progress observed today')).toBe(0);
    expect(progressLevel('maintenance only')).toBe(1);
    expect(progressLevel('some progress')).toBe(2);
    expect(progressLevel('meaningfully progressed')).toBe(3);
    expect(progressLevel('very strong progress / moved into real beta testing')).toBe(4);
    expect(progressLevel('strong progress but scope expanded')).toBe(4);
    expect(progressLevel('limited progress; work was mostly deferred because of client demands')).toBe(1);
    expect(progressLevel('who knows')).toBeNull();
  });
});

// ── Reflection + Coach, on a hand-built day ─────────────────────────────────

const metric = (key: string, value: number, extra: Partial<Metric> = {}): Metric => ({ key, label: key, value, unit: 'minutes', display: `${value}m`, group: 'time', ...extra });

function block(id: string, eventIds: number[], over: Partial<CapturedBlock> = {}): CapturedBlock {
  const events = eventIds.map((e) => byId.get(e)!);
  return {
    id,
    kind: 'ai',
    startedAt: new Date(events[0].startMs).toISOString(),
    endedAt: new Date(events[events.length - 1].endMs).toISOString(),
    activeMs: events.reduce((s, e) => s + (e.endMs - e.startMs), 0),
    envelopeMs: events[events.length - 1].endMs - events[0].startMs,
    eventIds,
    title: 'Implement SaaS billing',
    summary: null,
    classification: { contextId: 'coding', context: 'Coding', areaId: 'area_work', area: 'Work', intentId: 'intent_create', intent: 'Create', qualityId: 'quality_focused', quality: 'Focused', source: 'ai' },
    confidence: 0.8,
    uncertainty: [],
    thread: 'SaaS',
    priorityId: 'pr-saas',
    ...over,
  };
}

function action(over: Partial<CoachAction> = {}): CoachAction {
  return {
    id: 'act-1',
    source: 'daily',
    reportId: 'r1',
    originDayKey: '2026-09-01',
    parentActionId: null,
    title: 'Protect a 90-minute block for the SaaS billing work tomorrow morning',
    description: null,
    rationale: 'Client work took the afternoon; the SaaS billing work stopped at 90m.',
    actionType: 'protect_priority',
    daypart: 'morning',
    targetStart: iso(24 * 60),
    targetEnd: iso(27 * 60),
    focusMinutes: 90,
    focusTask: 'SaaS billing',
    priorityId: 'pr-saas',
    thread: 'SaaS',
    strategyKey: 'protect_priority|morning|long',
    targetKey: 'p:pr-saas',
    evidence: [{ kind: 'metric', metricKey: 'priority.pr-saas.minutes', label: 'Time linked to the priority', value: '90m' }],
    sourceMetricKeys: ['priority.pr-saas.minutes'],
    sourceActivityIds: ['b1'],
    confidence: 0.7,
    status: 'suggested',
    execution: null,
    executionSource: null,
    outcome: null,
    reasonCode: null,
    note: null,
    observation: null,
    linkedFocusSessionId: null,
    snoozedUntil: null,
    snoozeCount: 0,
    userEdited: false,
    createdAt: iso(780),
    acceptedAt: null,
    rejectedAt: null,
    executedAt: null,
    outcomeAt: null,
    closedAt: null,
    updatedAt: iso(780),
    ...over,
  };
}

function report(over: Partial<ReflectionReport> = {}): ReflectionReport {
  const period = { type: 'day' as const, key: '2026-09-01', start: '2026-08-31T18:30:00.000Z', end: '2026-09-01T18:30:00.000Z' };
  return {
    id: 'r1',
    period,
    coveredUntil: iso(780),
    status: 'fresh',
    trigger: 'scheduled',
    headline: 'SaaS billing took the morning; a client issue took the afternoon.',
    narrative: 'You started with the SaaS billing work. After a gap, an urgent client issue took the rest of the tracked time.',
    carryForward: null,
    coach: { actionIds: ['act-1'], followups: [], uncertainty: ['Reflect cannot see what happened while nothing was tracked.'], noActionReason: null, question: null },
    insights: [
      {
        id: 'i1',
        type: 'priority_alignment',
        title: 'Client work displaced the planned product work',
        observation: '90m went toward the SaaS; 60m went to the client issue.',
        interpretation: 'The client issue consumed the time that was available for product development.',
        relevance: null,
        suggestedAction: null,
        confidence: 0.8,
        evidence: [{ kind: 'metric', metricKey: 'priority.pr-saas.minutes', label: 'Time linked', value: '90m' }],
        sourceActivityIds: ['b1'],
        sourceMetricKeys: ['priority.pr-saas.minutes'],
        claimSignature: 'sig',
        createdAt: iso(780),
        feedback: null,
      },
    ],
    inputSchemaVersion: 2,
    outputSchemaVersion: 2,
    promptVersion: 'reflect-reflection-v2',
    model: 'test',
    attemptCount: 1,
    dataSnapshot: {
      period,
      coveredUntil: iso(780),
      isPartial: true,
      priorities: [],
      activePriorityIds: [],
      activities: [{ id: 'b1', startedAt: iso(0), endedAt: iso(90), minutes: 90, title: 'Implement SaaS billing', thread: 'SaaS', priorityId: 'pr-saas' }],
      notes: [],
      userContextIncluded: true,
      previousReportId: null,
    },
    metricsSnapshot: {
      'time.tracked_minutes': metric('time.tracked_minutes', 150),
      'time.focused_minutes': metric('time.focused_minutes', 90),
      'priority.pr-saas.minutes': metric('priority.pr-saas.minutes', 90),
      'priority.pr-client.minutes': metric('priority.pr-client.minutes', 60),
      'priority.pr-leads.minutes': metric('priority.pr-leads.minutes', 0),
    },
    error: null,
    errorCategory: null,
    staleReason: null,
    staleAt: null,
    needsVerification: false,
    generatedAt: iso(780),
    createdAt: iso(780),
    updatedAt: iso(780),
    ...over,
  };
}

function captured(over: { report?: ReflectionReport | null; actions?: CoachAction[]; timeline?: CapturedBlock[]; earlierActions?: CoachAction[] } = {}): CapturedDay {
  const timeline = over.timeline ?? [
    block('b1', [1, 2, 3]),
    block('b2', [4, 5], { title: 'Fix client authentication bug', thread: 'Client project', priorityId: 'pr-client' }),
  ];
  return {
    dayNumber: 1,
    date: '2026-09-01',
    period: { type: 'day', key: '2026-09-01', start: '2026-08-31T18:30:00.000Z', end: '2026-09-01T18:30:00.000Z' },
    processedAt: iso(780),
    events: EVENTS.map((e) => ({ datasetId: e.id, eventId: e.id + 100, startedAt: new Date(e.startMs).toISOString(), endedAt: new Date(e.endMs).toISOString() })),
    priorities: PRIORITIES,
    deterministicSessions: [block('s-1-5', [1, 2, 3, 4, 5], { kind: 'deterministic', priorityId: null, thread: null })].map((b) => ({ ...b, eventIds: b.eventIds.map((id) => id + 100) })),
    timeline: timeline.map((b) => ({ ...b, eventIds: b.eventIds.map((id) => id + 100) })),
    intelligence: { runs: [], eventsWithoutAiActivity: [] },
    reflection: { report: over.report === undefined ? report() : over.report, latestAttempt: null, otherReports: [] },
    coach: {
      actions: over.actions ?? [action()],
      earlierActions: over.earlierActions ?? [],
      lifecycleEvents: [],
      memoriesAdded: [],
      memoriesActive: [],
      messages: [],
    },
  };
}

const ANSWER: EvaluationOnlyDay = {
  dayNumber: 1,
  date: '2026-09-01',
  utcOffset: '+05:30',
  dayType: 'normal_mixed_workday',
  circumstances: [],
  laptopUsage: { first_seen: '09:00', last_seen: '12:30', approx_active_hours: 2.5, longest_unobserved_gap_minutes: 60 },
  events: EVENTS.map((e) => ({ datasetId: e.id, startMs: e.startMs, endMs: e.endMs, app: e.id === 2 ? 'YouTube' : 'VS Code', title: e.id === 2 ? 'Stripe billing tutorial' : 'code', url: e.id === 2 ? 'https://www.youtube.com/watch' : null })),
  groundTruth: {
    activities: [
      { id: 'gt-1', started_at: '09:00', ended_at: '10:30', title: 'SaaS billing implementation', summary: 'Implemented billing.', event_ids: [1, 2, 3], context: 'Work', area: 'Own SaaS', intent: 'Create', quality: 'Focused', importance: 'high' },
      { id: 'gt-2', started_at: '11:30', ended_at: '12:30', title: 'Client authentication bug', summary: 'Fixed a client bug.', event_ids: [4, 5], context: 'Work', area: 'Freelance', intent: 'Create', quality: 'Focused', importance: 'high' },
    ],
    unobserved_periods: [{ started_at: '10:30', ended_at: '11:30', reason: 'Offline' }],
  },
  expectedReflection: {
    period: 'today',
    key_observations: ['An unexpected client issue displaced some planned product work.', 'The evening was spent learning PostgreSQL indexing from a tutorial.'],
    priority_alignment: [
      { priority: 'Ship the SaaS MVP', assessment: 'meaningful progress' },
      { priority: 'Complete existing client work', assessment: 'meaningful progress' },
      { priority: 'Generate new freelance leads', assessment: 'no meaningful activity observed' },
    ],
    important_uncertainty: ['Some offline periods are completely unobserved.'],
    possible_next_step: 'Protect a longer uninterrupted block for SaaS development tomorrow.',
  },
  expectedCoachOutcome: {
    primary_action: { title: 'Protect a focused SaaS block', action_type: 'protect_priority', reason: 'Client work consumed product time.', suggested_focus_minutes: 90, target: 'Own SaaS' },
    secondary_action: null,
    things_not_to_do: ['Do not claim that offline time was wasted.', 'Do not infer motivation, stress, or psychological state.', 'Do not classify the Stripe tutorial on YouTube as unrelated entertainment.'],
  },
  evaluationObjectives: null,
};

const verdictOf = (criteria: { id: string; verdict: string }[], id: string) => criteria.find((c) => c.id === id)?.verdict;
const reflectionCtx = { semantic: SEMANTIC, knownBlockIds: new Set(['b1', 'b2']), findLeaks: () => [] as string[] };
const coachCtx = {
  semantic: SEMANTIC,
  knownBlockIds: new Set(['b1', 'b2']),
  hasHistory: false,
  workVideoEventIds: [2],
  predictedByEvent: new Map([[2, { area: 'Work', quality: 'Focused', blockTitle: 'Implement SaaS billing' }]]),
};

describe('reflection evaluation', () => {
  it('passes every deterministic check on a sound report', () => {
    const { deterministic } = evaluateReflection(captured(), ANSWER, reflectionCtx);
    expect(deterministic.filter((c) => c.verdict !== 'PASS').map((c) => `${c.id}: ${c.detail} ${c.evidence?.join('; ') ?? ''}`)).toEqual([]);
    expect(deterministic.map((c) => c.id)).toEqual([
      'report_generated',
      'not_empty_when_data_exists',
      'valid_structure',
      'evidence_activities_exist',
      'metric_keys_exist',
      'no_unsupported_event_references',
      'no_hallucinated_activities',
      'internally_consistent',
      'no_impossible_values',
      'no_ground_truth_reference',
    ]);
  });

  it('fails the deterministic checks a broken report should fail', () => {
    const broken = report({ headline: 'You spent 31h 10m on the SaaS, 140% of the day.' });
    broken.insights[0].sourceMetricKeys = ['thread.made-up.minutes'];
    broken.insights[0].sourceActivityIds = ['ghost'];
    broken.metricsSnapshot!['time.tracked_minutes'] = metric('time.tracked_minutes', 400);
    const { deterministic } = evaluateReflection(captured({ report: broken }), ANSWER, { ...reflectionCtx, findLeaks: () => ['Implemented billing.'] });
    expect(verdictOf(deterministic, 'metric_keys_exist')).toBe('FAIL');
    expect(verdictOf(deterministic, 'evidence_activities_exist')).toBe('FAIL');
    expect(verdictOf(deterministic, 'internally_consistent')).toBe('FAIL');
    expect(verdictOf(deterministic, 'no_impossible_values')).toBe('FAIL');
    expect(verdictOf(deterministic, 'no_ground_truth_reference')).toBe('FAIL');
  });

  it('a missing report fails generation and every answer-key criterion', () => {
    const result = evaluateReflection(captured({ report: null, actions: [] }), ANSWER, reflectionCtx);
    expect(result.generated).toBe(false);
    expect(verdictOf(result.deterministic, 'report_generated')).toBe('FAIL');
    expect(verdictOf(result.deterministic, 'not_empty_when_data_exists')).toBe('FAIL');
    expect(result.semantic.every((c) => c.verdict === 'FAIL')).toBe(true);
  });

  it('judges the answer-key criteria by meaning and by measured time', () => {
    const { semantic } = evaluateReflection(captured(), ANSWER, reflectionCtx);
    expect(verdictOf(semantic, 'key_observation_1')).toBe('PASS'); // same idea, different words
    expect(verdictOf(semantic, 'key_observation_2')).toBe('FAIL'); // never mentioned
    expect(semantic.find((c) => c.id === 'priority_alignment')).toMatchObject({ verdict: 'PASS', method: 'structural', confidence: 'high' });
    expect(verdictOf(semantic, 'possible_next_step')).toBe('PASS');
    expect(semantic.find((c) => c.id === 'uncertainty_1')!.verdict).not.toBe('FAIL');
  });

  it('priority alignment fails when the measured time contradicts the answer key', () => {
    const wrong = report();
    wrong.metricsSnapshot!['priority.pr-saas.minutes'] = metric('priority.pr-saas.minutes', 0);
    wrong.metricsSnapshot!['priority.pr-client.minutes'] = metric('priority.pr-client.minutes', 0);
    wrong.metricsSnapshot!['priority.pr-leads.minutes'] = metric('priority.pr-leads.minutes', 150);
    expect(verdictOf(evaluateReflection(captured({ report: wrong }), ANSWER, reflectionCtx).semantic, 'priority_alignment')).toBe('FAIL');
  });
});

describe('coach evaluation', () => {
  it('passes a grounded, specific, priority-linked recommendation', () => {
    const { criteria, actionCount } = evaluateCoach(captured(), ANSWER, coachCtx);
    expect(actionCount).toBe(1);
    expect(Object.fromEntries(criteria.map((c) => [c.id, c.verdict]))).toEqual({
      coach_c1: 'PASS',
      coach_c2: 'PASS',
      coach_c3: 'PASS',
      coach_c4: 'PASS',
      coach_c5: 'PASS',
      coach_c6: 'PASS',
      coach_c7: 'NOT_APPLICABLE', // no leisure in this day, none mentioned
      coach_c8: 'PASS',
      coach_c9: 'PASS',
      coach_c10: 'PASS',
      coach_c11: 'NOT_APPLICABLE', // first day
      coach_c12: 'NOT_APPLICABLE', // nothing was ever turned down
      coach_c13: 'NOT_APPLICABLE', // an action was expected
    });
  });

  it('with no report, counts the missed recommendation and nothing else', () => {
    const { criteria, actionCount } = evaluateCoach(captured({ report: null, actions: [] }), ANSWER, coachCtx);
    expect(actionCount).toBe(0);
    expect(verdictOf(criteria, 'coach_c1')).toBe('FAIL');
    expect(criteria.filter((c) => c.id !== 'coach_c1').every((c) => c.verdict === 'NOT_APPLICABLE')).toBe(true);
    expect(criteria).toHaveLength(13);
  });

  it('catches ungrounded evidence, too many actions and generic advice', () => {
    const actions = [
      action({ id: 'a1', sourceMetricKeys: ['thread.made-up.minutes'] }),
      action({ id: 'a2', title: 'Stay focused and take regular breaks', rationale: 'It helps.', priorityId: null, thread: null, targetKey: null, sourceMetricKeys: [], sourceActivityIds: [], evidence: [], daypart: 'any', targetStart: null, focusMinutes: null, focusTask: null }),
      action({ id: 'a3' }),
    ];
    const { criteria } = evaluateCoach(captured({ actions }), ANSWER, coachCtx);
    expect(verdictOf(criteria, 'coach_c2')).toBe('PARTIAL');
    expect(verdictOf(criteria, 'coach_c4')).toBe('PARTIAL');
    expect(verdictOf(criteria, 'coach_c5')).toBe('FAIL');
    expect(verdictOf(criteria, 'coach_c9')).toBe('FAIL');
  });

  it('catches psychological claims and judgments of leisure and offline time', () => {
    const judging = action({
      title: 'Cut down the YouTube videos that wasted your afternoon',
      rationale: 'You seemed stressed and unmotivated, and the long offline gap before lunch was unproductive.',
      actionType: 'avoid_pattern',
    });
    const { criteria } = evaluateCoach(captured({ actions: [judging] }), ANSWER, coachCtx);
    expect(verdictOf(criteria, 'coach_c6')).toBe('FAIL');
    expect(verdictOf(criteria, 'coach_c7')).toBe('FAIL');
    expect(verdictOf(criteria, 'coach_c8')).toBe('FAIL');
    const prohibited = criteria.find((c) => c.id === 'coach_c10')!;
    expect(prohibited.verdict).toBe('FAIL');
    expect(prohibited.detail).toMatch(/\[FAIL\] Do not claim that offline time was wasted/);
    expect(prohibited.detail).toMatch(/\[FAIL\] Do not infer motivation, stress/);
  });

  it('checks a "do not classify the tutorial as entertainment" rule against the actual classification', () => {
    const misclassified = { ...coachCtx, predictedByEvent: new Map([[2, { area: 'Leisure', quality: 'Distracting', blockTitle: 'Watching YouTube' }]]) };
    const prohibited = evaluateCoach(captured(), ANSWER, misclassified).criteria.find((c) => c.id === 'coach_c10')!;
    expect(prohibited.verdict).toBe('FAIL');
    expect(prohibited.detail).toMatch(/\[FAIL\] Do not classify the Stripe tutorial/);
  });

  it('recognises the right target with the wrong kind of action as partial, and the wrong target as a miss', () => {
    const wrongType = action({ actionType: 'rest', title: 'Leave the SaaS billing work alone until Thursday morning' });
    expect(verdictOf(evaluateCoach(captured({ actions: [wrongType] }), ANSWER, coachCtx).criteria, 'coach_c1')).toBe('PARTIAL');
    const wrongTarget = action({ actionType: 'rest', title: 'Reply to the client about the invoice and the proposal', rationale: 'The client thread is open.', priorityId: 'pr-client', thread: 'Client project', targetKey: 'p:pr-client', focusTask: null });
    expect(verdictOf(evaluateCoach(captured({ actions: [wrongTarget] }), ANSWER, coachCtx).criteria, 'coach_c1')).toBe('FAIL');
    expect(verdictOf(evaluateCoach(captured({ actions: [] }), ANSWER, coachCtx).criteria, 'coach_c1')).toBe('FAIL');
  });

  it('does not force an action, uses history, and does not repeat what was rejected', () => {
    const quiet: EvaluationOnlyDay = { ...ANSWER, expectedCoachOutcome: { ...ANSWER.expectedCoachOutcome, primary_action: null } };
    expect(verdictOf(evaluateCoach(captured({ actions: [] }), quiet, coachCtx).criteria, 'coach_c13')).toBe('PASS');
    expect(verdictOf(evaluateCoach(captured(), quiet, coachCtx).criteria, 'coach_c13')).toBe('FAIL');

    const withHistory = { ...coachCtx, hasHistory: true };
    expect(verdictOf(evaluateCoach(captured(), ANSWER, withHistory).criteria, 'coach_c11')).toBe('FAIL');
    const citing = action({ sourceMetricKeys: ['priority.pr-saas.minutes', 'recent.priority.pr-saas.active_days'] });
    const history = report();
    history.metricsSnapshot!['recent.priority.pr-saas.active_days'] = metric('recent.priority.pr-saas.active_days', 3);
    expect(verdictOf(evaluateCoach(captured({ actions: [citing], report: history }), ANSWER, withHistory).criteria, 'coach_c11')).toBe('PASS');

    const rejected = action({ id: 'old', status: 'rejected', reasonCode: 'bad_timing' });
    expect(verdictOf(evaluateCoach(captured({ earlierActions: [rejected] }), ANSWER, withHistory).criteria, 'coach_c12')).toBe('FAIL');
    const different = action({ strategyKey: 'close_open_loop|any|none', targetKey: 'p:pr-client', title: 'Send the client the final invoice' });
    expect(verdictOf(evaluateCoach(captured({ actions: [different], earlierActions: [rejected] }), ANSWER, withHistory).criteria, 'coach_c12')).toBe('PASS');
  });
});

describe('a whole day, and the summary', () => {
  it('evaluates both tracks in dataset event ids and aggregates them', () => {
    const day = evaluateDay(captured(), ANSWER, { config: { matching: MATCHING, semantic: SEMANTIC }, taxonomy: TAXONOMY, knownBlockIds: new Set(['b1', 'b2']), hasHistory: false, findLeaks: () => [] });
    expect(day.timeline.segmentation.metrics).toMatchObject({ matchedCount: 2, f1: 1, boundaryF1: 1 });
    // The sessionizer baseline merged both activities into one block.
    expect(day.deterministic.segmentation.metrics).toMatchObject({ predictedCount: 1, matchedCount: 1, recall: 0.5, underSegmentationRatio: 2 });
    expect(day.timeline.classification.byTime.full.accuracy).toBe(1);
    expect(day.timeline.classification.byTime.context.evaluated).toBe(150 * MIN);
    expect(day.mappingIssues).toEqual([]);

    const summary = summarize([day, day]);
    expect(summary.daysEvaluated).toBe(2);
    expect(summary.segmentation.timeline.micro).toMatchObject({ groundTruthCount: 4, matchedCount: 4, f1: 1 });
    expect(summary.segmentation.deterministic.micro.recall).toBe(0.5);
    expect(summary.reflection.semantic.key_observation).toMatchObject({ PASS: 2, FAIL: 2, score: 0.5 });
    expect(summary.coach.criteria.coach_c5).toMatchObject({ PASS: 2, score: 1 });
    expect(countVerdicts(['PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE'])).toMatchObject({ score: 0.5, NOT_APPLICABLE: 1 });
  });
});

describe('answer-key leak detector', () => {
  const evaluation: EvaluationOnly = {
    priorities: [],
    days: [{ ...ANSWER, groundTruth: { ...ANSWER.groundTruth, activities: [{ ...ANSWER.groundTruth.activities[0], summary: 'Implemented and tested billing-related functionality, including API research and code changes.' }] } }],
  };
  const input: ReflectInput = {
    persona: { id: 'p', type: 'founder_freelancer', role: 'Solo founder and freelance software developer who builds a SaaS product', current_work: [], priorities: ['Ship the SaaS MVP'] },
    utcOffset: '+05:30',
    days: [],
  };
  const detector = buildLeakDetector(evaluation, input);

  it('finds answer-key wording however it is cased or punctuated', () => {
    expect(detector.shingleCount).toBeGreaterThan(0);
    expect(detector.findLeaks('EVENTS … implemented and tested billing related functionality including api research and code changes …')).toHaveLength(1);
    expect(detector.findLeaks('the day type was normal_mixed_workday')).toEqual(['normal_mixed_workday']);
  });

  it('stays silent on ordinary prompts and on wording Reflect legitimately has', () => {
    expect(detector.findLeaks('You implemented billing and tested it. Then you researched the API.')).toEqual([]);
    expect(detector.findLeaks('ABOUT THE USER: Solo founder and freelance software developer who builds a SaaS product')).toEqual([]);
  });
});

// ── Coach, by dimension ─────────────────────────────────────────────────────

describe('coach dimensions — opportunity, precision, null, follow-through, adaptation', () => {
  const dimCtx = { semantic: SEMANTIC, knownBlockIds: new Set(['b1', 'b2']), previousProcessedAt: iso(0) };
  const withOpportunity = (strength: 'strong' | 'moderate' | 'none', over: Partial<EvaluationOnlyDay['expectedCoachOutcome']> = {}): EvaluationOnlyDay => ({
    ...ANSWER,
    expectedCoachOutcome: {
      ...ANSWER.expectedCoachOutcome,
      ...(strength === 'none' ? { primary_action: null } : {}),
      action_opportunity: { should_exist: strength === 'strong', strength, reason: 'test', priority: strength === 'none' ? null : 'Ship the SaaS MVP', type: strength === 'none' ? null : 'protect_priority' },
      ...over,
    },
  });
  const assess = (capturedDay: CapturedDay, answer: EvaluationOnlyDay = withOpportunity('strong')) => assessCoach(capturedDay, answer, dimCtx);
  /** An action as it stood after the simulated user answered. */
  const settled = (over: Partial<CoachAction>) =>
    action({ id: 'earlier', status: 'closed', acceptedAt: iso(790), execution: 'done', executionSource: 'observed', closedAt: iso(900), outcomeAt: iso(900), updatedAt: iso(900), ...over });

  it('opportunity detection: silence on a strong day is a miss; on a moderate day it is fine; on a null day it is right', () => {
    const silent = captured({ actions: [] });
    expect(assess(silent, withOpportunity('strong'))).toMatchObject({ verdict: 'missed', opportunity: { strength: 'strong' } });
    expect(assess(silent, withOpportunity('moderate')).verdict).toBe('acceptable_null');
    expect(assess(silent, withOpportunity('none')).verdict).toBe('correct_null');
    expect(assess(captured({ report: null, actions: [] }), withOpportunity('strong')).verdict).toBe('no_report');
    // An answer key written before the annotation existed: a primary action means "strong".
    expect(opportunityOf(ANSWER.expectedCoachOutcome)).toMatchObject({ strength: 'strong', should_exist: true });
    expect(opportunityOf({ ...ANSWER.expectedCoachOutcome, primary_action: null })).toMatchObject({ strength: 'none', should_exist: false });
  });

  it('a grounded, aligned, specific action aimed at the expected target is correct — and justified', () => {
    const day = assess(captured());
    expect(day.verdict).toBe('correct');
    expect(day.actions[0]).toMatchObject({ matches: 'primary', typeFit: 'exact', grounded: true, aligned: true, specific: true, feasible: true, generic: false, prohibited: false, justified: true, notes: [] });
  });

  it('an action is never rewarded for existing: on a null day it is unnecessary, and it counts against precision', () => {
    const day = assess(captured(), withOpportunity('none'));
    expect(day.verdict).toBe('unnecessary');
    expect(day.actions[0]).toMatchObject({ justified: false });
    expect(day.actions[0].notes).toContain('the day held no opportunity worth an action');
  });

  it('penalises unsupported, generic, misaimed and oversized actions — each for its own reason', () => {
    const unsupported = assess(captured({ actions: [action({ sourceMetricKeys: ['thread.made-up.minutes'], sourceActivityIds: [] })] })).actions[0];
    expect(unsupported).toMatchObject({ grounded: false, justified: false });
    const generic = assess(captured({ actions: [action({ title: 'Stay focused tomorrow', description: 'Avoid distractions and manage your time.', priorityId: null, thread: null, targetKey: null, focusTask: null, focusMinutes: null, daypart: 'any', sourceMetricKeys: [], sourceActivityIds: [] })] }));
    expect(generic.actions[0]).toMatchObject({ generic: true, specific: false, grounded: false, justified: false });
    expect(generic.verdict).toBe('wrong');
    // Aimed at the other work stream: well-formed, but not what the day called for.
    const misaimed = assess(captured({ actions: [action({ title: 'Send the revised proposal to the prospect tomorrow morning', rationale: 'The proposal was revised and not sent.', priorityId: 'pr-leads', thread: 'Leads', targetKey: 'p:pr-leads', focusTask: 'Proposal' })] }));
    expect(misaimed.actions[0]).toMatchObject({ matches: null, grounded: true, justified: false });
    expect(misaimed.verdict).toBe('wrong');
    const oversized = assess(captured({ actions: [action({ focusMinutes: 180 })] })).actions[0];
    expect(oversized).toMatchObject({ feasible: false });
    expect(oversized.notes.join(' ')).toContain('more than one sitting');
    const prohibited = assess(captured({ actions: [action({ title: 'Extend the workday tonight to recover the SaaS billing time', rationale: 'SaaS time was reduced by client work.' })] }), withOpportunity('strong', { things_not_to_do: ['Do not recommend extending the workday to recover SaaS time.'] })).actions[0];
    expect(prohibited).toMatchObject({ prohibited: true, justified: false });
  });

  it('saying the same thing again is not a new recommendation, whatever became of the first one', () => {
    const yesterday = action({ id: 'earlier', status: 'closed', execution: 'done', outcome: 'worked', createdAt: iso(780 - 24 * 60) });
    const again = assess(captured({ earlierActions: [yesterday], actions: [action({ id: 'today' })] })).actions[0];
    expect(again).toMatchObject({ repeated: true, justified: false });
    expect(again.notes.join(' ')).toContain('says the same thing as');
    // A different, more specific sentence for the same target is not a repeat; nor is one from long ago.
    expect(assess(captured({ earlierActions: [yesterday], actions: [action({ id: 'today', title: 'Finish the Stripe webhook retry handling in the SaaS billing work' })] })).actions[0].repeated).toBe(false);
    expect(assess(captured({ earlierActions: [{ ...yesterday, createdAt: iso(780 - 10 * 24 * 60) }], actions: [action({ id: 'today' })] })).actions[0].repeated).toBe(false);
  });

  it('a day-wide expected action (rest, fewer switches) is answered by the right kind of action, not by a target', () => {
    const answer = withOpportunity('strong', { primary_action: { title: 'Keep one uninterrupted block', action_type: 'reduce_fragmentation', reason: 'The day broke into short pieces.', suggested_focus_minutes: 90, target: null } });
    expect(assess(captured({ actions: [action({ actionType: 'reduce_fragmentation', strategyKey: 'reduce_fragmentation|morning|long' })] }), answer).verdict).toBe('correct');
    expect(assess(captured({ actions: [action({ actionType: 'rest', strategyKey: 'rest|any|none', focusMinutes: null })] }), answer).actions[0].matches).toBeNull();
  });

  it('precision, recall and appropriate-null are separate numbers', () => {
    const days = [
      assess(captured(), withOpportunity('strong')), // correct
      assess(captured({ actions: [] }), withOpportunity('strong')), // missed
      assess(captured({ actions: [] }), withOpportunity('none')), // correct null
      assess(captured(), withOpportunity('none')), // unnecessary
      assess(captured({ actions: [] }), withOpportunity('moderate')), // acceptable null
    ];
    const summary = summarizeCoachDimensions(days);
    expect(summary).toMatchObject({ daysEvaluated: 5, daysExpectedAction: 2, daysOptionalAction: 1, daysExpectedNull: 2, actionsGenerated: 2, daysWithActions: 2 });
    expect(summary.opportunityRecall).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(summary.actionPrecision).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(summary.appropriateNull).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(summary.verdicts).toMatchObject({ correct: 1, missed: 1, correct_null: 1, unnecessary: 1, acceptable_null: 1 });
    // A Coach that acts every day gets full recall and pays for it in precision and appropriate-null.
    const always = summarizeCoachDimensions([assess(captured(), withOpportunity('strong')), assess(captured(), withOpportunity('none')), assess(captured(), withOpportunity('none'))]);
    expect(always.opportunityRecall.value).toBe(1);
    expect(always.actionPrecision.value).toBeCloseTo(1 / 3);
    expect(always.appropriateNull.value).toBe(0);
    // …and one that never acts gets the nulls right and none of the opportunities.
    const never = summarizeCoachDimensions([assess(captured({ actions: [] }), withOpportunity('strong')), assess(captured({ actions: [] }), withOpportunity('none'))]);
    expect(never).toMatchObject({ opportunityRecall: { value: 0 }, actionPrecision: { value: null }, appropriateNull: { value: 1 } });
  });

  it('execution and outcome are tracked apart from each other and from recommendation quality', () => {
    const states = [
      settled({ id: 'a', outcome: 'worked' }), // followed, observed by Reflect, helped
      settled({ id: 'b', executionSource: 'user', outcome: 'did_not_work' }), // followed, said so, did not help
      settled({ id: 'c', execution: 'not_done', executionSource: 'user', reasonCode: 'external_constraint', outcomeAt: null }), // not followed
      settled({ id: 'd', status: 'review', outcome: null, outcomeAt: null, closedAt: null }), // done, nobody said whether it helped
      settled({ id: 'e', status: 'review', execution: null, executionSource: null, outcomeAt: null, closedAt: null }), // window passed, nothing known
      action({ id: 'f', status: 'rejected', rejectedAt: iso(800), reasonCode: 'not_relevant' }),
      action({ id: 'g', status: 'expired' }),
    ].map(stateOf);
    const summary = summarizeCoachDimensions([assess(captured())], states);
    expect(summary.lifecycle).toMatchObject({ accepted: 5, rejected: 1, undecided: 2, done: 3, notDone: 1, executionUnknown: 1, observedByReflect: 2, statedByUser: 2, worked: 1, didNotWork: 1 });
    expect(summary.executionTracking).toEqual({ value: 0.8, numerator: 4, denominator: 5 });
    expect(summary.outcomeTracking).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    // None of this touched the recommendation scores.
    expect(summary.actionPrecision.value).toBe(1);
  });

  it('adaptation: a rejected suggestion that comes back fails; one left alone passes', () => {
    const rejected = action({ id: 'earlier', status: 'rejected', rejectedAt: iso(790), closedAt: iso(790), reasonCode: 'not_relevant' });
    const back = assess(captured({ earlierActions: [rejected], actions: [action({ id: 'today', title: 'Keep a morning block for the SaaS billing work' })] }));
    expect(back.adaptation).toMatchObject([{ kind: 'rejected_not_repeated', pass: false, behaviour: 'repeated' }]);
    const left = assess(captured({ earlierActions: [rejected], actions: [] }));
    expect(left.adaptation).toMatchObject([{ kind: 'rejected_not_repeated', pass: true, behaviour: 'did not bring it back' }]);
  });

  it('adaptation: after "did not work", the same strategy fails; a changed one or none passes', () => {
    const failed = settled({ outcome: 'did_not_work' });
    const unchanged = assess(captured({ earlierActions: [failed], actions: [action({ id: 'today' })] }));
    expect(unchanged.adaptation).toMatchObject([{ kind: 'failed_not_repeated', pass: false, behaviour: 'repeated unchanged' }]);
    const changed = assess(captured({ earlierActions: [failed], actions: [action({ id: 'today', daypart: 'evening', focusMinutes: 30, strategyKey: 'protect_priority|evening|short', title: 'Give the SaaS billing work 30 minutes this evening' })] }));
    expect(changed.adaptation).toMatchObject([{ kind: 'failed_not_repeated', pass: true, behaviour: 'changed the strategy' }]);
    expect(assess(captured({ earlierActions: [failed], actions: [] })).adaptation).toMatchObject([{ pass: true, behaviour: 'backed off' }]);
    // "Bad timing": a different kind of action in the same part of the day is not an adaptation.
    const mistimed = settled({ outcome: 'did_not_work', reasonCode: 'bad_timing' });
    const sameSlot = assess(captured({ earlierActions: [mistimed], actions: [action({ id: 'today', actionType: 'focus_session', strategyKey: 'focus_session|morning|long' })] }));
    expect(sameSlot.adaptation).toMatchObject([{ kind: 'failed_not_repeated', pass: false, behaviour: 'kept the timing that failed' }]);
  });

  it('adaptation: what worked is reused, what partly worked is refined, and an external interruption is not held against anyone', () => {
    const reused = assess(captured({ earlierActions: [settled({ outcome: 'worked' })], actions: [action({ id: 'today', title: 'Protect the first block tomorrow for the SaaS invoice export' })] }));
    expect(reused.adaptation).toMatchObject([{ kind: 'worked_reused', pass: true, behaviour: 'reused what worked' }]);
    const repeated = assess(captured({ earlierActions: [settled({ outcome: 'partly_worked' })], actions: [action({ id: 'today' })] }));
    expect(repeated.adaptation).toMatchObject([{ kind: 'partly_refined', pass: false, behaviour: 'repeated unchanged' }]);
    const refined = assess(captured({ earlierActions: [settled({ outcome: 'partly_worked' })], actions: [action({ id: 'today', focusMinutes: 45, strategyKey: 'protect_priority|morning|medium' })] }));
    expect(refined.adaptation).toMatchObject([{ kind: 'partly_refined', pass: true, behaviour: 'refined it' }]);
    const interrupted = settled({ execution: 'not_done', executionSource: 'user', reasonCode: 'external_constraint', outcomeAt: null });
    expect(assess(captured({ earlierActions: [interrupted], actions: [action({ id: 'today' })] })).adaptation).toMatchObject([{ kind: 'external_not_penalised', pass: true, behaviour: 're-offered the next step' }]);
    // Something settled before the previous day's capture is old news, not an adaptation test.
    expect(assessCoach(captured({ earlierActions: [settled({ outcome: 'worked' })] }), withOpportunity('strong'), { ...dimCtx, previousProcessedAt: iso(2000) }).adaptation).toEqual([]);
    const summary = summarizeCoachDimensions([reused, repeated, refined]);
    expect(summary.adaptation).toMatchObject({ checks: 3, passed: 2, byKind: { worked_reused: { checks: 1, passed: 1 }, partly_refined: { checks: 2, passed: 1 } } });
  });

  it('the summary carries the dimensions next to the thirteen criteria, without merging them', () => {
    const evaluation = evaluateCoach(captured(), withOpportunity('strong'), coachCtx);
    expect(evaluation.assessment.verdict).toBe('correct');
    expect(evaluation.criteria).toHaveLength(13);
    // "Did not force an action" now reads the opportunity, not the mere presence of an expected action.
    expect(verdictOf(evaluateCoach(captured(), withOpportunity('none'), coachCtx).criteria, 'coach_c13')).toBe('FAIL');
    expect(verdictOf(evaluateCoach(captured({ actions: [] }), withOpportunity('none'), coachCtx).criteria, 'coach_c13')).toBe('PASS');
    expect(verdictOf(evaluateCoach(captured(), withOpportunity('moderate'), coachCtx).criteria, 'coach_c13')).toBe('NOT_APPLICABLE');
  });
});
