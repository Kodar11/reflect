import { intersectionLength, normalize, temporalIou, totalLength, type Interval } from './intervals';

/**
 * Activity / sessionization evaluation. Deterministic and title-blind: a
 * predicted block is compared with a ground-truth activity by WHEN it happened
 * and WHICH raw events it owns — never by how it was worded.
 */

/** One segment of a segmentation: a ground-truth activity or a predicted block. */
export interface Segment {
  id: string;
  /** Ids of the raw events the segment owns (dataset ids on both sides). */
  eventIds: number[];
  /** Tracked time: the segment's event intervals. */
  intervals: Interval[];
}

export interface TimedEvent {
  id: number;
  startMs: number;
  endMs: number;
}

export interface SegmentationConfig {
  iouThreshold: number;
  boundaryToleranceMs: number;
  minOverlapMs: number;
}

export interface SegmentMatch {
  groundTruthId: string;
  predictedId: string;
  iou: number;
  eventJaccard: number;
}

export interface SegmentationMetrics {
  groundTruthCount: number;
  predictedCount: number;
  matchedCount: number;
  precision: number;
  recall: number;
  f1: number;
  /** Mean temporal IoU of the matched pairs (null when nothing matched). */
  meanIouMatched: number | null;
  /** Mean over ALL ground-truth activities of their best IoU with any predicted block. */
  meanBestIou: number;
  /** The same, weighted by each ground-truth activity's tracked time. */
  durationWeightedIou: number;
  /** Share of ground-truth tracked time that lies inside some predicted block. */
  groundTruthCoverage: number;
  /** Share of ground-truth tracked time that lies inside the block it was matched to. */
  matchedCoverage: number;
  /** Mean number of predicted blocks each ground-truth activity is spread over (1 = not split). */
  overSegmentationRatio: number;
  /** Share of ground-truth activities spread over more than one predicted block. */
  overSegmentedShare: number;
  /** Mean number of ground-truth activities each predicted block covers (1 = not merged). */
  underSegmentationRatio: number;
  /** Share of predicted blocks that cover more than one ground-truth activity. */
  underSegmentedShare: number;
  groundTruthBoundaries: number;
  predictedBoundaries: number;
  matchedBoundaries: number;
  boundaryPrecision: number;
  boundaryRecall: number;
  boundaryF1: number;
  /** Mean distance from each ground-truth boundary to the nearest predicted boundary (null: no boundaries). */
  boundaryMaeMs: number | null;
  /** Mean |predicted − ground-truth| tracked time over matched pairs. */
  durationAbsErrorMs: number | null;
  /** Mean |predicted − ground-truth| / ground-truth tracked time over matched pairs. */
  durationRelError: number | null;
  groundTruthTrackedMs: number;
  predictedTrackedMs: number;
}

export interface SegmentationResult {
  metrics: SegmentationMetrics;
  matches: SegmentMatch[];
  unmatchedGroundTruth: string[];
  unmatchedPredicted: string[];
  /** Best predicted block (any IoU) per ground-truth activity, for inspection. */
  bestPerGroundTruth: { groundTruthId: string; predictedId: string | null; iou: number }[];
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : 0);
const f1Of = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
const meanOf = (values: number[]) => (values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null);

