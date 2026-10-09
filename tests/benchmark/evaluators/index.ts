import type { CapturedBlock, CapturedDay, CapturedTaxonomy } from '../runner/capture';
import type { BenchmarkConfig } from '../runner/config';
import type { DatasetWorkStream, EvaluationOnly, EvaluationOnlyDay } from '../runner/dataset';
import {
  mergeClassificationScores,
  scoreClassification,
  type ClassificationSample,
  type ClassificationScores,
  type GroundTruthLabels,
  type PredictedLabels,
} from './classification';
import { ACTION_TYPE_MAPPING, evaluateCoach, type CoachEvaluation } from './coach';
import { summarizeCoachDimensions, type ActionStateRecord, type CoachDimensionSummary } from './coachDimensions';
import { evaluateReflection, progressLevel, type ReflectionEvaluation } from './reflection';
import { evaluateSegmentation, segmentFromEvents, type Segment, type SegmentationMetrics, type SegmentationResult, type TimedEvent } from './segmentation';
import { buildStreamContext, streamOfActivity } from './streams';
import { NULL_LABEL, TAXONOMY_MAPPING, canonicalLabel, resolveMapping, type DatasetDimension } from './taxonomyMapping';
import type { Criterion, Verdict } from './text';

/**
 * The evaluator's entry points. This is the only place where what Reflect
 * produced (`CapturedDay`) and the answer key (`EvaluationOnlyDay`) meet — and
 * it runs strictly after the day's processing has finished.
 */

/** Bump when a metric's definition changes, so old and new results are not compared blindly. */
export const EVALUATOR_VERSION = 'reflect-benchmark-eval-v4';

export interface TrackEvaluation {
  segmentation: SegmentationResult;
  classification: { matched: ClassificationScores; byTime: ClassificationScores };
}

export interface DayEvaluation {
  dayNumber: number;
  date: string;
  /** What the Timeline shows (AI activities + deterministic fallback). The primary track. */
  timeline: TrackEvaluation;
  /** Stage-2 sessionizer + rule classification alone. The no-AI baseline. */
  deterministic: TrackEvaluation;
  /** Activities the key itself marks as unattributable, and what that did to the segmentation ground truth. */
  softBoundaries?: SoftBoundaries;
  /** Tracked time per Reflect Context — reported only; the dataset has no counterpart. */
  reflectContextMs: Record<string, number>;
  reflection: ReflectionEvaluation;
  coach: CoachEvaluation;
  mappingIssues: string[];
}

export interface DayEvaluationContext {
  config: Pick<BenchmarkConfig, 'matching' | 'semantic'>;
  taxonomy: CapturedTaxonomy;
  /** Ids of every timeline block shown up to and including this day. */
  knownBlockIds: Set<string>;
  hasHistory: boolean;
  /** When the previous day was captured (null on the first day). */
  previousProcessedAt?: string | null;
  findLeaks: (text: string) => string[];
  /** The persona's work streams (`EvaluationOnly.streams`). Empty or absent: the answer key names no streams. */
  streams?: Record<string, DatasetWorkStream>;
}

const VIDEO = /youtube|vimeo|\bvideo\b|tutorial/i;

/** The answer key's own word, in an activity's context, for "what this time was cannot be told from the screen". */
const UNDECIDED_CONTEXT = /^(uncertain|ambiguous|unknown|mixed|unresolved|unclear)\b/i;

export interface SoftBoundaries {
  /** Ground-truth activities the key itself could not attribute; they define no boundary. */
  uncertainActivities: number;
  /** Their share of the day's tracked time. */
  uncertainShare: number;
  /** Neighbouring activities of one work stream that only such an interlude separated, scored as one. */
  merged: number;
}

