import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';
import type {
  VerifiedSession,
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
} from './TimelineModels.js';
import { toVerified } from './TimelineModels.js';
import { computeStatistics } from '../session/SessionStatistics.js';

/**
 * Pure operation implementations. Each function takes the current working list
 * of `VerifiedSession`s plus the typed payload and the originating edit id
 * (used to namespace newly-minted session ids for split/merge/offline), and
 * returns a NEW list. Input is never mutated; output is a fresh array so the
 * engine can replay confidently and deterministically.
 *
 * Id-namespace strategy:
 *   - split halves: `s-{halfFirstEventId}-{halfLen}-e{editId}` (edit-namespace
 *     guarantees uniqueness even after multiple splits of the same session).
 *   - merged session: `m-{editId}` (one merge = one new session).
 *   - offline session: `u-{editId}`.
 * Generated, untouched sessions keep their Stage-2 `s-...` id.
 */

export interface OpCtx {
  editId: number;
  events: VerifiedSession[];
}

export type OpResult = VerifiedSession[];

/** RENAME — set customTitle on the generated session whose FIRST event's id
 * is the anchor. If the anchor matches no session's first event, the edit is
 * a no-op (the session may have been re-split such that the anchor now starts
 * a sub-session — in that case the rename still attaches if it matches a
 * current first-event id). */
export function applyRename(
  { events }: OpCtx,
  payload: RenamePayload,
): OpResult {
  return events.map((s) => {
    const firstId = s.events[0]?.id;
    if (firstId === payload.anchorEventId) {
      return { ...s, customTitle: payload.newTitle };
    }
    return s;
  });
}

/** SPLIT — partition the session containing `afterEventId` into two halves at
 * that event (the boundary lives in the FIRST half). If `afterEventId` is the
 * session's last event we produce an empty second half — we simply no-op
 * (don't insert a vacuous empty session). If the event isn't found, no-op. */
export function applySplit(
  { editId, events }: OpCtx,
  payload: SplitPayload,
): OpResult {
  const idx = events.findIndex((s) => s.events.some((e) => e.id === payload.afterEventId));
  if (idx < 0) return events;

  const target = events[idx];
  const splitAt = target.events.findIndex((e) => e.id === payload.afterEventId);
  if (splitAt < 0 || splitAt === target.events.length - 1) return events; // nothing after

  const firstHalf = target.events.slice(0, splitAt + 1);
  const secondHalf = target.events.slice(splitAt + 1);
  if (secondHalf.length === 0) return events;

  const a = toVerified(stripStats(fromEvents(firstHalf, splitId(firstHalf, editId))), 'generated');
  const b = toVerified(stripStats(fromEvents(secondHalf, splitId(secondHalf, editId))), 'generated');

  // Split halves keep an inherited custom title only on the first half (the
  // half containing the original session's first event) so a rename applied
  // either BEFORE or AFTER the split lands on the same half. The second half
  // starts unlabeled.
  a.customTitle = target.customTitle;

  return [...events.slice(0, idx), a, b, ...events.slice(idx + 1)];
}

/** MERGE — join two adjacent sessions identified by their boundary event ids:
 * one whose LAST event id === boundaryFromEventId followed by one whose
 * FIRST event id === boundaryToEventId. Adjacency is enforced here; the
 * service also gates the operation, so non-adjacent merges no-op without
 * throwing (the engine must be total). */
export function applyMerge(
  { editId, events }: OpCtx,
  payload: MergePayload,
): OpResult {
  const fromIdx = events.findIndex((s) => lastEventId(s) === payload.boundaryFromEventId);
  if (fromIdx < 0) return events;
  const toIdx = fromIdx + 1;
  if (toIdx >= events.length) return events;
  const next = events[toIdx];
  if (firstEventId(next) !== payload.boundaryToEventId) return events; // not the intended next

  const merged = toVerified(
    stripStats(fromEvents([...events[fromIdx].events, ...next.events] as Event[], `m-${editId}`)),
    'generated',
  );
  // Carry a custom title forward if either half had one (first non-empty wins).
  merged.customTitle = events[fromIdx].customTitle ?? next.customTitle;

  return [...events.slice(0, fromIdx), merged, ...events.slice(toIdx + 1)];
}

/** DELETE — hide the session whose event-id multiset matches the payload's.
 * We compare via sorted id arrays for determinism (exact match). The hidden
 * session is retained internally but filtered from the engine's final output. */
export function applyDelete(
  { events }: OpCtx,
  payload: DeletePayload,
): OpResult {
  const want = [...payload.eventIds].sort((a, b) => a - b).join(',');
  return events.map((s) => {
    const have = s.events.map((e) => e.id).sort((a, b) => a - b).join(',');
    return have === want ? { ...s, hidden: true } : s;
  });
}

/** CREATE_OFFLINE — splice a synthetic `source:'user'` session into the
 * timeline at its `startedAt`. It has no backing raw events; its duration is
 * the envelope and `activeDuration` is 0 (offline activity isn't event-backed). */
export function applyCreateOffline(
  { editId, events }: OpCtx,
  payload: CreateOfflinePayload,
): OpResult {
  const started = new Date(payload.startedAt);
  const ended = new Date(payload.endedAt);
  const session: VerifiedSession = {
    id: `u-${editId}`,
    startedAt: started,
    endedAt: ended,
    duration: Math.max(0, ended.getTime() - started.getTime()),
    activeDuration: 0,
    events: [],
    customTitle: payload.title,
    primaryApp: payload.app,
    primaryBrowser: payload.browser,
    primaryTitle: payload.title,
    primaryUrl: undefined,
    appsUsed: payload.app ? [payload.app] : [],
    browserTabs: [],
    eventCount: 0,
    source: 'user',
    hidden: false,
  };

  // Insert by startedAt; ties broken by id (lexicographic) for determinism.
  const insertPos = events.findIndex((s) => s.startedAt.getTime() > started.getTime());
  const at = insertPos < 0 ? events.length : insertPos;
  return [...events.slice(0, at), session, ...events.slice(at)];
}

/** Drop sessions that ended up hidden by a delete edit. */
export function dropHidden(events: VerifiedSession[]): VerifiedSession[] {
  return events.filter((s) => !s.hidden);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function firstEventId(s: VerifiedSession): number | undefined {
  return s.events[0]?.id;
}
function lastEventId(s: VerifiedSession): number | undefined {
  return s.events[s.events.length - 1]?.id;
}

function splitId(half: Event[], editId: number): string {
  const first = half[0]?.id ?? 0;
  return `s-${first}-${half.length}-e${editId}`;
}

/** Rebuild a Stage-2 `Session` skeleton from events so `computeStatistics`
 * works uniformly on split/merge outputs. */
function fromEvents(events: Event[], id: string): Session {
  return {
    id,
    startedAt: new Date(0),
    endedAt: new Date(0),
    duration: 0,
    activeDuration: 0,
    events,
    appsUsed: [],
    browserTabs: [],
    eventCount: events.length,
  };
}

/** computeStatistics mutates & returns the session. We call it on our skeleton. */
function stripStats(s: Session): Session {
  return computeStatistics(s);
}