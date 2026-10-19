import type { VerifiedSession } from './TimelineModels.js';
import type { Activity } from '../database/ActivityRuleRepository.js';

/**
 * The plain-JSON shape of a verified timeline block — what the Timeline page
 * receives and what a Timeline export contains. No Electron imports, so the
 * export service and tests can use it directly.
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
  /** Present when the block is an AI-derived activity. */
  ai?: {
    activityId: string;
    title: string;
    summary: string | null;
    confidence: number;
    uncertainty: string[];
    userLocked: boolean;
  } | null;
}

export function toVerifiedSessionDto(s: VerifiedSession, activities: Activity[]): VerifiedSessionDto {
  const activity = s.activityId ? activities.find((a) => a.id === s.activityId) ?? null : null;
  return {
    id: s.id,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt.toISOString(),
    duration: s.duration,
    activeDuration: s.activeDuration,
    eventCount: s.eventCount,
    title: s.customTitle ?? s.ai?.title ?? s.primaryTitle ?? '',
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
    ai: s.ai ? {
      activityId: s.ai.activityId,
      title: s.ai.title,
      summary: s.ai.summary,
      confidence: s.ai.confidence,
      uncertainty: s.ai.uncertainty,
      userLocked: s.ai.userLocked,
    } : null,
  };
}