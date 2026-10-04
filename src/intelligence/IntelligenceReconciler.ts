import type {
  ActivityInterpretation,
  ReconcilePlan,
  ValidatedActivity,
} from './IntelligenceModels.js';

/**
 * Turns a validated analysis into an INCREMENTAL write plan. Pure.
 *
 * Invariants the plan upholds:
 *   - an event belongs to at most one active AI activity;
 *   - nothing a user touched is modified: events owned by a `user_locked`
 *     activity, and events of user-edited timeline blocks, stay where they are;
 *   - a continued activity is extended in place (same canonical id) instead of
 *     being duplicated — including when the user returns to it after doing
 *     something else, and when hindsight folds later activities into it;
 *   - only an absence ends an activity for good: a continuation is refused
 *     when nothing at all was tracked for longer than the allowed silence;
 *   - an existing unlocked activity only loses the events the new analysis
 *     actually re-assigned. Nothing is deleted wholesale.
 */

/** A raw event overlapping the window, in chronological order. */
export interface WindowEvent {
  id: number;
  startedAt: string;
  endedAt: string;
}

export interface ReconcileInput {
  /** Every raw event overlapping the window, chronological. */
  windowEvents: WindowEvent[];
  activities: ValidatedActivity[];
  /** Raw events the preprocessor withheld from the model (noise). */
  droppedEventIds: number[];
  /** Current active owner of each window event, if any. */
  memberships: Map<number, { activityId: string; userLocked: boolean }>;
  /** The activities that were offered for continuation. */
  previous: Map<string, { userLocked: boolean; endedAt: string }>;
  /** Events belonging to timeline blocks the user edited. */
  protectedEventIds: Set<number>;
  /**
   * A continuation across a longer SILENCE becomes a new activity. Silence is
   * time with no tracked event at all; time spent on another activity is an
   * interruption, not a silence, and does not count.
   */
  maxContinuationGapMs: number;
  newId: () => string;
}

export function planReconciliation(input: ReconcileInput): ReconcilePlan {
  const order = new Map<number, number>();
  input.windowEvents.forEach((e, i) => order.set(e.id, i));
  const byId = new Map(input.windowEvents.map((e) => [e.id, e]));

  const untouchable = new Set<number>(input.protectedEventIds);
  for (const [eventId, owner] of input.memberships) {
    if (owner.userLocked) untouchable.add(eventId);
  }

  const assigned = absorbDroppedEvents(input, order);

  const plan: ReconcilePlan = { create: [], extend: [], detach: [], userProtectedEventIds: [] };
  const detached = new Map<string, number[]>();

  input.activities.forEach((activity, activityIndex) => {
    const eventIds = assigned[activityIndex].filter((id) => order.has(id));
    const free = eventIds.filter((id) => !untouchable.has(id));
    plan.userProtectedEventIds.push(...eventIds.filter((id) => untouchable.has(id)));
    if (free.length === 0) return;

    const interpretation = interpretationOf(activity);
    const segments = splitAroundUntouchable(free, order, input.windowEvents, untouchable);

    segments.forEach((events, segmentIndex) => {
      const continuation = segmentIndex === 0 ? resolveContinuation(activity, events, input, byId) : null;
      const continuationId = continuation?.accepted ? continuation.activityId : null;
      // A refused continuation leaves the previous activity as it was: only
      // the events it did not already own start the new activity.
      const segment = continuation && !continuation.accepted ? continuation.gained : events;
      if (segment.length === 0) return;
      const targetId = continuationId ?? input.newId();

      if (continuationId) {
        plan.extend.push({ activityId: continuationId, addEventIds: segment, ...interpretation });
      } else {
        plan.create.push({
          id: targetId,
          eventIds: segment,
          startedAt: minIso(segment.map((id) => byId.get(id)!.startedAt)),
          endedAt: maxIso(segment.map((id) => byId.get(id)!.endedAt)),
          ...interpretation,
        });
      }

      // Events moving in from another (unlocked) activity leave it.
      for (const id of segment) {
        const owner = input.memberships.get(id);
        if (owner && owner.activityId !== targetId) {
          const list = detached.get(owner.activityId) ?? [];
          list.push(id);
          detached.set(owner.activityId, list);
        }
      }
    });
  });

  for (const [activityId, eventIds] of detached) plan.detach.push({ activityId, eventIds });
  return plan;
}

