import { randomUUID } from 'node:crypto';
import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import type { IUserProfileRepository } from '../database/UserProfileRepository.js';
import { GeminiError, type IGeminiClient } from '../intelligence/GeminiClient.js';
import type { UserContextProvider } from '../intelligence/IntelligenceModels.js';
import { activitySignature } from './ReflectionActivities.js';
import type { ReflectionAnnotator } from './ReflectionAnnotator.js';
import { EVENTS_REMOVED_REASON } from './ReflectionChanges.js';
import type { DailyCoachSession, ReflectionCoachHook } from './ReflectionCoachHook.js';
import { assessSufficiency, findMeaningfulDifference, selectSupportingMetrics, staleReasonFor } from './ReflectionMetrics.js';
import { prioritiesFingerprint, type ReflectionMetricsService } from './ReflectionMetricsService.js';
import {
  DEFAULT_REFLECTION_CONFIG,
  REFLECTION_FEEDBACK_TYPES,
  REFLECTION_INPUT_SCHEMA_VERSION,
  REFLECTION_OUTPUT_SCHEMA_VERSION,
  REFLECTION_PERIOD_TYPES,
  REFLECTION_PRIORITY_STATUSES,
  type CarryItem,
  type GenerateResult,
  type InsightContinuity,
  type Metric,
  type MetricSet,
  type ReflectionConfig,
  type ReflectionErrorCategory,
  type ReflectionEvidence,
  type ReflectionFeedbackType,
  type ReflectionInsight,
  type ReflectionInsightType,
  type ReflectionLogger,
  type ReflectionPeriod,
  type ReflectionPeriodType,
  type ReflectionPriority,
  type ReflectionPriorityStatus,
  type ReflectionReport,
  type ReflectionTrigger,
  type ReportCoachBlock,
  type TaxonomyNames,
} from './ReflectionModels.js';
import {
  describePeriod,
  isCurrentPeriod,
  isFuturePeriod,
  isPeriodClosed,
  periodContaining,
  shiftPeriod,
} from './ReflectionPeriods.js';
import { prepareReflection } from './ReflectionPreprocessor.js';
import { isPossiblyStale, isSyncPlanEmpty, planPrioritySync, prioritiesActiveDuring } from './ReflectionPriorities.js';
import {
  REFLECTION_PROMPT_VERSION,
  buildReflectionPrompt,
  buildReflectionResponseSchema,
  buildReflectionRetryFeedback,
  buildReflectionSystemInstruction,
} from './ReflectionPrompt.js';
import { createEvidenceToolkit, validateReflectionOutput, type ValidatedReflection } from './ReflectionValidator.js';

/**
 * `ReflectionService` owns the reflection pipeline and its read model:
 *
 *   verified timeline → deterministic metrics (+ baselines, priorities)
 *     → compact dataset → Gemini → validation → transactional persistence
 *
 * A day's report is the day's INTELLIGENCE: when a coach is plugged in, the
 * same request also decides what is worth doing next, and its actions and
 * memory are committed in the same transaction as the report.
 *
 * Manual refresh and the scheduler both go through `generate` — there is one
 * pipeline. Reflection is an enhancement: every public method resolves with a
 * result object and never throws, and a failed generation leaves the
 * previously persisted reflection exactly as it was.
 */

/** One initial attempt + two retries. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 4_000];
const REJECTION_CATEGORIES: ReflectionErrorCategory[] = ['malformed_output', 'validation'];
const FEEDBACK_LOOKBACK_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;
/** How many periods the "which periods can I look at?" list reaches back, per type. */
const AVAILABILITY_LIMIT: Record<ReflectionPeriodType, number> = { day: 60, week: 26, month: 24, year: 10 };
/** Smaller periods first, so a week is written after its days and a month after its weeks. */
const TYPE_ORDER: Record<ReflectionPeriodType, number> = { day: 0, week: 1, month: 2, year: 3 };
/** The reflection of the next larger period is background for the smaller one. */
const LARGER_PERIOD: Partial<Record<ReflectionPeriodType, ReflectionPeriodType>> = { day: 'week', week: 'month', month: 'year' };

const FAILURE_MESSAGES: Record<ReflectionErrorCategory, string> = {
  missing_api_key: 'Gemini is not configured, so reflections cannot be written yet.',
  network: 'Reflect could not reach Gemini. Nothing was changed.',
  api: 'Gemini returned an error. Nothing was changed.',
  quota: 'The Gemini quota is exhausted for now. Nothing was changed.',
  malformed_output: 'The generated reflection was unreadable and was discarded.',
  validation: 'The generated reflection did not pass Reflect’s evidence checks and was discarded.',
  persistence: 'The reflection could not be saved.',
  internal: 'Something went wrong while writing this reflection.',
};

