import type { VerifiedSession } from '../timeline/TimelineModels.js';
import type {
  ActivityAnnotation,
  ReflectionActivity,
  ReflectionActivitySource,
  ReflectionPriority,
  TaxonomyNames,
} from './ReflectionModels.js';
import { matchesPriorityByKeyword, priorityActiveAt, priorityKey } from './ReflectionPriorities.js';

/**
 * Adapter from the verified timeline to what Reflection reasons about. Pure.
 *
 * Reflection sees exactly the activities the user sees: AI activities where
 * they exist, deterministic sessions elsewhere, with user edits and the
 * resolved classification applied. Nothing here reconstructs meaning from app
 * usage — that is the intelligence layer's job.
 */

function sourceOf(s: VerifiedSession): ReflectionActivitySource {
  if (s.source === 'user' || s.customTitle || s.classification?.source === 'user_override') return 'user_override';
  return s.ai ? 'ai' : 'deterministic';
}

/**
 * A human title for the block. A deterministic session has no interpreted
 * title, only a raw window title; Reflection uses the app / site name instead
 * so raw window titles are never sent to the model or stored in a report.
 */
function titleOf(s: VerifiedSession): string {
  if (s.customTitle) return s.customTitle;
  if (s.ai?.title) return s.ai.title;
  if (s.source === 'user' && s.primaryTitle) return s.primaryTitle;
  const parts = [s.primaryApp, s.primaryUrl].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Untitled activity';
}

/**
 * `range` is the window the sessions were queried for. It matters for blocks
 * the user added by hand: the timeline engine replays every offline block into
 * every query, whatever its date, so one outside the window is dropped here —
 * otherwise loading history day by day would count it once per day.
 */
export function toReflectionActivities(
  sessions: VerifiedSession[],
  range?: { start: string; end: string },
): ReflectionActivity[] {
  const from = range ? Date.parse(range.start) : -Infinity;
  const to = range ? Date.parse(range.end) : Infinity;
  const out: ReflectionActivity[] = [];
  for (const s of sessions) {
    if (s.hidden) continue;
    if (s.events.length === 0) {
      const start = s.startedAt.getTime();
      if (start < from || start >= to) continue;
    }
    // Tracked time is the sum of the block's events; an offline block the user
    // added by hand has no events, so its stated range is its duration.
    const ms = s.activeDuration > 0 ? s.activeDuration : s.duration;
    if (!(ms > 0)) continue;
    out.push({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt.toISOString(),
      durationMinutes: ms / 60_000,
      title: titleOf(s),
      summary: s.ai?.summary ?? null,
      contextId: s.classification?.context?.id ?? null,
      areaId: s.classification?.area?.id ?? null,
      intentId: s.classification?.intent?.id ?? null,
      qualityId: s.classification?.quality?.id ?? null,
      source: sourceOf(s),
      app: s.primaryApp ?? null,
      domain: s.primaryUrl ?? null,
      thread: null,
      priorityId: null,
    });
  }
  return out;
}

export function sortActivities(activities: ReflectionActivity[]): ReflectionActivity[] {
  return [...activities].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * Activities are loaded one local day at a time, so a block that crosses
 * midnight arrives as two fragments sharing an id. Reunite them.
 */
export function mergeFragments(activities: ReflectionActivity[]): ReflectionActivity[] {
  const byId = new Map<string, ReflectionActivity>();
  for (const a of activities) {
    const existing = byId.get(a.id);
    if (!existing) {
      byId.set(a.id, { ...a });
      continue;
    }
    if (a.startedAt < existing.startedAt) existing.startedAt = a.startedAt;
    if (a.endedAt > existing.endedAt) existing.endedAt = a.endedAt;
    existing.durationMinutes += a.durationMinutes;
  }
  return sortActivities([...byId.values()]);
}

/** Keep the part of each activity inside [start, end), scaling its time. */
export function clipActivities(activities: ReflectionActivity[], startIso: string, endIso: string): ReflectionActivity[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const out: ReflectionActivity[] = [];
  for (const a of activities) {
    const s = Date.parse(a.startedAt);
    const e = Date.parse(a.endedAt);
    if (s >= start && e <= end) {
      out.push(a);
      continue;
    }
    const cs = Math.max(s, start);
    const ce = Math.min(e, end);
    if (ce <= cs) continue;
    const ratio = e > s ? (ce - cs) / (e - s) : 1;
    out.push({
      ...a,
      startedAt: new Date(cs).toISOString(),
      endedAt: new Date(ce).toISOString(),
      durationMinutes: a.durationMinutes * ratio,
    });
  }
  return out;
}

/** Cache key for thread / priority decisions: same title + Context → same answer. */
export function activitySignature(activity: Pick<ReflectionActivity, 'title' | 'contextId'>): string {
  return `${priorityKey(activity.title)}|${activity.contextId ?? ''}`.slice(0, 240);
}

/** Normalized thread identity (`Project X` and `project  x` are one thread). */
export function threadSlug(label: string): string {
  return priorityKey(label).replace(/ /g, '-').slice(0, 48);
}

/**
 * Attach Reflection's overlay to each activity.
 *
 * thread   = cached annotation → the activity's Context name → none
 * priority = cached decision when the annotation evaluated that priority,
 *            otherwise a conservative keyword match; and only against
 *            priorities that applied when the activity happened.
 */
export function applyAnnotations(
  activities: ReflectionActivity[],
  annotations: Map<string, ActivityAnnotation>,
  priorities: ReflectionPriority[],
  taxonomy: TaxonomyNames,
): ReflectionActivity[] {
  return activities.map((a) => {
    const annotation = annotations.get(activitySignature(a));
    const contextName = a.contextId ? taxonomy.contexts[a.contextId] ?? null : null;
    const thread = annotation?.thread ?? contextName;

    let priorityId: string | null = null;
    const haystack = [a.title, a.summary, contextName, thread].filter(Boolean).join(' ');
    for (const p of priorities) {
      if (!priorityActiveAt(p, a.startedAt)) continue;
      const decided = annotation?.checkedPriorityIds.includes(p.id) ?? false;
      const linked = decided ? annotation!.priorityId === p.id : matchesPriorityByKeyword(p.text, haystack);
      if (linked) {
        priorityId = p.id;
        break;
      }
    }
    return { ...a, thread, priorityId };
  });
}
