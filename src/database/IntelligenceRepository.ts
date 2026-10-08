import type { Database } from './Database.js';
import {
  CONTEXT_LOOKBACK_MS,
  type ActivityInterpretation,
  type IntelligenceActivity,
  type IntelligenceErrorCategory,
  type IntelligenceRun,
  type IntelligenceRunStatus,
  type ReconcilePlan,
} from '../intelligence/IntelligenceModels.js';

/**
 * Storage seam for the intelligence layer. The service and the timeline
 * adapter depend on this interface; tests substitute an in-memory fake.
 *
 * AI interpretation lives ONLY in the intelligence_* tables. Raw events are
 * referenced by id and never written.
 */
export interface IIntelligenceRepository {
  // Runs
  createRun(run: NewIntelligenceRun): void;
  recordAttempt(runId: string, attemptCount: number, nowIso: string): void;
  failRun(runId: string, category: IntelligenceErrorCategory, error: string, nowIso: string): void;
  /** Runs left 'running' by a crash/shutdown are failed so they get retried. */
  failInterruptedRuns(nowIso: string): number;
  hasSucceededRun(windowStart: string, windowEnd: string): boolean;
  countFailedRuns(windowStart: string, windowEnd: string, categories: IntelligenceErrorCategory[]): number;
  listRecentRuns(limit: number): IntelligenceRun[];

  /**
   * Atomically apply a successful analysis: write the plan, re-derive the
   * envelope of every touched activity, supersede activities left without
   * events, and mark the run succeeded. All or nothing.
   */
  commitRun(commit: RunCommit): void;

  // Activities
  /** Active activities that could be continued by a window ending at `windowEnd`. */
  listContinuityActivities(windowEnd: string, minEndedAt: string, limit: number): IntelligenceActivity[];
  /** Active owner of each given event (events without an owner are absent). */
  getActiveMemberships(eventIds: number[]): ActivityMembership[];
  getActivitiesByIds(ids: string[]): IntelligenceActivity[];
  /** Ordered raw event ids of an activity. */
  getActivityEventIds(activityId: string): number[];
  /** Lock every active activity owning any of these events. Returns how many. */
  lockActivitiesForEvents(eventIds: number[], nowIso: string): number;
}

export interface NewIntelligenceRun {
  id: string;
  windowStart: string;
  windowEnd: string;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  nowIso: string;
}

export interface RunCommit {
  runId: string;
  windowStart: string;
  windowEnd: string;
  /** Concrete model version that produced the accepted output. */
  model: string;
  attemptCount: number;
  outputJson: string;
  plan: ReconcilePlan;
  nowIso: string;
}

export interface ActivityMembership {
  eventId: number;
  activityId: string;
  userLocked: boolean;
}

export interface AnalysisWindow {
  start: string;
  end: string;
}

/** What stopped standing when events were removed. */
export interface RetiredIntelligence {
  /** Activities that owned a removed event; they are no longer shown. */
  activityIds: string[];
  /** Analyses whose result no longer stands and should run again. */
  windows: AnalysisWindow[];
}

