import {
  ACTIVE_DAY_MIN_MINUTES,
  MAX_CONTEXT_METRICS,
  MAX_THREAD_METRICS,
  MEANINGFUL_ACTIVITY_MINUTES,
  SHORT_ACTIVITY_MINUTES,
  type DayFactKind,
  type DayFactRow,
  type DayFacts,
  type FocusSessionFacts,
  type Metric,
  type MetricGroup,
  type MetricSet,
  type MetricUnit,
  type ReflectionActivity,
  type ReflectionPeriod,
  type ReflectionPriority,
  type SubPeriodSummary,
  type TaxonomyNames,
} from './ReflectionModels.js';
import { activitySignature, threadSlug } from './ReflectionActivities.js';
import { DAYPARTS, computeMetrics, displayValue, formatMinutes } from './ReflectionMetrics.js';
import { formatDay, subBuckets } from './ReflectionPeriods.js';

/**
 * The day ledger. Pure.
 *
 * `buildDayFacts` condenses one local day of verified activities into a few
 * structured rows; `metricsFromFacts` turns any run of such days into the
 * same measurements the activity-based layer produces. A month or a year is
 * therefore read from structure — a few rows per day — instead of being
 * re-derived from raw events every time it is opened.
 *
 * The ledger never invents: a day without a row was not computed, a day whose
 * tracked total is below the active-day threshold was not OBSERVED, and
 * neither is ever treated as "zero work".
 */

/** Per-day measures copied from the day's own metrics (key in the ledger → metric key). */
const DAY_MEASURES: Record<string, string> = {
  tracked: 'time.tracked_minutes',
  focused: 'time.focused_minutes',
  switches: 'behavior.switches',
  activities: 'behavior.activity_count',
  longest_block: 'block.longest_minutes',
  sustained_blocks: 'block.sustained_count',
  focus_sessions: 'focus.session_count',
  focus_minutes: 'focus.total_minutes',
  focus_interruptions: 'focus.interruption_count',
};