/**
 * Ground truth for SEGMENTATION, with the key's stated uncertainty taken at its word.
 *
 * Where the key says of a stretch "purpose not observable" (reference browsing in the middle of a design
 * session, an unclear video), it is not asserting an activity boundary there — only that it could not tell.
 * Scoring Reflect against that boundary as if it were exact would punish it for joining, or for splitting, on a
 * question the key does not answer. So such a stretch is taken out of the comparison on both sides, and the two
 * pieces of one work stream it separated count as one activity. Everything the key IS sure of is scored exactly as
 * before; a key with no such activity is untouched.
 */
function segmentationGroundTruth(
  observed: EvaluationOnlyDay['groundTruth']['activities'],
  streams: Record<string, DatasetWorkStream>,
  eventsById: Map<number, TimedEvent>,
): { activities: { id: string; eventIds: number[] }[]; softEventIds: Set<number>; soft: SoftBoundaries } {
  const softEventIds = new Set<number>();
  const activities: { id: string; eventIds: number[]; stream: string | null }[] = [];
  let softSince = false;
  let merged = 0;
  let uncertain = 0;
  for (const activity of observed) {
    if (UNDECIDED_CONTEXT.test(String(activity.context).trim())) {
      for (const id of activity.event_ids) softEventIds.add(id);
      softSince = true;
      uncertain++;
      continue;
    }
    const stream = streamOfActivity(activity, streams);
    const previous = activities[activities.length - 1];
    if (softSince && previous && stream !== null && previous.stream === stream) {
      previous.eventIds.push(...activity.event_ids);
      merged++;
    } else {
      activities.push({ id: activity.id, eventIds: [...activity.event_ids], stream });
    }
    softSince = false;
  }
  const ms = (ids: Iterable<number>) => [...ids].reduce((sum, id) => sum + ((eventsById.get(id)?.endMs ?? 0) - (eventsById.get(id)?.startMs ?? 0)), 0);
  const total = ms(observed.flatMap((a) => a.event_ids));
  return { activities, softEventIds, soft: { uncertainActivities: uncertain, uncertainShare: total > 0 ? ms(softEventIds) / total : 0, merged } };
}

function predictedLabels(block: CapturedBlock, priorities: { id: string; text: string }[]): PredictedLabels {
  return {
    areaId: block.classification.areaId,
    intentId: block.classification.intentId,
    qualityId: block.classification.qualityId,
    priorityId: block.priorityId,
    contextName: block.classification.context,
    names: {
      area: block.classification.area,
      intent: block.classification.intent,
      quality: block.classification.quality,
      priority: block.priorityId ? priorities.find((p) => p.id === block.priorityId)?.text ?? block.priorityId : null,
    },
  };
}

