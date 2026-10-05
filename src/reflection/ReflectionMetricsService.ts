import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import {
  activitySignature,
  applyAnnotations,
  clipActivities,
  mergeFragments,
  threadSlug,
} from './ReflectionActivities.js';
import { buildDayFacts, groupDayFacts, isTrackedDay, metricsFromFacts, summarizeSubPeriods, trackedOf } from './ReflectionLedger.js';
import {
  buildCarryItems,
  buildTrajectories,
  carryMetrics,
  changeMetrics,
  coverageOf,
  detectEntityChanges,
  fingerprint,
  trajectoryMetrics,
} from './ReflectionLongitudinal.js';
import { assessSufficiency, buildComparisons, buildRecentDayMetrics, computeMetrics, type RecentDay } from './ReflectionMetrics.js';
import {
  SHORT_ACTIVITY_MINUTES,
  type DayFacts,
  type FocusSessionFacts,
  type MetricSet,
  type PeriodDataset,
  type ReflectionActivity,
  type ReflectionConfig,
  type ReflectionEvidence,
  type ReflectionPeriod,
  type ReflectionPeriodType,
  type ReflectionPriority,
  type TaxonomyNames,
} from './ReflectionModels.js';
import { formatDay, listDays, localDayKey, periodContaining, previousPeriodName, previousPeriods, shiftPeriod } from './ReflectionPeriods.js';
import { prioritiesActiveDuring, priorityIntervals } from './ReflectionPriorities.js';

/**
 * The impure half of the measurement layer: loads activities from the
 * verified timeline, attaches Reflection's cached annotations, and runs the
 * pure metric functions over the period, its predecessor, the personal
 * baseline and the day ledger.
 *
 * Two sources, by horizon:
 *
 *   day, week    the period's own activities, loaded one local day at a time
 *                (additive, cached per closed day) — every behavioural
 *                measure is available;
 *   month, year  the day ledger — a few structured rows per closed day,
 *                persisted — so a year is never re-derived from raw events
 *                just to be opened.
 *
 * Longitudinal structure (what changed versus history, how each body of work
 * moved, what is still carried) is read from the ledger for every period.
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
  /**
   * The timeline blocks that currently hold these raw events, best match
   * first — how a stored evidence reference finds its block again after any
   * regrouping. Absent in hosts without raw events (then time is used).
   */
  locateEvents?(eventIds: number[]): { id: string; startedAt: string; endedAt: string; matched: number }[];
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
/** Threads carried into reference periods so their absence is a measured zero. */
const MAX_UNION_THREADS = 12;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type ReflectionStore = Pick<IReflectionRepository, 'getAnnotations'> &
  Partial<Pick<IReflectionRepository, 'getDayFacts' | 'putDayFacts' | 'deleteDayFacts' | 'listInsightHistory' | 'listCurrentReports'>>;

export interface CoreResult {
  metrics: MetricSet;
  activities: ReflectionActivity[];
  priorities: ReflectionPriority[];
}

export interface PeriodAvailability {
  period: ReflectionPeriod;
  trackedMinutes: number;
  activeDays: number;
  /** Enough was observed to reflect on it. */
  enough: boolean;
}

export class ReflectionMetricsService {
  private readonly config: ReflectionConfig;
  private readonly now: () => Date;
  private readonly yieldToEventLoop: () => Promise<void>;
  /** Closed local day → its raw (un-annotated) activities. */
  private readonly dayCache = new Map<string, ReflectionActivity[]>();

