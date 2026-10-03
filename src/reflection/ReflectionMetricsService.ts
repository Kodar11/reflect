import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import {
  activitySignature,
  applyAnnotations,
  clipActivities,
  mergeFragments,
} from './ReflectionActivities.js';
import { assessSufficiency, buildComparisons, computeMetrics } from './ReflectionMetrics.js';
import type {
  FocusSessionFacts,
  MetricSet,
  PeriodDataset,
  ReflectionActivity,
  ReflectionConfig,
  ReflectionPeriod,
  ReflectionPriority,
  TaxonomyNames,
} from './ReflectionModels.js';
import { listDays, localDayKey, previousPeriodName, previousPeriods, shiftPeriod } from './ReflectionPeriods.js';
import { prioritiesActiveDuring } from './ReflectionPriorities.js';

/**
 * The impure half of the measurement layer: loads activities from the
 * verified timeline, attaches Reflection's cached annotations, and runs the
 * pure metric functions over the period, its predecessor and the personal
 * baseline.
 *
 * Activities are loaded one local day at a time. That keeps every period type
 * additive (a week is exactly the sum of its days), lets closed days be cached
 * so history is not re-derived on every visit, and gives the main process a
 * chance to breathe during a long (yearly) load.
 */

export interface ReflectionDataSources {
  /** Verified-timeline activities whose events start in [fromIso, toIso). */
  getActivities(fromIso: string, toIso: string): ReflectionActivity[];
  focus: Pick<IFocusRepository, 'getSessionsByRange' | 'getInterruptions' | 'getBlockedAttempts'>;
  taxonomy(): TaxonomyNames;
  /** When tracking began; nothing before it is ever loaded or compared. */
  firstEventAt(): string | null;
}

export interface ReflectionMetricsServiceOptions {
  config: ReflectionConfig;
  now?: () => Date;
  /** Yield to the event loop during long loads. */
  yieldToEventLoop?: () => Promise<void>;
}

/** Days loaded between yields. */
const YIELD_EVERY_DAYS = 7;

export class ReflectionMetricsService {
  private readonly config: ReflectionConfig;
  private readonly now: () => Date;
  private readonly yieldToEventLoop: () => Promise<void>;
  /** Closed local day → its raw (un-annotated) activities. */
  private readonly dayCache = new Map<string, ReflectionActivity[]>();

  constructor(
    private readonly sources: ReflectionDataSources,
    private readonly annotations: Pick<IReflectionRepository, 'getAnnotations'>,
    options: ReflectionMetricsServiceOptions,
  ) {
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  }

  /** Forget cached days — call whenever the timeline may have changed. */
  invalidate(): void {
    this.dayCache.clear();
  }

  /** Whether any tracking exists before `iso`. */
  hasHistoryBefore(iso: string): boolean {
    const first = this.sources.firstEventAt();
    return first !== null && Date.parse(first) < Date.parse(iso);
  }

  /** Raw activities in [startIso, endIso), without Reflection's overlay. */
  async loadRawActivities(startIso: string, endIso: string): Promise<ReflectionActivity[]> {
    const first = this.sources.firstEventAt();
    if (first === null || Date.parse(endIso) <= Date.parse(first)) return [];
    const from = Date.parse(startIso) < Date.parse(first) ? first : startIso;
    const todayKey = localDayKey(this.now());

    const collected: ReflectionActivity[] = [];
    let loaded = 0;
    for (const day of listDays(from, endIso)) {
      let activities = this.dayCache.get(day.key);
      if (!activities) {
        activities = this.sources.getActivities(day.start, day.end);
        // Today is still changing; only finished days are remembered.
        if (day.key < todayKey) this.dayCache.set(day.key, activities);
        if (++loaded % YIELD_EVERY_DAYS === 0) await this.yieldToEventLoop();
      }
      collected.push(...activities);
    }
    return clipActivities(mergeFragments(collected), startIso, endIso);
  }

  /** Activities in the range with thread / priority attached. */
  async loadActivities(startIso: string, endIso: string, priorities: ReflectionPriority[]): Promise<ReflectionActivity[]> {
    const raw = await this.loadRawActivities(startIso, endIso);
    return this.annotate(raw, priorities);
  }

  annotate(activities: ReflectionActivity[], priorities: ReflectionPriority[]): ReflectionActivity[] {
    if (activities.length === 0) return [];
    const signatures = [...new Set(activities.map(activitySignature))];
    const annotations = new Map(this.annotations.getAnnotations(signatures).map((a) => [a.signature, a]));
    return applyAnnotations(activities, annotations, priorities, this.sources.taxonomy());
  }

