import { NULL_LABEL, type DatasetDimension, type ResolvedMapping } from './taxonomyMapping';

/**
 * Classification evaluation, independent of segmentation quality and of any
 * wording. Two views of the same question:
 *
 *   matched   for each ground-truth activity that was matched to a predicted
 *             block, is the block classified as the activity is labelled?
 *   byTime    for every tracked minute, is the block that owns it classified
 *             as the ground-truth activity that owns it is labelled? This view
 *             needs no matching, so a wrong boundary cannot hide a right label.
 *
 * Each dimension reports a lenient accuracy (ambiguous dataset labels are
 * judged against their accept-set) and a strict one (only labels with a single
 * unambiguous Reflect twin). Unmappable labels are excluded from both.
 */

export const DIMENSIONS: readonly DatasetDimension[] = ['context', 'area', 'intent', 'quality'];

/** What Reflect assigned, by Reflect target. */
export interface PredictedLabels {
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  priorityId: string | null;
  /** Reflect's Context (user-defined activity) — reported, never scored: the dataset has no counterpart. */
  contextName: string | null;
  /** Display names, for the confusion table. */
  names: { area: string | null; intent: string | null; quality: string | null; priority: string | null };
}

export type GroundTruthLabels = Record<DatasetDimension, string | null>;

export interface ClassificationSample {
  groundTruth: GroundTruthLabels;
  /** null when no predicted block owns this time / matches this activity. */
  predicted: PredictedLabels | null;
  /** Weight: 1 per matched pair, or milliseconds for the by-time view. */
  weight: number;
}

export interface DimensionScore {
  /** Weight judged (exact + ambiguous labels). */
  evaluated: number;
  correct: number;
  accuracy: number | null;
  /** Only dataset labels with one unambiguous Reflect twin. */
  strictEvaluated: number;
  strictCorrect: number;
  strictAccuracy: number | null;
  /** Weight judged against an accept-set rather than a single value. */
  ambiguous: number;
  /** Weight excluded because the dataset label has no Reflect counterpart. */
  unmappable: number;
}

export interface ClassificationScores {
  samples: number;
  context: DimensionScore;
  area: DimensionScore;
  intent: DimensionScore;
  quality: DimensionScore;
  /** Every mappable dimension correct at once. */
  full: { evaluated: number; correct: number; accuracy: number | null };
  /** dataset label → Reflect value → weight, per dimension. */
  confusion: Record<DatasetDimension, Record<string, Record<string, number>>>;
}

const emptyScore = (): DimensionScore => ({
  evaluated: 0,
  correct: 0,
  accuracy: null,
  strictEvaluated: 0,
  strictCorrect: 0,
  strictAccuracy: null,
  ambiguous: 0,
  unmappable: 0,
});

function predictedValue(dimension: DatasetDimension, mapping: ResolvedMapping, predicted: PredictedLabels | null): { id: string | null; name: string } {
  if (!predicted) return { id: null, name: '(no predicted block)' };
  switch (mapping.dimensions[dimension].target) {
    case 'area':
      return { id: predicted.areaId, name: predicted.names.area ?? '(none)' };
    case 'intent':
      return { id: predicted.intentId, name: predicted.names.intent ?? '(none)' };
    case 'quality':
      return { id: predicted.qualityId, name: predicted.names.quality ?? '(none)' };
    case 'priority':
      return { id: predicted.priorityId, name: predicted.names.priority ?? '(none)' };
  }
}

export function scoreClassification(samples: ClassificationSample[], mapping: ResolvedMapping): ClassificationScores {
  const scores = { context: emptyScore(), area: emptyScore(), intent: emptyScore(), quality: emptyScore() };
  const confusion = { context: {}, area: {}, intent: {}, quality: {} } as ClassificationScores['confusion'];
  const full = { evaluated: 0, correct: 0, accuracy: null as number | null };

  for (const sample of samples) {
    let judgedAny = false;
    let allCorrect = true;
    for (const dimension of DIMENSIONS) {
      const label = sample.groundTruth[dimension] ?? NULL_LABEL;
      const resolved = mapping.dimensions[dimension].labels.get(label);
      const score = scores[dimension];
      const value = predictedValue(dimension, mapping, sample.predicted);

      const row = (confusion[dimension][label] ??= {});
      row[value.name] = (row[value.name] ?? 0) + sample.weight;

      if (!resolved || resolved.kind === 'unmappable') {
        score.unmappable += sample.weight;
        continue;
      }
      // No predicted block at all is a miss, never a match on "no value".
      const correct = sample.predicted !== null && resolved.acceptIds.includes(value.id);
      judgedAny = true;
      if (!correct) allCorrect = false;
      score.evaluated += sample.weight;
      if (correct) score.correct += sample.weight;
      if (resolved.kind === 'exact') {
        score.strictEvaluated += sample.weight;
        if (correct) score.strictCorrect += sample.weight;
      } else {
        score.ambiguous += sample.weight;
      }
    }
    if (judgedAny) {
      full.evaluated += sample.weight;
      if (allCorrect) full.correct += sample.weight;
    }
  }

  for (const dimension of DIMENSIONS) {
    const score = scores[dimension];
    score.accuracy = score.evaluated > 0 ? score.correct / score.evaluated : null;
    score.strictAccuracy = score.strictEvaluated > 0 ? score.strictCorrect / score.strictEvaluated : null;
  }
  full.accuracy = full.evaluated > 0 ? full.correct / full.evaluated : null;

  return { samples: samples.length, ...scores, full, confusion };
}

/** Add up scores of several days (weights are additive; accuracies are recomputed). */
export function mergeClassificationScores(all: ClassificationScores[]): ClassificationScores {
  const merged: ClassificationScores = {
    samples: 0,
    context: emptyScore(),
    area: emptyScore(),
    intent: emptyScore(),
    quality: emptyScore(),
    full: { evaluated: 0, correct: 0, accuracy: null },
    confusion: { context: {}, area: {}, intent: {}, quality: {} },
  };
  for (const scores of all) {
    merged.samples += scores.samples;
    merged.full.evaluated += scores.full.evaluated;
    merged.full.correct += scores.full.correct;
    for (const dimension of DIMENSIONS) {
      const into = merged[dimension];
      const from = scores[dimension];
      into.evaluated += from.evaluated;
      into.correct += from.correct;
      into.strictEvaluated += from.strictEvaluated;
      into.strictCorrect += from.strictCorrect;
      into.ambiguous += from.ambiguous;
      into.unmappable += from.unmappable;
      for (const [label, row] of Object.entries(scores.confusion[dimension])) {
        const target = (merged.confusion[dimension][label] ??= {});
        for (const [name, weight] of Object.entries(row)) target[name] = (target[name] ?? 0) + weight;
      }
    }
  }
  for (const dimension of DIMENSIONS) {
    const score = merged[dimension];
    score.accuracy = score.evaluated > 0 ? score.correct / score.evaluated : null;
    score.strictAccuracy = score.strictEvaluated > 0 ? score.strictCorrect / score.strictEvaluated : null;
  }
  merged.full.accuracy = merged.full.evaluated > 0 ? merged.full.correct / merged.full.evaluated : null;
  return merged;
}
