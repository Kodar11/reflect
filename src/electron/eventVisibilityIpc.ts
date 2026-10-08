import type { EventVisibilityService } from '../service/EventVisibilityService.js';

/**
 * Renderer bridge for the user's control over captured events: hide, restore
 * and permanently delete. Thin frame-validated handlers; the service decides
 * what a removal means for everything derived from the event.
 *
 * `tracker:listHidden` is the one channel that returns hidden events — it
 * backs the "Hidden events" list where they are restored or deleted, and
 * nothing else.
 */
export function registerEventVisibilityIpc(
  service: EventVisibilityService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
) {
  const idsOf = (p: { eventIds?: unknown } | undefined, channel: string): number[] => {
    const ids = Array.isArray(p?.eventIds) ? p.eventIds.filter((id): id is number => Number.isInteger(id)) : [];
    if (ids.length === 0) throw new Error(`${channel} requires event ids`);
    return ids.slice(0, 500);
  };

  ipcMainHandle('tracker:hideEvents', (p?: { eventIds?: unknown }) => service.hide(idsOf(p, 'tracker:hideEvents')));
  ipcMainHandle('tracker:unhideEvents', (p?: { eventIds?: unknown }) => service.unhide(idsOf(p, 'tracker:unhideEvents')));
  ipcMainHandle('tracker:deleteEvents', (p?: { eventIds?: unknown }) => service.deletePermanently(idsOf(p, 'tracker:deleteEvents')));
  ipcMainHandle('tracker:listHidden', (p?: { limit?: number }) => service.listHidden(p?.limit));
}
