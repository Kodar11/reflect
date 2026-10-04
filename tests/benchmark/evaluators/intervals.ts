/**
 * Interval arithmetic on epoch-millisecond ranges `[start, end)`. Pure, and
 * free of any local-time function, so results never depend on the timezone
 * the evaluator runs in.
 */

export type Interval = readonly [number, number];

/** Sort and merge touching / overlapping intervals; drop empty ones. */
export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function totalLength(intervals: readonly Interval[]): number {
  return normalize(intervals).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Intersection of two interval sets. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i][0], y[j][0]);
    const end = Math.min(x[i][1], y[j][1]);
    if (end > start) out.push([start, end]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

export function intersectionLength(a: readonly Interval[], b: readonly Interval[]): number {
  return intersect(a, b).reduce((sum, [s, e]) => sum + (e - s), 0);
}

export function unionLength(a: readonly Interval[], b: readonly Interval[]): number {
  return totalLength([...a, ...b]);
}

/** Temporal intersection-over-union of two interval sets (0 when both are empty). */
export function temporalIou(a: readonly Interval[], b: readonly Interval[]): number {
  const union = unionLength(a, b);
  return union > 0 ? intersectionLength(a, b) / union : 0;
}
