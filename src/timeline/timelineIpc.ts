import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type { TimelineService } from './TimelineService.js';
import type { VerifiedSession } from './TimelineModels.js';
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';

/**
 * Renderer bridge for the timeline. Mirrors `sessionIpc.ts` / `trackerIpc.ts`
 * for symmetry. Read paths return DTOs (sessions are in-memory; engine stays
 * in main); mutation paths append an edit and return the updated timeline so
 * the renderer can refresh with a single round-trip.
 *
 * All handlers ride the existing frame-validated `ipcMainHandle`. Return payloads
 * are plain JSON; the renderer never imports the engine.
 */

export interface VerifiedSessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  title: string; // customTitle ?? primaryTitle ?? ''
  isCustomTitle: boolean;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
  source: 'generated' | 'user';
  note?: string;
  /** Stable event ids that make up this session. Used by the renderer to issue
   * durable timeline edits without depending on regenerated session ids. */
  eventIds: number[];
  activity?: {
    id: string;
    name: string;
    color: string;
  } | null;
  activityRuleId?: string | null;
}

export function registerTimelineIpc(
  service: TimelineService,
  activityRuleRepo: ActivityRuleRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  ipcMainHandle('timeline:getToday', () => service.getToday().map(toDto));
  ipcMainHandle('timeline:getRange', (p?: { from: string; to: string }) => {
    if (!p || !p.from || !p.to) return service.getAll().map(toDto);
    return service.getByRange(p.from, p.to).map(toDto);
  });
  ipcMainHandle('timeline:getAll', (p?: { limit?: number }) =>
    service.getAll(p?.limit).map(toDto),
  );

  // Mutation: append an edit; return the refreshed timeline for one-shot refresh.
  ipcMainHandle('timeline:apply', (p?: { operation: string; payload: unknown }) => {
    if (!p || !p.operation) throw new Error('timeline:apply requires operation+payload');
    service.apply(p.operation as any, p.payload);
    return { ok: true };
  });

  ipcMainHandle('timeline:undo', () => ({ ok: service.undo() }));
  ipcMainHandle('timeline:redo', () => ({ ok: service.redo() }));
  ipcMainHandle('timeline:status', () => ({
    activeEdits: service.activeEditCount(),
  }));

  // Activities handlers
  ipcMainHandle('activities:list', () => activityRuleRepo.listActivities());
  ipcMainHandle('activities:save', (p: { id: string; name: string; color: string }) => {
    activityRuleRepo.saveActivity(p);
    return { ok: true };
  });
  ipcMainHandle('activities:delete', (p: { id: string }) => {
    activityRuleRepo.deleteActivity(p.id);
    return { ok: true };
  });

  // Rules handlers
  ipcMainHandle('rules:list', () => activityRuleRepo.listRules());
  ipcMainHandle('rules:save', (p: { id: string; activityId: string; conditions: string; enabled: number; priority: number }) => {
    activityRuleRepo.saveRule(p);
    return { ok: true };
  });
  ipcMainHandle('rules:delete', (p: { id: string }) => {
    activityRuleRepo.deleteRule(p.id);
    return { ok: true };
  });

  // Dormant push seam (Stage 3 polls every ~2s now; later stages may push).
  return {
    notifyTimelineChanged() {
      for (const wc of webContentsForPush()) {
        ipcWebContentsSend('timeline:changed', wc, null);
      }
    },
  };
}

function toDto(s: VerifiedSession): VerifiedSessionDto {
  return {
    id: s.id,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt.toISOString(),
    duration: s.duration,
    activeDuration: s.activeDuration,
    eventCount: s.eventCount,
    title: s.customTitle ?? s.primaryTitle ?? '',
    isCustomTitle: !!s.customTitle,
    primaryApp: s.primaryApp ?? null,
    primaryBrowser: s.primaryBrowser ?? null,
    primaryTitle: s.primaryTitle ?? null,
    primaryUrl: s.primaryUrl ?? null,
    appsUsed: s.appsUsed,
    browserTabs: s.browserTabs,
    source: s.source,
    note: s.note,
    eventIds: s.events.map((e) => e.id),
    activity: (s as any).activity ? {
      id: (s as any).activity.id,
      name: (s as any).activity.name,
      color: (s as any).activity.color,
    } : null,
    activityRuleId: (s as any).activityRuleId ?? null,
  };
}