export interface ReflectionServiceDeps {
  repo: IReflectionRepository;
  gemini: IGeminiClient;
  metrics: ReflectionMetricsService;
  annotator: Pick<ReflectionAnnotator, 'annotate'>;
  userContext: UserContextProvider;
  profiles: Pick<IUserProfileRepository, 'getProfile'>;
  taxonomy: () => TaxonomyNames;
  /** Human descriptions of the user's confirmed learned rules. */
  learnedPatterns?: () => string[];
  /** Human descriptions of the rules the user wrote themselves. */
  explicitRules?: () => string[];
  /** Joins a day's reflection with coaching in one request. */
  coach?: ReflectionCoachHook;
  /** Minutes after local midnight at which the day's reflection is written; defaults to the config. */
  dailyReflectionMinutes?: () => number;
  config?: ReflectionConfig;
  logger?: ReflectionLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

// ── Read model ──────────────────────────────────────────────────────────────

export interface ReflectionMetricView {
  key: string;
  label: string;
  display: string;
}

export interface ReflectionInsightView {
  id: string;
  type: ReflectionInsightType;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  evidence: ReflectionEvidence[];
  feedback: ReflectionFeedbackType | null;
  /** New, continuing, strengthening, weakening, resolved or recurred — decided by Reflect, not the model. */
  continuity: InsightContinuity;
  /** The stated priority this is about, when it is about one. */
  priority: { id: string; text: string } | null;
  /** The project / thread this is about, when it is about one. */
  thread: string | null;
}

export interface ReflectionAvailablePeriod {
  period: ReflectionPeriod;
  /** 'reported': a reflection exists · 'available': enough was observed to write one · 'thin': too little · 'unobserved': nothing recorded. */
  status: 'reported' | 'available' | 'thin' | 'unobserved';
  trackedMinutes: number;
}

/** How one cited activity is currently understood — what a correction would change. */
export interface InsightBasisActivity {
  evidenceIndex: number;
  title: string;
  start: string;
  end: string;
  thread: string | null;
  priority: { id: string; text: string } | null;
  /** Who decided the priority link. */
  linkedBy: 'user' | 'model' | 'keyword' | null;
}

export interface ReflectionReportView {
  id: string;
  status: 'fresh' | 'stale';
  headline: string;
  /** "What happened", in a few sentences. Days only. */
  narrative: string | null;
  /** The coaching written with this report; the actions themselves are read through the Coach. */
  coach: ReportCoachBlock | null;
  insights: ReflectionInsightView[];
  carryForward: { text: string; evidence: ReflectionEvidence[] } | null;
  /** Work still unresolved from earlier periods (and what closed), as it stood when this was written. */
  carried: CarryItem[];
  generatedAt: string | null;
  coveredUntil: string | null;
  isPartial: boolean;
  staleReason: string | null;
  /** Written by an earlier version of Reflect's reasoning; it can be rewritten on request. */
  outdated: boolean;
  supportingMetrics: ReflectionMetricView[];
  notes: string[];
}

export type RefreshBlockedReason =
  | 'not_configured'
  | 'generating'
  | 'future_period'
  | 'up_to_date'
  | 'cooldown'
  | 'insufficient_data';

export interface ReflectionPriorityView {
  id: string;
  text: string;
  status: ReflectionPriorityStatus;
  activeFrom: string;
  lastConfirmedAt: string;
  possiblyStale: boolean;
}

export interface ReflectionView {
  period: ReflectionPeriod & {
    title: string;
    range: string;
    isCurrent: boolean;
    isClosed: boolean;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  configured: boolean;
  report: ReflectionReportView | null;
  generation: {
    state: 'idle' | 'generating' | 'failed' | 'insufficient_data';
    errorCategory: ReflectionErrorCategory | null;
    message: string | null;
    at: string | null;
  };
  /** Deterministic numbers for a period that is still running or has no report. */
  live: { asOf: string; metrics: ReflectionMetricView[] } | null;
  sufficiency: { enough: boolean; message: string | null };
  canRefresh: boolean;
  refreshBlockedReason: RefreshBlockedReason | null;
  refreshAvailableAt: string | null;
  priorities: ReflectionPriorityView[];
  /** When today's reflection is written (only for the day that is running). */
  dailyReflectionAt: string | null;
}

export interface GenerateOptions {
  trigger: ReflectionTrigger;
}

const silentLogger: ReflectionLogger = { info() {}, warn() {}, error() {} };

const toMetricView = (m: Metric): ReflectionMetricView => ({ key: m.key, label: m.label, display: m.display });

export class ReflectionService {
  private readonly config: ReflectionConfig;
  private readonly log: ReflectionLogger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  /** Serialises generations so two reports are never written concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<GenerateResult>>();

  constructor(private readonly deps: ReflectionServiceDeps) {
    this.config = deps.config ?? DEFAULT_REFLECTION_CONFIG;
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newId = deps.newId ?? randomUUID;
  }

  isConfigured(): boolean {
    return this.deps.gemini.isConfigured();
  }

  /** The period of `type` containing `anchor` (default: now). */
  resolvePeriod(type: ReflectionPeriodType, anchor?: string | null): ReflectionPeriod {
    const at = anchor ? new Date(anchor) : this.now();
    return periodContaining(type, Number.isNaN(at.getTime()) ? this.now() : at);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Everything the Reflection page needs for one period. Never calls Gemini. */
  async getView(type: ReflectionPeriodType, anchor?: string | null): Promise<ReflectionView> {
    const now = this.now();
    const nowIso = now.toISOString();
    const period = this.resolvePeriod(type, anchor);
    const label = describePeriod(period, now);
    const closed = isPeriodClosed(period, now);
    const future = isFuturePeriod(period, now);
    const priorities = this.syncPriorities();

    let report: ReflectionReport | null = null;
    let attempt: ReflectionReport | null = null;
    try {
      report = this.deps.repo.getCurrentReport(period.type, period.key);
      if (report) report = await this.verify(report, priorities);
      attempt = this.deps.repo.getLatestAttempt(period.type, period.key);
    } catch (err) {
      this.log.error(`[REFLECTION] Could not read report ${period.type} ${period.key}: ${messageOf(err)}`);
    }

    // Live numbers: for a running period ("so far"), or when nothing was written.
    let live: ReflectionView['live'] = null;
    let liveMetrics: MetricSet | null = null;
    if (!future && (!closed || !report)) {
      try {
        const coveredUntil = closed ? period.end : nowIso;
        liveMetrics = (await this.deps.metrics.computeCore(period, coveredUntil, priorities)).metrics;
        live = { asOf: coveredUntil, metrics: selectSupportingMetrics(liveMetrics, period.type).map(toMetricView) };
      } catch (err) {
        this.log.error(`[REFLECTION] Could not compute live metrics: ${messageOf(err)}`);
      }
    }

    const assessed = liveMetrics ? assessSufficiency(liveMetrics, period.type, this.config) : null;
    const sufficiency = assessed
      ? { enough: assessed.enough, message: assessed.message }
      : { enough: report !== null, message: null as string | null };

    const generating = this.inFlight.has(periodId(period)) || attempt?.status === 'generating';
    const failed = attempt?.status === 'failed' && (!report || attempt.createdAt >= report.createdAt);
    const generation: ReflectionView['generation'] = generating
      ? { state: 'generating', errorCategory: null, message: null, at: attempt?.createdAt ?? null }
      : failed
        ? {
            state: 'failed',
            errorCategory: attempt!.errorCategory,
            message: FAILURE_MESSAGES[attempt!.errorCategory ?? 'internal'],
            at: attempt!.updatedAt,
          }
        : !report && attempt?.status === 'insufficient_data'
          ? { state: 'insufficient_data', errorCategory: null, message: sufficiency.message, at: attempt.createdAt }
          : { state: 'idle', errorCategory: null, message: null, at: null };

    const refresh = this.refreshState(period, report, attempt, sufficiency.enough, generating);

    return {
      period: {
        ...period,
        title: label.title,
        range: label.range,
        isCurrent: isCurrentPeriod(period, now),
        isClosed: closed,
        hasPrevious: this.deps.metrics.hasHistoryBefore(period.start),
        hasNext: closed,
      },
      configured: this.isConfigured(),
      report: report ? toReportView(report, period.type, priorities) : null,
      generation,
      live,
      sufficiency,
      canRefresh: refresh.reason === null,
      refreshBlockedReason: refresh.reason,
      refreshAvailableAt: refresh.availableAt,
      priorities: this.priorityViews(priorities, nowIso),
      dailyReflectionAt:
        period.type === 'day' && isCurrentPeriod(period, now) ? new Date(this.dailyReflectionTime(period)).toISOString() : null,
    };
  }

  /**
   * What the Reflection tab should open on: today when today already has a
   * reflection, otherwise the latest day that has one (a morning opens on
   * yesterday's briefing). `null` means today.
   */
  landingAnchor(): string | null {
    try {
      const today = periodContaining('day', this.now());
      if (this.deps.repo.getCurrentReport('day', today.key)) return null;
      for (let back = 1; back <= 3; back++) {
        const day = shiftPeriod(today, -back);
        if (this.deps.repo.getCurrentReport('day', day.key)) return day.start;
      }
    } catch (err) {
      this.log.error(`[REFLECTION] Could not resolve the landing day: ${messageOf(err)}`);
    }
    return null;
  }

  /** The instant at which `day`'s reflection is due. */
  private dailyReflectionTime(day: ReflectionPeriod): number {
    const start = new Date(day.start);
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const configured = this.deps.dailyReflectionMinutes?.() ?? this.config.dailyReflectionHour * 60 + this.config.dailyReflectionMinute;
    // A reflection time "before" the day's start belongs to the small hours at its end.
    const offset = (((configured - startMinutes) % 1440) + 1440) % 1440;
    return new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + offset).getTime();
  }

