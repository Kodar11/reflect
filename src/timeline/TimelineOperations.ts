import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';
import type {
  VerifiedSession,
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
  OverrideEnvelopePayload,
  DuplicatePayload,
  NotePayload,
  MarkOfflinePayload,
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
 *   - split halves: `s-{halfFirstEventId}-{halfLen}-e{editId}`
 *   - merged session: `m-{editId}`
 *   - offline session: `u-{editId}`
 *   - duplicated session: `d-{editId}`
 *   - envelope override: `o-{editId}`
 * Generated, untouched sessions keep their Stage-2 `s-...` id.
 */

export interface OpCtx {
  editId: number;
  events: VerifiedSession[];
}

export type OpResult = VerifiedSession[];

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

export function applySplit(
  { editId, events }: OpCtx,
  payload: SplitPayload,
): OpResult {
  const idx = events.findIndex((s) => s.events.some((e) => e.id === payload.afterEventId));
  if (idx < 0) return events;

  const target = events[idx];
  const splitAt = target.events.findIndex((e) => e.id === payload.afterEventId);
  if (splitAt < 0 || splitAt === target.events.length - 1) return events;

  const firstHalf = target.events.slice(0, splitAt + 1);
  const secondHalf = target.events.slice(splitAt + 1);
  if (secondHalf.length === 0) return events;

  const a = toVerified(stripStats(fromEvents(firstHalf, splitId(firstHalf, editId))), 'generated');
  const b = toVerified(stripStats(fromEvents(secondHalf, splitId(secondHalf, editId))), 'generated');
  a.customTitle = target.customTitle;
  a.note = target.note;

  // Preserve user-overridden envelope bounds if they were modified from the natural event times.
  const firstEv = target.events[0];
  const lastEv = target.events[target.events.length - 1];
  const naturalTargetStart = firstEv ? new Date(firstEv.startedAt).getTime() : target.startedAt.getTime();
  const naturalTargetEnd = lastEv ? new Date(lastEv.endedAt).getTime() : target.endedAt.getTime();

  if (target.startedAt.getTime() !== naturalTargetStart) {
    a.startedAt = target.startedAt;
    a.duration = Math.max(0, a.endedAt.getTime() - a.startedAt.getTime());
  }
  if (target.endedAt.getTime() !== naturalTargetEnd) {
    b.endedAt = target.endedAt;
    b.duration = Math.max(0, b.endedAt.getTime() - b.startedAt.getTime());
  }

  return [...events.slice(0, idx), a, b, ...events.slice(idx + 1)];
}

export function applyMerge(
  { editId, events }: OpCtx,
  payload: MergePayload,
): OpResult {
  let boundaries: { boundaryFromEventId: number; boundaryToEventId: number }[];
  if (payload.boundaries && payload.boundaries.length > 0) {
    boundaries = payload.boundaries;
  } else if (
    typeof payload.boundaryFromEventId === 'number' &&
    typeof payload.boundaryToEventId === 'number'
  ) {
    boundaries = [{ boundaryFromEventId: payload.boundaryFromEventId, boundaryToEventId: payload.boundaryToEventId }];
  } else {
    return events;
  }

  // Merge sequentially from the working list. After each merge the array is
  // shorter, so re-derive indices for the next boundary.
  let working = events;
  for (const { boundaryFromEventId, boundaryToEventId } of boundaries) {
    const fromIdx = working.findIndex((s) => lastEventId(s) === boundaryFromEventId);
    if (fromIdx < 0) continue;
    const toIdx = fromIdx + 1;
    if (toIdx >= working.length) continue;
    const next = working[toIdx];
    if (firstEventId(next) !== boundaryToEventId) continue;

    const merged = toVerified(
      stripStats(fromEvents([...working[fromIdx].events, ...next.events] as Event[], `m-${editId}`)),
      'generated',
    );
    merged.customTitle = working[fromIdx].customTitle ?? next.customTitle;
    merged.note = working[fromIdx].note ?? next.note;

    // Preserve start of the first session and end of the second session if they had overrides
    const firstEvOfFirst = working[fromIdx].events[0];
    const lastEvOfSecond = next.events[next.events.length - 1];
    const naturalFirstStart = firstEvOfFirst ? new Date(firstEvOfFirst.startedAt).getTime() : working[fromIdx].startedAt.getTime();
    const naturalLastEnd = lastEvOfSecond ? new Date(lastEvOfSecond.endedAt).getTime() : next.endedAt.getTime();

    if (working[fromIdx].startedAt.getTime() !== naturalFirstStart) {
      merged.startedAt = working[fromIdx].startedAt;
    }
    if (next.endedAt.getTime() !== naturalLastEnd) {
      merged.endedAt = next.endedAt;
    }
    merged.duration = Math.max(0, merged.endedAt.getTime() - merged.startedAt.getTime());

    working = [...working.slice(0, fromIdx), merged, ...working.slice(toIdx + 1)];
  }
  return working;
}

export function applyDelete(
  { events }: OpCtx,
  payload: DeletePayload,
): OpResult {
  const want = sortedKey(payload.eventIds);
  return events.map((s) => {
    const have = sortedKey(s.events.map((e) => e.id));
    return have === want ? { ...s, hidden: true } : s;
  });
}

export function applyCreateOffline(
  { editId, events }: OpCtx,
  payload: CreateOfflinePayload,
): OpResult {
  const started = new Date(payload.startedAt);
  const ended = new Date(payload.endedAt);
  const session = makeOfflineLike({
    id: `u-${editId}`,
    startedAt: started,
    endedAt: ended,
    title: payload.title,
    app: payload.app,
    browser: payload.browser,
  });

  const insertPos = events.findIndex((s) => s.startedAt.getTime() > started.getTime());
  const at = insertPos < 0 ? events.length : insertPos;
  return [...events.slice(0, at), session, ...events.slice(at)];
}

/** OVERRIDE_ENVELOPE — move/resize a session. The original is hidden (so undo
 * restores it) and a new session with the same events but the new envelope is
 * emitted. This is the one drag/resize edit operation (schema-free). */
export function applyOverrideEnvelope(
  { editId, events }: OpCtx,
  payload: OverrideEnvelopePayload,
): OpResult {
  const want = sortedKey(payload.eventIds);
  const idx = events.findIndex((s) => sortedKey(s.events.map((e) => e.id)) === want);
  if (idx < 0) return events;

  const target = events[idx];
  const newStarted = new Date(payload.newStartedAt);
  const newEnded = new Date(payload.newEndedAt);
  const moved: VerifiedSession = {
    ...target,
    id: `o-${editId}`,
    startedAt: newStarted,
    endedAt: newEnded,
    duration: Math.max(0, newEnded.getTime() - newStarted.getTime()),
    activeDuration: 0,
    source: target.source,
  };

  const hiddenOriginal = { ...target, hidden: true };
  const insertPos = events.findIndex((s) => s.startedAt.getTime() > newStarted.getTime());
  const at = insertPos < 0 ? events.length : insertPos;

  // Remove original from its old position, hide it, and splice the moved copy
  // at the new time. This keeps the working array sorted and deterministic.
  const withoutOriginal = [...events.slice(0, idx), ...events.slice(idx + 1)];
  const insertAt = withoutOriginal.findIndex((s) => s.startedAt.getTime() > newStarted.getTime());
  const place = insertAt < 0 ? withoutOriginal.length : insertAt;
  return [
    ...withoutOriginal.slice(0, place),
    moved,
    ...withoutOriginal.slice(place),
    hiddenOriginal, // hidden at end; engine will drop it later
  ];
}

export function applyDuplicate(
  { editId, events }: OpCtx,
  payload: DuplicatePayload,
): OpResult {
  const want = sortedKey(payload.eventIds);
  const idx = events.findIndex((s) => sortedKey(s.events.map((e) => e.id)) === want);
  if (idx < 0) return events;

  const target = events[idx];
  const offset = (payload.offsetMinutes ?? 30) * 60_000;
  const started = new Date(target.startedAt.getTime() + offset);
  const ended = new Date(target.endedAt.getTime() + offset);
  const duplicate: VerifiedSession = {
    ...target,
    id: `d-${editId}`,
    startedAt: started,
    endedAt: ended,
    duration: target.duration,
    activeDuration: 0,
    source: 'user',
    customTitle: target.customTitle ?? target.primaryTitle ?? 'Copy',
  };

  const insertPos = events.findIndex((s) => s.startedAt.getTime() > started.getTime());
  const at = insertPos < 0 ? events.length : insertPos;
  return [...events.slice(0, at), duplicate, ...events.slice(at)];
}

export function applyNote(
  { events }: OpCtx,
  payload: NotePayload,
): OpResult {
  const want = sortedKey(payload.eventIds);
  return events.map((s) => {
    const have = sortedKey(s.events.map((e) => e.id));
    return have === want ? { ...s, note: payload.note } : s;
  });
}

export function applyMarkOffline(
  { events }: OpCtx,
  payload: MarkOfflinePayload,
): OpResult {
  const want = sortedKey(payload.eventIds);
  return events.map((s) => {
    const have = sortedKey(s.events.map((e) => e.id));
    return have === want
      ? { ...s, source: payload.offline ? 'user' : 'generated' as const }
      : s;
  });
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

function sortedKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
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

function stripStats(s: Session): Session {
  return computeStatistics(s);
}

function makeOfflineLike(opts: {
  id: string;
  startedAt: Date;
  endedAt: Date;
  title: string;
  app?: string;
  browser?: string;
}): VerifiedSession {
  return {
    id: opts.id,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    duration: Math.max(0, opts.endedAt.getTime() - opts.startedAt.getTime()),
    activeDuration: 0,
    events: [],
    customTitle: opts.title,
    primaryApp: opts.app,
    primaryBrowser: opts.browser,
    primaryTitle: opts.title,
    primaryUrl: undefined,
    appsUsed: opts.app ? [opts.app] : [],
    browserTabs: [],
    eventCount: 0,
    source: 'user',
    hidden: false,
  };
}