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
 *     being duplicated;
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
  /** A continuation across a longer silence becomes a new activity. */
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

    segments.forEach((segment, segmentIndex) => {
      const first = byId.get(segment[0])!;
      const continuationId =
        segmentIndex === 0 ? resolveContinuation(activity, first, input) : null;
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

function resolveContinuation(
  activity: ValidatedActivity,
  firstEvent: WindowEvent,
  input: ReconcileInput,
): string | null {
  const id = activity.continuationOfActivityId;
  if (!id) return null;
  const previous = input.previous.get(id);
  if (!previous || previous.userLocked) return null;
  const gap = Date.parse(firstEvent.startedAt) - Date.parse(previous.endedAt);
  return gap <= input.maxContinuationGapMs ? id : null;
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
