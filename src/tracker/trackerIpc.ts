import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import { IEventRepository } from '../database/EventRepository.js';
import type { Event } from '../models/Event.js';

/**
 * Thin adapter from the renderer ("tracker:*") IPC channel names to the
 * `IEventRepository`. The renderer must never receive raw DB handles or SQL
 * strings — only the `Event[]` DTO the repository already returns.
 *
 * Uses the existing frame-validated `ipcMainHandle` (passed in by `main.ts`)
 * so a renderer from a wrong origin can't read tracking data. Range args are
 * ISO strings; the repository sorts/limits itself.
 *
 * A "push" seam is kept but dormant for Stage 1: the dev viewer polls
 * `tracker:getToday` every few seconds. When push notifications become wanted,
 * `notifyNewEvent` fans an `tracker:eventAdded` message to every live
 * renderer's WebContents — no other code needs to change.
 */
export function registerTrackerIpc(
  repo: IEventRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  ipcMainHandle('tracker:getToday', () => repo.getToday());
  ipcMainHandle('tracker:getRange', (p?: { from: string; to: string }) => {
    if (!p || !p.from || !p.to) return repo.getAll() as Event[];
    return repo.getByRange(p.from, p.to);
  });
  ipcMainHandle('tracker:getAll', (p?: { limit?: number }) => repo.getAll(p?.limit));

  return {
    notifyNewEvent() {
      for (const wc of webContentsForPush()) {
        ipcWebContentsSend('tracker:eventAdded', wc, null);
      }
    },
  };
}