/**
 * Collision-free layout for the Day / Week timeline. Pure — no React, no DOM.
 *
 * The timeline is a presentation of activities, never an editor of them: every
 * activity it is given gets a rectangle, none is merged, dropped or moved in
 * time. `top` is always the exact start time and `trueHeight` the exact
 * duration; only the lane (the horizontal slot) is a layout decision.
 *
 * Why lanes are computed on what is DRAWN rather than on clock time: an
 * activity needs a few pixels to be visible and clickable, so a one-minute
 * activity is drawn taller than one minute. Lanes assigned from clock times
 * alone let those minimum-height boxes run over the activities that follow.
 * Here the drawn extent is what must not collide.
 *
 *   1. Geometry    top / trueHeight from the clock; the drawn extent is at
 *                  least MIN_MARKER_HEIGHT.
 *   2. Lanes       first-fit interval partitioning over drawn extents, in
 *                  (start, end, id) order — the minimum number of lanes, and
 *                  the same answer for the same activities every time.
 *   3. Clusters    a chain of colliding activities shares one set of lanes;
 *                  when the chain ends the next activity is full width again.
 *                  Lanes mean "at the same time": an activity that merely
 *                  FOLLOWS a sliver is not pushed beside it — it starts a new
 *                  cluster and its box begins just under the sliver (`inset`).
 *   4. Lane widths a lane holding only slivers (a one-second tab switch inside
 *                  a two-hour block) is narrow and sits on the right, so the
 *                  long activity stays prominent.
 *   5. Expansion   an activity widens over lanes to its right that are empty
 *                  for its whole extent.
 *   6. Labels      a short activity grows to one labelled line only where the
 *                  space below it is free. It never grows into another one.
 */
import { DAY_PX_PER_HOUR, startOfDay } from './timelineUtils';

/** Smallest drawn height: enough to see, hover and click. */
export const MIN_MARKER_HEIGHT = 4;
/** Shortest block that can carry a one-line label. */
export const LABEL_MIN_HEIGHT = 14;
/** Height a short activity grows to when the space below it is free. */
export const CHIP_HEIGHT = 20;
/** From here a block shows a title and a time line. */
export const COMPACT_MIN_HEIGHT = 42;
/** From here a block uses the roomy card layout. */
export const FULL_MIN_HEIGHT = 68;
/** Width of a sliver-only lane relative to a normal lane. */
export const SLIM_LANE_WEIGHT = 0.4;

const EPS = 1e-6;

// ── density ─────────────────────────────────────────────────────────────────

/** Time scale of the Day View. A uniform zoom: it never bends the time axis. */
export type TimelineDensity = 'compact' | 'normal' | 'detailed';

export const TIMELINE_DENSITIES: TimelineDensity[] = ['compact', 'normal', 'detailed'];
export const DEFAULT_DENSITY: TimelineDensity = 'normal';

const DENSITY_PX_PER_HOUR: Record<TimelineDensity, number> = {
  compact: DAY_PX_PER_HOUR,
  normal: DAY_PX_PER_HOUR * 2,
  detailed: DAY_PX_PER_HOUR * 4,
};

export function pxPerHourFor(density: TimelineDensity): number {
  return DENSITY_PX_PER_HOUR[density];
}

export function parseDensity(value: unknown): TimelineDensity {
  return TIMELINE_DENSITIES.includes(value as TimelineDensity) ? (value as TimelineDensity) : DEFAULT_DENSITY;
}

// ── block presentation ──────────────────────────────────────────────────────

/**
 * How much a block of a given drawn height can show.
 *   marker  — a sliver: no text, details on hover / click
 *   line    — one line: title and duration
 *   compact — title, plus one line of time and duration
 *   full    — the roomy card
 */
export type BlockMode = 'marker' | 'line' | 'compact' | 'full';

export function blockMode(height: number): BlockMode {
  if (height < LABEL_MIN_HEIGHT) return 'marker';
  if (height < COMPACT_MIN_HEIGHT) return 'line';
  if (height < FULL_MIN_HEIGHT) return 'compact';
  return 'full';
}