  /** The next time a day's reflection falls due — when the scheduler should wake. */
  nextDailyReflectionAt(): Date {
    const now = this.now();
    const today = periodContaining('day', now);
    const due = this.dailyReflectionTime(today);
    return new Date(due > now.getTime() ? due : this.dailyReflectionTime(shiftPeriod(today, 1)));
  }

  /**
   * Which periods can be looked at. `periods` are the ones that already have
   * a reflection; with a `type`, `available` lists every period of that type
   * since tracking began (newest first) with what was observed in it — so a
   * past period that holds enough data can be reflected on when asked for,
   * and one in which nothing was recorded is shown as unobserved, not empty.
   */
  async listAvailablePeriods(type?: ReflectionPeriodType | null): Promise<{ periods: ReflectionPeriod[]; hasHistory: boolean; available: ReflectionAvailablePeriod[] }> {
    try {
      const periods = this.deps.repo.listReportedPeriods();
      const hasHistory = this.deps.metrics.hasHistoryBefore(this.now().toISOString());
      let available: ReflectionAvailablePeriod[] = [];
      if (type && hasHistory) {
        const reported = new Set(periods.filter((p) => p.type === type).map((p) => p.key));
        available = (await this.deps.metrics.availability(type, AVAILABILITY_LIMIT[type], this.syncPriorities())).map((a) => ({
          period: a.period,
          status: reported.has(a.period.key) ? 'reported' : a.enough ? 'available' : a.trackedMinutes < 1 ? 'unobserved' : 'thin',
          trackedMinutes: a.trackedMinutes,
        }));
      }
      return { periods, hasHistory, available };
    } catch (err) {
      this.log.error(`[REFLECTION] Could not list periods: ${messageOf(err)}`);
      return { periods: [], hasHistory: false, available: [] };
    }
  }

  // ── Evidence ───────────────────────────────────────────────────────────────

