import type { IIntelligenceRepository } from '../database/IntelligenceRepository.js';
import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';
import { computeStatistics } from '../session/SessionStatistics.js';
import type { AiTimelineSource } from '../timeline/TimelineService.js';
import type { IntelligenceActivity } from './IntelligenceModels.js';

/**
 * Timeline adapter over persisted AI activities.
 *
 *   deterministic sessions ──► AI activities where they exist
 *                              + deterministic fallback everywhere else
 *
 * Events owned by an active AI activity are regrouped into one session per
 * activity. A deterministic session with no AI-owned event is returned
 * untouched (same object, same id), so history that was never analysed
 * behaves exactly as before. Raw events are only read.
 */
export class IntelligenceTimelineSource implements AiTimelineSource {
  constructor(
    private readonly repo: IIntelligenceRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  compose(deterministic: Session[], resessionize: (events: Event[]) => Session[]): Session[] {
    const eventIds = deterministic.flatMap((s) => s.events.map((e) => e.id));
    if (eventIds.length === 0) return deterministic;

    const ownerOf = new Map(this.repo.getActiveMemberships(eventIds).map((m) => [m.eventId, m.activityId]));
    if (ownerOf.size === 0) return deterministic;

    const activities = new Map(
      this.repo.getActivitiesByIds([...new Set(ownerOf.values())]).map((a) => [a.id, a]),
    );

    const owned = new Map<string, Event[]>();
    const result: Session[] = [];

    for (const session of deterministic) {
      if (!session.events.some((e) => activities.has(ownerOf.get(e.id) ?? ''))) {
        result.push(session);
        continue;
      }

      // Split the session: AI-owned events go to their activity; what is left
      // falls back to deterministic sessionization, one uncovered run at a time
      // so a fallback block never straddles an AI activity.
      let run: Event[] = [];
      const flush = () => {
        if (run.length > 0) result.push(...resessionize(run));
        run = [];
      };
      for (const event of session.events) {
        const activityId = ownerOf.get(event.id);
        if (activityId && activities.has(activityId)) {
          flush();
          const list = owned.get(activityId) ?? [];
          list.push(event);
          owned.set(activityId, list);
        } else {
          run.push(event);
        }
      }
      flush();
    }

    for (const [activityId, events] of owned) {
      result.push(toSession(activities.get(activityId)!, events));
    }

    return result.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  lockActivitiesForEvents(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    this.repo.lockActivitiesForEvents(eventIds, this.now().toISOString());
  }
}

function toSession(activity: IntelligenceActivity, events: Event[]): Session {
  const ordered = [...events].sort((a, b) => {
    const d = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return d !== 0 ? d : a.id - b.id;
  });
  const session: Session = {
    id: activity.id,
    startedAt: new Date(0),
    endedAt: new Date(0),
    duration: 0,
    activeDuration: 0,
    events: ordered,
    appsUsed: [],
    browserTabs: [],
    eventCount: ordered.length,
    ai: {
      activityId: activity.id,
      title: activity.title,
      summary: activity.summary,
      contextId: activity.contextId,
      areaId: activity.areaId,
      intentId: activity.intentId,
      qualityId: activity.qualityId,
      confidence: activity.confidence,
      uncertainty: activity.uncertainty,
      userLocked: activity.userLocked,
    },
  };
  return computeStatistics(session);
}
