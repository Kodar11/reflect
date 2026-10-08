import type { Database } from './Database.js';
import type {
  ActivityAnnotation,
  DayFactKind,
  DayFactRow,
  DayFacts,
  InsightContinuity,
  MetricSet,
  PriorityEvent,
  PriorityEventType,
  ReflectionCarryForward,
  ReflectionDataSnapshot,
  ReflectionErrorCategory,
  ReflectionEvidence,
  ReflectionFeedbackType,
  ReflectionInsight,
  ReflectionInsightType,
  ReflectionPeriod,
  ReflectionPeriodType,
  ReflectionPriority,
  ReflectionPriorityStatus,
  ReflectionReport,
  ReflectionReportStatus,
  ReflectionTrigger,
  ReportCoachBlock,
} from '../reflection/ReflectionModels.js';
import {
  EVENTS_REMOVED_HEADLINE,
  EVENTS_REMOVED_REASON,
  planReportRedaction,
  type RemovedEvents,
} from '../reflection/ReflectionChanges.js';
import { intervalsFromEvents, type PrioritySyncPlan } from '../reflection/ReflectionPriorities.js';

/**
 * Storage seam for the reflection layer. The service depends on this
 * interface; tests substitute an in-memory fake.
 *
 * Reflections are stored as structured data — observation, interpretation,
 * evidence, sources and the metric snapshot they were written from — so they
 * can be understood later (and queried by the future Coach) without scraping
 * prose. No raw event payload is ever written here.
 */
export interface IReflectionRepository {
  // Reports
  /** Open a generation attempt (status 'generating'). */
  createGenerating(report: NewReflectionReport): void;
  recordAttempt(reportId: string, attemptCount: number, nowIso: string): void;
  /**
   * Atomically complete an attempt: supersede the period's current report,
   * mark this one 'fresh' and store its insights. All or nothing — on failure
   * the previous report is exactly as it was.
   */
  commitReport(commit: ReflectionCommit): void;
  failReport(reportId: string, category: ReflectionErrorCategory, error: string, nowIso: string): void;
  /** Remember that a period held too little data, so it is not re-examined. */
  recordInsufficient(report: NewReflectionReport): void;
  /** Attempts left 'generating' by a crash/shutdown are failed. */
  failInterruptedReports(nowIso: string): number;
  /** The period's current report ('fresh' or 'stale'), with insights. */
  getCurrentReport(type: ReflectionPeriodType, key: string): ReflectionReport | null;
  /** The most recent row for the period, whatever its status. */
  getLatestAttempt(type: ReflectionPeriodType, key: string): ReflectionReport | null;
  getReportById(id: string): ReflectionReport | null;
  countFailedReports(type: ReflectionPeriodType, key: string, categories: ReflectionErrorCategory[]): number;
  /** fresh → stale. Returns whether the row changed. */
  markStale(reportId: string, reason: string, nowIso: string): boolean;
  /**
   * Underlying data changed: flag fresh reports so they are re-checked when
   * next opened. With a range, only reports whose period overlaps it — or
   * whose PREVIOUS period does, since that is what they were compared with.
   */
  flagForVerification(range: { start: string; end: string } | null, nowIso: string): number;
  clearVerification(reportId: string): void;
  /** Current reports, newest period first; optionally only those starting before `beforeStart`. */
  listCurrentReports(type: ReflectionPeriodType | null, limit: number, beforeStart?: string): ReflectionReport[];
  /** Periods that have a current report, newest first. */
  listReportedPeriods(): ReflectionPeriod[];
  /**
   * The insights of the current reports of earlier periods of one type,
   * newest period first, reduced to identity. One query, no report bodies —
   * this is how "was this said before?" is answered for any horizon.
   */
  listInsightHistory(type: ReflectionPeriodType, beforeStart: string, reportLimit: number): InsightHistoryRow[];

  // Feedback
  /** Set (or with `null` clear) the feedback on an insight. False when the insight does not exist. */
  setFeedback(insightId: string, feedback: ReflectionFeedbackType | null, id: string, nowIso: string): boolean;
  listFeedback(sinceIso: string): ReflectionFeedbackRecord[];

  // Priorities
  listPriorities(): ReflectionPriority[];
  /** `ids[i]` is the id of `plan.insert[i]`. Every change is also written to the priority's event log. */
  applyPrioritySync(plan: PrioritySyncPlan, ids: string[], nowIso: string): void;
  /** A real change of status is recorded as an event; setting the status it already has does nothing. */
  setPriorityStatus(id: string, status: ReflectionPriorityStatus, nowIso: string): ReflectionPriority | null;

  // Annotations
  getAnnotations(signatures: string[]): ActivityAnnotation[];
  /**
   * Store thread / priority decisions. A 'user' row is a correction and is
   * never replaced by a 'model' one. Returns the signatures whose thread or
   * priority actually changed; the ledger days holding them are dropped in
   * the same transaction, so derived history can never disagree with a link.
   */
  upsertAnnotations(annotations: ActivityAnnotation[], nowIso: string): string[];

  // Day ledger (a cache of derived facts; safe to drop at any time)
  /** Every ledger row of the days starting in [startIso, endIso). */
  getDayFacts(startIso: string, endIso: string): DayFactRow[];
  /** Replace one day's rows. */
  putDayFacts(day: DayFacts): void;
  /** Drop the days overlapping the range — or all of them. */
  deleteDayFacts(range: { start: string; end: string } | null): number;
  /** Thread labels already in use, most recently used first. */
  listThreadLabels(limit: number): string[];
}

