import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';

/**
 * Stage 3 — Timeline layer.
 *
 * The timeline layer OVERLAYS user edits on top of the *generated* sessions
 * produced by the pure Stage 2 engine. Generated sessions are immutable; this
 * layer only ever reads them. Edits live in a separate, append-only log
 * (`timeline_edits`) and are re-applied (replayed) on every derivation so the
 * raw events remain the single source of truth.
 *
 * Layers:
 *   PURE  — TimelineModels, TimelineEdits, TimelineOperations, TimelineEngine.
 *           No React / SQLite / Electron / Date.now / Math.random. Same input
 *           always yields the same verified timeline.
 *   IMPURE — TimelineService (injects IEditRepository + SessionService),
 *            timelineIpc (renderer bridge).
 *
 * Edit references use EVENT IDS (durable, primary keys) rather than generated
 * session ids so an improved Stage-2 algorithm later (which may regenerate
 * different session ids) won't dangle the edit log.
 */

/**
 * A `VerifiedSession` is a generated session (or a purely synthetic "offline"
 * session) plus the user-applied overlays: a custom name, a source tag, and
 * a hidden flag. All overlays are products of replaying the edit log.
 */
export interface VerifiedSession {
  /** Generated sessions use the Stage-2 id (`s-{firstEventId}-{count}`).
   * Offline-inserted sessions use a synthetic `u-{editId}` id so they sort
   * deterministically and stay stable across re-derivations of the same log.
   * Post-split halves derive new ids deterministically (see TimelineOperations). */
  id: string;
  startedAt: Date;
  endedAt: Date;
  duration: number;
  activeDuration: number;
  events: Event[];
  /** Alias for the primary title used by the timeline UI. When the user renames
   * a session this is the custom value; falls back to Stage-2's `primaryTitle`. */
  customTitle?: string;
  primaryApp?: string;
  primaryBrowser?: string;
  primaryTitle?: string;
  primaryUrl?: string;
  appsUsed: string[];
  browserTabs: string[];
  eventCount: number;
  /** 'generated' = came from the session engine (even if renamed/split/merged).
   * 'user' = created offline by a create_offline edit. Visually identical by
   * spec; this flag is metadata only. */
  source: 'generated' | 'user';
  /** A deleted session stays in the log (so undo can restore it) but is hidden
   * from the verified timeline. */
  hidden: boolean;
  /** User note attached to this session (from `note` edit). */
  note?: string;
  activityId?: string | null;
}

/** Edit operations the log records. Each has a typed `TimelinePayload`.
 * Additions are schema-free: `timeline_edits` stores `operation TEXT` +
 * `payload TEXT`, so new operation strings require no migration. */
export type TimelineOperation =
  | 'rename'
  | 'split'
  | 'merge'
  | 'delete'
  | 'create_offline'
  | 'override_envelope'
  | 'duplicate'
  | 'note'
  | 'mark_offline'
  | 'assign_activity';

/** Base row from the DB; payload is JSON (decoded by helpers). */
export interface TimelineEdit {
  id: number;
  operation: TimelineOperation;
  /** Decoded payload object (typed per operation). */
  payload: TimelinePayload;
  createdAt: string | null;
  /** NULL = active; non-null = logically undone (skipped by the engine). */
  undoneAt: string | null;
}

/** JSON stored in `timeline_edits.payload`. */
export interface RenamePayload {
  /** First event id of the target session (durable anchor across regens). */
  anchorEventId: number;
  oldTitle?: string;
  newTitle: string;
}
export interface SplitPayload {
  /** Event id AFTER which to cut; the boundary event belongs to the FIRST half. */
  afterEventId: number;
}
export interface MergePayload {
  /** Last event id of the first session + first event id of the second. */
  boundaryFromEventId?: number;
  boundaryToEventId?: number;
  /** Stage 3.5 multi-merge: a sequence of boundaries merged in one edit row. */
  boundaries?: { boundaryFromEventId: number; boundaryToEventId: number }[];
}
export interface DeletePayload {
  /** Every event id belonging to the deleted session (durable across regens). */
  eventIds: number[];
}
export interface CreateOfflinePayload {
  startedAt: string; // ISO
  endedAt: string;   // ISO
  title: string;
  app?: string;
  browser?: string;
}
export interface OverrideEnvelopePayload {
  /** Event ids of the session whose envelope is being overridden. */
  eventIds: number[];
  newStartedAt: string; // ISO
  newEndedAt: string;   // ISO
}
export interface DuplicatePayload {
  /** Event ids of the session to duplicate. */
  eventIds: number[];
  /** Minutes offset from the original session's start (default +30). */
  offsetMinutes?: number;
}
export interface NotePayload {
  /** Event ids of the session the note is attached to. */
  eventIds: number[];
  note: string;
}
export interface MarkOfflinePayload {
  /** Event ids of the session to mark as user/offline source. */
  eventIds: number[];
  offline: boolean;
}
export interface AssignActivityPayload {
  eventIds: number[];
  activityId: string | null;
}

export type TimelinePayload =
  | RenamePayload
  | SplitPayload
  | MergePayload
  | DeletePayload
  | CreateOfflinePayload
  | OverrideEnvelopePayload
  | DuplicatePayload
  | NotePayload
  | MarkOfflinePayload
  | AssignActivityPayload;


/** Promote a generated Session to a VerifiedSession (no overlays yet). */
export function toVerified(s: Session, source: 'generated' | 'user' = 'generated'): VerifiedSession {
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    duration: s.duration,
    activeDuration: s.activeDuration,
    events: s.events,
    primaryApp: s.primaryApp,
    primaryBrowser: s.primaryBrowser,
    primaryTitle: s.primaryTitle,
    primaryUrl: s.primaryUrl,
    appsUsed: s.appsUsed,
    browserTabs: s.browserTabs,
    eventCount: s.eventCount,
    source,
    hidden: false,
  };
}