// ── layout ──────────────────────────────────────────────────────────────────

export interface LayoutInput {
  id: string;
  startedAt: string | Date;
  endedAt: string | Date;
}

export interface BlockLayout {
  id: string;
  /** Exact start, px from the start of the day. */
  top: number;
  /** Exact duration in px (0 for a zero-length or inverted range). */
  trueHeight: number;
  /**
   * Px trimmed from the top of the drawn box, because the sliver that ends
   * where this block starts needs its minimum height. At most
   * MIN_MARKER_HEIGHT; the box stays inside the block's real extent.
   */
  inset: number;
  /** Drawn height, from `top + inset`: never below MIN_MARKER_HEIGHT, never into another block. */
  height: number;
  /** First lane, left to right, within the cluster. */
  lane: number;
  /** Lanes covered (>= 1). */
  laneSpan: number;
  /** Lanes in this block's cluster. */
  laneCount: number;
  /** Left edge as a fraction of the content width, 0..1. */
  left: number;
  /** Width as a fraction of the content width, 0..1. */
  width: number;
}

export interface DayLayout {
  /** Blocks in (start, end, id) order. */
  blocks: BlockLayout[];
  byId: Map<string, BlockLayout>;
  /** Most lanes any cluster needed. */
  maxLanes: number;
}

interface Placed {
  id: string;
  top: number;
  trueHeight: number;
  inset: number;
  /** End of the drawn extent used for collisions. */
  bottom: number;
  lane: number;
  laneSpan: number;
  laneCount: number;
  left: number;
  width: number;
  height: number;
}

function toMs(value: string | Date): number {
  return typeof value === 'string' ? new Date(value).getTime() : value.getTime();
}

/**
 * Lay out one day's activities.
 *
 * Activities without a readable start time cannot be placed and are skipped;
 * an end before its start (a system-clock change mid-event) is drawn as a
 * zero-length activity at its start.
 */
export function computeDayLayout(
  items: readonly LayoutInput[],
  baseDay: Date,
  pxPerHour: number = DAY_PX_PER_HOUR,
): DayLayout {
  const dayStart = startOfDay(baseDay).getTime();
  const toPx = (ms: number) => ((ms - dayStart) / 3_600_000) * pxPerHour;

  const ordered = items
    .map((item) => {
      const start = toMs(item.startedAt);
      const rawEnd = toMs(item.endedAt);
      const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start;
      return { id: item.id, start, end };
    })
    .filter((item) => Number.isFinite(item.start))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterBottom = -Infinity;
  /** Latest real (clock) end in the open cluster. */
  let clusterTrueBottom = -Infinity;
  /** Bottom of the last block in each lane of the open cluster. */
  let laneBottoms: number[] = [];

  const closeCluster = () => {
    if (cluster.length > 0) finishCluster(cluster, laneBottoms.length);
    cluster = [];
    laneBottoms = [];
    clusterBottom = -Infinity;
    clusterTrueBottom = -Infinity;
  };

  for (const item of ordered) {
    const top = toPx(item.start);
    const trueHeight = Math.max(0, toPx(item.end) - top);
    const bottom = top + Math.max(trueHeight, MIN_MARKER_HEIGHT);

    // Nothing in the open cluster is still running at this start; only the
    // minimum height of its last slivers reaches past it. If this block can
    // give up those few pixels and still carry a label, it follows them in a
    // new cluster rather than being squeezed beside them.
    let inset = 0;
    const spill = clusterBottom - top;
    if (
      spill > EPS &&
      top >= clusterTrueBottom - EPS &&
      spill <= MIN_MARKER_HEIGHT + EPS &&
      trueHeight - spill >= LABEL_MIN_HEIGHT
    ) {
      inset = spill;
      closeCluster();
    }

    if (top >= clusterBottom - EPS) closeCluster();

    let lane = laneBottoms.findIndex((laneBottom) => laneBottom <= top + EPS);
    if (lane < 0) lane = laneBottoms.length;
    laneBottoms[lane] = bottom;
    clusterBottom = Math.max(clusterBottom, bottom);
    clusterTrueBottom = Math.max(clusterTrueBottom, top + trueHeight);

    const block: Placed = {
      id: item.id,
      top,
      trueHeight,
      inset,
      bottom,
      lane,
      laneSpan: 1,
      laneCount: 1,
      left: 0,
      width: 1,
      height: bottom - top - inset,
    };
    cluster.push(block);
    placed.push(block);
  }
  closeCluster();

  growLabels(placed);

  const blocks: BlockLayout[] = placed.map((b) => ({
    id: b.id,
    top: b.top,
    trueHeight: b.trueHeight,
    inset: b.inset,
    height: b.height,
    lane: b.lane,
    laneSpan: b.laneSpan,
    laneCount: b.laneCount,
    left: b.left,
    width: b.width,
  }));

  return {
    blocks,
    byId: new Map(blocks.map((b) => [b.id, b])),
    maxLanes: blocks.reduce((max, b) => Math.max(max, b.laneCount), blocks.length > 0 ? 1 : 0),
  };
}