export interface NewReflectionReport {
  id: string;
  period: ReflectionPeriod;
  coveredUntil: string;
  trigger: ReflectionTrigger;
  inputSchemaVersion: number;
  outputSchemaVersion: number;
  promptVersion: string;
  model: string;
  nowIso: string;
}

export interface ReflectionCommit {
  reportId: string;
  period: ReflectionPeriod;
  coveredUntil: string;
  /** Concrete model version that produced the accepted output. */
  model: string;
  attemptCount: number;
  headline: string;
  narrative: string | null;
  carryForward: ReflectionCarryForward | null;
  /** The coaching half of a day's intelligence, when it was written together. */
  coach: ReportCoachBlock | null;
  insights: ReflectionInsight[];
  dataSnapshot: ReflectionDataSnapshot;
  metricsSnapshot: MetricSet;
  nowIso: string;
  /**
   * Further writes that must land atomically with the report (the Coach's
   * actions and memory). Runs inside the commit's transaction: if it throws,
   * nothing of this commit is kept.
   */
  alongside?: () => void;
}

export interface ReflectionFeedbackRecord {
  insightId: string;
  insightType: ReflectionInsightType;
  feedbackType: ReflectionFeedbackType;
  createdAt: string;
  /** What the insight was about — so feedback applies to the claim, not just its type. */
  identityKey?: string;
  subjectKey?: string | null;
  title?: string;
  reportId?: string;
  periodType?: ReflectionPeriodType;
  periodKey?: string;
}

export interface InsightHistoryRow {
  period: ReflectionPeriod;
  reportId: string;
  insightId: string;
  type: ReflectionInsightType;
  title: string;
  identityKey: string;
  subjectKey: string | null;
  thread: string | null;
  priorityId: string | null;
  continuity: InsightContinuity;
  magnitude: number | null;
  feedback: ReflectionFeedbackType | null;
}

/** How many failed attempts are kept per period (older ones are pruned). */
const MAX_FAILED_ROWS_PER_PERIOD = 5;

