import type { VerifiedSessionDto } from '../../timeline/timelineIpc';

/**
 * Resolve which session id should remain selected after a timeline refresh.
 *
 * Session IDs are derived from events and can change for active sessions
 * when new events arrive or sessions are re-derived.
 *
 * Selection therefore uses:
 *
 * 1. The existing session ID, when it still exists.
 * 2. The original anchor event ID, when the session ID changed.
 *
 * The anchor event may appear anywhere in the session's eventIds array.
 *
 * IMPORTANT:
 * We do not immediately clear the selection when the session cannot be
 * resolved during a single refresh. Active sessions are continuously being
 * re-derived, so there can be a temporary mismatch between refreshes.
 * Keeping the existing selection prevents the Inspector from flickering
 * to the Daily Summary.
 */
export function resolveSelection(
  sessions: VerifiedSessionDto[],
  selectedId: string | null,
  anchorEventId: number | null,
): {
  nextId: string | null;
  nextAnchor: number | null;
} {
  // Nothing is currently selected.
  if (!selectedId) {
    return {
      nextId: null,
      nextAnchor: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. The selected session still exists.
  // ─────────────────────────────────────────────────────────────────────

  const selected = sessions.find((session) => session.id === selectedId);

  if (selected) {
    return {
      nextId: selected.id,
      nextAnchor: anchorEventId ?? selected.eventIds[0] ?? null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. The session ID changed.
  //
  // This is expected for an active session because new events can cause
  // the session to be re-derived with a different ID.
  //
  // Find the new session containing the original anchor event.
  // ─────────────────────────────────────────────────────────────────────

  if (anchorEventId !== null) {
    const migrated = sessions.find((session) =>
      session.eventIds.includes(anchorEventId),
    );

    if (migrated) {
      return {
        nextId: migrated.id,
        nextAnchor: anchorEventId,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. Temporary resolution failure.
  //
  // DO NOT clear the selection immediately.
  //
  // The next polling refresh will try to resolve the active session again.
  // Keeping selectedId here prevents:
  //
  //     SessionDetail
  //          ↓
  //     Daily Summary
  //          ↓
  //     SessionDetail
  //
  // which was causing the visible flicker.
  // ─────────────────────────────────────────────────────────────────────

  return {
    nextId: selectedId,
    nextAnchor: anchorEventId,
  };
}