import type { IReflectionRepository, ReflectionFeedbackRecord } from '../database/ReflectionRepository.js';
import type {
  ReflectionCarryForward,
  ReflectionInsight,
  ReflectionInsightType,
  ReflectionPeriod,
  ReflectionPeriodType,
  ReflectionReport,
} from './ReflectionModels.js';

/**
 * Structured read access to past reflections — the surface the future Coach
 * will query. Nothing here calls a model, and nothing scrapes prose: every
 * answer comes from the persisted insights, evidence and metric snapshots.
 */

export interface InsightHistoryEntry {
  period: ReflectionPeriod;
  reportId: string;
  insight: ReflectionInsight;
}

export interface RecurringPattern {
  signature: string;
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

const DEFAULT_LIMIT = 52;

export class ReflectionHistory {
  constructor(private readonly repo: IReflectionRepository) {}

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

  /** Claims surfaced in more than one report of the same period type. */
  getRecurringPatterns(periodType: ReflectionPeriodType, limit = DEFAULT_LIMIT): RecurringPattern[] {
    const patterns = new Map<string, RecurringPattern>();
    // Newest first, so the first sighting of a signature is its latest wording.
    for (const report of this.repo.listCurrentReports(periodType, limit)) {
      for (const signature of new Set(report.insights.map((i) => i.claimSignature))) {
        const insight = report.insights.find((i) => i.claimSignature === signature)!;
        const existing = patterns.get(signature);
        if (existing) {
          existing.occurrences++;
          existing.firstSeen = report.period;
        } else {
          patterns.set(signature, {
            signature,
            type: insight.type,
            title: insight.title,
            occurrences: 1,
            firstSeen: report.period,
            lastSeen: report.period,
          });
        }
      }
    }
    return [...patterns.values()].filter((p) => p.occurrences > 1).sort((a, b) => b.occurrences - a.occurrences);
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
}