  /** Core (non-comparative) metrics of [period.start, coveredUntil). */
  async computeCore(
    period: ReflectionPeriod,
    coveredUntil: string,
    allPriorities: ReflectionPriority[],
    forceThreads: string[] = [],
  ): Promise<{ metrics: MetricSet; activities: ReflectionActivity[]; priorities: ReflectionPriority[] }> {
    const priorities = prioritiesActiveDuring(allPriorities, period.start, coveredUntil);
    const activities = await this.loadActivities(period.start, coveredUntil, priorities);
    const metrics = computeMetrics({
      period,
      activities,
      priorities,
      taxonomy: this.sources.taxonomy(),
      focus: this.focusFacts(period.start, coveredUntil),
      forceThreads,
    });
    return { metrics, activities, priorities };
  }

  /**
   * Everything deterministic about a period: its metrics, the comparison with
   * the previous period, the personal baseline, and what could not be known.
   */
  async computeDataset(period: ReflectionPeriod, coveredUntil: string, allPriorities: ReflectionPriority[]): Promise<PeriodDataset> {
    const isPartial = Date.parse(coveredUntil) < Date.parse(period.end);
    const core = await this.computeCore(period, coveredUntil, allPriorities);
    const sufficiency = assessSufficiency(core.metrics, period.type, this.config);
    const dataset: PeriodDataset = {
      period,
      coveredUntil,
      isPartial,
      activities: core.activities,
      priorities: core.priorities,
      metrics: core.metrics,
      sufficiency,
      notes: [],
      hasPreviousComparison: false,
      baselinePeriodCount: 0,
    };
    if (!sufficiency.enough) return dataset;

    // Threads of this period are reported for the reference periods too, so
    // "no time on it then" is a measured zero rather than an unknown.
    const threads = [...new Set(core.activities.map((a) => a.thread).filter((t): t is string => t !== null))];
    const reference = async (p: ReflectionPeriod): Promise<MetricSet | null> => {
      if (!this.hasHistoryBefore(p.end)) return null;
      const result = await this.computeCore(p, p.end, allPriorities, threads);
      return assessSufficiency(result.metrics, p.type, this.config).enough ? result.metrics : null;
    };

    const previous = await reference(shiftPeriod(period, -1));
    const { lookback, minPeriods } = this.config.baseline[period.type];
    const baselines: MetricSet[] = [];
    for (const p of previousPeriods(period, lookback)) {
      const metrics = p.key === shiftPeriod(period, -1).key ? previous : await reference(p);
      if (metrics) baselines.push(metrics);
    }

    const comparisons = buildComparisons({
      current: core.metrics,
      previous,
      previousName: previousPeriodName(period.type),
      baselines,
      baselineUnit: period.type,
      minBaselinePeriods: minPeriods,
      mode: isPartial ? 'partial' : 'full',
    });

    const hasBaseline = baselines.length >= minPeriods;
    const notes: string[] = [];
    if (!this.hasHistoryBefore(period.start)) {
      notes.push(
        `This is the first ${period.type} Reflect has tracked. Comparisons will appear as more history accumulates.`,
      );
    } else {
      if (!previous) notes.push(`Not enough activity in the previous ${period.type} for a ${period.type}-over-${period.type} comparison.`);
      if (!hasBaseline) notes.push('Not enough history yet for a personal baseline.');
    }
    if (isPartial && (previous || hasBaseline)) {
      notes.push('This period is still in progress, so only rates and averages are compared — not totals.');
    }
    if (core.priorities.length === 0) notes.push('No current priorities are stated, so priority alignment cannot be assessed.');

    return {
      ...dataset,
      metrics: { ...core.metrics, ...comparisons },
      notes,
      hasPreviousComparison: previous !== null,
      baselinePeriodCount: hasBaseline ? baselines.length : 0,
    };
  }

  /** Focus sessions that ran inside the range, as plain facts. */
  private focusFacts(startIso: string, endIso: string): FocusSessionFacts[] {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    const facts: FocusSessionFacts[] = [];
    for (const session of this.sources.focus.getSessionsByRange(startIso, endIso)) {
      if (!session.startedAt || session.state === 'planned' || session.state === 'cancelled') continue;
      const s = Date.parse(session.startedAt);
      if (Number.isNaN(s) || s < start || s >= end) continue;
      const sessionEnd = session.endedAt ?? new Date(Math.min(end, s + session.elapsedMs + session.totalPauseMs)).toISOString();
      facts.push({
        id: session.id,
        task: session.task,
        startedAt: session.startedAt,
        endedAt: sessionEnd,
        elapsedMinutes: session.elapsedMs / 60_000,
        interruptionCount: this.sources.focus.getInterruptions(session.id).filter((i) => i.type !== 'resume').length,
        blockedAttemptCount: this.sources.focus.getBlockedAttempts(session.id).length,
      });
    }
    return facts;
  }
}