/** Steps 4 and 5: order and size the lanes of one cluster, then widen blocks. */
function finishCluster(cluster: Placed[], laneCount: number): void {
  const lanes: Placed[][] = Array.from({ length: laneCount }, () => []);
  for (const block of cluster) lanes[block.lane].push(block);

  // A lane is slim when nothing in it is long enough to carry a label.
  const slim = lanes.map((lane) => lane.every((b) => b.trueHeight < LABEL_MIN_HEIGHT));
  const allSlim = slim.every(Boolean);

  // Lanes with real blocks first; slim lanes after them. Stable otherwise.
  const order = lanes.map((_, i) => i).sort((a, b) => Number(slim[a]) - Number(slim[b]) || a - b);
  const weights = order.map((i) => (!allSlim && slim[i] ? SLIM_LANE_WEIGHT : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);

  const offsets: number[] = [];
  let acc = 0;
  for (const w of weights) {
    offsets.push(acc / total);
    acc += w;
  }

  const ordered = order.map((i) => lanes[i]);
  ordered.forEach((lane, index) => {
    for (const block of lane) {
      block.lane = index;
      block.laneCount = laneCount;
    }
  });

  const collides = (a: Placed, b: Placed) => a.top < b.bottom - EPS && b.top < a.bottom - EPS;

  for (const block of cluster) {
    let span = 1;
    while (block.lane + span < laneCount && !ordered[block.lane + span].some((other) => collides(block, other))) {
      span++;
    }
    block.laneSpan = span;
    block.left = offsets[block.lane];
    let width = 0;
    for (let i = block.lane; i < block.lane + span; i++) width += weights[i];
    block.width = width / total;
  }
}

/**
 * Step 6: a block too short for a label grows to one labelled line when
 * nothing below it — in the columns it covers — starts before the line ends.
 * `placed` is in start order, so only the blocks that follow can be in the way.
 */
function growLabels(placed: Placed[]): void {
  for (let i = 0; i < placed.length; i++) {
    const block = placed[i];
    if (block.height >= CHIP_HEIGHT) continue;

    const drawnTop = block.top + block.inset;
    let free = CHIP_HEIGHT;
    for (let j = i + 1; j < placed.length; j++) {
      const next = placed[j];
      if (next.top - drawnTop >= free) break;
      const sideBySide = next.left >= block.left + block.width - EPS || block.left >= next.left + next.width - EPS;
      if (!sideBySide) {
        free = Math.min(free, next.top + next.inset - drawnTop);
        break;
      }
    }

    // Growing is only worth it when it buys a readable line.
    if (free >= LABEL_MIN_HEIGHT && free > block.height) block.height = free;
  }
}

/** The block under a point, if any. Fractions for x, px for y. */
export function blockAt(layout: DayLayout, xFraction: number, y: number): BlockLayout | null {
  for (const b of layout.blocks) {
    const top = b.top + b.inset;
    if (xFraction >= b.left && xFraction < b.left + b.width && y >= top && y < top + b.height) return b;
  }
  return null;
}