function eventJaccard(a: number[], b: number[]): number {
  const setA = new Set(a);
  const shared = b.filter((id) => setA.has(id)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? shared / union : 0;
}

/**
 * One-to-one matching, highest temporal IoU first. Ties are broken by event
 * ownership and then by id, so the same inputs always match the same way.
 */
export function matchSegments(groundTruth: Segment[], predicted: Segment[], iouThreshold: number): SegmentMatch[] {
  const candidates: SegmentMatch[] = [];
  for (const g of groundTruth) {
    for (const p of predicted) {
      const iou = temporalIou(g.intervals, p.intervals);
      if (iou >= iouThreshold && iou > 0) {
        candidates.push({ groundTruthId: g.id, predictedId: p.id, iou, eventJaccard: eventJaccard(g.eventIds, p.eventIds) });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.iou - a.iou ||
      b.eventJaccard - a.eventJaccard ||
      (a.groundTruthId < b.groundTruthId ? -1 : a.groundTruthId > b.groundTruthId ? 1 : 0) ||
      (a.predictedId < b.predictedId ? -1 : a.predictedId > b.predictedId ? 1 : 0),
  );
  const usedGt = new Set<string>();
  const usedPred = new Set<string>();
  const matches: SegmentMatch[] = [];
  for (const c of candidates) {
    if (usedGt.has(c.groundTruthId) || usedPred.has(c.predictedId)) continue;
    usedGt.add(c.groundTruthId);
    usedPred.add(c.predictedId);
    matches.push(c);
  }
  return matches;
}

/**
 * Boundaries of a segmentation: walking the day's raw events in order, a
 * boundary sits at the start of every event owned by a different segment than
 * the event before it. The first event of the day is not a boundary — both
 * sides get it for free.
 */
export function boundariesOf(segments: Segment[], events: TimedEvent[]): number[] {
  const owner = new Map<number, string>();
  for (const segment of segments) for (const id of segment.eventIds) owner.set(id, segment.id);
  const ordered = [...events].sort((a, b) => a.startMs - b.startMs || a.id - b.id);
  const out: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const before = owner.get(ordered[i - 1].id) ?? null;
    const here = owner.get(ordered[i].id) ?? null;
    if (before !== here) out.push(ordered[i].startMs);
  }
  return out;
}

/** One-to-one boundary matching within `toleranceMs`, nearest first. */
export function matchBoundaries(groundTruth: number[], predicted: number[], toleranceMs: number): number {
  const pairs: { g: number; p: number; d: number }[] = [];
  groundTruth.forEach((gt, g) =>
    predicted.forEach((pr, p) => {
      const d = Math.abs(gt - pr);
      if (d <= toleranceMs) pairs.push({ g, p, d });
    }),
  );
  pairs.sort((a, b) => a.d - b.d || a.g - b.g || a.p - b.p);
  const usedG = new Set<number>();
  const usedP = new Set<number>();
  let matched = 0;
  for (const pair of pairs) {
    if (usedG.has(pair.g) || usedP.has(pair.p)) continue;
    usedG.add(pair.g);
    usedP.add(pair.p);
    matched++;
  }
  return matched;
}

export function evaluateSegmentation(
  groundTruth: Segment[],
  predicted: Segment[],
  events: TimedEvent[],
  config: SegmentationConfig,
): SegmentationResult {
  const gtById = new Map(groundTruth.map((g) => [g.id, g]));
  const predById = new Map(predicted.map((p) => [p.id, p]));
  const matches = matchSegments(groundTruth, predicted, config.iouThreshold);
  const matchedGt = new Set(matches.map((m) => m.groundTruthId));
  const matchedPred = new Set(matches.map((m) => m.predictedId));

  const precision = ratio(matches.length, predicted.length);
  const recall = ratio(matches.length, groundTruth.length);

  // Best IoU per ground-truth activity, whether or not it clears the threshold.
  const bestPerGroundTruth = groundTruth.map((g) => {
    let best: { predictedId: string | null; iou: number } = { predictedId: null, iou: 0 };
    for (const p of predicted) {
      const iou = temporalIou(g.intervals, p.intervals);
      if (iou > best.iou || (iou === best.iou && iou > 0 && best.predictedId !== null && p.id < best.predictedId)) best = { predictedId: p.id, iou };
    }
    return { groundTruthId: g.id, ...best };
  });

  const gtTracked = groundTruth.reduce((sum, g) => sum + totalLength(g.intervals), 0);
  const predTracked = predicted.reduce((sum, p) => sum + totalLength(p.intervals), 0);
  const allPredicted = normalize(predicted.flatMap((p) => p.intervals));
  const covered = groundTruth.reduce((sum, g) => sum + intersectionLength(g.intervals, allPredicted), 0);
  const matchedCovered = matches.reduce(
    (sum, m) => sum + intersectionLength(gtById.get(m.groundTruthId)!.intervals, predById.get(m.predictedId)!.intervals),
    0,
  );

  // Over / under segmentation: how many segments of the other side each one meaningfully overlaps.
  const overlaps = (a: Segment, b: Segment) => intersectionLength(a.intervals, b.intervals) >= config.minOverlapMs;
  const fragmentsPerGt = groundTruth.map((g) => predicted.filter((p) => overlaps(g, p)).length);
  const gtPerPred = predicted.map((p) => groundTruth.filter((g) => overlaps(g, p)).length);
  const coveredGt = fragmentsPerGt.filter((n) => n > 0);
  const coveringPred = gtPerPred.filter((n) => n > 0);

  // Boundaries.
  const gtBoundaries = boundariesOf(groundTruth, events);
  const predBoundaries = boundariesOf(predicted, events);
  const matchedBoundaries = matchBoundaries(gtBoundaries, predBoundaries, config.boundaryToleranceMs);
  // No predicted boundary means none was wrong; no true boundary means none was missed.
  const boundaryPrecision = predBoundaries.length > 0 ? matchedBoundaries / predBoundaries.length : 1;
  const boundaryRecall = gtBoundaries.length > 0 ? matchedBoundaries / gtBoundaries.length : 1;
  const boundaryMaeMs =
    gtBoundaries.length > 0 && predBoundaries.length > 0
      ? meanOf(gtBoundaries.map((gt) => Math.min(...predBoundaries.map((pr) => Math.abs(gt - pr)))))
      : null;

  // Duration error over matched pairs.
  const durationErrors = matches.map((m) => {
    const g = totalLength(gtById.get(m.groundTruthId)!.intervals);
    const p = totalLength(predById.get(m.predictedId)!.intervals);
    return { abs: Math.abs(p - g), rel: g > 0 ? Math.abs(p - g) / g : 0 };
  });

  return {
    metrics: {
      groundTruthCount: groundTruth.length,
      predictedCount: predicted.length,
      matchedCount: matches.length,
      precision,
      recall,
      f1: f1Of(precision, recall),
      meanIouMatched: meanOf(matches.map((m) => m.iou)),
      meanBestIou: meanOf(bestPerGroundTruth.map((b) => b.iou)) ?? 0,
      durationWeightedIou: ratio(
        bestPerGroundTruth.reduce((sum, b) => sum + b.iou * totalLength(gtById.get(b.groundTruthId)!.intervals), 0),
        gtTracked,
      ),
      groundTruthCoverage: ratio(covered, gtTracked),
      matchedCoverage: ratio(matchedCovered, gtTracked),
      overSegmentationRatio: meanOf(coveredGt) ?? 0,
      overSegmentedShare: ratio(fragmentsPerGt.filter((n) => n > 1).length, groundTruth.length),
      underSegmentationRatio: meanOf(coveringPred) ?? 0,
      underSegmentedShare: ratio(gtPerPred.filter((n) => n > 1).length, predicted.length),
      groundTruthBoundaries: gtBoundaries.length,
      predictedBoundaries: predBoundaries.length,
      matchedBoundaries,
      boundaryPrecision,
      boundaryRecall,
      boundaryF1: f1Of(boundaryPrecision, boundaryRecall),
      boundaryMaeMs,
      durationAbsErrorMs: meanOf(durationErrors.map((d) => d.abs)),
      durationRelError: meanOf(durationErrors.map((d) => d.rel)),
      groundTruthTrackedMs: gtTracked,
      predictedTrackedMs: predTracked,
    },
    matches,
    unmatchedGroundTruth: groundTruth.filter((g) => !matchedGt.has(g.id)).map((g) => g.id),
    unmatchedPredicted: predicted.filter((p) => !matchedPred.has(p.id)).map((p) => p.id),
    bestPerGroundTruth,
  };
}

/** Build a segment from the raw events it owns. */
export function segmentFromEvents(id: string, eventIds: number[], eventsById: Map<number, TimedEvent>): Segment {
  const owned = eventIds.map((eventId) => eventsById.get(eventId)).filter((e): e is TimedEvent => e !== undefined);
  return { id, eventIds: owned.map((e) => e.id), intervals: normalize(owned.map((e) => [e.startMs, e.endMs] as Interval)) };
}