  /**
   * Where a stored piece of evidence is on the Timeline now. Evidence is
   * anchored to raw events, so it still resolves after the blocks around
   * those events were regrouped, re-analysed or edited.
   */
  async resolveEvidence(evidence: Pick<ReflectionEvidence, 'eventIds' | 'activityId' | 'period'>): Promise<{ activityId: string | null; start: string; end: string } | null> {
    try {
      return await this.deps.metrics.resolveEvidence(evidence);
    } catch (err) {
      this.log.error(`[REFLECTION] Could not resolve evidence: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * "Why did Reflect say this?" — the activities an insight cites, as they
   * are understood NOW: which project and which priority each is linked to,
   * and who decided that link. This is what the user corrects when an
   * insight is not accurate.
   */
  async getInsightBasis(reportId: string, insightId: string): Promise<InsightBasisActivity[]> {
    try {
      const insight = this.deps.repo.getReportById(reportId)?.insights.find((i) => i.id === insightId);
      if (!insight) return [];
      const priorities = this.syncPriorities();
      const out: InsightBasisActivity[] = [];
      for (const [evidenceIndex, evidence] of insight.evidence.entries()) {
        if (evidence.kind !== 'activity') continue;
        const activity = await this.currentActivity(evidence, priorities);
        if (!activity) continue;
        const priority = priorities.find((p) => p.id === activity.priorityId);
        out.push({
          evidenceIndex,
          title: activity.title,
          start: activity.startedAt,
          end: activity.endedAt,
          thread: activity.thread,
          priority: priority ? { id: priority.id, text: priority.text } : null,
          linkedBy: activity.priorityLinkSource ?? null,
        });
      }
      return out;
    } catch (err) {
      this.log.error(`[REFLECTION] Could not explain insight ${insightId}: ${messageOf(err)}`);
      return [];
    }
  }

  /** The activity a piece of evidence points at, as the Timeline holds it now, with its links. */
  private async currentActivity(evidence: Pick<ReflectionEvidence, 'eventIds' | 'activityId' | 'period'>, priorities: ReflectionPriority[]) {
    const where = await this.deps.metrics.resolveEvidence(evidence);
    if (!where?.activityId) return null;
    const day = periodContaining('day', where.start);
    const nextDay = shiftPeriod(periodContaining('day', new Date(Date.parse(where.end) - 1)), 1);
    const activities = await this.deps.metrics.loadActivities(day.start, nextDay.start, prioritiesActiveDuring(priorities, day.start, nextDay.start));
    return activities.find((a) => a.id === where.activityId) ?? null;
  }

  /**
   * The user corrects how an activity is linked: "this was not work on that
   * priority", "this belongs to another one", "this is a different project".
   *
   * The correction goes into the SAME store the annotator writes to, marked
   * as the user's — so it applies to every activity of that kind, the model
   * never overwrites it, and every reflection reads the corrected link.
   * Classification (what kind of activity it was) is corrected on the
   * Timeline, through the existing flow; Reflection consumes both.
   */
  async correctActivityLink(input: {
    evidence: Pick<ReflectionEvidence, 'eventIds' | 'activityId' | 'period'>;
    /** `null` = not work on any stated priority; omitted = leave as is. */
    priorityId?: string | null;
    /** `null` = no project; omitted = leave as is. */
    thread?: string | null;
  }): Promise<boolean> {
    try {
      const priorities = this.syncPriorities();
      if (input.priorityId && !priorities.some((p) => p.id === input.priorityId)) return false;
      const activity = await this.currentActivity(input.evidence, priorities);
      if (!activity) return false;
      const nowIso = this.now().toISOString();
      const signature = activitySignature(activity);
      const existing = this.deps.repo.getAnnotations([signature])[0];
      const thread = input.thread === undefined ? existing?.thread ?? activity.thread : input.thread === null ? null : input.thread.replace(/\s+/g, ' ').trim().slice(0, 40) || null;
      this.deps.repo.upsertAnnotations(
        [
          {
            signature,
            thread,
            priorityId: input.priorityId === undefined ? activity.priorityId : input.priorityId,
            // Final for every priority, present and future: the keyword fallback never re-links it.
            checkedPriorityIds: priorities.map((p) => p.id),
            source: 'user',
          },
        ],
        nowIso,
      );
      this.notifyDataChanged({ kind: 'links' });
      this.log.info(`[REFLECTION] Link corrected by the user for “${activity.title}”.`);
      return true;
    } catch (err) {
      this.log.error(`[REFLECTION] Could not save the correction: ${messageOf(err)}`);
      return false;
    }
  }

  // ── Feedback + priorities ──────────────────────────────────────────────────

  /** Record (or with `null` clear) the user's feedback on one insight. */
  submitFeedback(insightId: string, feedback: ReflectionFeedbackType | null): boolean {
    if (feedback !== null && !REFLECTION_FEEDBACK_TYPES.includes(feedback)) return false;
    try {
      return this.deps.repo.setFeedback(insightId, feedback, this.newId(), this.now().toISOString());
    } catch (err) {
      this.log.error(`[REFLECTION] Could not save feedback: ${messageOf(err)}`);
      return false;
    }
  }

  getPriorities(): ReflectionPriorityView[] {
    return this.priorityViews(this.syncPriorities(), this.now().toISOString());
  }

  /** Mark a stated priority active / paused / completed. */
  setPriorityStatus(id: string, status: ReflectionPriorityStatus): ReflectionPriorityView[] {
    if (!REFLECTION_PRIORITY_STATUSES.includes(status) || status === 'archived') return this.getPriorities();
    const nowIso = this.now().toISOString();
    try {
      this.deps.repo.setPriorityStatus(id, status, nowIso);
      // Reflections of the periods still running were written against the old set.
      this.deps.repo.flagForVerification({ start: nowIso, end: new Date(Date.parse(nowIso) + 1).toISOString() }, nowIso);
    } catch (err) {
      this.log.error(`[REFLECTION] Could not update priority: ${messageOf(err)}`);
    }
    return this.getPriorities();
  }

  /**
   * Reconcile the normalized priorities with the saved profile and return all
   * of them. Read per call (never cached) so a profile edit applies at once.
   */
  syncPriorities(): ReflectionPriority[] {
    const { repo } = this.deps;
    try {
      const nowIso = this.now().toISOString();
      const stated = this.deps.userContext.getUserContext()?.priorities ?? [];
      const existing = repo.listPriorities();
      const profile = this.deps.profiles.getProfile();
      const plan = planPrioritySync(existing, stated, {
        nowIso,
        confirmedAt: profile.updatedAt ?? nowIso,
        initialActiveFrom: profile.createdAt ?? nowIso,
      });
      if (isSyncPlanEmpty(plan)) return existing;
      repo.applyPrioritySync(plan, plan.insert.map(() => `pr-${this.newId().slice(0, 8)}`), nowIso);
      // A reworded priority can match earlier activity differently (the keyword
      // fallback reads its wording), so the days derived under the old wording
      // are derived again. Everything else only applies from now on.
      if (plan.rename.length > 0) this.deps.metrics.invalidate();
      return repo.listPriorities();
    } catch (err) {
      this.log.error(`[REFLECTION] Could not sync priorities: ${messageOf(err)}`);
      return [];
    }
  }

  // ── Change notifications ───────────────────────────────────────────────────

  /**
   * The verified timeline (or the profile) changed. Cached activities are
   * dropped and affected reflections are flagged for re-checking; nothing is
   * regenerated and no stored report is rewritten.
   */
  notifyDataChanged(change: { kind: 'timeline' | 'profile' | 'focus' | 'links'; range?: { start: string; end: string } | null }): void {
    try {
      const nowIso = this.now().toISOString();
      if (change.kind === 'profile') {
        // Stated priorities apply from now on; nothing a closed day was derived from moved.
        this.deps.metrics.invalidate('memory');
        this.syncPriorities();
        this.deps.repo.flagForVerification({ start: nowIso, end: new Date(Date.parse(nowIso) + 1).toISOString() }, nowIso);
      } else if (change.kind === 'links') {
        // A link applies to every activity of its kind, on any day. The ledger
        // days holding it were already dropped with the annotation itself.
        this.deps.metrics.invalidate('memory');
        this.deps.repo.flagForVerification(null, nowIso);
      } else {
        // Timeline, classification or Focus data: the affected days are derived again.
        this.deps.metrics.invalidate(change.range ?? null);
        this.deps.repo.flagForVerification(change.range ?? null, nowIso);
      }
    } catch (err) {
      this.log.error(`[REFLECTION] Could not record data change: ${messageOf(err)}`);
    }
  }

  /** Fail attempts a previous process left 'generating'. */
  recoverInterrupted(): number {
    try {
      const count = this.deps.repo.failInterruptedReports(this.now().toISOString());
      if (count > 0) this.log.warn(`[REFLECTION] Marked ${count} interrupted generation(s) as failed.`);
      return count;
    } catch (err) {
      this.log.error(`[REFLECTION] Could not recover interrupted generations: ${messageOf(err)}`);
      return 0;
    }
  }

  // ── Scheduling support ─────────────────────────────────────────────────────

  /**
   * The reports the scheduler should write now, in order: closed days, weeks,
   * months and years still missing a (final) report, oldest first, then
   * today's reflection once the daily reflection time has passed.
   */
  async pendingScheduledPeriods(): Promise<ReflectionPeriod[]> {
    const now = this.now();
    let pending: ReflectionPeriod[] = [];
    try {
      if (!this.deps.metrics.hasHistoryBefore(now.toISOString())) return [];
      const priorities = this.syncPriorities();
      const running: ReflectionPeriod[] = [];

      for (const type of REFLECTION_PERIOD_TYPES) {
        const current = periodContaining(type, now);
        for (let back = this.config.backlog[type]; back >= 1; back--) {
          const period = shiftPeriod(current, -back);
          if (!this.deps.metrics.hasHistoryBefore(period.end)) continue;
          if ((await this.needsClosedReport(period, priorities)) || this.needsRewrite(period, now)) pending.push(period);
        }
        // A week, month or year does not have to end before it can be read.
        if (type !== 'day' && (await this.needsRunningReport(current, now, priorities))) running.push(current);
      }

      // A long absence is caught up over several cycles: never more than a
      // handful of reports per cycle, the most recent closed periods first.
      // "So far" reports of running periods only take the room that is left.
      const cap = this.config.maxScheduledPerCycle;
      if (pending.length > cap) {
        pending = [...pending].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : TYPE_ORDER[a.type] - TYPE_ORDER[b.type])).slice(0, cap);
      }
      pending.push(...running.slice(0, Math.max(0, cap - pending.length)));
      pending.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : TYPE_ORDER[a.type] - TYPE_ORDER[b.type]));

      // Today's reflection: at the user's reflection time — or a little
      // earlier, once the day has visibly wound down.
      const today = periodContaining('day', now);
      const reflectionTime = this.dailyReflectionTime(today);
      const earliest = reflectionTime - this.config.earlyReflectionWindowMinutes * 60_000;
      if (now.getTime() >= earliest && !this.rejectedTooOften(today)) {
        const current = this.deps.repo.getCurrentReport('day', today.key);
        const latest = this.deps.repo.getLatestAttempt('day', today.key);
        const written =
          current !== null && current.staleReason !== EVENTS_REMOVED_REASON && current.coveredUntil !== null && Date.parse(current.coveredUntil) >= earliest;
        const tooThin = latest?.status === 'insufficient_data' && Date.parse(latest.createdAt) >= reflectionTime;
        const due = now.getTime() >= reflectionTime ? !tooThin : await this.hasWoundDown(today, now);
        if (!written && due) pending.push(today);
      }
    } catch (err) {
      this.log.error(`[REFLECTION] Could not plan scheduled reflections: ${messageOf(err)}`);
    }
    return pending;
  }

  /**
   * Natural end of the day: enough happened to reflect on, and nothing has
   * been tracked for a while.
   */
  private async hasWoundDown(today: ReflectionPeriod, now: Date): Promise<boolean> {
    const pulse = await this.deps.metrics.activityPulse(today.start, now.toISOString());
    if (pulse.lastEndedAt === null || pulse.minutes < this.config.sufficiency.day.minTrackedMinutes) return false;
    return now.getTime() - Date.parse(pulse.lastEndedAt) >= this.config.windDownInactivityMinutes * 60_000;
  }

  private rejectedTooOften(period: ReflectionPeriod): boolean {
    return (
      this.deps.repo.countFailedReports(period.type, period.key, REJECTION_CATEGORIES) >= this.config.maxRejectedAttemptsPerPeriod
    );
  }

  /**
   * A stale report inside the backlog window is rewritten — its period's data
   * or links were corrected after it was written — but not more often than
   * the cooldown allows, however many edits follow each other.
   */
  private needsRewrite(period: ReflectionPeriod, now: Date): boolean {
    if (this.rejectedTooOften(period)) return false;
    const current = this.deps.repo.getCurrentReport(period.type, period.key);
    if (current?.status !== 'stale') return false;
    // Written from an event the user has since removed: not something to leave standing for the cooldown.
    if (current.staleReason === EVENTS_REMOVED_REASON) return true;
    return now.getTime() - Date.parse(current.generatedAt ?? current.createdAt) >= this.config.staleRegenerateCooldownMs;
  }

  /**
   * Does the week / month / year that is still running need a "so far"
   * report? Once it holds enough to reflect on — and again only when the one
   * it has is several days old.
   */
  private async needsRunningReport(period: ReflectionPeriod, now: Date, priorities: ReflectionPriority[]): Promise<boolean> {
    if (period.type === 'day' || this.rejectedTooOften(period)) return false;
    const { repo, metrics } = this.deps;
    // 0 (or less) turns "so far" reports off for that horizon.
    if (!(this.config.runningRefreshDays[period.type] > 0)) return false;
    const refreshMs = this.config.runningRefreshDays[period.type] * DAY_MS;
    const current = repo.getCurrentReport(period.type, period.key);
    if (current?.staleReason === EVENTS_REMOVED_REASON) return true;
    if (current) return now.getTime() - Date.parse(current.coveredUntil ?? current.createdAt) >= refreshMs;
    const latest = repo.getLatestAttempt(period.type, period.key);
    // Found too thin (or failed) recently: look again when it could have changed.
    if (latest && now.getTime() - Date.parse(latest.createdAt) < Math.min(refreshMs, DAY_MS)) return false;
    const core = await metrics.computeCore(period, now.toISOString(), priorities);
    return assessSufficiency(core.metrics, period.type, this.config).enough;
  }

  /** Does this closed period still need its (final) report? */
  private async needsClosedReport(period: ReflectionPeriod, priorities: ReflectionPriority[] = []): Promise<boolean> {
    if (this.rejectedTooOften(period)) return false;
    const { repo, metrics } = this.deps;

    const current = repo.getCurrentReport(period.type, period.key);
    const examined = current ?? repo.getLatestAttempt(period.type, period.key);
    if (!examined || (!current && examined.status !== 'insufficient_data')) return true;

    // Written (or found too thin) while the period was still running: redo it
    // once, and only if enough happened afterwards to matter.
    const coveredUntil = examined.coveredUntil ?? period.end;
    if (Date.parse(coveredUntil) >= Date.parse(period.end)) return false;
    return (await metrics.trackedMinutesBetween(coveredUntil, period.end, priorities)) >= this.config.finalizeMinNewMinutes;
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  /** Generate (or regenerate) the reflection of one period. Never throws. */
  generate(period: ReflectionPeriod, options: GenerateOptions): Promise<GenerateResult> {
    const id = periodId(period);
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const run = this.queue.then(() => this.runGeneration(period, options));
    this.queue = run.catch(() => undefined);
    this.inFlight.set(id, run);
    void run.finally(() => {
      if (this.inFlight.get(id) === run) this.inFlight.delete(id);
    });
    return run;
  }

  private async runGeneration(period: ReflectionPeriod, options: GenerateOptions): Promise<GenerateResult> {
    const { repo, gemini, metrics } = this.deps;
    const fail = (category: ReflectionErrorCategory, error: string, reportId: string | null, attempts: number): GenerateResult => ({
      status: 'failed',
      category,
      error,
      reportId,
      period,
      attempts,
    });

    let reportId: string | null = null;
    let attempts = 0;
    try {
      const now = this.now();
      const nowIso = now.toISOString();
      if (isFuturePeriod(period, now)) return { status: 'skipped', reason: 'future_period', period };
      if (!metrics.hasHistoryBefore(period.end)) return { status: 'skipped', reason: 'no_data', period };

      if (options.trigger === 'manual') {
        const current = repo.getCurrentReport(period.type, period.key);
        const latest = repo.getLatestAttempt(period.type, period.key);
        const blocked = this.refreshState(period, current, latest, true, false).reason;
        if (blocked === 'cooldown') return { status: 'skipped', reason: 'throttled', period };
        // "Up to date" is a claim, so it is checked — against the timeline, the
        // links, the Focus data and the priorities as they are NOW. Only a
        // report that still describes its period is left alone.
        if (blocked === 'up_to_date' && current && (await this.verify(current, this.syncPriorities(), true)).status === 'fresh') {
          return { status: 'skipped', reason: 'up_to_date', period };
        }
      }

      // Missing key: clear, non-fatal, and nothing is written.
      if (!gemini.isConfigured()) {
        this.log.warn('[REFLECTION] Generation unavailable: GEMINI_API_KEY is not set.');
        return fail('missing_api_key', 'GEMINI_API_KEY is not set', null, 0);
      }

      const coveredUntil = isPeriodClosed(period, now) ? period.end : nowIso;
      const allPriorities = this.syncPriorities();
      const taxonomy = this.deps.taxonomy();

      // Link this period's (and the previous period's) activities to threads
      // and priorities. Cached per signature; best-effort.
      const previousPeriod = shiftPeriod(period, -1);
      const raw = await metrics.loadRawActivities(previousPeriod.start, coveredUntil);
      await this.deps.annotator.annotate(raw, prioritiesActiveDuring(allPriorities, previousPeriod.start, coveredUntil), taxonomy);

      const dataset = await metrics.computeDataset(period, coveredUntil, allPriorities);
      const base = {
        period,
        coveredUntil,
        trigger: options.trigger,
        inputSchemaVersion: REFLECTION_INPUT_SCHEMA_VERSION,
        outputSchemaVersion: REFLECTION_OUTPUT_SCHEMA_VERSION,
        promptVersion: REFLECTION_PROMPT_VERSION,
        model: gemini.model,
        nowIso,
      };
      if (!dataset.sufficiency.enough) {
        repo.recordInsufficient({ ...base, id: this.newId() });
        this.log.info(`[REFLECTION] ${period.type} ${period.key}: not enough activity to reflect on.`);
        return { status: 'skipped', reason: 'insufficient_data', period };
      }

      const userContext = this.deps.userContext.getUserContext();
      const userFeedback = repo.listFeedback(new Date(now.getTime() - FEEDBACK_LOOKBACK_MS).toISOString());
      const prepared = prepareReflection(dataset, {
        userContext,
        taxonomy,
        config: this.config,
        nowIso,
        previousReport: repo.getCurrentReport(period.type, previousPeriod.key),
        history: repo.listInsightHistory(period.type, period.start, this.config.identityLookback[period.type]),
        reportedPeriods: repo
          .listReportedPeriods()
          .filter((p) => p.type === period.type && p.start < period.start)
          .slice(0, this.config.identityLookback[period.type]),
        feedback: userFeedback,
        learnedPatterns: this.deps.learnedPatterns?.() ?? [],
        explicitRules: this.deps.explicitRules?.() ?? [],
        longerTermReport: this.longerTermReport(period),
      });
      const label = describePeriod(period, now);

      // A claim about THIS period that the user marked "not accurate" is not
      // made again while the evidence it rested on is what it was. Once the
      // user (or anything upstream) corrected that evidence, it is open again.
      const disputedIdentities = new Set<string>();
      for (const f of userFeedback) {
        if (f.feedbackType !== 'inaccurate' || !f.identityKey || f.periodType !== period.type || f.periodKey !== period.key || !f.reportId) continue;
        const disputedReport = repo.getReportById(f.reportId);
        if (disputedReport?.metricsSnapshot && !findMeaningfulDifference(disputedReport.metricsSnapshot, dataset.metrics, this.config)) {
          disputedIdentities.add(f.identityKey);
        }
      }

      // A day is reflected on and coached in one request. The coach is an
      // enhancement of the reflection: if it cannot start, the day is still
      // reflected on.
      let coach: DailyCoachSession | null = null;
      if (period.type === 'day' && this.deps.coach) {
        try {
          coach = await this.deps.coach.beginDaily({
            period,
            coveredUntil,
            now,
            dataset,
            replacesReportId: repo.getCurrentReport(period.type, period.key)?.id ?? null,
            activityRefs: new Map([...prepared.activityByRef].map(([ref, activity]) => [activity.id, ref])),
          });
        } catch (err) {
          this.log.warn(`[REFLECTION] Coach unavailable for ${period.key}; reflecting without it: ${messageOf(err)}`);
        }
      }

      this.log.info(
        `[REFLECTION] Generation started: ${period.type} ${period.key}, ${dataset.activities.length} activities, ` +
          `${prepared.input.metrics.length} metrics, ${prepared.input.comparisons.length} comparisons, ` +
          `user context ${userContext ? 'present' : 'not provided'}, coach ${coach ? 'included' : 'not included'}.`,
      );

      reportId = this.newId();
      repo.createGenerating({ ...base, id: reportId });

      const systemInstruction = buildReflectionSystemInstruction(coach?.parts);
      const basePrompt = buildReflectionPrompt(prepared.input, coach?.parts);
      const responseJsonSchema = buildReflectionResponseSchema(dataset.priorities.map((p) => p.id), coach?.parts);
      const periodLabel = `${label.title} ${label.range}`;
      const evidence = createEvidenceToolkit({
        metrics: dataset.metrics,
        activityByRef: prepared.activityByRef,
        priorities: dataset.priorities,
        periodLabel,
      });

      type Accepted = { reflection: ValidatedReflection; coach: unknown; model: string };
      let accepted: Accepted | null = null;
      let salvage: Accepted | null = null;
      let lastError: { category: ReflectionErrorCategory; message: string } = { category: 'internal', message: 'No attempt was made' };
      let feedback: string[] | null = null;
      // The coaching half of the first response in which it validated cleanly.
      // A retry is asked for because of the reflection ("drop any claim you
      // cannot support"); it must not also re-roll, or talk the model out of,
      // a coaching decision that had nothing wrong with it.
      let settledCoach: { value: unknown } | null = null;
      // When no attempt's coaching validated cleanly, the subset that kept the most is what survives — not merely
      // the last one. (An action that passed every check in attempt 2 is not lost because attempt 3 kept nothing.)
      let bestCoach: { value: unknown; weight: number } | null = null;

      while (attempts < MAX_ATTEMPTS && !accepted) {
        if (attempts > 0) {
          const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          this.log.warn(`[REFLECTION] Retry ${attempts}/${MAX_ATTEMPTS - 1} in ${delay}ms after ${lastError.category}.`);
          await this.sleep(delay);
        }
        attempts++;
        repo.recordAttempt(reportId, attempts, this.now().toISOString());

        try {
          const response = await gemini.generateJson({
            systemInstruction,
            prompt: feedback ? `${basePrompt}\n\n${buildReflectionRetryFeedback(feedback)}` : basePrompt,
            responseJsonSchema,
          });

          let rawOutput: unknown;
          try {
            rawOutput = JSON.parse(response.text);
          } catch {
            lastError = { category: 'malformed_output', message: 'Response was not valid JSON' };
            feedback = ['The response was not valid JSON.'];
            this.log.warn('[REFLECTION] Malformed structured output (not JSON).');
            continue;
          }

          const validation = validateReflectionOutput(rawOutput, {
            period,
            metrics: dataset.metrics,
            activityByRef: prepared.activityByRef,
            priorities: dataset.priorities,
            maxInsights: this.config.maxInsights[period.type],
            history: prepared.history,
            disputedIdentities,
            mutedIdentities: prepared.mutedIdentities,
            periodLabel,
          });
          // The coaching half is checked against the same evidence. Its valid
          // subset is always usable, so it can never sink a good reflection.
          const coachCheck = coach ? coach.validate((rawOutput as { coach?: unknown } | null)?.coach, evidence) : null;
          if (coachCheck?.ok && !settledCoach) settledCoach = { value: coachCheck.value };
          const coachProblems = settledCoach || !coachCheck || coachCheck.ok ? [] : coachCheck.errors;
          if (coachCheck && !coachCheck.ok && (!bestCoach || (coachCheck.weight ?? 0) > bestCoach.weight)) bestCoach = { value: coachCheck.value, weight: coachCheck.weight ?? 0 };
          const coachValue = settledCoach ? settledCoach.value : coachCheck ? (coachCheck.ok ? coachCheck.value : bestCoach!.value) : null;
          const problems = [...(validation.ok ? [] : validation.errors), ...coachProblems];
          const reflection = validation.ok ? validation.reflection : validation.salvaged;
          if (problems.length === 0 && reflection) {
            accepted = { reflection, coach: coachValue, model: response.modelVersion };
            break;
          }
          lastError = { category: 'validation', message: problems.slice(0, 5).join('; ') };
          feedback = problems;
          if (reflection) salvage = { reflection, coach: coachValue, model: response.modelVersion };
          this.log.warn(`[REFLECTION] Validation failed: ${problems.length} problem(s). ${lastError.message}`);
        } catch (err) {
          if (!(err instanceof GeminiError)) throw err;
          lastError = { category: err.category, message: err.message };
          this.log.warn(`[REFLECTION] Gemini request failed (${err.category}).`);
          if (!err.retryable) break;
        }
      }

      // Retries exhausted: keep what fully validated rather than nothing —
      // every unsupported insight has already been removed from it.
      if (!accepted && salvage && lastError.category === 'validation') {
        accepted = salvage;
        this.log.warn(`[REFLECTION] Accepting the validated subset (${salvage.reflection.insights.length} insight(s)) after ${attempts} attempts.`);
      }

      if (!accepted) {
        this.failReport(reportId, lastError.category, lastError.message);
        this.log.error(`[REFLECTION] Generation failed after ${attempts} attempt(s): ${lastError.category} — ${lastError.message}`);
        return fail(lastError.category, lastError.message, reportId, attempts);
      }

      const createdAt = this.now().toISOString();
      const insights: ReflectionInsight[] = accepted.reflection.insights.map((insight) => ({
        ...insight,
        id: this.newId(),
        createdAt,
      }));
      try {
        // Canonical ids for everything the coach creates are minted here, by
        // the backend; the model's aliases never reach the database.
        const coachPlan = coach && accepted.coach !== null ? coach.plan(accepted.coach, reportId, createdAt) : null;
        repo.commitReport({
          reportId,
          period,
          coveredUntil,
          model: accepted.model,
          attemptCount: attempts,
          headline: accepted.reflection.headline,
          narrative: accepted.reflection.narrative,
          // With a coach, what to do next is a tracked action, not a sentence.
          carryForward: coach ? null : accepted.reflection.carryForward,
          coach: coachPlan?.block ?? null,
          alongside: coachPlan?.apply,
          insights,
          dataSnapshot: prepared.snapshot,
          metricsSnapshot: dataset.metrics,
          nowIso: createdAt,
        });
      } catch (err) {
        const message = messageOf(err);
        this.failReport(reportId, 'persistence', message);
        this.log.error(`[REFLECTION] Persistence failed; previous reflection kept: ${message}`);
        return fail('persistence', message, reportId, attempts);
      }

      this.log.info(`[REFLECTION] Persisted ${period.type} ${period.key}: ${insights.length} insight(s).`);
      return { status: 'succeeded', reportId, period, attempts, insightCount: insights.length };
    } catch (err) {
      const message = messageOf(err);
      if (reportId) this.failReport(reportId, 'internal', message);
      this.log.error(`[REFLECTION] Generation failed (internal): ${message}`);
      return fail('internal', message, reportId, attempts);
    }
  }

  private failReport(reportId: string, category: ReflectionErrorCategory, message: string): void {
    try {
      this.deps.repo.failReport(reportId, category, message.slice(0, 1000), this.now().toISOString());
    } catch (err) {
      this.log.error(`[REFLECTION] Could not record generation failure: ${messageOf(err)}`);
    }
  }

  // ── Staleness ──────────────────────────────────────────────────────────────

  /**
   * Re-check a flagged report against the current timeline. A report that no
   * longer describes its period is marked stale — never rewritten — and can
   * then be regenerated.
   */
  private async verify(report: ReflectionReport, priorities: ReflectionPriority[], force = false): Promise<ReflectionReport> {
    if (report.status !== 'fresh' || (!force && !report.needsVerification)) return report;
    const { repo, metrics } = this.deps;
    try {
      const now = this.now();
      const coveredUntil = report.coveredUntil ?? report.period.end;
      const basis = report.dataSnapshot?.basis;
      let reason: string | null = null;

      // The priorities the period was read against: which ones applied during
      // it, how they were worded, and when each applied. A change made after
      // a closed period does not touch that period.
      if (basis && basis.priorities !== prioritiesFingerprint(prioritiesActiveDuring(priorities, report.period.start, coveredUntil), report.period.start, coveredUntil)) {
        reason = 'priorities_changed';
      }
      // A period still running was written against the priorities of that moment.
      if (!reason && !isPeriodClosed(report.period, now) && report.dataSnapshot) {
        const before = [...report.dataSnapshot.activePriorityIds].sort().join(',');
        const after = priorities.filter((p) => p.status === 'active').map((p) => p.id).sort().join(',');
        if (before !== after) reason = 'priorities_changed';
      }
      // Where the time went, what it is linked to, and the Focus sessions.
      if (!reason && report.metricsSnapshot && report.coveredUntil) {
        const core = await metrics.computeCore(report.period, report.coveredUntil, priorities);
        const moved = findMeaningfulDifference(report.metricsSnapshot, core.metrics, this.config);
        if (moved) reason = staleReasonFor(moved);
      }
      // What it was compared with: the previous period, as it is known now.
      if (!reason && basis && basis.previousTrackedMinutes !== null) {
        const previous = shiftPeriod(report.period, -1);
        const tracked = (await metrics.computeCore(previous, previous.end, priorities)).metrics['time.tracked_minutes']?.value;
        const before = basis.previousTrackedMinutes;
        const after = typeof tracked === 'number' ? tracked : 0;
        if (Math.abs(before - after) > Math.max(this.config.staleMinMinutes, this.config.staleMinRatio * Math.max(before, after))) reason = 'history_changed';
      }

      const nowIso = now.toISOString();
      if (reason && repo.markStale(report.id, reason, nowIso)) {
        this.log.info(`[REFLECTION] ${report.period.type} ${report.period.key} is stale (${reason}).`);
        return { ...report, status: 'stale', staleReason: reason, staleAt: nowIso, needsVerification: false };
      }
      repo.clearVerification(report.id);
      return { ...report, needsVerification: false };
    } catch (err) {
      this.log.error(`[REFLECTION] Could not verify report ${report.id}: ${messageOf(err)}`);
      return report;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** The current reflection of the next larger period containing (or just before) this one. */
  private longerTermReport(period: ReflectionPeriod): ReflectionReport | null {
    const type = LARGER_PERIOD[period.type];
    if (!type) return null;
    const containing = periodContaining(type, period.start);
    return this.deps.repo.getCurrentReport(type, containing.key) ?? this.deps.repo.getCurrentReport(type, shiftPeriod(containing, -1).key);
  }

  /** May the user refresh this period now, and if not, why? */
  private refreshState(
    period: ReflectionPeriod,
    report: ReflectionReport | null,
    attempt: ReflectionReport | null,
    enoughData: boolean,
    generating: boolean,
  ): { reason: RefreshBlockedReason | null; availableAt: string | null } {
    const now = this.now();
    const block = (reason: RefreshBlockedReason, availableAt: string | null = null) => ({ reason, availableAt });
    if (generating) return block('generating');
    if (isFuturePeriod(period, now)) return block('future_period');
    if (!this.isConfigured()) return block('not_configured');

    if (attempt?.status === 'failed' && (!report || attempt.createdAt >= report.createdAt)) {
      const retryAt = Date.parse(attempt.updatedAt) + this.config.failedRetryCooldownMs;
      if (now.getTime() < retryAt) return block('cooldown', new Date(retryAt).toISOString());
    }
    if (report?.status === 'fresh') {
      const complete = report.coveredUntil !== null && Date.parse(report.coveredUntil) >= Date.parse(period.end);
      // Written by the current reasoning from data that still stands: nothing
      // to rewrite. (A change upstream flags the report; it is then re-checked
      // and, if it no longer describes its period, becomes stale.)
      if (complete && report.promptVersion === REFLECTION_PROMPT_VERSION) return block('up_to_date');
      const refreshAt = Date.parse(report.generatedAt ?? report.createdAt) + this.config.manualRefreshCooldownMs;
      if (now.getTime() < refreshAt) return block('cooldown', new Date(refreshAt).toISOString());
    }
    if (!enoughData) return block('insufficient_data');
    return { reason: null, availableAt: null };
  }

  private priorityViews(priorities: ReflectionPriority[], nowIso: string): ReflectionPriorityView[] {
    return priorities
      .filter((p) => p.status !== 'archived')
      .map((p) => ({
        id: p.id,
        text: p.text,
        status: p.status,
        activeFrom: p.activeFrom,
        lastConfirmedAt: p.lastConfirmedAt,
        possiblyStale: isPossiblyStale(p, nowIso, this.config.priorityStaleAfterDays),
      }));
  }
}

function periodId(period: ReflectionPeriod): string {
  return `${period.type}:${period.key}`;
}

function toReportView(report: ReflectionReport, type: ReflectionPeriodType, priorities: ReflectionPriority[]): ReflectionReportView {
  const priorityOf = (id: string | null) => {
    const priority = id ? priorities.find((p) => p.id === id) : undefined;
    return priority ? { id: priority.id, text: priority.text } : null;
  };
  return {
    id: report.id,
    status: report.status === 'stale' ? 'stale' : 'fresh',
    headline: report.headline ?? '',
    narrative: report.narrative,
    coach: report.coach,
    insights: report.insights.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      observation: i.observation,
      interpretation: i.interpretation,
      relevance: i.relevance,
      evidence: i.evidence,
      feedback: i.feedback,
      continuity: i.continuity,
      priority: priorityOf(i.priorityId),
      thread: i.thread,
    })),
    carryForward: report.carryForward ? { text: report.carryForward.text, evidence: report.carryForward.evidence } : null,
    carried: report.dataSnapshot?.carried ?? [],
    outdated: report.promptVersion !== REFLECTION_PROMPT_VERSION,
    generatedAt: report.generatedAt,
    coveredUntil: report.coveredUntil,
    isPartial: report.dataSnapshot?.isPartial ?? false,
    staleReason: report.staleReason,
    supportingMetrics: report.metricsSnapshot ? selectSupportingMetrics(report.metricsSnapshot, type).map(toMetricView) : [],
    notes: report.dataSnapshot?.notes ?? [],
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
