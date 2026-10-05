import type { IReflectionRepository, InsightHistoryRow, ReflectionFeedbackRecord } from '../database/ReflectionRepository.js';
import { groupDayFacts, isTrackedDay } from './ReflectionLedger.js';
import { buildCarryItems, buildTrajectories } from './ReflectionLongitudinal.js';
import type { ReflectionMetricsService } from './ReflectionMetricsService.js';
import {
  DEFAULT_REFLECTION_CONFIG,
  type CarryItem,
  type DayFactKind,
  type PriorityEvent,
  type ReflectionCarryForward,
  type ReflectionConfig,
  type ReflectionInsight,
  type ReflectionInsightType,
  type ReflectionPeriod,
  type ReflectionPeriodType,
  type ReflectionPriority,
  type ReflectionReport,
  type WorkTrajectory,
} from './ReflectionModels.js';
import { periodContaining } from './ReflectionPeriods.js';

/**
 * Reflect's historical memory, as structure.
 *
 * Everything here is answered from persisted, structured data — the insight
 * identities, the metric snapshots, the day ledger, the priority event log —
 * never by scraping prose and never by calling a model. It is what the Coach
 * reads to know how the user's work has moved across days, and what any
 * later layer should read instead of re-deriving history from raw events.
 *
 *   previous reports / insights   getReflection, getInsightHistory
 *   insight identity over time    getRecurringPatterns
 *   historical metrics            getBehaviorTrends, getEntityTrend
 *   priority / thread trends      getPriorityAlignmentHistory, getPriorityHistory
 *   carried work                  getWorkTrajectories, getCarriedWork
 */

export interface InsightHistoryEntry {
  period: ReflectionPeriod;
  reportId: string;
  insight: ReflectionInsight;
}

export interface RecurringPattern {
  /** What the pattern is about and which way it points (`<subject>|<pattern>`). */
  signature: string;
  subjectKey: string | null;
  type: ReflectionInsightType;
  /** The most recent wording of the claim. */
  title: string;
  occurrences: number;
  firstSeen: ReflectionPeriod;
  lastSeen: ReflectionPeriod;
}

export interface MetricTrendPoint {
  period: ReflectionPeriod;
  value: number;
  display: string;
}

export interface PriorityAlignmentPoint {
  period: ReflectionPeriod;
  priorityId: string;
  priorityText: string;
  minutes: number;
  sharePercent: number | null;
}

/** One tracked day of an entity's history. Days nothing was recorded on are absent, not zero. */
export interface EntityTrendPoint {
  dayKey: string;
  start: string;
  end: string;
  minutes: number;
}

const DEFAULT_LIMIT = 52;

type HistoryStore = Pick<IReflectionRepository, 'getCurrentReport' | 'listCurrentReports' | 'listInsightHistory' | 'listFeedback' | 'listPriorities'> &
  Partial<Pick<IReflectionRepository, 'getDayFacts'>>;

export interface ReflectionHistoryOptions {
  /** Gives access to the day ledger (computing missing days on demand). */
  metrics?: Pick<ReflectionMetricsService, 'ledgerDays'> & Partial<Pick<ReflectionMetricsService, 'genericThreads'>>;
  config?: ReflectionConfig;
  now?: () => Date;
}

export class ReflectionHistory {
  private readonly config: ReflectionConfig;
  private readonly now: () => Date;

  constructor(
    private readonly repo: HistoryStore,
    private readonly options: ReflectionHistoryOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_REFLECTION_CONFIG;
    this.now = options.now ?? (() => new Date());
  }

  getReflection(type: ReflectionPeriodType, key: string): ReflectionReport | null {
    return this.repo.getCurrentReport(type, key);
  }

  /** Insights of one type (or all), newest period first. */
  getInsightHistory(type: ReflectionInsightType | null = null, limit = DEFAULT_LIMIT): InsightHistoryEntry[] {
    const out: InsightHistoryEntry[] = [];
    for (const report of this.repo.listCurrentReports(null, limit)) {
      for (const insight of report.insights) {
        if (type === null || insight.type === type) out.push({ period: report.period, reportId: report.id, insight });
      }
    }
    return out;
  }

  /** What was said about one subject (`p:<priorityId>` / `t:<threadSlug>`), newest period first. */
  getSubjectHistory(periodType: ReflectionPeriodType, subjectKey: string, limit = DEFAULT_LIMIT): InsightHistoryRow[] {
    return this.repo.listInsightHistory(periodType, FAR_FUTURE, limit).filter((row) => row.subjectKey === subjectKey);
  }