export function buildDayFacts(input: {
  day: Pick<ReflectionPeriod, 'key' | 'start' | 'end'>;
  /** The day's activities, clipped to the day, with thread / priority attached. */
  activities: ReflectionActivity[];
  /** Priorities that applied during the day. */
  priorities: ReflectionPriority[];
  taxonomy: TaxonomyNames;
  /** Focus sessions that ran their course. */
  focus: FocusSessionFacts[];
}): DayFacts {
  const { day, activities } = input;
  const rows: DayFactRow[] = [];
  const row = (kind: DayFactKind, key: string, label: string | null, minutes: number, sessions = 0, priorityId: string | null = null) => {
    rows.push({ dayKey: day.key, dayStart: day.start, dayEnd: day.end, kind, key, label, minutes: Math.round(minutes * 100) / 100, sessions, priorityId });
  };

  // Behaviour is measured once, by the same code a day's own reflection uses.
  const metrics = computeMetrics({
    period: { type: 'day', ...day },
    activities,
    priorities: input.priorities,
    taxonomy: input.taxonomy,
    focus: input.focus,
  });
  for (const [measure, metricKey] of Object.entries(DAY_MEASURES)) {
    const metric = metrics[metricKey];
    // 'tracked' is always written: it is what marks the day as computed.
    if (measure === 'tracked') row('measure', measure, null, typeof metric?.value === 'number' ? metric.value : 0);
    else if (metric && typeof metric.value === 'number') row('measure', measure, measure === 'longest_block' ? longestBlockLabel(metric) : null, metric.value);
  }
  for (const part of DAYPARTS) {
    const metric = metrics[`daypart.${part.id}.minutes`];
    if (metric && typeof metric.value === 'number') row('daypart', part.id, part.label, metric.value);
  }

  interface Sum {
    label: string | null;
    minutes: number;
    sessions: number;
    byPriority: Map<string, number>;
  }
  const sums = new Map<string, Sum>();
  const add = (kind: DayFactKind, key: string | null, label: string | null, a: ReflectionActivity) => {
    if (!key) return;
    const id = `${kind}\u0000${key}`;
    const entry = sums.get(id) ?? { label, minutes: 0, sessions: 0, byPriority: new Map<string, number>() };
    entry.minutes += a.durationMinutes;
    if (a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES) entry.sessions++;
    if (a.priorityId) entry.byPriority.set(a.priorityId, (entry.byPriority.get(a.priorityId) ?? 0) + a.durationMinutes);
    sums.set(id, entry);
  };
  const priorityText = new Map(input.priorities.map((p) => [p.id, p.text]));
  for (const a of activities) {
    add('thread', a.thread ? threadSlug(a.thread) : null, a.thread, a);
    add('priority', a.priorityId, a.priorityId ? priorityText.get(a.priorityId) ?? null : null, a);
    add('area', a.areaId, null, a);
    add('intent', a.intentId, null, a);
    add('quality', a.qualityId, null, a);
    add('context', a.contextId, null, a);
    add('signature', activitySignature(a), null, a);
  }
  for (const [id, sum] of [...sums.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [kind, key] = id.split('\u0000') as [DayFactKind, string];
    // The priority most of a thread's time went toward that day; ties go to the smaller id.
    const main = [...sum.byPriority.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    const priorityId = kind === 'thread' && main && main[1] >= sum.minutes / 2 ? main[0] : null;
    row(kind, key, sum.label, sum.minutes, sum.sessions, priorityId);
  }
  return { key: day.key, start: day.start, end: day.end, rows };
}

function longestBlockLabel(metric: Metric): string | null {
  const match = /\((.*)\)$/.exec(metric.label);
  // "Longest uninterrupted block (Project X, started 9:00 AM)" → "Project X".
  return match ? match[1].replace(/, started .*$/, '') : null;
}

/** Group ledger rows (one flat query result) into days, oldest first. */
export function groupDayFacts(rows: DayFactRow[]): DayFacts[] {
  const byDay = new Map<string, DayFacts>();
  for (const r of rows) {
    let day = byDay.get(r.dayKey);
    if (!day) {
      day = { key: r.dayKey, start: r.dayStart, end: r.dayEnd, rows: [] };
      byDay.set(r.dayKey, day);
    }
    day.rows.push(r);
  }
  return [...byDay.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
}

export function measureOf(day: DayFacts, key: string): number | null {
  const row = day.rows.find((r) => r.kind === 'measure' && r.key === key);
  return row ? row.minutes : null;
}

export const trackedOf = (day: DayFacts): number => measureOf(day, 'tracked') ?? 0;

/** A day Reflect actually observed. Anything less is missing data, not an idle day. */
export const isTrackedDay = (day: DayFacts): boolean => trackedOf(day) >= ACTIVE_DAY_MIN_MINUTES;

export interface EntityTotal {
  key: string;
  label: string | null;
  minutes: number;
  sessions: number;
  /** Days with at least a minute of it, oldest first. */
  days: DayFacts[];
  /** For a thread: the priority most of its time was linked to. */
  priorityId: string | null;
}

/** Time per entity of one kind across the days, largest first. */
export function entityTotals(days: DayFacts[], kind: DayFactKind): EntityTotal[] {
  const totals = new Map<string, EntityTotal & { byPriority: Map<string, number> }>();
  for (const day of days) {
    for (const r of day.rows) {
      if (r.kind !== kind) continue;
      const entry: EntityTotal & { byPriority: Map<string, number> } = totals.get(r.key) ?? {
        key: r.key,
        label: r.label,
        minutes: 0,
        sessions: 0,
        days: [],
        priorityId: null,
        byPriority: new Map<string, number>(),
      };
      entry.minutes += r.minutes;
      entry.sessions += r.sessions;
      if (r.label) entry.label = r.label;
      if (r.minutes >= 1) entry.days.push(day);
      if (r.priorityId) entry.byPriority.set(r.priorityId, (entry.byPriority.get(r.priorityId) ?? 0) + r.minutes);
      totals.set(r.key, entry);
    }
  }
  return [...totals.values()]
    .map(({ byPriority, ...entry }) => {
      const main = [...byPriority.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      return { ...entry, priorityId: main && main[1] >= entry.minutes / 2 ? main[0] : null };
    })
    .sort((a, b) => b.minutes - a.minutes || (a.key < b.key ? -1 : 1));
}

// ── Metrics from the ledger ─────────────────────────────────────────────────

export interface FactsMetricsInput {
  period: ReflectionPeriod;
  /** Ledger days inside the period (and, for a running period, today computed live). */
  days: DayFacts[];
  /** Priorities that applied during the period. */
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  taxonomy: TaxonomyNames;
  /** Threads to report even when absent — so a reference period states a real zero. */
  forceThreads?: string[];
}

/**
 * The measurements of a period, from its days' facts. Keys, units and wording
 * match `computeMetrics`, so comparisons, staleness checks and the UI treat
 * both the same; measures that need the individual activities (a single
 * fragmented stretch, the median activity) are simply not produced.
 */
export function metricsFromFacts(input: FactsMetricsInput): MetricSet {
  const { period, taxonomy } = input;
  const days = input.days.filter((d) => d.start >= period.start && d.start < period.end);
  const metrics: MetricSet = {};
  const add = (
    key: string,
    label: string,
    value: number | string,
    unit: MetricUnit,
    group: MetricGroup,
    extra: Partial<Pick<Metric, 'range' | 'priorityId' | 'thread'>> & { display?: string } = {},
  ) => {
    const { display, ...rest } = extra;
    const rounded = typeof value === 'number' ? (unit === 'per_hour' ? Math.round(value * 10) / 10 : Math.round(value)) : value;
    metrics[key] = { key, label, value: rounded, unit, display: display ?? (typeof rounded === 'number' ? displayValue(rounded, unit) : rounded), group, ...rest };
  };
  const sum = (measure: string) => days.reduce((total, d) => total + (measureOf(d, measure) ?? 0), 0);
  const spanOf = (list: DayFacts[]) => (list.length > 0 ? { start: list[0].start, end: list[list.length - 1].end } : undefined);

  const tracked = sum('tracked');
  const share = (part: number) => (tracked > 0 ? (part / tracked) * 100 : 0);
  add('time.tracked_minutes', 'Total tracked time', tracked, 'minutes', 'time');

  for (const e of entityTotals(days, 'area')) {
    if (e.minutes < 1) continue;
    const name = taxonomy.areas[e.key] ?? e.key;
    add(`time.area.${e.key}`, `Time in the ${name} area`, e.minutes, 'minutes', 'time');
    add(`time.area.${e.key}.share`, `Share of tracked time in the ${name} area`, share(e.minutes), 'percent', 'time');
  }
  for (const e of entityTotals(days, 'intent')) {
    if (e.minutes >= 1) add(`time.intent.${e.key}`, `Time with intent ${taxonomy.intents[e.key] ?? e.key}`, e.minutes, 'minutes', 'time');
  }
  for (const e of entityTotals(days, 'quality')) {
    if (e.minutes >= 1) add(`time.quality.${e.key}`, `Time classified as ${taxonomy.qualities[e.key] ?? e.key}`, e.minutes, 'minutes', 'time');
  }
  for (const e of entityTotals(days, 'context').slice(0, MAX_CONTEXT_METRICS)) {
    if (e.minutes >= 1) add(`time.context.${e.key}`, `Time in context “${taxonomy.contexts[e.key] ?? e.key}”`, e.minutes, 'minutes', 'time');
  }

  // Focused time exists only where Quality was determined on at least one day.
  const qualityKnown = days.some((d) => measureOf(d, 'focused') !== null);
  const focused = sum('focused');
  if (qualityKnown) {
    add('time.focused_minutes', 'Focused time (Deep Work + Focused)', focused, 'minutes', 'time');
    if (tracked >= 1) add('time.focused_share', 'Share of tracked time that was focused', share(focused), 'percent', 'time');
  }

  const active = days.filter(isTrackedDay);
  add('days.active', 'Days with tracked activity', active.length, 'count', 'behavior');
  if (active.length > 0) add('time.tracked_per_active_day', 'Tracked time per active day', tracked / active.length, 'minutes', 'time');

  if (sum('activities') > 0) add('behavior.activity_count', 'Meaningful activities (5 minutes or longer)', sum('activities'), 'count', 'behavior');
  if (active.length > 0) {
    const switches = sum('switches');
    add('behavior.switches', 'Context switches', switches, 'count', 'behavior');
    if (tracked >= 60) add('behavior.switches_per_hour', 'Context switches per tracked hour', switches / (tracked / 60), 'per_hour', 'behavior');
  }

  for (const part of DAYPARTS) {
    const minutes = days.reduce((total, d) => total + (d.rows.find((r) => r.kind === 'daypart' && r.key === part.id)?.minutes ?? 0), 0);
    if (minutes >= 1) add(`daypart.${part.id}.minutes`, `Tracked time — ${part.label}`, minutes, 'minutes', 'attention');
  }

  const longestDay = days.reduce<DayFacts | null>((best, d) => ((measureOf(d, 'longest_block') ?? 0) > (best ? measureOf(best, 'longest_block') ?? 0 : 0) ? d : best), null);
  if (longestDay) {
    const blockRow = longestDay.rows.find((r) => r.kind === 'measure' && r.key === 'longest_block')!;
    const what = blockRow.label ? `${blockRow.label}, ` : '';
    add('block.longest_minutes', `Longest uninterrupted block (${what}${formatDay(new Date(longestDay.start))})`, blockRow.minutes, 'minutes', 'attention', {
      range: { start: longestDay.start, end: longestDay.end },
    });
    add('block.sustained_count', 'Uninterrupted blocks of 25 minutes or longer', sum('sustained_blocks'), 'count', 'attention');
  }
  const sustainedDays = days.filter((d) => (measureOf(d, 'sustained_blocks') ?? 0) >= 1).length;
  if (sustainedDays >= 2) add('pattern.sustained_days', 'Days with a sustained block (25 minutes or longer)', sustainedDays, 'count', 'attention');

  // ── Threads ──
  const threads = entityTotals(days, 'thread');
  const reported = threads.filter((t) => t.minutes >= SHORT_ACTIVITY_MINUTES).slice(0, MAX_THREAD_METRICS);
  for (const label of input.forceThreads ?? []) {
    const slug = threadSlug(label);
    if (!slug || reported.some((t) => t.key === slug)) continue;
    reported.push(threads.find((t) => t.key === slug) ?? { key: slug, label, minutes: 0, sessions: 0, days: [], priorityId: null });
  }
  for (const t of reported) {
    const label = t.label ?? t.key;
    const extra = { thread: label, ...(t.priorityId ? { priorityId: t.priorityId } : {}), ...(spanOf(t.days) ? { range: spanOf(t.days) } : {}) };
    add(`thread.${t.key}.minutes`, `Time on “${label}”`, t.minutes, 'minutes', 'thread', extra);
    if (tracked >= 1) add(`thread.${t.key}.share`, `Share of tracked time on “${label}”`, share(t.minutes), 'percent', 'thread', { thread: label });
    add(`thread.${t.key}.sessions`, `Sessions on “${label}”`, t.sessions, 'count', 'thread', { thread: label });
    add(`thread.${t.key}.active_days`, `Days with work on “${label}”`, t.days.length, 'count', 'thread', extra);
  }
  if (threads.length > 0) {
    add('continuity.multi_day_threads', 'Threads worked on across more than one day', threads.filter((t) => t.days.length >= 2).length, 'count', 'continuity');
  }

  // ── Priorities ──
  const byPriority = new Map(entityTotals(days, 'priority').map((e) => [e.key, e]));
  let linked = 0;
  for (const p of input.priorities) {
    const e = byPriority.get(p.id);
    const minutes = e?.minutes ?? 0;
    linked += minutes;
    const extra = { priorityId: p.id, ...(e && spanOf(e.days) ? { range: spanOf(e.days) } : {}) };
    add(`priority.${p.id}.minutes`, `Time linked to the priority “${p.text}”`, minutes, 'minutes', 'priority', extra);
    if (tracked >= 1) add(`priority.${p.id}.share`, `Share of tracked time linked to the priority “${p.text}”`, share(minutes), 'percent', 'priority', { priorityId: p.id });
    add(`priority.${p.id}.sessions`, `Sessions linked to the priority “${p.text}”`, e?.sessions ?? 0, 'count', 'priority', { priorityId: p.id });
    add(`priority.${p.id}.active_days`, `Days with work linked to the priority “${p.text}”`, e?.days.length ?? 0, 'count', 'priority', extra);
  }
  if (input.priorities.length > 0) {
    add('priority.linked_minutes', 'Time linked to any current priority', linked, 'minutes', 'priority');
    add('priority.unlinked_minutes', 'Time not linked to a current priority', Math.max(0, tracked - linked), 'minutes', 'priority');
  }

  // ── Focus sessions ──
  if (sum('focus_sessions') > 0) {
    add('focus.session_count', 'Focus sessions', sum('focus_sessions'), 'count', 'focus');
    add('focus.total_minutes', 'Time in Focus sessions', sum('focus_minutes'), 'minutes', 'focus');
    add('focus.interruption_count', 'Focus session interruptions', sum('focus_interruptions'), 'count', 'focus');
  }

  // ── Series: how the period moved across its sub-periods ──
  for (const bucket of bucketFacts(period, days)) {
    if (bucket.tracked < 1) continue;
    const range = { start: bucket.start, end: bucket.end };
    add(`series.${bucket.key}.tracked_minutes`, `Tracked time — ${bucket.label}`, bucket.tracked, 'minutes', 'series', { range });
    if (qualityKnown) add(`series.${bucket.key}.focused_minutes`, `Focused time — ${bucket.label}`, bucket.days.reduce((t, d) => t + (measureOf(d, 'focused') ?? 0), 0), 'minutes', 'series', { range });
    add(`series.${bucket.key}.switches`, `Context switches — ${bucket.label}`, bucket.days.reduce((t, d) => t + (measureOf(d, 'switches') ?? 0), 0), 'count', 'series', { range });
    const topThread = entityTotals(bucket.days, 'thread')[0];
    if (topThread && topThread.minutes >= SHORT_ACTIVITY_MINUTES) {
      const label = topThread.label ?? topThread.key;
      add(`series.${bucket.key}.top_thread`, `Main thread — ${bucket.label}`, label, 'text', 'series', { range, thread: label, display: `${label} (${formatMinutes(topThread.minutes)})` });
    }
    for (const p of input.priorities) {
      const minutes = entityTotals(bucket.days, 'priority').find((e) => e.key === p.id)?.minutes ?? 0;
      add(`series.${bucket.key}.priority.${p.id}.minutes`, `Time linked to the priority “${p.text}” — ${bucket.label}`, minutes, 'minutes', 'series', { range, priorityId: p.id });
    }
  }

  return metrics;
}

interface BucketFacts {
  key: string;
  label: string;
  start: string;
  end: string;
  days: DayFacts[];
  tracked: number;
}

function bucketFacts(period: ReflectionPeriod, days: DayFacts[]): BucketFacts[] {
  return subBuckets(period).map((b) => {
    const inside = days.filter((d) => d.start >= b.start && d.start < b.end);
    return { key: b.key, label: b.label, start: b.start, end: b.end, days: inside, tracked: inside.reduce((t, d) => t + trackedOf(d), 0) };
  });
}

/**
 * The period's sub-periods as structure: what a week's days, a month's weeks
 * or a year's months each held. A sub-period nothing was observed in carries
 * `null` totals — it is missing, not empty.
 */
export function summarizeSubPeriods(period: ReflectionPeriod, days: DayFacts[], coveredUntil: string, headlineOf: (start: string, end: string) => string | null = () => null): SubPeriodSummary[] {
  return bucketFacts(period, days)
    .filter((b) => b.start < coveredUntil)
    .map((b) => {
      const observed = b.days.filter(isTrackedDay);
      const qualityKnown = b.days.some((d) => measureOf(d, 'focused') !== null);
      return {
        key: b.key,
        label: b.label,
        start: b.start,
        end: b.end,
        trackedMinutes: observed.length > 0 ? Math.round(b.tracked) : null,
        focusedMinutes: observed.length > 0 && qualityKnown ? Math.round(b.days.reduce((t, d) => t + (measureOf(d, 'focused') ?? 0), 0)) : null,
        activeDays: observed.length,
        top: [...entityTotals(b.days, 'priority'), ...entityTotals(b.days, 'thread').filter((t) => t.priorityId === null)]
          .filter((e) => e.minutes >= SHORT_ACTIVITY_MINUTES)
          .sort((x, y) => y.minutes - x.minutes)
          .slice(0, 3)
          .map((e) => ({ label: e.label ?? e.key, minutes: Math.round(e.minutes) })),
        headline: headlineOf(b.start, b.end),
      };
    });
}