interface RunRow {
  id: string;
  window_start: string;
  window_end: string;
  status: string;
  model: string;
  prompt_version: string;
  schema_version: number;
  attempt_count: number;
  error: string | null;
  error_category: string | null;
  output_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  started_at: string;
  ended_at: string;
  title: string;
  summary: string | null;
  context_id: string | null;
  area_id: string | null;
  intent_id: string | null;
  quality_id: string | null;
  confidence: number;
  uncertainty: string | null;
  source_run_id: string;
  user_locked: number;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export class IntelligenceRepository implements IIntelligenceRepository {
  private readonly createRunStmt;
  private readonly recordAttemptStmt;
  private readonly failRunStmt;
  private readonly failInterruptedStmt;
  private readonly hasSucceededStmt;
  private readonly countFailedStmt;
  private readonly recentRunsStmt;
  private readonly supersedeRunsStmt;
  private readonly succeedRunStmt;

  private readonly insertActivityStmt;
  private readonly updateInterpretationStmt;
  private readonly insertMembershipStmt;
  private readonly deleteMembershipStmt;
  private readonly maxPositionStmt;
  private readonly countMembershipsStmt;
  private readonly refreshEnvelopeStmt;
  private readonly supersedeActivityStmt;

  private readonly continuityStmt;
  private readonly membershipsStmt;
  private readonly activitiesByIdsStmt;
  private readonly activityEventIdsStmt;
  private readonly lockStmt;

  constructor(private readonly db: Database) {
    this.createRunStmt = db.prepare(
      `INSERT INTO intelligence_runs
         (id, window_start, window_end, status, model, prompt_version, schema_version, attempt_count, created_at, updated_at)
       VALUES
         (@id, @window_start, @window_end, 'running', @model, @prompt_version, @schema_version, 0, @now, @now)`,
    );
    this.recordAttemptStmt = db.prepare(
      `UPDATE intelligence_runs SET attempt_count = @attempt_count, updated_at = @now WHERE id = @id`,
    );
    this.failRunStmt = db.prepare(
      `UPDATE intelligence_runs
       SET status = 'failed', error = @error, error_category = @error_category, updated_at = @now
       WHERE id = @id`,
    );
    this.failInterruptedStmt = db.prepare(
      `UPDATE intelligence_runs
       SET status = 'failed', error = 'Interrupted before completion', error_category = 'internal', updated_at = @now
       WHERE status = 'running'`,
    );
    this.hasSucceededStmt = db.prepare(
      `SELECT 1 AS one FROM intelligence_runs
       WHERE window_start = @window_start AND window_end = @window_end AND status = 'succeeded'
       LIMIT 1`,
    );
    this.countFailedStmt = db.prepare(
      `SELECT COUNT(*) AS count FROM intelligence_runs
       WHERE window_start = @window_start AND window_end = @window_end AND status = 'failed'
         AND error_category IN (SELECT value FROM json_each(@categories))`,
    );
    this.recentRunsStmt = db.prepare(
      `SELECT * FROM intelligence_runs ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
    );
    this.supersedeRunsStmt = db.prepare(
      `UPDATE intelligence_runs
       SET status = 'superseded', updated_at = @now
       WHERE window_start = @window_start AND window_end = @window_end
         AND status = 'succeeded' AND id != @id`,
    );
    this.succeedRunStmt = db.prepare(
      `UPDATE intelligence_runs
       SET status = 'succeeded', model = @model, attempt_count = @attempt_count,
           output_json = @output_json, error = NULL, error_category = NULL, updated_at = @now
       WHERE id = @id`,
    );

    this.insertActivityStmt = db.prepare(
      `INSERT INTO intelligence_activities
         (id, started_at, ended_at, title, summary, context_id, area_id, intent_id, quality_id,
          confidence, uncertainty, source_run_id, user_locked, superseded_at, created_at, updated_at)
       VALUES
         (@id, @started_at, @ended_at, @title, @summary, @context_id, @area_id, @intent_id, @quality_id,
          @confidence, @uncertainty, @source_run_id, 0, NULL, @now, @now)`,
    );
    // `user_locked = 0` is a last line of defence: a locked activity is never rewritten.
    this.updateInterpretationStmt = db.prepare(
      `UPDATE intelligence_activities
       SET title = @title, summary = @summary, context_id = @context_id, area_id = @area_id,
           intent_id = @intent_id, quality_id = @quality_id, confidence = @confidence,
           uncertainty = @uncertainty, updated_at = @now
       WHERE id = @id AND user_locked = 0 AND superseded_at IS NULL`,
    );
    this.insertMembershipStmt = db.prepare(
      `INSERT OR IGNORE INTO intelligence_activity_events (activity_id, event_id, position)
       VALUES (@activity_id, @event_id, @position)`,
    );
    this.deleteMembershipStmt = db.prepare(
      `DELETE FROM intelligence_activity_events
       WHERE activity_id = @activity_id AND event_id = @event_id
         AND activity_id IN (SELECT id FROM intelligence_activities WHERE user_locked = 0)`,
    );
    this.maxPositionStmt = db.prepare(
      `SELECT COALESCE(MAX(position), -1) AS max FROM intelligence_activity_events WHERE activity_id = ?`,
    );
    this.countMembershipsStmt = db.prepare(
      `SELECT COUNT(*) AS count FROM intelligence_activity_events WHERE activity_id = ?`,
    );
    this.refreshEnvelopeStmt = db.prepare(
      `UPDATE intelligence_activities
       SET started_at = COALESCE((
             SELECT MIN(e.started_at) FROM intelligence_activity_events ae
             JOIN events e ON e.id = ae.event_id WHERE ae.activity_id = @id AND e.hidden_at IS NULL), started_at),
           ended_at = COALESCE((
             SELECT MAX(e.ended_at) FROM intelligence_activity_events ae
             JOIN events e ON e.id = ae.event_id WHERE ae.activity_id = @id AND e.hidden_at IS NULL), ended_at),
           updated_at = @now
       WHERE id = @id`,
    );
    this.supersedeActivityStmt = db.prepare(
      `UPDATE intelligence_activities
       SET superseded_at = @now, updated_at = @now
       WHERE id = @id AND user_locked = 0 AND superseded_at IS NULL`,
    );

    this.continuityStmt = db.prepare(
      `SELECT * FROM intelligence_activities
       WHERE superseded_at IS NULL AND started_at < @window_end AND ended_at >= @min_ended_at
       ORDER BY ended_at DESC, started_at DESC
       LIMIT @limit`,
    );
    this.membershipsStmt = db.prepare(
      `SELECT ae.event_id, ae.activity_id, a.user_locked
       FROM intelligence_activity_events ae
       JOIN intelligence_activities a ON a.id = ae.activity_id
       WHERE a.superseded_at IS NULL
         AND ae.event_id IN (SELECT value FROM json_each(@event_ids))`,
    );
    this.activitiesByIdsStmt = db.prepare(
      `SELECT * FROM intelligence_activities WHERE id IN (SELECT value FROM json_each(@ids))`,
    );
    this.activityEventIdsStmt = db.prepare(
      `SELECT event_id FROM intelligence_activity_events WHERE activity_id = ? ORDER BY position ASC, event_id ASC`,
    );
    this.lockStmt = db.prepare(
      `UPDATE intelligence_activities
       SET user_locked = 1, updated_at = @now
       WHERE superseded_at IS NULL AND user_locked = 0
         AND id IN (
           SELECT activity_id FROM intelligence_activity_events
           WHERE event_id IN (SELECT value FROM json_each(@event_ids))
         )`,
    );
  }

  // --- Runs ---

  createRun(run: NewIntelligenceRun): void {
    this.createRunStmt.run({
      id: run.id,
      window_start: run.windowStart,
      window_end: run.windowEnd,
      model: run.model,
      prompt_version: run.promptVersion,
      schema_version: run.schemaVersion,
      now: run.nowIso,
    });
  }

  recordAttempt(runId: string, attemptCount: number, nowIso: string): void {
    this.recordAttemptStmt.run({ id: runId, attempt_count: attemptCount, now: nowIso });
  }

  failRun(runId: string, category: IntelligenceErrorCategory, error: string, nowIso: string): void {
    this.failRunStmt.run({ id: runId, error, error_category: category, now: nowIso });
  }

  failInterruptedRuns(nowIso: string): number {
    return this.failInterruptedStmt.run({ now: nowIso }).changes;
  }

  hasSucceededRun(windowStart: string, windowEnd: string): boolean {
    return this.hasSucceededStmt.get({ window_start: windowStart, window_end: windowEnd }) !== undefined;
  }

  countFailedRuns(windowStart: string, windowEnd: string, categories: IntelligenceErrorCategory[]): number {
    const row = this.countFailedStmt.get({
      window_start: windowStart,
      window_end: windowEnd,
      categories: JSON.stringify(categories),
    }) as { count: number };
    return row.count;
  }

  listRecentRuns(limit: number): IntelligenceRun[] {
    return (this.recentRunsStmt.all({ limit }) as RunRow[]).map(rowToRun);
  }

  commitRun(commit: RunCommit): void {
    const { plan, nowIso: now } = commit;

    this.db.transaction(() => {
      const touched = new Set<string>();

      for (const { activityId, eventIds } of plan.detach) {
        for (const eventId of eventIds) {
          this.deleteMembershipStmt.run({ activity_id: activityId, event_id: eventId });
        }
        touched.add(activityId);
      }

      for (const activity of plan.create) {
        this.insertActivityStmt.run({
          id: activity.id,
          started_at: activity.startedAt,
          ended_at: activity.endedAt,
          ...interpretationParams(activity),
          source_run_id: commit.runId,
          now,
        });
        activity.eventIds.forEach((eventId, position) => {
          this.insertMembershipStmt.run({ activity_id: activity.id, event_id: eventId, position });
        });
        touched.add(activity.id);
      }

      for (const extension of plan.extend) {
        const updated = this.updateInterpretationStmt.run({
          id: extension.activityId,
          ...interpretationParams(extension),
          now,
        });
        if (updated.changes === 0) {
          throw new Error(`Cannot extend activity ${extension.activityId}: missing, locked or superseded`);
        }
        const { max } = this.maxPositionStmt.get(extension.activityId) as { max: number };
        extension.addEventIds.forEach((eventId, index) => {
          this.insertMembershipStmt.run({
            activity_id: extension.activityId,
            event_id: eventId,
            position: max + 1 + index,
          });
        });
        touched.add(extension.activityId);
      }

      for (const id of touched) {
        const { count } = this.countMembershipsStmt.get(id) as { count: number };
        if (count === 0) this.supersedeActivityStmt.run({ id, now });
        else this.refreshEnvelopeStmt.run({ id, now });
      }

      // A forced re-analysis replaces the earlier successful run of this window.
      this.supersedeRunsStmt.run({
        id: commit.runId,
        window_start: commit.windowStart,
        window_end: commit.windowEnd,
        now,
      });
      const done = this.succeedRunStmt.run({
        id: commit.runId,
        model: commit.model,
        attempt_count: commit.attemptCount,
        output_json: commit.outputJson,
        now,
      });
      if (done.changes === 0) throw new Error(`Run ${commit.runId} does not exist`);
    });
  }

  // --- Activities ---

  listContinuityActivities(windowEnd: string, minEndedAt: string, limit: number): IntelligenceActivity[] {
    const rows = this.continuityStmt.all({
      window_end: windowEnd,
      min_ended_at: minEndedAt,
      limit,
    }) as ActivityRow[];
    return rows.map(rowToActivity).reverse();
  }

  getActiveMemberships(eventIds: number[]): ActivityMembership[] {
    if (eventIds.length === 0) return [];
    const rows = this.membershipsStmt.all({ event_ids: JSON.stringify(eventIds) }) as {
      event_id: number;
      activity_id: string;
      user_locked: number;
    }[];
    return rows.map((r) => ({
      eventId: r.event_id,
      activityId: r.activity_id,
      userLocked: r.user_locked === 1,
    }));
  }

  getActivitiesByIds(ids: string[]): IntelligenceActivity[] {
    if (ids.length === 0) return [];
    return (this.activitiesByIdsStmt.all({ ids: JSON.stringify(ids) }) as ActivityRow[]).map(rowToActivity);
  }

  getActivityEventIds(activityId: string): number[] {
    return (this.activityEventIdsStmt.all(activityId) as { event_id: number }[]).map((r) => r.event_id);
  }

  lockActivitiesForEvents(eventIds: number[], nowIso: string): number {
    if (eventIds.length === 0) return 0;
    return this.lockStmt.run({ event_ids: JSON.stringify(eventIds), now: nowIso }).changes;
  }

  // --- Event removal ---

  /**
   * The user hid or deleted these events. Call BEFORE a deletion, while the
   * memberships still say which activities held them.
   *
   * An activity that owned one of them is retired, not trimmed: its title and
   * summary were written with that event as evidence, so neither can be shown
   * as though nothing changed. Its remaining events fall back to deterministic
   * sessions straight away, and the analyses that covered it are superseded so
   * they run again on what is left. Unlike an analysis, this retires a
   * user-locked activity too — the user's own removal outranks it.
   *
   * `purge` (a permanent deletion) also removes what was only kept as
   * history: the retired activity rows of that stretch and the stored model
   * output of every analysis that was shown the events.
   */
  retireForEvents(eventIds: number[], range: AnalysisWindow, nowIso: string, options: { purge?: boolean } = {}): RetiredIntelligence {
    if (eventIds.length === 0) return { activityIds: [], windows: [] };
    const ids = JSON.stringify(eventIds);

    return this.db.transaction(() => {
      const owners = this.db
        .prepare(
          `SELECT DISTINCT a.id, a.started_at, a.ended_at
           FROM intelligence_activities a
           JOIN intelligence_activity_events ae ON ae.activity_id = a.id
           WHERE a.superseded_at IS NULL
             AND ae.event_id IN (SELECT value FROM json_each(@ids))`,
        )
        .all({ ids }) as Pick<ActivityRow, 'id' | 'started_at' | 'ended_at'>[];

      this.db.prepare(`DELETE FROM intelligence_activity_events WHERE event_id IN (SELECT value FROM json_each(@ids))`).run({ ids });

      const windows = new Map<string, AnalysisWindow>();
      const retire = this.db.prepare(
        `UPDATE intelligence_activities SET superseded_at = @now, updated_at = @now WHERE id = @id AND superseded_at IS NULL`,
      );
      for (const owner of owners) {
        retire.run({ id: owner.id, now: nowIso });
        for (const w of this.supersedeRunsOverlapping({ start: owner.started_at, end: owner.ended_at }, nowIso)) {
          windows.set(`${w.start}|${w.end}`, w);
        }
      }

      if (options.purge) {
        this.db
          .prepare(
            `DELETE FROM intelligence_activities
             WHERE superseded_at IS NOT NULL
               AND (id IN (SELECT value FROM json_each(@owners)) OR (started_at <= @end AND ended_at >= @start))`,
          )
          .run({ owners: JSON.stringify(owners.map((o) => o.id)), start: range.start, end: range.end });
        // An analysis is shown its window plus the lookback before it.
        this.db
          .prepare(
            `UPDATE intelligence_runs SET output_json = NULL
             WHERE output_json IS NOT NULL AND window_end >= @start AND window_start <= @reach`,
          )
          .run({ start: range.start, reach: new Date(Date.parse(range.end) + CONTEXT_LOOKBACK_MS).toISOString() });
      }

      return { activityIds: owners.map((o) => o.id), windows: [...windows.values()] };
    });
  }

  /**
   * Supersede the successful analyses whose window overlaps the range, so the
   * windows are analysed again. Returns those windows.
   */
  supersedeRunsOverlapping(range: AnalysisWindow, nowIso: string): AnalysisWindow[] {
    return this.db.transaction(() => {
      const runs = this.db
        .prepare(
          `SELECT id, window_start, window_end FROM intelligence_runs
           WHERE status = 'succeeded' AND window_start <= @end AND window_end >= @start`,
        )
        .all({ start: range.start, end: range.end }) as Pick<RunRow, 'id' | 'window_start' | 'window_end'>[];
      const supersede = this.db.prepare(`UPDATE intelligence_runs SET status = 'superseded', updated_at = @now WHERE id = @id`);
      for (const run of runs) supersede.run({ id: run.id, now: nowIso });
      return runs.map((run) => ({ start: run.window_start, end: run.window_end }));
    });
  }
}

function interpretationParams(i: ActivityInterpretation) {
  return {
    title: i.title,
    summary: i.summary,
    context_id: i.contextId,
    area_id: i.areaId,
    intent_id: i.intentId,
    quality_id: i.qualityId,
    confidence: i.confidence,
    uncertainty: JSON.stringify(i.uncertainty),
  };
}

function rowToRun(r: RunRow): IntelligenceRun {
  return {
    id: r.id,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    status: r.status as IntelligenceRunStatus,
    model: r.model,
    promptVersion: r.prompt_version,
    schemaVersion: r.schema_version,
    attemptCount: r.attempt_count,
    error: r.error,
    errorCategory: r.error_category as IntelligenceErrorCategory | null,
    outputJson: r.output_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToActivity(r: ActivityRow): IntelligenceActivity {
  let uncertainty: string[] = [];
  try {
    const parsed = r.uncertainty ? JSON.parse(r.uncertainty) : [];
    if (Array.isArray(parsed)) uncertainty = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // Malformed column — treat as no notes.
  }
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    title: r.title,
    summary: r.summary,
    contextId: r.context_id,
    areaId: r.area_id,
    intentId: r.intent_id,
    qualityId: r.quality_id,
    confidence: r.confidence,
    uncertainty,
    sourceRunId: r.source_run_id,
    userLocked: r.user_locked === 1,
    supersededAt: r.superseded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
