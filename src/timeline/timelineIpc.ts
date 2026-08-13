import type { WebContents } from 'electron';
import { ipcWebContentsSend } from '../electron/util.js';
import type { TimelineService } from './TimelineService.js';
import type { VerifiedSession } from './TimelineModels.js';
import type { Activity, ActivityRuleRepository } from '../database/ActivityRuleRepository.js';

/**
 * Renderer bridge for the timeline. Mirrors `sessionIpc.ts` / `trackerIpc.ts`
 * for symmetry. Read paths return DTOs (sessions are in-memory; engine stays
 * in main); mutation paths append an edit and return the updated timeline so
 * the renderer can refresh with a single round-trip.
 *
 * All handlers ride the existing frame-validated `ipcMainHandle`. Return payloads
 * are plain JSON; the renderer never imports the engine.
 */

export interface ClassificationDto {
  context: { id: string | null; name: string; color: string | null } | null;
  area: { id: string | null; name: string } | null;
  intent: { id: string | null; name: string } | null;
  quality: { id: string | null; name: string } | null;
  source: string;
  reason: string;
  matchedRuleId: string | null;
  matchedConditions: string | null;
  isOverride: boolean;
}

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
  classification?: ClassificationDto | null;
}

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

function toDto(s: VerifiedSession, activities: Activity[]): VerifiedSessionDto {
  const activity = s.activityId ? activities.find((a) => a.id === s.activityId) ?? null : null;
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
    activity: activity ? { id: activity.id, name: activity.name, color: activity.color } : null,
    activityRuleId: s.classification?.matchedRuleId ?? null,
    classification: s.classification ? {
      context: s.classification.context ? {
        id: s.classification.context.id,
        name: s.classification.context.name,
        color: s.classification.context.color ?? null,
      } : null,
      area: s.classification.area ? {
        id: s.classification.area.id,
        name: s.classification.area.name,
      } : null,
      intent: s.classification.intent ? {
        id: s.classification.intent.id,
        name: s.classification.intent.name,
      } : null,
      quality: s.classification.quality ? {
        id: s.classification.quality.id,
        name: s.classification.quality.name,
      } : null,
      source: s.classification.source,
      reason: s.classification.reason,
      matchedRuleId: s.classification.matchedRuleId,
      matchedConditions: s.classification.matchedConditions,
      isOverride: s.classification.isOverride,
    } : null,
  };
}