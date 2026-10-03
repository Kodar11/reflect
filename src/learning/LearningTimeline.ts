import type { VerifiedSession } from '../timeline/TimelineModels.js';
import type { LearningActivity } from './LearnedRuleModels.js';

/**
 * Adapter from the verified timeline to what the learning layer matches
 * against. Learning sees exactly the activities the user sees: AI activities
 * where they exist, deterministic sessions elsewhere, user edits applied.
 * Offline/synthetic blocks carry no raw events and are skipped.
 */
export function toLearningActivities(sessions: VerifiedSession[]): LearningActivity[] {
  return sessions
    .filter((s) => !s.hidden && s.events.length > 0)
    .map((s) => ({
      aiActivityId: s.ai?.activityId ?? null,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt.toISOString(),
      activeDurationMs: s.activeDuration,
      primaryApp: s.primaryApp,
      primaryBrowser: s.primaryBrowser,
      primaryTitle: s.primaryTitle,
      primaryUrl: s.primaryUrl,
      appsUsed: s.appsUsed,
      browserTabs: s.browserTabs,
      eventIds: s.events.map((e) => e.id),
      classificationSource: s.classification?.source ?? null,
      classification: {
        contextId: s.classification?.context?.id ?? null,
        areaId: s.classification?.area?.id ?? null,
        intentId: s.classification?.intent?.id ?? null,
        qualityId: s.classification?.quality?.id ?? null,
      },
    }));
}
