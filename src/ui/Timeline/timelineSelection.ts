import type { VerifiedSessionDto } from '../../timeline/timelineIpc';

/**
 * Resolve which session id should be considered selected after a data refresh.
 *
 * Session ids are derived from events and can change for active sessions when
 * new events arrive or sessions are re-derived. To keep the Inspector stable,
 * we migrate selection to a session that starts with the same anchor event id.
 */
export function resolveSelection(
  sessions: VerifiedSessionDto[],
  selectedId: string | null,
  anchorEventId: number | null,
): { nextId: string | null; nextAnchor: number | null } {
  if (!selectedId) {
    return { nextId: null, nextAnchor: null };
  }

  const selected = sessions.find((s) => s.id === selectedId);
  if (selected) {
    return { nextId: selected.id, nextAnchor: selected.eventIds[0] ?? null };
  }

  if (anchorEventId != null) {
    const migrated = sessions.find((s) => s.eventIds[0] === anchorEventId);
    if (migrated) {
      return { nextId: migrated.id, nextAnchor: anchorEventId };
    }
  }

  return { nextId: null, nextAnchor: null };
}