  constructor(
    private readonly sources: ReflectionDataSources,
    private readonly store: ReflectionStore,
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

  /**
   * Forget derived data — call whenever the timeline may have changed.
   *
   *   (no argument)  everything: the in-memory days and the whole ledger
   *   a range        only the days overlapping it
   *   'memory'       the in-memory days only (nothing a closed day's facts
   *                  were derived from has changed)
   */
  invalidate(scope: { start: string; end: string } | 'memory' | null = null): void {
    if (scope === 'memory' || scope === null) this.dayCache.clear();
    else {
      for (const day of listDays(scope.start, scope.end)) this.dayCache.delete(day.key);
    }
    if (scope !== 'memory') this.store.deleteDayFacts?.(scope);
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
    const annotations = new Map(this.store.getAnnotations(signatures).map((a) => [a.signature, a]));
    return applyAnnotations(activities, annotations, priorities, this.sources.taxonomy());
  }

  // ── Day ledger ─────────────────────────────────────────────────────────────

  /**
   * The facts of every local day in [startIso, endIso), oldest first. Closed
   * days come from the ledger and are computed (once) and stored when absent;
   * a day still running is computed live and never stored.
   */
  async ledgerDays(startIso: string, endIso: string, allPriorities: ReflectionPriority[]): Promise<DayFacts[]> {
    const first = this.sources.firstEventAt();
    const now = this.now();
    const until = Math.min(Date.parse(endIso), now.getTime());
    if (first === null || until <= Date.parse(first) || until <= Date.parse(startIso)) return [];
    const from = Date.parse(startIso) < Date.parse(first) ? first : startIso;
    const wanted = listDays(from, new Date(until).toISOString());
    if (wanted.length === 0) return [];

    const stored = new Map(
      this.store.getDayFacts ? groupDayFacts(this.store.getDayFacts(wanted[0].start, wanted[wanted.length - 1].end)).map((d) => [d.key, d]) : [],
    );
    const out: DayFacts[] = [];
    let computed = 0;
    for (const day of wanted) {
      const known = stored.get(day.key);
      // A row computed under another day boundary describes a different day.
      if (known && known.start === day.start && known.end === day.end) {
        out.push(known);
        continue;
      }
      const closed = Date.parse(day.end) <= now.getTime();
      const facts = await this.computeDayFacts(day, closed ? day.end : now.toISOString(), allPriorities);
      if (closed) this.store.putDayFacts?.(facts);
      out.push(facts);
      if (++computed % YIELD_EVERY_DAYS === 0) await this.yieldToEventLoop();
    }
    return out;
  }

  private async computeDayFacts(day: ReflectionPeriod, coveredUntil: string, allPriorities: ReflectionPriority[]): Promise<DayFacts> {
    const priorities = prioritiesActiveDuring(allPriorities, day.start, coveredUntil);
    const activities = await this.loadActivities(day.start, coveredUntil, priorities);
    const focus = this.focusFacts(day.start, coveredUntil).filter((f) => f.endReason !== 'ended-early' && f.endReason !== 'abandoned');
    return buildDayFacts({ day, activities, priorities, taxonomy: this.sources.taxonomy(), focus });
  }

  /** Months and years are read from the ledger; days and weeks from their own activities. */
  private usesLedger(type: ReflectionPeriodType): boolean {
    return (type === 'month' || type === 'year') && this.store.getDayFacts !== undefined;
  }

  // ── Core metrics ───────────────────────────────────────────────────────────

  /** Core (non-comparative) metrics of [period.start, coveredUntil). */
  async computeCore(
    period: ReflectionPeriod,
    coveredUntil: string,
    allPriorities: ReflectionPriority[],
    forceThreads: string[] = [],
  ): Promise<CoreResult> {
    const priorities = prioritiesActiveDuring(allPriorities, period.start, coveredUntil);
    if (this.usesLedger(period.type)) {
      const days = await this.ledgerDays(period.start, coveredUntil, allPriorities);
      return { metrics: metricsFromFacts({ period, days, priorities, taxonomy: this.sources.taxonomy(), forceThreads }), activities: [], priorities };
    }
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
   * the previous period, the personal (and, for a day, same-weekday) baseline,
   * what changed versus history, how its work moved, what is still carried —
   * and, plainly, what could not be known.
   */
  async computeDataset(period: ReflectionPeriod, coveredUntil: string, allPriorities: ReflectionPriority[]): Promise<PeriodDataset> {
    const isPartial = Date.parse(coveredUntil) < Date.parse(period.end);
    let core = await this.computeCore(period, coveredUntil, allPriorities);
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

    // ── The union of what either side contained ──
    // Threads of this period are reported for the reference periods, and the
    // previous period's threads for this one: "no time on it" is then a
    // measured zero on whichever side it is missing — work that vanished is
    // compared, not silently dropped.
    const previousPeriod = shiftPeriod(period, -1);
    const hasPrevious = this.hasHistoryBefore(previousPeriod.end);
    const ownThreads = threadsOf(core);
    const previousProbe = hasPrevious ? await this.computeCore(previousPeriod, previousPeriod.end, allPriorities) : null;
    const threads = [...new Set([...ownThreads, ...(previousProbe ? threadsOf(previousProbe) : [])])].slice(0, MAX_UNION_THREADS);
    if (threads.some((t) => !ownThreads.includes(t))) core = await this.computeCore(period, coveredUntil, allPriorities, threads);

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

    const previous = await reference(previousPeriod);
    const { lookback, minPeriods } = this.config.baseline[period.type];
    const baselines: MetricSet[] = [];
    for (const p of previousPeriods(period, lookback)) {
      const metrics = p.key === previousPeriod.key ? previous : await reference(p);
      if (metrics) baselines.push(metrics);
    }

    // A Tuesday is first of all compared with other Tuesdays.
    const weekdayBaselines: MetricSet[] = [];
    const weekday = this.config.weekdayBaseline;
    if (period.type === 'day') {
      for (let i = 1; i <= weekday.lookback; i++) {
        const metrics = await reference(shiftPeriod(period, -7 * i));
        if (metrics) weekdayBaselines.push(metrics);
      }
    }
    const weekdayName = WEEKDAY_NAMES[new Date(period.start).getDay()];
    const mode = isPartial ? 'partial' : 'full';

    const comparisons = buildComparisons({
      current: core.metrics,
      previous,
      previousName: previousPeriodName(period.type),
      baselines,
      baselineUnit: period.type,
      minBaselinePeriods: minPeriods,
      mode,
      ...(period.type === 'day' ? { weekdayBaselines, weekdayName, minWeekdayPeriods: weekday.minPeriods } : {}),
    });

    const changes = detectEntityChanges({
      current: core.metrics,
      previous,
      baselines,
      mode,
      daily: period.type === 'day',
      priorities: allPriorities,
      asOf: coveredUntil,
      taxonomy: this.sources.taxonomy(),
    });

    // ── How the work moved, and what is still carried ──
    const windowStart = new Date(
      Math.min(Date.parse(period.start), Date.parse(coveredUntil) - this.config.trajectoryDays[period.type] * 86_400_000),
    ).toISOString();
    const windowDays = this.store.getDayFacts ? await this.ledgerDays(windowStart, coveredUntil, allPriorities) : [];
    const periodDays = windowDays.filter((d) => d.start >= period.start);
    const trajectories = buildTrajectories({
      days: windowDays,
      priorities: allPriorities,
      asOf: coveredUntil,
      stalledAfter: this.config.stalledAfterTrackedDays,
      genericThreads: this.genericThreads(),
    });
    const events = allPriorities.flatMap((p) => p.history ?? []).sort((a, b) => (a.at < b.at ? -1 : 1));
    const raised = this.raisedBefore(period);
    const carried = buildCarryItems({
      trajectories,
      raised: raised.times,
      raisedLast: raised.last,
      eventsInPeriod: events.filter((e) => e.at >= period.start && e.at < coveredUntil),
    });
    // What came before tracking began was never observable: it is neither a
    // missing day nor an empty month, and is left out of both.
    const first = this.sources.firstEventAt();
    const trackingSince = first ? periodContaining('day', first).start : period.start;
    const coverage = coverageOf(period, periodDays, coveredUntil, listDays(trackingSince > period.start ? trackingSince : period.start, period.end));

    const hasBaseline = baselines.length >= minPeriods;
    const notes: string[] = [];
    if (!this.hasHistoryBefore(period.start)) {
      notes.push(
        `This is the first ${period.type} Reflect has tracked. Comparisons will appear as more history accumulates.`,
      );
    } else {
      if (!previous) notes.push(`Not enough activity in the previous ${period.type} for a ${period.type}-over-${period.type} comparison.`);
      if (!hasBaseline) notes.push('Not enough history yet for a personal baseline.');
      if (period.type === 'day' && weekdayBaselines.length < weekday.minPeriods) {
        notes.push(
          `Not enough earlier ${weekdayName}s with data yet (${weekdayBaselines.length} of the ${weekday.minPeriods} needed) to compare this day with your usual ${weekdayName}.`,
        );
      }
    }
    if (isPartial && (previous || hasBaseline)) {
      notes.push('This period is still in progress, so only rates and averages are compared — not totals.');
    }
    if (core.priorities.length === 0) notes.push('No current priorities are stated, so priority alignment cannot be assessed.');
    notes.push(...coverage.notes);
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

    const longitudinal: MetricSet = {
      ...changeMetrics(changes, {
        previousName: previousPeriodName(period.type),
        unit: period.type,
        currentRange: { start: period.start, end: coveredUntil },
        previousRange: { start: previousPeriod.start, end: previousPeriod.end },
        daily: period.type === 'day',
      }),
      ...trajectoryMetrics(trajectories),
      ...carryMetrics(carried),
      ...coverage.metrics,
    };
    const windowEvents = events.filter((e) => e.at >= (period.type === 'day' ? windowStart : period.start) && e.at < coveredUntil && e.type !== 'stated');

    return {
      ...dataset,
      activities: core.activities,
      priorities: core.priorities,
      metrics: { ...core.metrics, ...comparisons, ...recent, ...longitudinal },
      notes,
      hasPreviousComparison: previous !== null,
      baselinePeriodCount: hasBaseline ? baselines.length : 0,
      trajectories,
      carried,
      changes,
      subPeriods: period.type === 'day' ? [] : summarizeSubPeriods(period, periodDays, coveredUntil, this.subPeriodHeadlines(period)).filter((b) => b.end > trackingSince),
      priorityEvents: windowEvents,
      basis: {
        priorities: prioritiesFingerprint(core.priorities, period.start, coveredUntil),
        carried: fingerprint(carried.map((c) => [c.key, c.status])),
        previousTrackedMinutes: previous ? (typeof previous['time.tracked_minutes']?.value === 'number' ? (previous['time.tracked_minutes'].value as number) : null) : null,
      },
    };
  }

  /** Thread keys that are only a Context name standing in for a missing project. */
  genericThreads(): Set<string> {
    return new Set(Object.values(this.sources.taxonomy().contexts).map(threadSlug).filter(Boolean));
  }

  /**
   * Subjects the earlier reflections of this period type raised as lagging or
   * open: how often, and which of them the reflection just before this one raised.
   */
  private raisedBefore(period: ReflectionPeriod): { times: Map<string, number>; last: Set<string> } {
    const times = new Map<string, number>();
    const last = new Set<string>();
    try {
      const latestKey = this.store.listCurrentReports?.(period.type, 1, period.start)[0]?.period.key ?? null;
      for (const row of this.store.listInsightHistory?.(period.type, period.start, this.config.identityLookback[period.type]) ?? []) {
        if (!row.subjectKey || !(row.identityKey.endsWith('|lagging') || row.type === 'open_loop')) continue;
        times.set(row.subjectKey, (times.get(row.subjectKey) ?? 0) + 1);
        if (row.period.key === latestKey) last.add(row.subjectKey);
      }
    } catch {
      // History is an aid: without it, only stated priorities are carried.
    }
    return { times, last };
  }

  /** The headline of each sub-period's own reflection, where one exists (a month synthesizes its weeks). */
  private subPeriodHeadlines(period: ReflectionPeriod): (start: string, end: string) => string | null {
    const subType: ReflectionPeriodType | null = period.type === 'week' ? 'day' : period.type === 'month' ? 'week' : period.type === 'year' ? 'month' : null;
    if (!subType || !this.store.listCurrentReports) return () => null;
    try {
      const limit = subType === 'day' ? 7 : subType === 'week' ? 6 : 12;
      const reports = this.store.listCurrentReports(subType, limit, period.end).filter((r) => r.period.end > period.start && r.headline);
      // A sub-period's report is the one covering most of the bucket.
      return (start, end) =>
        reports
          .map((r) => ({ r, overlap: Math.min(Date.parse(end), Date.parse(r.period.end)) - Math.max(Date.parse(start), Date.parse(r.period.start)) }))
          .filter((x) => x.overlap > 0)
          .sort((a, b) => b.overlap - a.overlap)[0]?.r.headline ?? null;
    } catch {
      return () => null;
    }
  }

  // ── Period availability ────────────────────────────────────────────────────

  /**
   * The most recent `limit` periods of `type` since tracking began, newest
   * first, with what was observed in each. Read from the ledger: a period
   * with nothing tracked is reported as such, never as a period of zeros.
   */
  async availability(type: ReflectionPeriodType, limit: number, allPriorities: ReflectionPriority[]): Promise<PeriodAvailability[]> {
    const first = this.sources.firstEventAt();
    const now = this.now();
    if (first === null) return [];
    const periods: ReflectionPeriod[] = [];
    for (let p = periodContaining(type, now); periods.length < limit && Date.parse(p.end) > Date.parse(first); p = shiftPeriod(p, -1)) periods.push(p);
    if (periods.length === 0) return [];
    const days = await this.ledgerDays(periods[periods.length - 1].start, now.toISOString(), allPriorities);
    const limits = this.config.sufficiency[type];
    return periods.map((period) => {
      const inside = days.filter((d) => d.start >= period.start && d.start < period.end);
      const trackedMinutes = Math.round(inside.reduce((total, d) => total + trackedOf(d), 0));
      const activeDays = inside.filter(isTrackedDay).length;
      return { period, trackedMinutes, activeDays, enough: trackedMinutes >= limits.minTrackedMinutes && activeDays >= limits.minActiveDays };
    });
  }

  /** Tracked minutes in [startIso, endIso): the first (partial) day from its activities, the rest from the ledger. */
  async trackedMinutesBetween(startIso: string, endIso: string, allPriorities: ReflectionPriority[]): Promise<number> {
    if (Date.parse(endIso) <= Date.parse(startIso)) return 0;
    const firstDayEnd = periodContaining('day', startIso).end;
    const head = await this.loadRawActivities(startIso, firstDayEnd < endIso ? firstDayEnd : endIso);
    let minutes = head.reduce((sum, a) => sum + a.durationMinutes, 0);
    if (firstDayEnd < endIso) {
      if (this.store.getDayFacts) minutes += (await this.ledgerDays(firstDayEnd, endIso, allPriorities)).reduce((sum, d) => sum + trackedOf(d), 0);
      else minutes += (await this.loadRawActivities(firstDayEnd, endIso)).reduce((sum, a) => sum + a.durationMinutes, 0);
    }
    return minutes;
  }

  // ── Evidence ───────────────────────────────────────────────────────────────

  /**
   * Where a stored piece of evidence lives on the Timeline NOW.
   *
   * Evidence is anchored to raw event ids, which never change; the block that
   * holds them may have been regrouped, re-analysed, split or merged since.
   * Resolution, in order: the block holding most of those events → the block
   * that still carries the recorded id → the block covering most of the
   * recorded time window. Deterministic: ties go to the earlier block.
   */
  async resolveEvidence(evidence: Pick<ReflectionEvidence, 'eventIds' | 'activityId' | 'period'>): Promise<{ activityId: string | null; start: string; end: string } | null> {
    const eventIds = evidence.eventIds ?? [];
    if (eventIds.length > 0 && this.sources.locateEvents) {
      const best = [...this.sources.locateEvents(eventIds)]
        .filter((b) => b.matched > 0)
        .sort((a, b) => b.matched - a.matched || (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1))[0];
      if (best) return { activityId: best.id, start: best.startedAt, end: best.endedAt };
    }
    const window = evidence.period ?? null;
    if (!window) return null;
    const days = listDays(window.start, window.end);
    const from = days[0]?.start ?? periodContaining('day', window.start).start;
    const to = days[days.length - 1]?.end ?? periodContaining('day', window.start).end;
    const blocks = await this.loadRawActivities(from, to);
    const wanted = new Set(eventIds);
    const overlap = (a: ReflectionActivity) => Math.min(Date.parse(a.endedAt), Date.parse(window.end)) - Math.max(Date.parse(a.startedAt), Date.parse(window.start));
    const best = blocks
      .map((a) => ({ a, events: (a.eventIds ?? []).filter((id) => wanted.has(id)).length, sameId: evidence.activityId !== undefined && a.id === evidence.activityId ? 1 : 0, time: overlap(a) }))
      .filter((x) => x.events > 0 || x.sameId > 0 || x.time > 0)
      .sort((x, y) => y.events - x.events || y.sameId - x.sameId || y.time - x.time || (x.a.startedAt < y.a.startedAt ? -1 : 1))[0];
    return best ? { activityId: best.a.id, start: best.a.startedAt, end: best.a.endedAt } : { activityId: null, start: window.start, end: window.end };
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

/** The threads a period's metrics report on, largest first. */
function threadsOf(core: CoreResult): string[] {
  const fromActivities = [...new Set(core.activities.map((a) => a.thread).filter((t): t is string => t !== null))];
  if (fromActivities.length > 0) return fromActivities;
  return Object.values(core.metrics)
    .filter((m) => /^thread\.[^.]+\.minutes$/.test(m.key) && typeof m.value === 'number' && m.value >= SHORT_ACTIVITY_MINUTES && m.thread)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map((m) => m.thread!);
}

/**
 * The priorities a period was read against: which ones, their wording, and
 * the stretches (clipped to the period) during which each applied. A change
 * that happened after a closed period does not touch that period.
 */
export function prioritiesFingerprint(priorities: ReflectionPriority[], startIso: string, endIso: string): string {
  return fingerprint(
    priorities.map((p) => [
      p.id,
      p.text,
      priorityIntervals(p)
        .map((i) => [i.from < startIso ? startIso : i.from, i.until === null || i.until > endIso ? endIso : i.until])
        .filter(([from, until]) => from < until),
    ]),
  );
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
