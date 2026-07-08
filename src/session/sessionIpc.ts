import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type { SessionService } from './SessionService.js';
import type { Session } from './Session.js';

/**
 * Thin adapter from the renderer ("session:*") IPC channel names to the
 * `SessionService`. Mirrors `trackerIpc.ts` so the two read paths look
 * symmetric from the renderer's perspective.
 *
 * Uses the existing frame-validated `ipcMainHandle` (passed in by `main.ts`)
 * so a renderer from a wrong origin can't read session data. DTOs are plain
 * JSON (sessions are in-memory only); the renderer never imports the engine.
 */
export interface SessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
}

export function registerSessionIpc(
  service: SessionService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  ipcMainHandle('session:getToday', () => service.getToday().map(toDto));
  ipcMainHandle('session:getRange', (p?: { from: string; to: string }) => {
    if (!p || !p.from || !p.to) return service.getAll().map(toDto);
    return service.getByRange(p.from, p.to).map(toDto);
  });
  ipcMainHandle('session:getAll', (p?: { limit?: number }) =>
    service.getAll(p?.limit).map(toDto),
  );

  // Dormant push seam (Stage 2 polls). Reserved so a later stage can notify
  // the renderer that the underlying raw events changed and it should refresh.
  return {
    notifySessionsChanged() {
      for (const wc of webContentsForPush()) {
        ipcWebContentsSend('session:changed', wc, null);
      }
    },
  };
}

function toDto(s: Session): SessionDto {
  return {
    id: s.id,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt.toISOString(),
    duration: s.duration,
    activeDuration: s.activeDuration,
    eventCount: s.eventCount,
    primaryApp: s.primaryApp ?? null,
    primaryBrowser: s.primaryBrowser ?? null,
    primaryTitle: s.primaryTitle ?? null,
    primaryUrl: s.primaryUrl ?? null,
    appsUsed: s.appsUsed,
    browserTabs: s.browserTabs,
  };
}