/**
 * A noise event sandwiched between two events of the same activity belongs to
 * that activity — otherwise it would surface as a stray fallback block.
 */
function absorbDroppedEvents(input: ReconcileInput, order: Map<number, number>): number[][] {
  const assigned = input.activities.map((a) => [...a.eventIds]);
  if (input.droppedEventIds.length === 0) return assigned;

  const ownerOf = new Map<number, number>();
  assigned.forEach((ids, index) => ids.forEach((id) => ownerOf.set(id, index)));
  const dropped = new Set(input.droppedEventIds);
  const events = input.windowEvents;

  for (const id of input.droppedEventIds) {
    const position = order.get(id);
    if (position === undefined) continue;

    let before = position - 1;
    while (before >= 0 && dropped.has(events[before].id)) before--;
    let after = position + 1;
    while (after < events.length && dropped.has(events[after].id)) after++;
    if (before < 0 || after >= events.length) continue;

    const left = ownerOf.get(events[before].id);
    const right = ownerOf.get(events[after].id);
    if (left !== undefined && left === right) assigned[left].push(id);
  }

  return assigned.map((ids) => ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
}

/**
 * Cut an activity's events wherever a user-owned event sits between them, so
 * no AI block is drawn across something the user edited.
 */
function splitAroundUntouchable(
  eventIds: number[],
  order: Map<number, number>,
  windowEvents: WindowEvent[],
  untouchable: Set<number>,
): number[][] {
  const segments: number[][] = [[eventIds[0]]];
  for (let i = 1; i < eventIds.length; i++) {
    const from = order.get(eventIds[i - 1])!;
    const to = order.get(eventIds[i])!;
    let interrupted = false;
    for (let p = from + 1; p < to; p++) {
      if (untouchable.has(windowEvents[p].id)) {
        interrupted = true;
        break;
      }
    }
    if (interrupted) segments.push([eventIds[i]]);
    else segments[segments.length - 1].push(eventIds[i]);
  }
  return segments;
}

interface ContinuationDecision {
  activityId: string;
  accepted: boolean;
  /** Events the previous activity does not own yet, chronological. */
  gained: number[];
}

/**
 * Whether `events` may join the previous activity the model named.
 *
 * Events the activity already owns are not in question. What it gains must
 * follow it without a long silence: the time between its end and the first
 * event it gains is measured as UNTRACKED time, so an hour spent on something
 * else does not stop the user from resuming, while an hour away does.
 */
function resolveContinuation(
  activity: ValidatedActivity,
  events: number[],
  input: ReconcileInput,
  byId: Map<number, WindowEvent>,
): ContinuationDecision | null {
  const id = activity.continuationOfActivityId;
  if (!id) return null;
  const previous = input.previous.get(id);
  if (!previous || previous.userLocked) return null;

  const gained = events.filter((eventId) => input.memberships.get(eventId)?.activityId !== id);
  if (gained.length === 0) return { activityId: id, accepted: true, gained };

  const previousEnd = Date.parse(previous.endedAt);
  const firstGained = Math.min(...gained.map((eventId) => Date.parse(byId.get(eventId)!.startedAt)));
  const silence = untrackedMs(previousEnd, firstGained, input.windowEvents);
  return { activityId: id, accepted: silence <= input.maxContinuationGapMs, gained };
}

/** Time in [from, to) during which no window event was being tracked. */
function untrackedMs(from: number, to: number, events: WindowEvent[]): number {
  if (to <= from) return 0;
  const spans = events
    .map((e) => [Math.max(from, Date.parse(e.startedAt)), Math.min(to, Date.parse(e.endedAt))] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let tracked = 0;
  let cursor = from;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    tracked += end - Math.max(start, cursor);
    cursor = end;
  }
  return to - from - tracked;
}

function interpretationOf(activity: ValidatedActivity): ActivityInterpretation {
  return {
    title: activity.title,
    summary: activity.summary,
    contextId: activity.contextId,
    areaId: activity.areaId,
    intentId: activity.intentId,
    qualityId: activity.qualityId,
    confidence: activity.confidence,
    uncertainty: activity.uncertainty,
  };
}

function minIso(values: string[]): string {
  return new Date(Math.min(...values.map((v) => Date.parse(v)))).toISOString();
}

function maxIso(values: string[]): string {
  return new Date(Math.max(...values.map((v) => Date.parse(v)))).toISOString();
}