export function evaluateDay(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: DayEvaluationContext): DayEvaluation {
  const events: TimedEvent[] = answer.events.map((e) => ({ id: e.datasetId, startMs: e.startMs, endMs: e.endMs }));
  const eventsById = new Map(events.map((e) => [e.id, e]));
  const datasetIdOf = new Map(captured.events.map((e) => [e.eventId, e.datasetId]));

  // Time away from the screen that the key tells as an activity owns no events: there is nothing Reflect could have reconstructed.
  const observed = answer.groundTruth.activities.filter((a) => a.event_ids.length > 0);
  const streams = ctx.streams ?? {};
  const byStream = Object.keys(streams).length > 0;
  const scored = segmentationGroundTruth(observed, streams, eventsById);
  const groundTruth: Segment[] = scored.activities.map((a) => segmentFromEvents(a.id, a.eventIds, eventsById));
  const scoredEvents = events.filter((e) => !scored.softEventIds.has(e.id));
  const labelsOf = new Map<string, GroundTruthLabels>(
    observed.map((a) => [
      a.id,
      { context: canonicalLabel('context', a.context), area: byStream ? streamOfActivity(a, streams) : canonicalLabel('area', a.area), intent: canonicalLabel('intent', a.intent), quality: canonicalLabel('quality', a.quality) },
    ]),
  );
  const ownerOf = new Map<number, string>();
  for (const a of observed) for (const id of a.event_ids) ownerOf.set(id, a.id);

  const used: Record<DatasetDimension, (string | null)[]> = { context: [], area: [], intent: [], quality: [] };
  for (const labels of labelsOf.values()) for (const dimension of Object.keys(used) as DatasetDimension[]) used[dimension].push(labels[dimension]);
  const mapping = resolveMapping(
    { areas: ctx.taxonomy.areas, intents: ctx.taxonomy.intents, qualities: ctx.taxonomy.qualities, priorities: captured.priorities },
    used,
    streams,
  );
  const streamContext = byStream ? buildStreamContext(streams, captured, answer) : undefined;

  const evaluateTrack = (blocks: CapturedBlock[]): TrackEvaluation => {
    const toDataset = (block: CapturedBlock) => block.eventIds.map((id) => datasetIdOf.get(id)).filter((id): id is number => id !== undefined);
    // A block is compared on the events the key is sure of; one made only of time the key could not attribute is neither right nor wrong.
    const predicted = blocks
      .map((b) => ({ id: b.id, eventIds: toDataset(b).filter((id) => !scored.softEventIds.has(id)) }))
      .filter((b) => b.eventIds.length > 0)
      .map((b) => segmentFromEvents(b.id, b.eventIds, eventsById));
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    const segmentation = evaluateSegmentation(groundTruth, predicted, scoredEvents, ctx.config.matching);

    const matched: ClassificationSample[] = segmentation.matches.map((m) => ({
      groundTruth: labelsOf.get(m.groundTruthId)!,
      predicted: predictedLabels(blockById.get(m.predictedId)!, captured.priorities),
      weight: 1,
    }));

    const blockOf = new Map<number, CapturedBlock>();
    for (const block of blocks) for (const id of toDataset(block)) blockOf.set(id, block);
    const byTime: ClassificationSample[] = [];
    for (const event of events) {
      const owner = ownerOf.get(event.id);
      if (!owner) continue;
      const block = blockOf.get(event.id);
      byTime.push({ groundTruth: labelsOf.get(owner)!, predicted: block ? predictedLabels(block, captured.priorities) : null, weight: event.endMs - event.startMs });
    }
    return { segmentation, classification: { matched: scoreClassification(matched, mapping), byTime: scoreClassification(byTime, mapping) } };
  };

  const reflectContextMs: Record<string, number> = {};
  for (const block of captured.timeline) {
    const name = block.classification.context ?? '(none)';
    reflectContextMs[name] = (reflectContextMs[name] ?? 0) + block.activeMs;
  }

  // What the Coach checks need to know about how the day's video events were classified.
  const predictedByEvent = new Map<number, { area: string | null; quality: string | null; blockTitle: string }>();
  for (const block of captured.timeline) {
    for (const id of block.eventIds) {
      const datasetId = datasetIdOf.get(id);
      if (datasetId !== undefined) predictedByEvent.set(datasetId, { area: block.classification.area, quality: block.classification.quality, blockTitle: block.title });
    }
  }
  const workVideoEventIds = answer.events
    .filter((e) => VIDEO.test(`${e.app ?? ''} ${e.title ?? ''} ${e.url ?? ''}`))
    .filter((e) => labelsOf.get(ownerOf.get(e.datasetId) ?? '')?.context === 'Work')
    .map((e) => e.datasetId);

  return {
    dayNumber: answer.dayNumber,
    date: answer.date,
    timeline: evaluateTrack(captured.timeline),
    deterministic: evaluateTrack(captured.deterministicSessions),
    softBoundaries: scored.soft,
    reflectContextMs,
    reflection: evaluateReflection(captured, answer, { semantic: ctx.config.semantic, knownBlockIds: ctx.knownBlockIds, findLeaks: ctx.findLeaks, streams: streamContext }),
    coach: evaluateCoach(captured, answer, {
      semantic: ctx.config.semantic,
      knownBlockIds: ctx.knownBlockIds,
      hasHistory: ctx.hasHistory,
      previousProcessedAt: ctx.previousProcessedAt ?? null,
      workVideoEventIds,
      predictedByEvent,
      streams: streamContext,
    }),
    mappingIssues: mapping.issues,
  };
}

