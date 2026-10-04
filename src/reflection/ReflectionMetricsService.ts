import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import {
  activitySignature,
  applyAnnotations,
  clipActivities,
  mergeFragments,
} from './ReflectionActivities.js';
import { assessSufficiency, buildComparisons, buildRecentDayMetrics, computeMetrics, type RecentDay } from './ReflectionMetrics.js';
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
import { formatDay, listDays, localDayKey, previousPeriodName, previousPeriods, shiftPeriod } from './ReflectionPeriods.js';
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
  /**
   * How long the user had tracking paused inside [fromIso, toIso), in ms.
   * Paused time is missing data — it must not be read as inactivity.
   */
  trackingPausedMs?(fromIso: string, toIso: string): number;
}

/** Shorter pauses are not worth a note. */
const PAUSE_NOTE_MIN_MS = 5 * 60_000;

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

  /** Time the user had tracking paused inside the period (up to now); 0 when unknown. */
  private pausedMs(period: ReflectionPeriod): number {
    try {
      const end = Math.min(Date.parse(period.end), this.now().getTime());
      if (end <= Date.parse(period.start)) return 0;
      return this.sources.trackingPausedMs?.(period.start, new Date(end).toISOString()) ?? 0;
    } catch {
      return 0;
    }
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
    const focusSessions = this.focusFacts(period.start, coveredUntil);
    const metrics = computeMetrics({
      period,
      activities,
      priorities,
      taxonomy: this.sources.taxonomy(),
      // Aggregate Focus metrics count sessions that ran their course; the
      // per-session facts also include the ones that were ended early.
      focus: focusSessions.filter((f) => f.endReason !== 'ended-early' && f.endReason !== 'abandoned'),
      focusSessions,
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
    const cores = new Map<string, MetricSet | null>();
    const coreOf = async (p: ReflectionPeriod): Promise<MetricSet | null> => {
      if (!cores.has(p.key)) {
        cores.set(p.key, this.hasHistoryBefore(p.end) ? (await this.computeCore(p, p.end, allPriorities, threads)).metrics : null);
      }
      return cores.get(p.key)!;
    };
    const reference = async (p: ReflectionPeriod): Promise<MetricSet | null> => {
      const metrics = await coreOf(p);
      return metrics && assessSufficiency(metrics, p.type, this.config).enough ? metrics : null;
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
    const pausedMs = this.pausedMs(period);
    if (pausedMs >= PAUSE_NOTE_MIN_MS) {
      notes.push(
        `The user paused tracking for about ${formatPause(pausedMs)} during this ${period.type}. Nothing was recorded in that time: it is missing data, not inactivity or a break.`,
      );
    }

    // A day also sees the days just before it, one by one.
    let recent: MetricSet = {};
    if (period.type === 'day' && this.config.recentDays > 0) {
      const days: RecentDay[] = [];
      for (const p of previousPeriods(period, this.config.recentDays)) {
        const metrics = await coreOf(p);
        if (metrics) days.push({ key: p.key, label: formatDay(new Date(p.start)), range: { start: p.start, end: p.end }, metrics });
      }
      recent = buildRecentDayMetrics({ days, priorities: core.priorities, threads, lookback: this.config.recentDays });
    }

    return {
      ...dataset,
      metrics: { ...core.metrics, ...comparisons, ...recent },
      notes,
      hasPreviousComparison: previous !== null,
      baselinePeriodCount: hasBaseline ? baselines.length : 0,
    };
  }

  /** How much was tracked in [startIso, endIso), and when the last of it ended. */
  async activityPulse(startIso: string, endIso: string): Promise<{ minutes: number; lastEndedAt: string | null }> {
    const activities = await this.loadRawActivities(startIso, endIso);
    return {
      minutes: activities.reduce((sum, a) => sum + a.durationMinutes, 0),
      lastEndedAt: activities.reduce<string | null>((latest, a) => (latest === null || a.endedAt > latest ? a.endedAt : latest), null),
    };
  }

  /** Focus sessions that started inside the range, as plain facts. */
  focusFacts(startIso: string, endIso: string): FocusSessionFacts[] {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    const facts: FocusSessionFacts[] = [];
    for (const session of this.sources.focus.getSessionsByRange(startIso, endIso)) {
      if (!session.startedAt || session.state === 'planned') continue;
      // A session that was started and dropped at once is not evidence of anything.
      if (session.state === 'cancelled' && session.elapsedMs < 60_000) continue;
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
        plannedMinutes: session.plannedDurationMinutes,
        endReason: session.endReason ?? (session.state === 'completed' ? 'completed' : session.state === 'cancelled' ? 'ended-early' : null),
        note: session.endNote ?? session.notes ?? null,
      });
    }
    return facts;
  }
}

/** "25 minutes", "1 hour", "3 hours 10 minutes". */
function formatPause(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 1 ? '1 hour' : `${h} hours`;
  const mins = m === 1 ? '1 minute' : `${m} minutes`;
  if (h === 0) return mins;
  return m === 0 ? hours : `${hours} ${mins}`;
}
