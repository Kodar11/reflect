import type { IEventRepository } from '../database/EventRepository.js';
import { MAX_EVIDENCE_EVENT_IDS, type ReflectionEvidence, type ReflectionReport } from './ReflectionModels.js';

/**
 * Which renderer mutations can change what a past reflection was written
 * from, and how much of history each one touches.
 *
 * Timeline edits and manual classifications name the events they affect, so
 * only reflections overlapping those events need another look. Rule, Context
 * and undo/redo changes can re-classify any day, so everything is re-checked.
 */

/** Channels after which reflections must be re-verified. */
export const TIMELINE_CHANGE_CHANNELS: readonly string[] = [
  'timeline:apply',
  'timeline:undo',
  'timeline:redo',
  'activities:save',
  'activities:delete',
  'rules:save',
  'rules:delete',
  'categorization:saveOverride',
  'categorization:deleteOverride',
  'categorization:saveEventClassification',
  'categorization:deleteEventClassification',
  'categorization:rememberEventAsRule',
  'learnedRules:confirmCandidate',
];

export const PROFILE_CHANGE_CHANNELS: readonly string[] = ['userProfile:save', 'userProfile:update'];

/** Changes that add or remove a rule / Context re-classify all of history. */
const GLOBAL_CHANNELS = new Set([
  'timeline:undo',
  'timeline:redo',
  'activities:save',
  'activities:delete',
  'rules:save',
  'rules:delete',
  'categorization:deleteOverride',
  'categorization:rememberEventAsRule',
  'learnedRules:confirmCandidate',
]);

const TIME_KEYS = new Set(['startedAt', 'endedAt', 'newStartedAt', 'newEndedAt']);

function collect(value: unknown, key: string, ids: Set<number>, times: number[], depth: number): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (/event/i.test(key) && Number.isInteger(value)) ids.add(value);
    return;
  }
  if (typeof value === 'string') {
    if (TIME_KEYS.has(key)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) times.push(t);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, ids, times, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) collect(v, k, ids, times, depth + 1);
  }
}

/**
 * The stretch of history a mutation touched, or `null` when it cannot be
 * narrowed down (then every reflection is re-checked).
 */
export function affectedRange(
  channel: string,
  payload: unknown,
  events: Pick<IEventRepository, 'getByIds'>,
): { start: string; end: string } | null {
  if (GLOBAL_CHANNELS.has(channel)) return null;
  // "Remember this" turns a correction into a rule, which reaches all of history.
  if ((payload as { remember?: unknown } | null)?.remember === true) return null;

  const ids = new Set<number>();
  const times: number[] = [];
  collect(payload, '', ids, times, 0);
  if (ids.size > 0) {
    for (const event of events.getByIds([...ids])) {
      times.push(Date.parse(event.startedAt), Date.parse(event.endedAt));
    }
  }
  const known = times.filter((t) => !Number.isNaN(t));
  if (known.length === 0) return null;
  return { start: new Date(Math.min(...known)).toISOString(), end: new Date(Math.max(...known) + 1).toISOString() };
}

// ── Removed events ──────────────────────────────────────────────────────────

/**
 * Events the user hid or deleted, with what stood on them when they went:
 * the timeline blocks that held them (AI activities and deterministic
 * sessions alike). Derived data is matched against this — never against the
 * events' titles or URLs, which are not carried here.
 */
export interface RemovedEvents {
  eventIds: number[];
  /** When each removed event happened. */
  ranges: { start: string; end: string }[];
  /** Ids of the blocks that held one of them. */
  activityIds: string[];
}

/** Why a report that was written from a removed event is stale. */
export const EVENTS_REMOVED_REASON = 'events_removed';

/** Shown in place of a headline that was written from a removed event. */
export const EVENTS_REMOVED_HEADLINE = 'This reflection is being rewritten because an event it was written from was removed.';

type ActivityReference = Pick<ReflectionEvidence, 'eventIds' | 'activityId' | 'period'> & { kind?: string };

/**
 * Does this reference to a timeline block rest on a removed event?
 *
 * Event ids decide when the reference lists them all. A reference that lists
 * none, or only a capped sample, is also matched by the block's id and — as
 * the last resort — by the stretch of time it covered.
 */
export function citesRemovedEvents(ref: ActivityReference, removed: RemovedEvents): boolean {
  const ids = ref.eventIds ?? [];
  if (ids.some((id) => removed.eventIds.includes(id))) return true;
  if (ref.activityId !== undefined && removed.activityIds.includes(ref.activityId)) return true;
  if (ref.kind !== 'activity' || !ref.period) return false;
  if (ids.length > 0 && ids.length < MAX_EVIDENCE_EVENT_IDS) return false;
  const { start, end } = ref.period;
  return removed.ranges.some((r) => r.start <= end && r.end >= start);
}

/** What has to leave a stored report because it was written from a removed event. */
export interface ReportRedaction {
  insightIds: string[];
  carryForward: boolean;
  /** Indexes into `dataSnapshot.activities`. */
  snapshotActivities: number[];
}

/**
 * The parts of a report that rest on removed events, or `null` when the
 * report never saw them. Only what is structurally tied to the events is
 * found here; what the model wrote in free prose is handled by the caller.
 */
export function planReportRedaction(
  report: Pick<ReflectionReport, 'insights' | 'carryForward' | 'dataSnapshot'>,
  removed: RemovedEvents,
): ReportRedaction | null {
  const cites = (evidence: ReflectionEvidence[], sourceActivityIds: string[]) =>
    evidence.some((e) => citesRemovedEvents(e, removed)) || sourceActivityIds.some((id) => removed.activityIds.includes(id));

  const insightIds = report.insights.filter((i) => cites(i.evidence, i.sourceActivityIds)).map((i) => i.id);
  const carryForward = report.carryForward !== null && cites(report.carryForward.evidence, report.carryForward.sourceActivityIds);
  const snapshotActivities: number[] = [];
  (report.dataSnapshot?.activities ?? []).forEach((a, index) => {
    const ref = { kind: 'activity', activityId: a.id, eventIds: a.eventIds, period: { start: a.startedAt, end: a.endedAt } };
    if (citesRemovedEvents(ref, removed)) snapshotActivities.push(index);
  });

  if (insightIds.length === 0 && !carryForward && snapshotActivities.length === 0) return null;
  return { insightIds, carryForward, snapshotActivities };
}