interface ReportRow {
  id: string;
  period_type: string;
  period_key: string;
  period_start: string;
  period_end: string;
  covered_until: string | null;
  status: string;
  trigger_source: string;
  headline: string | null;
  narrative: string | null;
  carry_forward_json: string | null;
  coach_json: string | null;
  input_schema_version: number;
  output_schema_version: number;
  prompt_version: string;
  model: string;
  attempt_count: number;
  data_snapshot_json: string | null;
  metrics_snapshot_json: string | null;
  error: string | null;
  error_category: string | null;
  stale_reason: string | null;
  stale_at: string | null;
  needs_verification: number;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InsightRow {
  id: string;
  report_id: string;
  position: number;
  type: string;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  evidence_json: string;
  source_activity_ids_json: string;
  source_metric_keys_json: string;
  claim_signature: string;
  confidence: number;
  created_at: string;
  feedback_type: string | null;
  identity_key: string | null;
  subject_key: string | null;
  thread: string | null;
  priority_id: string | null;
  continuity: string | null;
  magnitude: number | null;
}

interface PriorityEventRow {
  priority_id: string;
  at: string;
  type: string;
  text: string;
  previous_text: string | null;
}

interface DayFactDbRow {
  day_key: string;
  day_start: string;
  day_end: string;
  kind: string;
  key: string;
  label: string | null;
  minutes: number;
  sessions: number;
  priority_id: string | null;
}

interface PriorityRow {
  id: string;
  text: string;
  normalized_key: string;
  status: string;
  active_from: string;
  active_until: string | null;
  last_confirmed_at: string;
}

interface AnnotationRow {
  signature: string;
  thread_label: string | null;
  priority_id: string | null;
  checked_priority_ids_json: string;
  source: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class ReflectionRepository implements IReflectionRepository {
  private readonly insertReportStmt;
  private readonly pruneFailedStmt;
  private readonly recordAttemptStmt;
  private readonly supersedeCurrentStmt;
  private readonly completeReportStmt;
  private readonly insertInsightStmt;
  private readonly deleteFailedStmt;
  private readonly failReportStmt;
  private readonly deleteInsufficientStmt;
  private readonly failInterruptedStmt;
  private readonly currentReportStmt;
  private readonly latestAttemptStmt;
  private readonly reportByIdStmt;
  private readonly countFailedStmt;
  private readonly markStaleStmt;
  private readonly flagAllStmt;
  private readonly flagRangeStmt;
  private readonly clearVerificationStmt;
  private readonly listCurrentStmt;
  private readonly reportedPeriodsStmt;
  private readonly insightsStmt;

  private readonly insightExistsStmt;
  private readonly deleteFeedbackStmt;
  private readonly upsertFeedbackStmt;
  private readonly listFeedbackStmt;

  private readonly listPrioritiesStmt;
  private readonly insertPriorityStmt;
  private readonly archivePriorityStmt;
  private readonly confirmPriorityStmt;
  private readonly priorityByIdStmt;
  private readonly setPriorityStatusStmt;

  private readonly annotationsStmt;
  private readonly upsertAnnotationStmt;
  private readonly threadLabelsStmt;

  private readonly insightHistoryStmt;
  private readonly priorityEventsStmt;
  private readonly insertPriorityEventStmt;
  private readonly reactivatePriorityStmt;
  private readonly renamePriorityStmt;
  private readonly dayFactsStmt;
  private readonly insertDayFactStmt;
  private readonly deleteDayStmt;
  private readonly deleteDayRangeStmt;
  private readonly deleteAllDaysStmt;
  private readonly deleteDaysBySignatureStmt;

  constructor(private readonly db: Database) {
    this.insertReportStmt = db.prepare(
      `INSERT INTO reflection_reports
         (id, period_type, period_key, period_start, period_end, covered_until, status, trigger_source,
          input_schema_version, output_schema_version, prompt_version, model, attempt_count, created_at, updated_at)
       VALUES
         (@id, @period_type, @period_key, @period_start, @period_end, @covered_until, @status, @trigger_source,
          @input_schema_version, @output_schema_version, @prompt_version, @model, 0, @now, @now)`,
    );
    this.pruneFailedStmt = db.prepare(
      `DELETE FROM reflection_reports
       WHERE status = 'failed' AND period_type = @period_type AND period_key = @period_key
         AND id NOT IN (
           SELECT id FROM reflection_reports
           WHERE status = 'failed' AND period_type = @period_type AND period_key = @period_key
           ORDER BY created_at DESC, rowid DESC
           LIMIT ${MAX_FAILED_ROWS_PER_PERIOD}
         )`,
    );
    this.recordAttemptStmt = db.prepare(
      `UPDATE reflection_reports SET attempt_count = @attempt_count, updated_at = @now WHERE id = @id`,
    );
    this.supersedeCurrentStmt = db.prepare(
      `UPDATE reflection_reports
       SET status = 'superseded', updated_at = @now
       WHERE period_type = @period_type AND period_key = @period_key
         AND status IN ('fresh', 'stale') AND id != @id`,
    );
    this.completeReportStmt = db.prepare(
      `UPDATE reflection_reports
       SET status = 'fresh', headline = @headline, narrative = @narrative,
           carry_forward_json = @carry_forward_json, coach_json = @coach_json,
           covered_until = @covered_until, model = @model, attempt_count = @attempt_count,
           data_snapshot_json = @data_snapshot_json, metrics_snapshot_json = @metrics_snapshot_json,
           error = NULL, error_category = NULL, stale_reason = NULL, stale_at = NULL,
           needs_verification = 0, generated_at = @now, updated_at = @now
       WHERE id = @id AND status = 'generating'`,
    );
    this.insertInsightStmt = db.prepare(
      `INSERT INTO reflection_insights
         (id, report_id, position, type, title, observation, interpretation, relevance,
          evidence_json, source_activity_ids_json, source_metric_keys_json, claim_signature, confidence,
          identity_key, subject_key, thread, priority_id, continuity, magnitude,
          created_at, updated_at)
       VALUES
         (@id, @report_id, @position, @type, @title, @observation, @interpretation, @relevance,
          @evidence_json, @source_activity_ids_json, @source_metric_keys_json, @claim_signature, @confidence,
          @identity_key, @subject_key, @thread, @priority_id, @continuity, @magnitude,
          @now, @now)`,
    );
    this.deleteFailedStmt = db.prepare(
      `DELETE FROM reflection_reports
       WHERE period_type = @period_type AND period_key = @period_key AND status IN ('failed', 'insufficient_data')`,
    );
    this.failReportStmt = db.prepare(
      `UPDATE reflection_reports
       SET status = 'failed', error = @error, error_category = @error_category, updated_at = @now
       WHERE id = @id AND status = 'generating'`,
    );
    this.deleteInsufficientStmt = db.prepare(
      `DELETE FROM reflection_reports
       WHERE period_type = @period_type AND period_key = @period_key AND status = 'insufficient_data'`,
    );
    this.failInterruptedStmt = db.prepare(
      `UPDATE reflection_reports
       SET status = 'failed', error = 'Interrupted before completion', error_category = 'internal', updated_at = @now
       WHERE status = 'generating'`,
    );
    this.currentReportStmt = db.prepare(
      `SELECT * FROM reflection_reports
       WHERE period_type = @period_type AND period_key = @period_key AND status IN ('fresh', 'stale')
       LIMIT 1`,
    );
    this.latestAttemptStmt = db.prepare(
      `SELECT * FROM reflection_reports
       WHERE period_type = @period_type AND period_key = @period_key
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    );
    this.reportByIdStmt = db.prepare(`SELECT * FROM reflection_reports WHERE id = ?`);
    this.countFailedStmt = db.prepare(
      `SELECT COUNT(*) AS count FROM reflection_reports
       WHERE period_type = @period_type AND period_key = @period_key AND status = 'failed'
         AND error_category IN (SELECT value FROM json_each(@categories))`,
    );
    this.markStaleStmt = db.prepare(
      `UPDATE reflection_reports
       SET status = 'stale', stale_reason = @reason, stale_at = @now, needs_verification = 0, updated_at = @now
       WHERE id = @id AND status = 'fresh'`,
    );
    this.flagAllStmt = db.prepare(
      `UPDATE reflection_reports SET needs_verification = 1, updated_at = @now
       WHERE status = 'fresh' AND needs_verification = 0`,
    );
    this.flagRangeStmt = db.prepare(
      `UPDATE reflection_reports SET needs_verification = 1, updated_at = @now
       WHERE status = 'fresh' AND needs_verification = 0
         AND period_end > @start
         AND period_start < CASE period_type
               WHEN 'day' THEN @end_day WHEN 'week' THEN @end_week WHEN 'month' THEN @end_month ELSE @end_year END`,
    );
    this.clearVerificationStmt = db.prepare(`UPDATE reflection_reports SET needs_verification = 0 WHERE id = ?`);
    this.listCurrentStmt = db.prepare(
      `SELECT * FROM reflection_reports
       WHERE status IN ('fresh', 'stale')
         AND (@period_type IS NULL OR period_type = @period_type)
         AND (@before IS NULL OR period_start < @before)
       ORDER BY period_start DESC, rowid DESC
       LIMIT @limit`,
    );
    this.reportedPeriodsStmt = db.prepare(
      `SELECT period_type, period_key, period_start, period_end FROM reflection_reports
       WHERE status IN ('fresh', 'stale')
       ORDER BY period_start DESC, rowid DESC`,
    );
    this.insightsStmt = db.prepare(
      `SELECT i.*, f.feedback_type
       FROM reflection_insights i
       LEFT JOIN reflection_feedback f ON f.insight_id = i.id
       WHERE i.report_id = ?
       ORDER BY i.position ASC`,
    );

    this.insightExistsStmt = db.prepare(`SELECT 1 AS one FROM reflection_insights WHERE id = ?`);
    this.deleteFeedbackStmt = db.prepare(`DELETE FROM reflection_feedback WHERE insight_id = ?`);
    this.upsertFeedbackStmt = db.prepare(
      `INSERT INTO reflection_feedback (id, insight_id, feedback_type, created_at)
       VALUES (@id, @insight_id, @feedback_type, @now)
       ON CONFLICT (insight_id) DO UPDATE SET
         feedback_type = excluded.feedback_type,
         created_at    = excluded.created_at`,
    );
    this.listFeedbackStmt = db.prepare(
      `SELECT f.insight_id, f.feedback_type, f.created_at, i.type, i.title, i.identity_key, i.claim_signature, i.subject_key,
              r.id AS report_id, r.period_type, r.period_key
       FROM reflection_feedback f
       JOIN reflection_insights i ON i.id = f.insight_id
       JOIN reflection_reports r ON r.id = i.report_id
       WHERE f.created_at >= ?
       ORDER BY f.created_at DESC, f.rowid DESC`,
    );

    this.listPrioritiesStmt = db.prepare(`SELECT * FROM reflection_priorities ORDER BY active_from ASC, rowid ASC`);
    this.insertPriorityStmt = db.prepare(
      `INSERT INTO reflection_priorities
         (id, text, normalized_key, status, active_from, active_until, last_confirmed_at, created_at, updated_at)
       VALUES
         (@id, @text, @normalized_key, 'active', @active_from, NULL, @last_confirmed_at, @now, @now)`,
    );
    this.archivePriorityStmt = db.prepare(
      `UPDATE reflection_priorities
       SET status = 'archived', active_until = COALESCE(active_until, @now), updated_at = @now
       WHERE id = @id AND status != 'archived'`,
    );
    this.confirmPriorityStmt = db.prepare(
      `UPDATE reflection_priorities SET last_confirmed_at = @confirmed_at, updated_at = @now WHERE id = @id`,
    );
    this.priorityByIdStmt = db.prepare(`SELECT * FROM reflection_priorities WHERE id = ?`);
    this.setPriorityStatusStmt = db.prepare(
      `UPDATE reflection_priorities
       SET status = @status,
           active_until = CASE WHEN @status = 'active' THEN NULL ELSE COALESCE(active_until, @now) END,
           last_confirmed_at = CASE WHEN @status = 'active' THEN @now ELSE last_confirmed_at END,
           updated_at = @now
       WHERE id = @id AND status != @status`,
    );
    this.priorityEventsStmt = db.prepare(`SELECT priority_id, at, type, text, previous_text FROM reflection_priority_events ORDER BY at ASC, id ASC`);
    this.insertPriorityEventStmt = db.prepare(
      `INSERT INTO reflection_priority_events (priority_id, at, type, text, previous_text)
       VALUES (@priority_id, @at, @type, @text, @previous_text)`,
    );
    this.reactivatePriorityStmt = db.prepare(
      `UPDATE reflection_priorities
       SET status = 'active', active_until = NULL, text = @text, last_confirmed_at = @confirmed_at, updated_at = @now
       WHERE id = @id AND status = 'archived'`,
    );
    this.renamePriorityStmt = db.prepare(
      `UPDATE reflection_priorities
       SET text = @text, normalized_key = @normalized_key, last_confirmed_at = @confirmed_at, updated_at = @now
       WHERE id = @id`,
    );

    this.annotationsStmt = db.prepare(
      `SELECT * FROM reflection_activity_annotations
       WHERE signature IN (SELECT value FROM json_each(@signatures))`,
    );
    // USER > MODEL: a correction is only ever replaced by another correction.
    this.upsertAnnotationStmt = db.prepare(
      `INSERT INTO reflection_activity_annotations
         (signature, thread_label, priority_id, checked_priority_ids_json, source, created_at, updated_at)
       VALUES
         (@signature, @thread_label, @priority_id, @checked_priority_ids_json, @source, @now, @now)
       ON CONFLICT (signature) DO UPDATE SET
         thread_label              = excluded.thread_label,
         priority_id               = excluded.priority_id,
         checked_priority_ids_json = excluded.checked_priority_ids_json,
         source                    = excluded.source,
         updated_at                = excluded.updated_at
       WHERE reflection_activity_annotations.source != 'user' OR excluded.source = 'user'`,
    );

    this.insightHistoryStmt = db.prepare(
      `SELECT r.id AS report_id, r.period_type, r.period_key, r.period_start, r.period_end,
              i.id, i.type, i.title, i.claim_signature, i.identity_key, i.subject_key, i.thread, i.priority_id,
              i.continuity, i.magnitude, f.feedback_type
       FROM (
         SELECT * FROM reflection_reports
         WHERE status IN ('fresh', 'stale') AND period_type = @period_type AND period_start < @before
         ORDER BY period_start DESC, rowid DESC
         LIMIT @limit
       ) r
       JOIN reflection_insights i ON i.report_id = r.id
       LEFT JOIN reflection_feedback f ON f.insight_id = i.id
       ORDER BY r.period_start DESC, i.position ASC`,
    );

    this.dayFactsStmt = db.prepare(
      `SELECT * FROM reflection_day_facts WHERE day_start >= @start AND day_start < @end ORDER BY day_start ASC, kind ASC, key ASC`,
    );
    this.insertDayFactStmt = db.prepare(
      `INSERT INTO reflection_day_facts (day_key, day_start, day_end, kind, key, label, minutes, sessions, priority_id)
       VALUES (@day_key, @day_start, @day_end, @kind, @key, @label, @minutes, @sessions, @priority_id)`,
    );
    this.deleteDayStmt = db.prepare(`DELETE FROM reflection_day_facts WHERE day_key = ?`);
    this.deleteDayRangeStmt = db.prepare(`DELETE FROM reflection_day_facts WHERE day_start < @end AND day_end > @start`);
    this.deleteAllDaysStmt = db.prepare(`DELETE FROM reflection_day_facts`);
    this.deleteDaysBySignatureStmt = db.prepare(
      `DELETE FROM reflection_day_facts
       WHERE day_key IN (
         SELECT day_key FROM reflection_day_facts
         WHERE kind = 'signature' AND key IN (SELECT value FROM json_each(@signatures))
       )`,
    );
    this.threadLabelsStmt = db.prepare(
      `SELECT thread_label FROM reflection_activity_annotations
       WHERE thread_label IS NOT NULL
       GROUP BY thread_label
       ORDER BY MAX(updated_at) DESC, thread_label ASC
       LIMIT ?`,
    );
  }

  // --- Reports ---

  createGenerating(report: NewReflectionReport): void {
    this.db.transaction(() => {
      this.insertReportStmt.run(reportParams(report, 'generating'));
      this.pruneFailedStmt.run({ period_type: report.period.type, period_key: report.period.key });
    });
  }

  recordAttempt(reportId: string, attemptCount: number, nowIso: string): void {
    this.recordAttemptStmt.run({ id: reportId, attempt_count: attemptCount, now: nowIso });
  }

  commitReport(commit: ReflectionCommit): void {
    const { period, nowIso: now } = commit;
    this.db.transaction(() => {
      this.supersedeCurrentStmt.run({ id: commit.reportId, period_type: period.type, period_key: period.key, now });
      const done = this.completeReportStmt.run({
        id: commit.reportId,
        headline: commit.headline,
        narrative: commit.narrative,
        carry_forward_json: commit.carryForward ? JSON.stringify(commit.carryForward) : null,
        coach_json: commit.coach ? JSON.stringify(commit.coach) : null,
        covered_until: commit.coveredUntil,
        model: commit.model,
        attempt_count: commit.attemptCount,
        data_snapshot_json: JSON.stringify(commit.dataSnapshot),
        metrics_snapshot_json: JSON.stringify(commit.metricsSnapshot),
        now,
      });
      if (done.changes === 0) throw new Error(`Reflection report ${commit.reportId} is not being generated`);

      commit.insights.forEach((insight, position) => {
        this.insertInsightStmt.run({
          id: insight.id,
          report_id: commit.reportId,
          position,
          type: insight.type,
          title: insight.title,
          observation: insight.observation,
          interpretation: insight.interpretation,
          relevance: insight.relevance,
          evidence_json: JSON.stringify(insight.evidence),
          source_activity_ids_json: JSON.stringify(insight.sourceActivityIds),
          source_metric_keys_json: JSON.stringify(insight.sourceMetricKeys),
          claim_signature: insight.claimSignature,
          confidence: insight.confidence,
          identity_key: insight.identityKey,
          subject_key: insight.subjectKey,
          thread: insight.thread,
          priority_id: insight.priorityId,
          continuity: insight.continuity,
          magnitude: insight.magnitude,
          now,
        });
      });

      // Earlier failed / insufficient attempts of this period are now history.
      this.deleteFailedStmt.run({ period_type: period.type, period_key: period.key });

      commit.alongside?.();
    });
  }

  failReport(reportId: string, category: ReflectionErrorCategory, error: string, nowIso: string): void {
    this.failReportStmt.run({ id: reportId, error, error_category: category, now: nowIso });
  }

  recordInsufficient(report: NewReflectionReport): void {
    this.db.transaction(() => {
      this.deleteInsufficientStmt.run({ period_type: report.period.type, period_key: report.period.key });
      this.insertReportStmt.run(reportParams(report, 'insufficient_data'));
    });
  }

  failInterruptedReports(nowIso: string): number {
    return this.failInterruptedStmt.run({ now: nowIso }).changes;
  }

  getCurrentReport(type: ReflectionPeriodType, key: string): ReflectionReport | null {
    const row = this.currentReportStmt.get({ period_type: type, period_key: key }) as ReportRow | undefined;
    return row ? this.toReport(row) : null;
  }

  getLatestAttempt(type: ReflectionPeriodType, key: string): ReflectionReport | null {
    const row = this.latestAttemptStmt.get({ period_type: type, period_key: key }) as ReportRow | undefined;
    return row ? this.toReport(row) : null;
  }

  getReportById(id: string): ReflectionReport | null {
    const row = this.reportByIdStmt.get(id) as ReportRow | undefined;
    return row ? this.toReport(row) : null;
  }

  countFailedReports(type: ReflectionPeriodType, key: string, categories: ReflectionErrorCategory[]): number {
    const row = this.countFailedStmt.get({
      period_type: type,
      period_key: key,
      categories: JSON.stringify(categories),
    }) as { count: number };
    return row.count;
  }

  markStale(reportId: string, reason: string, nowIso: string): boolean {
    return this.markStaleStmt.run({ id: reportId, reason, now: nowIso }).changes > 0;
  }

  flagForVerification(range: { start: string; end: string } | null, nowIso: string): number {
    if (!range) return this.flagAllStmt.run({ now: nowIso }).changes;
    const reach = referenceReach(range.end);
    return this.flagRangeStmt.run({ start: range.start, end_day: reach.day, end_week: reach.week, end_month: reach.month, end_year: reach.year, now: nowIso }).changes;
  }

  clearVerification(reportId: string): void {
    this.clearVerificationStmt.run(reportId);
  }

  listCurrentReports(type: ReflectionPeriodType | null, limit: number, beforeStart?: string): ReflectionReport[] {
    const rows = this.listCurrentStmt.all({ period_type: type, before: beforeStart ?? null, limit }) as ReportRow[];
    return rows.map((row) => this.toReport(row));
  }

  listReportedPeriods(): ReflectionPeriod[] {
    const rows = this.reportedPeriodsStmt.all() as Pick<
      ReportRow,
      'period_type' | 'period_key' | 'period_start' | 'period_end'
    >[];
    return rows.map((r) => ({
      type: r.period_type as ReflectionPeriodType,
      key: r.period_key,
      start: r.period_start,
      end: r.period_end,
    }));
  }

  listInsightHistory(type: ReflectionPeriodType, beforeStart: string, reportLimit: number): InsightHistoryRow[] {
    const rows = this.insightHistoryStmt.all({ period_type: type, before: beforeStart, limit: reportLimit }) as (InsightRow & {
      report_id: string;
      period_type: string;
      period_key: string;
      period_start: string;
      period_end: string;
    })[];
    return rows.map((r) => ({
      period: { type: r.period_type as ReflectionPeriodType, key: r.period_key, start: r.period_start, end: r.period_end },
      reportId: r.report_id,
      insightId: r.id,
      type: r.type as ReflectionInsightType,
      title: r.title,
      identityKey: r.identity_key ?? r.claim_signature,
      subjectKey: r.subject_key,
      thread: r.thread,
      priorityId: r.priority_id,
      continuity: (r.continuity ?? 'new') as InsightContinuity,
      magnitude: r.magnitude,
      feedback: r.feedback_type as ReflectionFeedbackType | null,
    }));
  }

  // --- Feedback ---

  setFeedback(insightId: string, feedback: ReflectionFeedbackType | null, id: string, nowIso: string): boolean {
    if (this.insightExistsStmt.get(insightId) === undefined) return false;
    if (feedback === null) this.deleteFeedbackStmt.run(insightId);
    else this.upsertFeedbackStmt.run({ id, insight_id: insightId, feedback_type: feedback, now: nowIso });
    return true;
  }

  listFeedback(sinceIso: string): ReflectionFeedbackRecord[] {
    const rows = this.listFeedbackStmt.all(sinceIso) as {
      insight_id: string;
      feedback_type: string;
      created_at: string;
      type: string;
      title: string;
      identity_key: string | null;
      claim_signature: string;
      subject_key: string | null;
      report_id: string;
      period_type: string;
      period_key: string;
    }[];
    return rows.map((r) => ({
      insightId: r.insight_id,
      insightType: r.type as ReflectionInsightType,
      feedbackType: r.feedback_type as ReflectionFeedbackType,
      createdAt: r.created_at,
      identityKey: r.identity_key ?? r.claim_signature,
      subjectKey: r.subject_key,
      title: r.title,
      reportId: r.report_id,
      periodType: r.period_type as ReflectionPeriodType,
      periodKey: r.period_key,
    }));
  }

  // --- Priorities ---

  listPriorities(): ReflectionPriority[] {
    const events = new Map<string, PriorityEvent[]>();
    for (const e of this.priorityEventsStmt.all() as PriorityEventRow[]) {
      const list = events.get(e.priority_id) ?? [];
      list.push({ priorityId: e.priority_id, at: e.at, type: e.type as PriorityEventType, text: e.text, previousText: e.previous_text });
      events.set(e.priority_id, list);
    }
    return (this.listPrioritiesStmt.all() as PriorityRow[]).map((row) => rowToPriority(row, events.get(row.id) ?? []));
  }

  private recordPriorityEvent(id: string, type: PriorityEventType, at: string, text: string, previousText: string | null = null): void {
    this.insertPriorityEventStmt.run({ priority_id: id, at, type, text, previous_text: previousText });
  }

  applyPrioritySync(plan: PrioritySyncPlan, ids: string[], nowIso: string): void {
    this.db.transaction(() => {
      const textOf = (id: string) => (this.priorityByIdStmt.get(id) as PriorityRow | undefined)?.text ?? '';
      for (const id of plan.archiveIds) {
        if (this.archivePriorityStmt.run({ id, now: nowIso }).changes > 0) this.recordPriorityEvent(id, 'archived', nowIso, textOf(id));
      }
      for (const id of plan.confirmIds) this.confirmPriorityStmt.run({ id, confirmed_at: plan.confirmedAt, now: nowIso });
      for (const r of plan.reactivate) {
        if (this.reactivatePriorityStmt.run({ id: r.id, text: r.text, confirmed_at: plan.confirmedAt, now: nowIso }).changes > 0) {
          this.recordPriorityEvent(r.id, 'reactivated', nowIso, r.text);
        }
      }
      for (const r of plan.rename) {
        this.renamePriorityStmt.run({ id: r.id, text: r.text, normalized_key: r.normalizedKey, confirmed_at: plan.confirmedAt, now: nowIso });
        this.recordPriorityEvent(r.id, 'renamed', nowIso, r.text, r.previousText);
      }
      plan.insert.forEach((p, index) => {
        this.insertPriorityStmt.run({
          id: ids[index],
          text: p.text,
          normalized_key: p.normalizedKey,
          active_from: p.activeFrom,
          last_confirmed_at: p.lastConfirmedAt,
          now: nowIso,
        });
        this.recordPriorityEvent(ids[index], 'stated', p.activeFrom, p.text);
      });
    });
  }

  setPriorityStatus(id: string, status: ReflectionPriorityStatus, nowIso: string): ReflectionPriority | null {
    this.db.transaction(() => {
      const before = this.priorityByIdStmt.get(id) as PriorityRow | undefined;
      if (!before || this.setPriorityStatusStmt.run({ id, status, now: nowIso }).changes === 0) return;
      // The stretch that just ended (or began) is history from now on.
      this.recordPriorityEvent(id, status === 'active' ? 'reactivated' : (status as PriorityEventType), nowIso, before.text);
    });
    return this.listPriorities().find((p) => p.id === id) ?? null;
  }

  // --- Annotations ---

  getAnnotations(signatures: string[]): ActivityAnnotation[] {
    if (signatures.length === 0) return [];
    const rows = this.annotationsStmt.all({ signatures: JSON.stringify(signatures) }) as AnnotationRow[];
    return rows.map((r) => ({
      signature: r.signature,
      thread: r.thread_label,
      priorityId: r.priority_id,
      checkedPriorityIds: parseJson<string[]>(r.checked_priority_ids_json, []),
      source: r.source === 'user' ? 'user' : 'model',
    }));
  }

  upsertAnnotations(annotations: ActivityAnnotation[], nowIso: string): string[] {
    if (annotations.length === 0) return [];
    const changed: string[] = [];
    this.db.transaction(() => {
      const before = new Map(this.getAnnotations(annotations.map((a) => a.signature)).map((a) => [a.signature, a]));
      for (const a of annotations) {
        const written = this.upsertAnnotationStmt.run({
          signature: a.signature,
          thread_label: a.thread,
          priority_id: a.priorityId,
          checked_priority_ids_json: JSON.stringify(a.checkedPriorityIds),
          source: a.source ?? 'model',
          now: nowIso,
        });
        const previous = before.get(a.signature);
        const differs = !previous || previous.thread !== a.thread || previous.priorityId !== a.priorityId || (previous.source ?? 'model') !== (a.source ?? 'model');
        if (written.changes > 0 && differs) changed.push(a.signature);
      }
      // Days derived from a link that just changed are derived again on demand.
      if (changed.length > 0) this.deleteDaysBySignatureStmt.run({ signatures: JSON.stringify(changed) });
    });
    return changed;
  }

  listThreadLabels(limit: number): string[] {
    return (this.threadLabelsStmt.all(limit) as { thread_label: string }[]).map((r) => r.thread_label);
  }

  // --- Day ledger ---

  getDayFacts(startIso: string, endIso: string): DayFactRow[] {
    return (this.dayFactsStmt.all({ start: startIso, end: endIso }) as DayFactDbRow[]).map((r) => ({
      dayKey: r.day_key,
      dayStart: r.day_start,
      dayEnd: r.day_end,
      kind: r.kind as DayFactKind,
      key: r.key,
      label: r.label,
      minutes: r.minutes,
      sessions: r.sessions,
      priorityId: r.priority_id,
    }));
  }

  putDayFacts(day: DayFacts): void {
    this.db.transaction(() => {
      this.deleteDayStmt.run(day.key);
      for (const r of day.rows) {
        this.insertDayFactStmt.run({
          day_key: day.key,
          day_start: day.start,
          day_end: day.end,
          kind: r.kind,
          key: r.key,
          label: r.label,
          minutes: r.minutes,
          sessions: r.sessions,
          priority_id: r.priorityId,
        });
      }
    });
  }

  deleteDayFacts(range: { start: string; end: string } | null): number {
    return range ? this.deleteDayRangeStmt.run({ start: range.start, end: range.end }).changes : this.deleteAllDaysStmt.run().changes;
  }

  // --- Event removal ---

  /**
   * The user hid or deleted events. Every stored report that was written
   * from a block holding one of them stops showing what was derived from it:
   *
   *   - insights (and the carry-forward) that cite the block are removed,
   *     with their evidence — a claim is not kept without what it rested on;
   *   - the block leaves the report's record of what it was written from;
   *   - the headline and the narrative, which retell the period in free prose
   *     and cannot be checked sentence by sentence, are withdrawn;
   *   - a current report becomes stale (`events_removed`), which is what gets
   *     it rewritten from the timeline as it now is.
   *
   * Reports that never saw the events are not touched. `signatures` are the
   * thread / priority links cached for the affected blocks; the ones the
   * model decided are dropped so their labels are not offered again (a link
   * the user corrected is theirs and stays).
   *
   * Returns the periods whose current report went stale.
   */
  redactRemovedEvents(removed: RemovedEvents, signatures: string[], nowIso: string): ReflectionPeriod[] {
    if (removed.eventIds.length === 0 || removed.ranges.length === 0) return [];
    const start = removed.ranges.reduce((min, r) => (r.start < min ? r.start : min), removed.ranges[0].start);
    const end = removed.ranges.reduce((max, r) => (r.end > max ? r.end : max), removed.ranges[0].end);
    const stale: ReflectionPeriod[] = [];

    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM reflection_reports
           WHERE status IN ('fresh', 'stale', 'superseded') AND period_start <= @end AND period_end >= @start`,
        )
        .all({ start, end }) as ReportRow[];
      const deleteInsight = this.db.prepare(`DELETE FROM reflection_insights WHERE id = ?`);
      const redact = this.db.prepare(
        `UPDATE reflection_reports
         SET headline = @headline, narrative = NULL,
             carry_forward_json = CASE WHEN @drop_carry = 1 THEN NULL ELSE carry_forward_json END,
             data_snapshot_json = @data_snapshot_json,
             status = CASE WHEN status = 'fresh' THEN 'stale' ELSE status END,
             stale_reason = CASE WHEN status = 'superseded' THEN stale_reason ELSE @reason END,
             stale_at = CASE WHEN status = 'superseded' THEN stale_at ELSE @now END,
             needs_verification = 0, updated_at = @now
         WHERE id = @id`,
      );

      for (const row of rows) {
        const report = this.toReport(row);
        const plan = planReportRedaction(report, removed);
        if (!plan) continue;
        for (const id of plan.insightIds) deleteInsight.run(id);
        const snapshot = report.dataSnapshot
          ? { ...report.dataSnapshot, activities: report.dataSnapshot.activities.filter((_, index) => !plan.snapshotActivities.includes(index)) }
          : null;
        redact.run({
          id: row.id,
          headline: EVENTS_REMOVED_HEADLINE,
          drop_carry: plan.carryForward ? 1 : 0,
          data_snapshot_json: snapshot ? JSON.stringify(snapshot) : null,
          reason: EVENTS_REMOVED_REASON,
          now: nowIso,
        });
        if (row.status !== 'superseded') stale.push(report.period);
      }

      if (signatures.length > 0) {
        this.db
          .prepare(
            `DELETE FROM reflection_activity_annotations
             WHERE source != 'user' AND signature IN (SELECT value FROM json_each(@signatures))`,
          )
          .run({ signatures: JSON.stringify(signatures) });
      }
    });
    return stale;
  }

