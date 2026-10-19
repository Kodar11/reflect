import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type { TimelineService } from './TimelineService.js';
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import { toVerifiedSessionDto as toDto } from './timelineDto.js';

export type { ClassificationDto, VerifiedSessionDto } from './timelineDto.js';

/**
 * Renderer bridge for the timeline. Mirrors `sessionIpc.ts` / `trackerIpc.ts`
 * for symmetry. Read paths return DTOs (sessions are in-memory; engine stays
 * in main); mutation paths append an edit and return the updated timeline so
 * the renderer can refresh with a single round-trip.
 *
 * All handlers ride the existing frame-validated `ipcMainHandle`. Return payloads
 * are plain JSON; the renderer never imports the engine.
 */

export function registerTimelineIpc(
  service: TimelineService,
  activityRuleRepo: ActivityRuleRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
  webContentsForPush: () => WebContents[] = () => [],
) {
  const listActivities = () => activityRuleRepo.listActivities();

  ipcMainHandle('timeline:getToday', () => {
    const activities = listActivities();
    return service.getToday().map((s) => toDto(s, activities));
  });
  ipcMainHandle('timeline:getRange', (p?: { from: string; to: string }) => {
    const activities = listActivities();
    if (!p || !p.from || !p.to) return service.getAll().map((s) => toDto(s, activities));
    return service.getByRange(p.from, p.to).map((s) => toDto(s, activities));
  });
  ipcMainHandle('timeline:getAll', (p?: { limit?: number }) => {
    const activities = listActivities();
    return service.getAll(p?.limit).map((s) => toDto(s, activities));
  });

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
  ipcMainHandle('rules:save', (p: { id: string; activityId: string; conditions: string; enabled: number; priority: number; areaId?: string | null; intentId?: string | null; qualityId?: string | null }) => {
    activityRuleRepo.saveRule({
      id: p.id,
      activityId: p.activityId,
      conditions: p.conditions,
      enabled: p.enabled,
      priority: p.priority,
      areaId: p.areaId ?? null,
      intentId: p.intentId ?? null,
      qualityId: p.qualityId ?? null,
    });
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