  /**
   * Patterns surfaced in more than one report of the same period type — the
   * same subject pointing the same way, whatever words or metrics each
   * report used for it.
   */
  getRecurringPatterns(periodType: ReflectionPeriodType, limit = DEFAULT_LIMIT): RecurringPattern[] {
    const patterns = new Map<string, RecurringPattern & { periods: Set<string> }>();
    // Newest first, so the first sighting of an identity is its latest wording.
    for (const row of this.repo.listInsightHistory(periodType, FAR_FUTURE, limit)) {
      const existing = patterns.get(row.identityKey);
      if (existing) {
        if (!existing.periods.has(row.period.key)) {
          existing.periods.add(row.period.key);
          existing.occurrences++;
          existing.firstSeen = row.period;
        }
      } else {
        patterns.set(row.identityKey, {
          signature: row.identityKey,
          subjectKey: row.subjectKey,
          type: row.type,
          title: row.title,
          occurrences: 1,
          firstSeen: row.period,
          lastSeen: row.period,
          periods: new Set([row.period.key]),
        });
      }
    }
    return [...patterns.values()]
      .filter((p) => p.occurrences > 1)
      .map(({ periods: _periods, ...pattern }) => pattern)
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  /** One metric across the reports of a period type, oldest first. */
  getBehaviorTrends(periodType: ReflectionPeriodType, metricKey: string, limit = DEFAULT_LIMIT): MetricTrendPoint[] {
    const points: MetricTrendPoint[] = [];
    for (const report of this.repo.listCurrentReports(periodType, limit)) {
      const metric = report.metricsSnapshot?.[metricKey];
      if (metric && typeof metric.value === 'number') {
        points.push({ period: report.period, value: metric.value, display: metric.display });
      }
    }
    return points.reverse();
  }

  /**
   * Time on one entity (a thread, a priority, an area…) day by day, straight
   * from the ledger — independent of which periods happen to have a report.
   * Only days that are already in the ledger are returned.
   */
  getEntityTrend(kind: DayFactKind, key: string, startIso: string, endIso: string): EntityTrendPoint[] {
    const days = groupDayFacts(this.repo.getDayFacts?.(startIso, endIso) ?? []);
    return days.filter(isTrackedDay).map((day) => ({
      dayKey: day.key,
      start: day.start,
      end: day.end,
      minutes: day.rows.find((r) => r.kind === kind && r.key === key)?.minutes ?? 0,
    }));
  }

  /** Time linked to each stated priority, per period, oldest first. */
  getPriorityAlignmentHistory(periodType: ReflectionPeriodType, limit = DEFAULT_LIMIT): PriorityAlignmentPoint[] {
    const points: PriorityAlignmentPoint[] = [];
    for (const report of this.repo.listCurrentReports(periodType, limit)) {
      for (const priority of report.dataSnapshot?.priorities ?? []) {
        const minutes = report.metricsSnapshot?.[`priority.${priority.id}.minutes`];
        if (!minutes || typeof minutes.value !== 'number') continue;
        const share = report.metricsSnapshot?.[`priority.${priority.id}.share`];
        points.push({
          period: report.period,
          priorityId: priority.id,
          priorityText: priority.text,
          minutes: minutes.value,
          sharePercent: share && typeof share.value === 'number' ? share.value : null,
        });
      }
    }
    return points.reverse();
  }

  /** Every stated priority with what happened to it: stated, paused, completed, reworded, removed, taken up again. */
  getPriorityHistory(): { priority: ReflectionPriority; events: PriorityEvent[] }[] {
    return this.repo.listPriorities().map((priority) => ({ priority, events: priority.history ?? [] }));
  }

  getUserFeedback(sinceIso: string): ReflectionFeedbackRecord[] {
    return this.repo.listFeedback(sinceIso);
  }

  /** What Reflect suggested carrying forward, newest period first. */
  getCarryForwardHistory(
    periodType: ReflectionPeriodType | null = null,
    limit = DEFAULT_LIMIT,
  ): { period: ReflectionPeriod; reportId: string; carryForward: ReflectionCarryForward }[] {
    return this.repo
      .listCurrentReports(periodType, limit)
      .filter((r) => r.carryForward !== null)
      .map((r) => ({ period: r.period, reportId: r.id, carryForward: r.carryForward! }));
  }

  /**
   * How each body of work has moved across the recent tracked days, as of
   * now — computed from the ledger and the current links, so a correction the
   * user made a moment ago is already in it.
   */
  async getWorkTrajectories(): Promise<WorkTrajectory[]> {
    if (!this.options.metrics) return [];
    const now = this.now();
    const priorities = this.repo.listPriorities();
    const start = new Date(now.getTime() - this.config.trajectoryDays.day * 86_400_000).toISOString();
    const days = await this.options.metrics.ledgerDays(start, now.toISOString(), priorities);
    return buildTrajectories({
      days,
      priorities,
      asOf: now.toISOString(),
      stalledAfter: this.config.stalledAfterTrackedDays,
      genericThreads: this.options.metrics.genericThreads?.(),
    });
  }

  /**
   * What is unresolved right now, and what closed today: the structured
   * carry-forward the Coach works from. Not a task list — every item is a
   * stated priority or a project the user actually worked on.
   */
  async getCarriedWork(): Promise<CarryItem[]> {
    const now = this.now();
    const today = periodContaining('day', now);
    const raised = new Map<string, number>();
    const raisedLast = new Set<string>();
    const latestKey = this.repo.listCurrentReports('day', 1, today.end)[0]?.period.key ?? null;
    for (const row of this.repo.listInsightHistory('day', today.end, this.config.identityLookback.day)) {
      if (!row.subjectKey || !(row.identityKey.endsWith('|lagging') || row.type === 'open_loop')) continue;
      raised.set(row.subjectKey, (raised.get(row.subjectKey) ?? 0) + 1);
      if (row.period.key === latestKey) raisedLast.add(row.subjectKey);
    }
    const events = this.repo
      .listPriorities()
      .flatMap((p) => p.history ?? [])
      .filter((e) => e.at >= today.start && e.at < now.toISOString());
    return buildCarryItems({ trajectories: await this.getWorkTrajectories(), raised, raisedLast, eventsInPeriod: events });
  }
}

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';
