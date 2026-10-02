import type {
  ActivityMembership,
  IIntelligenceRepository,
  NewIntelligenceRun,
  RunCommit,
} from '../../src/database/IntelligenceRepository';
import type {
  IntelligenceActivity,
  IntelligenceErrorCategory,
  IntelligenceRun,
} from '../../src/intelligence/IntelligenceModels';
import type { Event } from '../../src/models/Event';

/**
 * In-memory fake of `IIntelligenceRepository`. Mirrors the SQL repository's
 * contract (single-transaction commit, envelope refresh, supersede-on-empty,
 * lock protection) so the service and timeline can be tested without SQLite.
 */
export class FakeIntelligenceRepository implements IIntelligenceRepository {
  runs: IntelligenceRun[] = [];
  activities = new Map<string, IntelligenceActivity>();
  /** activityId → ordered event ids */
  members = new Map<string, number[]>();
  /** Set to make the next commit throw (persistence failure). */
  failNextCommit: Error | null = null;

  constructor(private readonly lookupEvent: (id: number) => Event | undefined) {}

  createRun(run: NewIntelligenceRun): void {
    this.runs.push({
      id: run.id,
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      status: 'running',
      model: run.model,
      promptVersion: run.promptVersion,
      schemaVersion: run.schemaVersion,
      attemptCount: 0,
      error: null,
      errorCategory: null,
      outputJson: null,
      createdAt: run.nowIso,
      updatedAt: run.nowIso,
    });
  }

  recordAttempt(runId: string, attemptCount: number): void {
    this.run(runId).attemptCount = attemptCount;
  }

  failRun(runId: string, category: IntelligenceErrorCategory, error: string): void {
    const run = this.run(runId);
    run.status = 'failed';
    run.error = error;
    run.errorCategory = category;
  }

  failInterruptedRuns(): number {
    const running = this.runs.filter((r) => r.status === 'running');
    for (const run of running) {
      run.status = 'failed';
      run.error = 'Interrupted before completion';
      run.errorCategory = 'internal';
    }
    return running.length;
  }

  hasSucceededRun(windowStart: string, windowEnd: string): boolean {
    return this.runs.some(
      (r) => r.windowStart === windowStart && r.windowEnd === windowEnd && r.status === 'succeeded',
    );
  }

  countFailedRuns(windowStart: string, windowEnd: string, categories: IntelligenceErrorCategory[]): number {
    return this.runs.filter(
      (r) =>
        r.windowStart === windowStart &&
        r.windowEnd === windowEnd &&
        r.status === 'failed' &&
        r.errorCategory !== null &&
        categories.includes(r.errorCategory),
    ).length;
  }

  listRecentRuns(limit: number): IntelligenceRun[] {
    return [...this.runs].reverse().slice(0, limit);
  }

  commitRun(commit: RunCommit): void {
    if (this.failNextCommit) {
      const err = this.failNextCommit;
      this.failNextCommit = null;
      throw err;
    }
    // Work on copies so a throw mid-way leaves the previous state intact.
    const activities = new Map([...this.activities].map(([id, a]) => [id, { ...a }]));
    const members = new Map([...this.members].map(([id, ids]) => [id, [...ids]]));
    const touched = new Set<string>();
    const { plan, nowIso } = commit;

    for (const { activityId, eventIds } of plan.detach) {
      const activity = activities.get(activityId);
      if (activity && !activity.userLocked) {
        members.set(activityId, (members.get(activityId) ?? []).filter((id) => !eventIds.includes(id)));
      }
      touched.add(activityId);
    }

    for (const a of plan.create) {
      activities.set(a.id, {
        id: a.id,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        title: a.title,
        summary: a.summary,
        contextId: a.contextId,
        areaId: a.areaId,
        intentId: a.intentId,
        qualityId: a.qualityId,
        confidence: a.confidence,
        uncertainty: a.uncertainty,
        sourceRunId: commit.runId,
        userLocked: false,
        supersededAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      members.set(a.id, [...a.eventIds]);
      touched.add(a.id);
    }

    for (const x of plan.extend) {
      const activity = activities.get(x.activityId);
      if (!activity || activity.userLocked || activity.supersededAt !== null) {
        throw new Error(`Cannot extend activity ${x.activityId}: missing, locked or superseded`);
      }
      Object.assign(activity, {
        title: x.title,
        summary: x.summary,
        contextId: x.contextId,
        areaId: x.areaId,
        intentId: x.intentId,
        qualityId: x.qualityId,
        confidence: x.confidence,
        uncertainty: x.uncertainty,
        updatedAt: nowIso,
      });
      const list = members.get(x.activityId) ?? [];
      for (const id of x.addEventIds) if (!list.includes(id)) list.push(id);
      members.set(x.activityId, list);
      touched.add(x.activityId);
    }

    for (const id of touched) {
      const activity = activities.get(id);
      if (!activity) continue;
      const ids = members.get(id) ?? [];
      if (ids.length === 0) {
        if (!activity.userLocked) activity.supersededAt = nowIso;
        continue;
      }
      const events = ids.map((eid) => this.lookupEvent(eid)).filter((e): e is Event => e !== undefined);
      if (events.length > 0) {
        activity.startedAt = events.map((e) => e.startedAt).sort()[0];
        activity.endedAt = events.map((e) => e.endedAt).sort().reverse()[0];
      }
    }

    const run = this.run(commit.runId);
    for (const other of this.runs) {
      if (
        other !== run &&
        other.status === 'succeeded' &&
        other.windowStart === commit.windowStart &&
        other.windowEnd === commit.windowEnd
      ) {
        other.status = 'superseded';
      }
    }
    run.status = 'succeeded';
    run.model = commit.model;
    run.attemptCount = commit.attemptCount;
    run.outputJson = commit.outputJson;
    run.error = null;
    run.errorCategory = null;

    this.activities = activities;
    this.members = members;
  }

  listContinuityActivities(windowEnd: string, minEndedAt: string, limit: number): IntelligenceActivity[] {
    return this.active()
      .filter((a) => a.startedAt < windowEnd && a.endedAt >= minEndedAt)
      .sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : 0))
      .slice(0, limit)
      .reverse()
      .map((a) => ({ ...a }));
  }

  getActiveMemberships(eventIds: number[]): ActivityMembership[] {
    const wanted = new Set(eventIds);
    const out: ActivityMembership[] = [];
    for (const activity of this.active()) {
      for (const eventId of this.members.get(activity.id) ?? []) {
        if (wanted.has(eventId)) out.push({ eventId, activityId: activity.id, userLocked: activity.userLocked });
      }
    }
    return out;
  }

  getActivitiesByIds(ids: string[]): IntelligenceActivity[] {
    return ids.map((id) => this.activities.get(id)).filter((a): a is IntelligenceActivity => !!a).map((a) => ({ ...a }));
  }

  getActivityEventIds(activityId: string): number[] {
    return [...(this.members.get(activityId) ?? [])];
  }

  lockActivitiesForEvents(eventIds: number[]): number {
    const wanted = new Set(eventIds);
    let count = 0;
    for (const activity of this.active()) {
      if (activity.userLocked) continue;
      if ((this.members.get(activity.id) ?? []).some((id) => wanted.has(id))) {
        activity.userLocked = true;
        count++;
      }
    }
    return count;
  }

  // ── test helpers ──

  active(): IntelligenceActivity[] {
    return [...this.activities.values()]
      .filter((a) => a.supersededAt === null)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  private run(id: string): IntelligenceRun {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`Run ${id} does not exist`);
    return run;
  }
}