// ── Answer-key vocabulary ───────────────────────────────────────────────────

export interface VocabularyCheck {
  errors: string[];
  warnings: string[];
  /** Per classification dimension: how many scored activities there are, and how many carry a label with no mapping. */
  classification: Record<DatasetDimension, { activities: number; unmapped: number }>;
}

/**
 * What the evaluator can and cannot read in the answer key, established
 * before a single request is made.
 *
 * A Coach action type with no mapping is an error: the expected action could
 * only ever be scored as "wrong". A classification label with no mapping is
 * not: the activity is left out of that dimension's accuracy (it is never
 * counted as right or wrong), and how many are left out is reported here so
 * that an accuracy over a small remainder is not mistaken for the whole.
 */
export function checkAnswerKeyVocabulary(evaluation: EvaluationOnly): VocabularyCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const classification = { context: { activities: 0, unmapped: 0 }, area: { activities: 0, unmapped: 0 }, intent: { activities: 0, unmapped: 0 }, quality: { activities: 0, unmapped: 0 } };
  const unmappedLabels = new Map<string, number>();
  for (const day of evaluation.days) {
    const at = `day ${day.dayNumber}`;
    for (const activity of day.groundTruth.activities) {
      if (activity.event_ids.length === 0) continue; // off-screen time: not scored
      for (const dimension of ['context', 'area', 'intent', 'quality'] as const) {
        const byStream = dimension === 'area' && Object.keys(evaluation.streams).length > 0;
        const label = (byStream ? streamOfActivity(activity, evaluation.streams) : canonicalLabel(dimension, activity[dimension])) ?? NULL_LABEL;
        classification[dimension].activities++;
        // A stream of work that no stated priority covers cannot be judged against a priority link.
        const known = byStream
          ? label === NULL_LABEL || evaluation.streams[label].kind !== 'work' || evaluation.streams[label].priorities.length > 0
          : label in TAXONOMY_MAPPING[dimension].labels || (dimension === 'area' && evaluation.priorities.includes(label));
        if (!known) {
          classification[dimension].unmapped++;
          const key = `${dimension} "${label.length > 60 ? `${label.slice(0, 57)}…` : label}"`;
          unmappedLabels.set(key, (unmappedLabels.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [slot, action] of [['primary_action', day.expectedCoachOutcome.primary_action], ['secondary_action', day.expectedCoachOutcome.secondary_action]] as const) {
      if (!action) continue;
      if (!(action.action_type in ACTION_TYPE_MAPPING)) errors.push(`${at} ${slot}: action_type "${action.action_type}" has no entry in evaluators/coach.ts ACTION_TYPE_MAPPING`);
      // A target is a known work stream, a stated priority, or the name of the thing itself ("DBMS Practical 3"),
      // which is matched against what the action says.
      if (action.target !== null && !action.target.trim()) errors.push(`${at} ${slot}: target is empty (use null for a day-wide action)`);
    }
    const opportunity = day.expectedCoachOutcome.action_opportunity;
    if (opportunity?.type && !(opportunity.type in ACTION_TYPE_MAPPING)) errors.push(`${at} action_opportunity: type "${opportunity.type}" has no entry in ACTION_TYPE_MAPPING`);
    for (const entry of day.expectedReflection.priority_alignment) {
      if (typeof entry !== 'string' && progressLevel(entry.assessment) === null) warnings.push(`${at}: priority assessment "${entry.assessment}" is not recognised and will not be scored`);
    }
  }
  for (const [label, count] of [...unmappedLabels].sort((a, b) => b[1] - a[1])) {
    warnings.push(`${label} has no entry in evaluators/taxonomyMapping.ts: ${count} activit${count === 1 ? 'y is' : 'ies are'} left out of that dimension's accuracy`);
  }
  return { errors, warnings, classification };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface VerdictCounts {
  PASS: number;
  PARTIAL: number;
  FAIL: number;
  NOT_APPLICABLE: number;
  /** (PASS + ½·PARTIAL) / applicable; null when nothing applied. */
  score: number | null;
}

export function countVerdicts(verdicts: Verdict[]): VerdictCounts {
  const counts: VerdictCounts = { PASS: 0, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, score: null };
  for (const v of verdicts) counts[v]++;
  const applicable = counts.PASS + counts.PARTIAL + counts.FAIL;
  counts.score = applicable > 0 ? (counts.PASS + 0.5 * counts.PARTIAL) / applicable : null;
  return counts;
}

/** `key_observation_3` → `key_observation`; everything else is its own group. */
const groupOf = (criterion: Criterion) => criterion.id.replace(/_\d+$/, '');

function countByGroup(criteria: Criterion[]): Record<string, VerdictCounts & { label: string; method: string; confidence: string }> {
  const groups = new Map<string, Criterion[]>();
  for (const c of criteria) groups.set(groupOf(c), [...(groups.get(groupOf(c)) ?? []), c]);
  return Object.fromEntries(
    [...groups.entries()].map(([id, list]) => [
      id,
      { ...countVerdicts(list.map((c) => c.verdict)), label: list[0].label, method: list[0].method, confidence: list.some((c) => c.confidence === 'low') ? 'low' : 'high' },
    ]),
  );
}

export interface SegmentationSummary {
  /** Counts summed over all days, ratios recomputed from the sums. */
  micro: Pick<
    SegmentationMetrics,
    | 'groundTruthCount'
    | 'predictedCount'
    | 'matchedCount'
    | 'precision'
    | 'recall'
    | 'f1'
    | 'groundTruthBoundaries'
    | 'predictedBoundaries'
    | 'matchedBoundaries'
    | 'boundaryPrecision'
    | 'boundaryRecall'
    | 'boundaryF1'
    | 'groundTruthCoverage'
    | 'durationWeightedIou'
  >;
  /** Plain mean of each day's value (days where a value is undefined are left out). */
  meanPerDay: Record<keyof SegmentationMetrics, number | null>;
}

function summarizeSegmentation(days: SegmentationMetrics[]): SegmentationSummary {
  const sum = (key: keyof SegmentationMetrics) => days.reduce((s, d) => s + ((d[key] as number | null) ?? 0), 0);
  const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
  const f1 = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
  const precision = ratio(sum('matchedCount'), sum('predictedCount'));
  const recall = ratio(sum('matchedCount'), sum('groundTruthCount'));
  const boundaryPrecision = ratio(sum('matchedBoundaries'), sum('predictedBoundaries'));
  const boundaryRecall = ratio(sum('matchedBoundaries'), sum('groundTruthBoundaries'));
  const tracked = sum('groundTruthTrackedMs');
  const keys = days.length > 0 ? (Object.keys(days[0]) as (keyof SegmentationMetrics)[]) : [];
  const meanPerDay = Object.fromEntries(
    keys.map((key) => {
      const values = days.map((d) => d[key]).filter((v): v is number => typeof v === 'number');
      return [key, values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null];
    }),
  ) as SegmentationSummary['meanPerDay'];
  return {
    micro: {
      groundTruthCount: sum('groundTruthCount'),
      predictedCount: sum('predictedCount'),
      matchedCount: sum('matchedCount'),
      precision,
      recall,
      f1: f1(precision, recall),
      groundTruthBoundaries: sum('groundTruthBoundaries'),
      predictedBoundaries: sum('predictedBoundaries'),
      matchedBoundaries: sum('matchedBoundaries'),
      boundaryPrecision,
      boundaryRecall,
      boundaryF1: f1(boundaryPrecision, boundaryRecall),
      groundTruthCoverage: ratio(days.reduce((s, d) => s + d.groundTruthCoverage * d.groundTruthTrackedMs, 0), tracked),
      durationWeightedIou: ratio(days.reduce((s, d) => s + d.durationWeightedIou * d.groundTruthTrackedMs, 0), tracked),
    },
    meanPerDay,
  };
}

export interface BenchmarkSummary {
  evaluatorVersion: string;
  daysEvaluated: number;
  segmentation: { timeline: SegmentationSummary; deterministic: SegmentationSummary };
  classification: {
    timeline: { matched: ClassificationScores; byTime: ClassificationScores };
    deterministic: { matched: ClassificationScores; byTime: ClassificationScores };
    reflectContextMs: Record<string, number>;
  };
  reflection: {
    reportsGenerated: number;
    deterministic: Record<string, VerdictCounts & { label: string; method: string; confidence: string }>;
    semantic: Record<string, VerdictCounts & { label: string; method: string; confidence: string }>;
    deterministicOverall: VerdictCounts;
    semanticOverall: VerdictCounts;
  };
  coach: {
    actionsPerDay: Record<string, number>;
    criteria: Record<string, VerdictCounts & { label: string; method: string; confidence: string }>;
    overall: VerdictCounts;
    /** Recommendation quality, follow-through, outcome and adaptation — each on its own. */
    dimensions: CoachDimensionSummary;
  };
  mappingIssues: string[];
}

export function summarize(days: DayEvaluation[], finalActionStates: ActionStateRecord[] = []): BenchmarkSummary {
  const reflectContextMs: Record<string, number> = {};
  for (const day of days) for (const [name, ms] of Object.entries(day.reflectContextMs)) reflectContextMs[name] = (reflectContextMs[name] ?? 0) + ms;
  const actionsPerDay: Record<string, number> = {};
  for (const day of days) actionsPerDay[String(day.coach.actionCount)] = (actionsPerDay[String(day.coach.actionCount)] ?? 0) + 1;

  const deterministic = days.flatMap((d) => d.reflection.deterministic);
  const semantic = days.flatMap((d) => d.reflection.semantic);
  const coach = days.flatMap((d) => d.coach.criteria);

  return {
    evaluatorVersion: EVALUATOR_VERSION,
    daysEvaluated: days.length,
    segmentation: {
      timeline: summarizeSegmentation(days.map((d) => d.timeline.segmentation.metrics)),
      deterministic: summarizeSegmentation(days.map((d) => d.deterministic.segmentation.metrics)),
    },
    classification: {
      timeline: {
        matched: mergeClassificationScores(days.map((d) => d.timeline.classification.matched)),
        byTime: mergeClassificationScores(days.map((d) => d.timeline.classification.byTime)),
      },
      deterministic: {
        matched: mergeClassificationScores(days.map((d) => d.deterministic.classification.matched)),
        byTime: mergeClassificationScores(days.map((d) => d.deterministic.classification.byTime)),
      },
      reflectContextMs,
    },
    reflection: {
      reportsGenerated: days.filter((d) => d.reflection.generated).length,
      deterministic: countByGroup(deterministic),
      semantic: countByGroup(semantic),
      deterministicOverall: countVerdicts(deterministic.map((c) => c.verdict)),
      semanticOverall: countVerdicts(semantic.map((c) => c.verdict)),
    },
    coach: {
      actionsPerDay,
      criteria: countByGroup(coach),
      overall: countVerdicts(coach.map((c) => c.verdict)),
      dimensions: summarizeCoachDimensions(
        days.map((d) => d.coach.assessment),
        finalActionStates,
      ),
    },
    mappingIssues: [...new Set(days.flatMap((d) => d.mappingIssues))],
  };
}