  // --- mapping ---

  private toReport(row: ReportRow): ReflectionReport {
    const insights = (this.insightsStmt.all(row.id) as InsightRow[]).map((i) => ({
      id: i.id,
      type: i.type as ReflectionInsightType,
      title: i.title,
      observation: i.observation,
      interpretation: i.interpretation,
      relevance: i.relevance,
      confidence: i.confidence,
      evidence: parseJson<ReflectionEvidence[]>(i.evidence_json, []),
      sourceActivityIds: parseJson<string[]>(i.source_activity_ids_json, []),
      sourceMetricKeys: parseJson<string[]>(i.source_metric_keys_json, []),
      claimSignature: i.claim_signature,
      // Reports written before identities existed are read through their signature.
      identityKey: i.identity_key ?? i.claim_signature,
      subjectKey: i.subject_key ?? null,
      thread: i.thread ?? null,
      priorityId: i.priority_id ?? null,
      continuity: (i.continuity ?? 'new') as InsightContinuity,
      magnitude: i.magnitude ?? null,
      createdAt: i.created_at,
      feedback: i.feedback_type as ReflectionFeedbackType | null,
    }));
    return {
      id: row.id,
      period: {
        type: row.period_type as ReflectionPeriodType,
        key: row.period_key,
        start: row.period_start,
        end: row.period_end,
      },
      coveredUntil: row.covered_until,
      status: row.status as ReflectionReportStatus,
      trigger: row.trigger_source as ReflectionTrigger,
      headline: row.headline,
      narrative: row.narrative ?? null,
      carryForward: parseJson<ReflectionCarryForward | null>(row.carry_forward_json, null),
      coach: parseJson<ReportCoachBlock | null>(row.coach_json ?? null, null),
      insights,
      inputSchemaVersion: row.input_schema_version,
      outputSchemaVersion: row.output_schema_version,
      promptVersion: row.prompt_version,
      model: row.model,
      attemptCount: row.attempt_count,
      dataSnapshot: parseJson<ReflectionDataSnapshot | null>(row.data_snapshot_json, null),
      metricsSnapshot: parseJson<MetricSet | null>(row.metrics_snapshot_json, null),
      error: row.error,
      errorCategory: row.error_category as ReflectionErrorCategory | null,
      staleReason: row.stale_reason,
      staleAt: row.stale_at,
      needsVerification: row.needs_verification === 1,
      generatedAt: row.generated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * How far past a change the reports reach that were COMPARED with the changed
 * stretch: a report's reference is its previous period, so a change touches
 * the reports of the following day / week / month / year too.
 */
export function referenceReach(endIso: string): Record<ReflectionPeriodType, string> {
  const at = (days: number) => new Date(Date.parse(endIso) + days * 86_400_000).toISOString();
  return { day: at(1), week: at(7), month: at(31), year: at(366) };
}

function reportParams(report: NewReflectionReport, status: ReflectionReportStatus) {
  return {
    id: report.id,
    period_type: report.period.type,
    period_key: report.period.key,
    period_start: report.period.start,
    period_end: report.period.end,
    covered_until: report.coveredUntil,
    status,
    trigger_source: report.trigger,
    input_schema_version: report.inputSchemaVersion,
    output_schema_version: report.outputSchemaVersion,
    prompt_version: report.promptVersion,
    model: report.model,
    now: report.nowIso,
  };
}

function rowToPriority(r: PriorityRow, history: PriorityEvent[]): ReflectionPriority {
  const intervals = intervalsFromEvents(history);
  return {
    id: r.id,
    text: r.text,
    normalizedKey: r.normalized_key,
    status: r.status as ReflectionPriorityStatus,
    activeFrom: r.active_from,
    activeUntil: r.active_until,
    lastConfirmedAt: r.last_confirmed_at,
    ...(intervals.length > 0 ? { intervals, history } : {}),
  };
}
