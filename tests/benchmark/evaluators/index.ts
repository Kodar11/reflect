import type { CapturedBlock, CapturedDay, CapturedTaxonomy } from '../runner/capture';
import type { BenchmarkConfig } from '../runner/config';
import type { EvaluationOnly, EvaluationOnlyDay } from '../runner/dataset';
import {
  mergeClassificationScores,
  scoreClassification,
  type ClassificationSample,
  type ClassificationScores,
  type GroundTruthLabels,
  type PredictedLabels,
} from './classification';
import { ACTION_TYPE_MAPPING, KNOWN_TARGETS, evaluateCoach, type CoachEvaluation } from './coach';
import { evaluateReflection, progressLevel, type ReflectionEvaluation } from './reflection';
import { evaluateSegmentation, segmentFromEvents, type Segment, type SegmentationMetrics, type SegmentationResult, type TimedEvent } from './segmentation';
import { NULL_LABEL, TAXONOMY_MAPPING, resolveMapping, type DatasetDimension } from './taxonomyMapping';
import type { Criterion, Verdict } from './text';

/**
 * The evaluator's entry points. This is the only place where what Reflect
 * produced (`CapturedDay`) and the answer key (`EvaluationOnlyDay`) meet — and
 * it runs strictly after the day's processing has finished.
 */

/** Bump when a metric's definition changes, so old and new results are not compared blindly. */
export const EVALUATOR_VERSION = 'reflect-benchmark-eval-v1';

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
  findLeaks: (text: string) => string[];
}

const VIDEO = /youtube|vimeo|\bvideo\b|tutorial/i;

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

  const groundTruth: Segment[] = answer.groundTruth.activities.map((a) => segmentFromEvents(a.id, a.event_ids, eventsById));
  const labelsOf = new Map<string, GroundTruthLabels>(
    answer.groundTruth.activities.map((a) => [a.id, { context: a.context, area: a.area, intent: a.intent, quality: a.quality }]),
  );
  const ownerOf = new Map<number, string>();
  for (const a of answer.groundTruth.activities) for (const id of a.event_ids) ownerOf.set(id, a.id);

  const used: Record<DatasetDimension, (string | null)[]> = { context: [], area: [], intent: [], quality: [] };
  for (const labels of labelsOf.values()) for (const dimension of Object.keys(used) as DatasetDimension[]) used[dimension].push(labels[dimension]);
  const mapping = resolveMapping(
    { areas: ctx.taxonomy.areas, intents: ctx.taxonomy.intents, qualities: ctx.taxonomy.qualities, priorities: captured.priorities },
    used,
  );

  const evaluateTrack = (blocks: CapturedBlock[]): TrackEvaluation => {
    const toDataset = (block: CapturedBlock) => block.eventIds.map((id) => datasetIdOf.get(id)).filter((id): id is number => id !== undefined);
    const predicted = blocks.map((b) => segmentFromEvents(b.id, toDataset(b), eventsById));
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    const segmentation = evaluateSegmentation(groundTruth, predicted, events, ctx.config.matching);

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
    reflectContextMs,
    reflection: evaluateReflection(captured, answer, { semantic: ctx.config.semantic, knownBlockIds: ctx.knownBlockIds, findLeaks: ctx.findLeaks }),
    coach: evaluateCoach(captured, answer, {
      semantic: ctx.config.semantic,
      knownBlockIds: ctx.knownBlockIds,
      hasHistory: ctx.hasHistory,
      workVideoEventIds,
      predictedByEvent,
    }),
    mappingIssues: mapping.issues,
  };
}

// ── Answer-key vocabulary ───────────────────────────────────────────────────

/**
 * Every label the answer key uses must be one the evaluator knows how to
 * read. Checked together with the dataset, so an unknown label fails before a
 * single request is made rather than being scored as "wrong" afterwards.
 */
export function checkAnswerKeyVocabulary(evaluation: EvaluationOnly): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const day of evaluation.days) {
    const at = `day ${day.dayNumber}`;
    for (const activity of day.groundTruth.activities) {
      for (const dimension of ['context', 'area', 'intent', 'quality'] as const) {
        const label = activity[dimension] ?? NULL_LABEL;
        if (!(label in TAXONOMY_MAPPING[dimension].labels)) {
          errors.push(`${at} ${activity.id}: ${dimension} "${label}" has no entry in evaluators/taxonomyMapping.ts`);
        }
      }
    }
    for (const [slot, action] of [['primary_action', day.expectedCoachOutcome.primary_action], ['secondary_action', day.expectedCoachOutcome.secondary_action]] as const) {
      if (!action) continue;
      if (!(action.action_type in ACTION_TYPE_MAPPING)) errors.push(`${at} ${slot}: action_type "${action.action_type}" has no entry in evaluators/coach.ts ACTION_TYPE_MAPPING`);
      if (action.target !== null && !KNOWN_TARGETS.includes(action.target)) errors.push(`${at} ${slot}: target "${action.target}" is not one of ${KNOWN_TARGETS.join(', ')}`);
    }
    for (const entry of day.expectedReflection.priority_alignment) {
      if (progressLevel(entry.assessment) === null) warnings.push(`${at}: priority assessment "${entry.assessment}" is not recognised and will not be scored`);
    }
  }
  return { errors, warnings };
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
  };
  mappingIssues: string[];
}

export function summarize(days: DayEvaluation[]): BenchmarkSummary {
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
    },
    mappingIssues: [...new Set(days.flatMap((d) => d.mappingIssues))],
  };
}
