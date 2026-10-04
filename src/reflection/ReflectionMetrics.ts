import {
  ACTIVE_DAY_MIN_MINUTES,
  BLOCK_MAX_GAP_MINUTES,
  FOCUSED_QUALITY_IDS,
  FRAGMENTED_MIN_SWITCHES,
  MAX_APP_METRICS,
  MAX_CONTEXT_METRICS,
  MAX_THREAD_METRICS,
  MEANINGFUL_ACTIVITY_MINUTES,
  MIN_BEHAVIOR_ACTIVITY_MINUTES,
  SHORT_ACTIVITY_MINUTES,
  SUSTAINED_ACTIVITY_MINUTES,
  SWITCH_MAX_GAP_MINUTES,
  type FocusSessionFacts,
  type Metric,
  type MetricGroup,
  type MetricSet,
  type MetricUnit,
  type ReflectionActivity,
  type ReflectionConfig,
  type ReflectionPeriod,
  type ReflectionPeriodType,
  type ReflectionPriority,
  type SufficiencyAssessment,
  type TaxonomyNames,
} from './ReflectionModels.js';
import { sortActivities, threadSlug } from './ReflectionActivities.js';
import {
  formatClockMinutes,
  formatDay,
  formatHour,
  formatLocalDateTime,
  listDays,
  localDayKey,
  subBuckets,
} from './ReflectionPeriods.js';
import { priorityKey } from './ReflectionPriorities.js';

/**
 * The deterministic measurement layer. Pure: the same activities always yield
 * the same metrics. Every number a reflection may quote is produced here —
 * the model interprets these measurements, it never calculates them.
 *
 * A metric is only emitted when it can actually be determined. Absent data is
 * absent, never zero.
 */

// ── Formatting ──────────────────────────────────────────────────────────────

/** `48m`, `2h 13m`, `3h`. */
export function formatMinutes(minutes: number): string {
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export function displayValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'minutes':
      return formatMinutes(value);
    case 'percent':
      return `${Math.round(value)}%`;
    case 'per_hour':
      return `${value.toFixed(1)} per hour`;
    case 'clock':
      return formatClockMinutes(value);
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

function roundFor(value: number, unit: MetricUnit): number {
  if (unit === 'per_hour') return Math.round(value * 10) / 10;
  if (unit === 'count') return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return Math.round(value);
}

// ── Time-of-day ─────────────────────────────────────────────────────────────

export const DAYPARTS = [
  { id: 'morning', label: 'Morning (5 AM–12 PM)', name: 'morning' },
  { id: 'afternoon', label: 'Afternoon (12 PM–5 PM)', name: 'afternoon' },
  { id: 'evening', label: 'Evening (5 PM–10 PM)', name: 'evening' },
  { id: 'night', label: 'Night (10 PM–5 AM)', name: 'night' },
] as const;

export type DaypartId = (typeof DAYPARTS)[number]['id'];

export function daypartOf(hour: number): DaypartId {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

interface Slice {
  dayKey: string;
  hour: number;
  minutes: number;
  activity: ReflectionActivity;
}

/** Spread an activity's tracked minutes over the local hours it spans. */
function sliceByHour(activity: ReflectionActivity): Slice[] {
  const start = Date.parse(activity.startedAt);
  const end = Date.parse(activity.endedAt);
  const startDate = new Date(start);
  if (!(end > start)) {
    return [{ dayKey: localDayKey(startDate), hour: startDate.getHours(), minutes: activity.durationMinutes, activity }];
  }
  const ratio = activity.durationMinutes / ((end - start) / 60_000);
  const slices: Slice[] = [];
  let cursor = start;
  while (cursor < end) {
    const d = new Date(cursor);
    let next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    if (next <= cursor) next = cursor + 3_600_000; // DST gap
    const sliceEnd = Math.min(next, end);
    slices.push({
      dayKey: localDayKey(d),
      hour: d.getHours(),
      minutes: ((sliceEnd - cursor) / 60_000) * ratio,
      activity,
    });
    cursor = sliceEnd;
  }
  return slices;
}

// ── Behaviour primitives ────────────────────────────────────────────────────

/** What "the same thing" means when deciding whether the user switched. */
function identityOf(a: ReflectionActivity): string {
  if (a.thread) return `t:${threadSlug(a.thread)}`;
  if (a.contextId) return `c:${a.contextId}`;
  return `x:${priorityKey(a.title)}`;
}

interface Switch {
  at: string;
  from: ReflectionActivity;
  to: ReflectionActivity;
}

function findSwitches(ordered: ReflectionActivity[]): Switch[] {
  const switches: Switch[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const gap = (Date.parse(cur.startedAt) - Date.parse(prev.endedAt)) / 60_000;
    if (gap <= SWITCH_MAX_GAP_MINUTES && identityOf(prev) !== identityOf(cur)) {
      switches.push({ at: cur.startedAt, from: prev, to: cur });
    }
  }
  return switches;
}

interface Block {
  start: string;
  end: string;
  minutes: number;
  activityIds: string[];
  label: string;
}

/** Consecutive activities on the same thing, with no real gap, are one block. */
function findBlocks(ordered: ReflectionActivity[]): Block[] {
  const blocks: Block[] = [];
  let current: (Block & { identity: string; longest: number }) | null = null;
  for (const a of ordered) {
    const identity = identityOf(a);
    const gap = current ? (Date.parse(a.startedAt) - Date.parse(current.end)) / 60_000 : Infinity;
    if (current && identity === current.identity && gap <= BLOCK_MAX_GAP_MINUTES) {
      current.minutes += a.durationMinutes;
      if (a.endedAt > current.end) current.end = a.endedAt;
      current.activityIds.push(a.id);
      if (a.durationMinutes > current.longest) {
        current.longest = a.durationMinutes;
        current.label = a.thread ?? a.title;
      }
    } else {
      if (current) blocks.push(current);
      current = {
        start: a.startedAt,
        end: a.endedAt,
        minutes: a.durationMinutes,
        activityIds: [a.id],
        label: a.thread ?? a.title,
        identity,
        longest: a.durationMinutes,
      };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** Deterministic "largest first" ordering with a stable tie-break. */
function topEntries<T extends { minutes: number }>(map: Map<string, T>): [string, T][] {
  return [...map.entries()].sort((a, b) => b[1].minutes - a[1].minutes || (a[0] < b[0] ? -1 : 1));
}

// ── Core metrics ────────────────────────────────────────────────────────────

export interface MetricsInput {
  period: ReflectionPeriod;
  /** Activities inside the period (already clipped to what is covered). */
  activities: ReflectionActivity[];
  /** Priorities that applied during the period. */
  priorities: ReflectionPriority[];
  taxonomy: TaxonomyNames;
  focus: FocusSessionFacts[];
  /**
   * Every Focus session of the period, including ones ended early. Described
   * one by one for a day, so "did the commitment actually happen?" can be
   * answered from evidence.
   */
  focusSessions?: FocusSessionFacts[];
  /** Threads to report even when they are not among the largest — used so a
   * comparison period can state a real zero instead of "unknown". */
  forceThreads?: string[];
}

export function computeMetrics(input: MetricsInput): MetricSet {
  const { period, taxonomy } = input;
  const multiDay = period.type !== 'day';
  const metrics: MetricSet = {};
  const add = (
    key: string,
    label: string,
    value: number | string,
    unit: MetricUnit,
    group: MetricGroup,
    extra: Partial<Pick<Metric, 'range' | 'activityIds' | 'priorityId' | 'thread'>> & { display?: string } = {},
  ) => {
    const { display, ...rest } = extra;
    const finalValue = typeof value === 'number' ? roundFor(value, unit) : value;
    metrics[key] = {
      key,
      label,
      value: finalValue,
      unit,
      display: display ?? (typeof finalValue === 'number' ? displayValue(finalValue, unit) : finalValue),
      group,
      ...rest,
    };
  };

  const activities = sortActivities(input.activities);
  const tracked = activities.reduce((sum, a) => sum + a.durationMinutes, 0);
  const slices = activities.flatMap(sliceByHour);

  // ── Time allocation ──
  add('time.tracked_minutes', 'Total tracked time', tracked, 'minutes', 'time');
  const share = (part: number) => (tracked > 0 ? (part / tracked) * 100 : 0);

  const sumBy = (pick: (a: ReflectionActivity) => string | null) => {
    const totals = new Map<string, { minutes: number }>();
    for (const a of activities) {
      const id = pick(a);
      if (!id) continue;
      const entry = totals.get(id) ?? { minutes: 0 };
      entry.minutes += a.durationMinutes;
      totals.set(id, entry);
    }
    return totals;
  };

  for (const [id, { minutes }] of topEntries(sumBy((a) => a.areaId))) {
    if (minutes < 1) continue;
    const name = taxonomy.areas[id] ?? id;
    add(`time.area.${id}`, `Time in the ${name} area`, minutes, 'minutes', 'time');
    add(`time.area.${id}.share`, `Share of tracked time in the ${name} area`, share(minutes), 'percent', 'time');
  }
  for (const [id, { minutes }] of topEntries(sumBy((a) => a.intentId))) {
    if (minutes < 1) continue;
    add(`time.intent.${id}`, `Time with intent ${taxonomy.intents[id] ?? id}`, minutes, 'minutes', 'time');
  }
  const qualityTotals = sumBy((a) => a.qualityId);
  for (const [id, { minutes }] of topEntries(qualityTotals)) {
    if (minutes < 1) continue;
    add(`time.quality.${id}`, `Time classified as ${taxonomy.qualities[id] ?? id}`, minutes, 'minutes', 'time');
  }
  for (const [id, { minutes }] of topEntries(sumBy((a) => a.contextId)).slice(0, MAX_CONTEXT_METRICS)) {
    if (minutes < 1) continue;
    add(`time.context.${id}`, `Time in context “${taxonomy.contexts[id] ?? id}”`, minutes, 'minutes', 'time');
  }

  // Focused time exists only where Quality was actually determined.
  const qualityKnown = qualityTotals.size > 0;
  const isFocused = (a: ReflectionActivity) => a.qualityId !== null && FOCUSED_QUALITY_IDS.includes(a.qualityId);
  const focused = activities.filter(isFocused).reduce((sum, a) => sum + a.durationMinutes, 0);
  if (qualityKnown) {
    add('time.focused_minutes', 'Focused time (Deep Work + Focused)', focused, 'minutes', 'time');
    if (tracked >= 1) add('time.focused_share', 'Share of tracked time that was focused', share(focused), 'percent', 'time');
  }

  const unclassified = activities
    .filter((a) => !a.contextId && !a.areaId && !a.intentId && !a.qualityId)
    .reduce((sum, a) => sum + a.durationMinutes, 0);
  if (unclassified >= 1) add('time.unclassified_minutes', 'Unclassified time', unclassified, 'minutes', 'time');

  const appTotals = sumBy((a) => a.domain ?? a.app);
  for (const [name, { minutes }] of topEntries(appTotals).slice(0, MAX_APP_METRICS)) {
    if (minutes < SHORT_ACTIVITY_MINUTES) continue;
    add(`app.${threadSlug(name)}.minutes`, `Time in ${name}`, minutes, 'minutes', 'time');
  }

  // ── Active days ──
  const minutesByDay = new Map<string, number>();
  for (const s of slices) minutesByDay.set(s.dayKey, (minutesByDay.get(s.dayKey) ?? 0) + s.minutes);
  const activeDays = [...minutesByDay.entries()].filter(([, m]) => m >= ACTIVE_DAY_MIN_MINUTES).map(([d]) => d);
  add('days.active', 'Days with tracked activity', activeDays.length, 'count', 'behavior');
  if (multiDay && activeDays.length > 0) {
    add('time.tracked_per_active_day', 'Tracked time per active day', tracked / activeDays.length, 'minutes', 'time');
  }

  // ── Session behaviour ──
  const ordered = activities.filter((a) => a.durationMinutes >= MIN_BEHAVIOR_ACTIVITY_MINUTES);
  const meaningful = ordered.filter((a) => a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES);
  if (meaningful.length > 0) {
    const durations = meaningful.map((a) => a.durationMinutes);
    add('behavior.activity_count', 'Meaningful activities (5 minutes or longer)', meaningful.length, 'count', 'behavior');
    add(
      'behavior.avg_activity_minutes',
      'Average activity length',
      durations.reduce((s, d) => s + d, 0) / durations.length,
      'minutes',
      'behavior',
    );
    add('behavior.median_activity_minutes', 'Median activity length', median(durations), 'minutes', 'behavior');
    const longest = meaningful.reduce((best, a) => (a.durationMinutes > best.durationMinutes ? a : best));
    add('behavior.longest_activity_minutes', `Longest single activity (${longest.title})`, longest.durationMinutes, 'minutes', 'behavior', {
      activityIds: [longest.id],
      range: { start: longest.startedAt, end: longest.endedAt },
    });
    add(
      'behavior.short_activities',
      'Short activities (under 10 minutes)',
      ordered.filter((a) => a.durationMinutes < SHORT_ACTIVITY_MINUTES).length,
      'count',
      'behavior',
    );
    add(
      'behavior.sustained_activities',
      'Sustained activities (25 minutes or longer)',
      meaningful.filter((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES).length,
      'count',
      'behavior',
    );
  }

  const switches = findSwitches(ordered);
  if (ordered.length > 0) {
    add('behavior.switches', 'Context switches', switches.length, 'count', 'behavior');
    if (tracked >= 60) {
      add('behavior.switches_per_hour', 'Context switches per tracked hour', switches.length / (tracked / 60), 'per_hour', 'behavior');
    }
  }

  // The single most fragmented stretch: one daypart of one day.
  const stretches = new Map<string, { count: number; dayKey: string; part: DaypartId; involved: ReflectionActivity[] }>();
  for (const sw of switches) {
    const at = new Date(sw.at);
    const part = daypartOf(at.getHours());
    const dayKey = localDayKey(at);
    const key = `${dayKey}|${part}`;
    const entry = stretches.get(key) ?? { count: 0, dayKey, part, involved: [] };
    entry.count++;
    for (const a of [sw.from, sw.to]) if (!entry.involved.includes(a)) entry.involved.push(a);
    stretches.set(key, entry);
  }
  const peak = [...stretches.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))[0]?.[1];
  if (peak && peak.count >= FRAGMENTED_MIN_SWITCHES) {
    const start = peak.involved.reduce((min, a) => (a.startedAt < min ? a.startedAt : min), peak.involved[0].startedAt);
    const end = peak.involved.reduce((max, a) => (a.endedAt > max ? a.endedAt : max), peak.involved[0].endedAt);
    const window = `${formatClockMinutes(minuteOfDay(start))}–${formatClockMinutes(minuteOfDay(end))}`;
    const where = multiDay ? `${peak.part} of ${formatDay(new Date(start))}, ${window}` : `the ${peak.part}, ${window}`;
    add('fragmentation.peak_switches', `Most context switches in one stretch (${where})`, peak.count, 'count', 'behavior', {
      range: { start, end },
      activityIds: peak.involved.slice(0, 12).map((a) => a.id),
    });
  }

  // ── Attention patterns ──
  const partMinutes = new Map<DaypartId, number>();
  const partFocused = new Map<DaypartId, number>();
  const hourMinutes = new Map<number, number>();
  for (const s of slices) {
    const part = daypartOf(s.hour);
    partMinutes.set(part, (partMinutes.get(part) ?? 0) + s.minutes);
    if (isFocused(s.activity)) partFocused.set(part, (partFocused.get(part) ?? 0) + s.minutes);
    hourMinutes.set(s.hour, (hourMinutes.get(s.hour) ?? 0) + s.minutes);
  }
  const partSwitches = new Map<DaypartId, number>();
  for (const sw of switches) {
    const part = daypartOf(new Date(sw.at).getHours());
    partSwitches.set(part, (partSwitches.get(part) ?? 0) + 1);
  }
  for (const part of DAYPARTS) {
    const minutes = partMinutes.get(part.id) ?? 0;
    if (minutes < 1) continue;
    add(`daypart.${part.id}.minutes`, `Tracked time — ${part.label}`, minutes, 'minutes', 'attention');
    if (qualityKnown) {
      add(`daypart.${part.id}.focused_minutes`, `Focused time — ${part.label}`, partFocused.get(part.id) ?? 0, 'minutes', 'attention');
    }
    add(`daypart.${part.id}.switches`, `Context switches — ${part.label}`, partSwitches.get(part.id) ?? 0, 'count', 'attention');
  }
  const peakHour = [...hourMinutes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (peakHour && peakHour[1] >= SHORT_ACTIVITY_MINUTES) {
    add('attention.peak_hour', 'Hour of day with the most tracked time', peakHour[0], 'count', 'attention', {
      display: `${formatHour(peakHour[0])}–${formatHour(peakHour[0] + 1)}`,
    });
  }

  // ── Uninterrupted blocks ──
  const blocks = findBlocks(ordered);
  const sustained = blocks.filter((b) => b.minutes >= SUSTAINED_ACTIVITY_MINUTES);
  if (blocks.length > 0) {
    const longest = blocks.reduce((best, b) => (b.minutes > best.minutes ? b : best));
    const when = multiDay ? `, ${formatLocalDateTime(longest.start)}` : `, started ${formatClockMinutes(minuteOfDay(longest.start))}`;
    add('block.longest_minutes', `Longest uninterrupted block (${longest.label}${when})`, longest.minutes, 'minutes', 'attention', {
      range: { start: longest.start, end: longest.end },
      activityIds: longest.activityIds.slice(0, 12),
    });
    add('block.sustained_count', 'Uninterrupted blocks of 25 minutes or longer', sustained.length, 'count', 'attention');
  }
  const sustainedByDay = new Map<string, Block[]>();
  for (const b of sustained) {
    const key = localDayKey(b.start);
    sustainedByDay.set(key, [...(sustainedByDay.get(key) ?? []), b]);
  }
  if (!multiDay && sustained.length > 0) {
    const first = sustained[0];
    add('block.first_sustained_start', 'Start of the first sustained block', minuteOfDay(first.start), 'clock', 'attention', {
      range: { start: first.start, end: first.end },
      activityIds: first.activityIds.slice(0, 12),
    });
  }
  if (multiDay && sustainedByDay.size >= 2) {
    const days = [...sustainedByDay.values()];
    const beforeNoon = days.filter((list) => {
      const longest = list.reduce((best, b) => (b.minutes > best.minutes ? b : best));
      return new Date(longest.start).getHours() < 12;
    }).length;
    add('pattern.sustained_days', 'Days with a sustained block (25 minutes or longer)', days.length, 'count', 'attention');
    add('pattern.longest_block_before_noon_days', 'Days whose longest block started before noon', beforeNoon, 'count', 'attention', {
      display: `${beforeNoon} of ${days.length} days`,
    });
    add(
      'pattern.typical_first_sustained_start',
      'Typical start of the first sustained block of the day',
      median(days.map((list) => minuteOfDay(list[0].start))),
      'clock',
      'attention',
    );
  }

  // ── Threads (projects / themes) ──
  interface ThreadStats {
    label: string;
    minutes: number;
    sessions: number;
    days: Set<string>;
  }
  const threads = new Map<string, ThreadStats>();
  for (const a of activities) {
    if (!a.thread) continue;
    const slug = threadSlug(a.thread);
    if (!slug) continue;
    const entry = threads.get(slug) ?? { label: a.thread, minutes: 0, sessions: 0, days: new Set<string>() };
    entry.minutes += a.durationMinutes;
    if (a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES) entry.sessions++;
    threads.set(slug, entry);
  }
  for (const s of slices) {
    if (s.activity.thread && s.minutes >= 1) threads.get(threadSlug(s.activity.thread))?.days.add(s.dayKey);
  }
  const reported = topEntries(threads)
    .filter(([, t]) => t.minutes >= SHORT_ACTIVITY_MINUTES)
    .slice(0, MAX_THREAD_METRICS)
    .map(([slug]) => slug);
  for (const label of input.forceThreads ?? []) {
    const slug = threadSlug(label);
    if (!slug) continue;
    if (!threads.has(slug)) threads.set(slug, { label, minutes: 0, sessions: 0, days: new Set() });
    if (!reported.includes(slug)) reported.push(slug);
  }
  for (const slug of reported) {
    const t = threads.get(slug)!;
    const extra = { thread: t.label };
    add(`thread.${slug}.minutes`, `Time on “${t.label}”`, t.minutes, 'minutes', 'thread', extra);
    if (tracked >= 1) add(`thread.${slug}.share`, `Share of tracked time on “${t.label}”`, share(t.minutes), 'percent', 'thread', extra);
    add(`thread.${slug}.sessions`, `Sessions on “${t.label}”`, t.sessions, 'count', 'thread', extra);
    if (multiDay) add(`thread.${slug}.active_days`, `Days with work on “${t.label}”`, t.days.size, 'count', 'thread', extra);
  }

  // ── Priority alignment ──
  let linked = 0;
  for (const p of input.priorities) {
    const own = activities.filter((a) => a.priorityId === p.id);
    const minutes = own.reduce((sum, a) => sum + a.durationMinutes, 0);
    linked += minutes;
    const extra = {
      priorityId: p.id,
      activityIds: [...own].sort((a, b) => b.durationMinutes - a.durationMinutes).slice(0, 12).map((a) => a.id),
    };
    add(`priority.${p.id}.minutes`, `Time linked to the priority “${p.text}”`, minutes, 'minutes', 'priority', extra);
    if (tracked >= 1) {
      add(`priority.${p.id}.share`, `Share of tracked time linked to the priority “${p.text}”`, share(minutes), 'percent', 'priority', {
        priorityId: p.id,
      });
    }
    add(
      `priority.${p.id}.sessions`,
      `Sessions linked to the priority “${p.text}”`,
      own.filter((a) => a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES).length,
      'count',
      'priority',
      { priorityId: p.id },
    );
    if (multiDay) {
      const days = new Set(slices.filter((s) => s.activity.priorityId === p.id && s.minutes >= 1).map((s) => s.dayKey));
      add(`priority.${p.id}.active_days`, `Days with work linked to the priority “${p.text}”`, days.size, 'count', 'priority', {
        priorityId: p.id,
      });
    }
  }
  if (input.priorities.length > 0) {
    add('priority.linked_minutes', 'Time linked to any current priority', linked, 'minutes', 'priority');
    add('priority.unlinked_minutes', 'Time not linked to a current priority', Math.max(0, tracked - linked), 'minutes', 'priority');
  }

  // ── Continuity ──
  if (multiDay) {
    const multiDayThreads = [...threads.values()].filter((t) => t.days.size >= 2).length;
    if (threads.size > 0) {
      add('continuity.multi_day_threads', 'Threads worked on across more than one day', multiDayThreads, 'count', 'continuity');
    }
  }
  const lastThreaded = [...activities]
    .reverse()
    .find((a) => a.thread && a.durationMinutes >= SHORT_ACTIVITY_MINUTES);
  if (lastThreaded?.thread) {
    const stats = threads.get(threadSlug(lastThreaded.thread));
    add('continuity.last_thread', 'Most recent sustained work thread', lastThreaded.thread, 'text', 'continuity', {
      display: `${lastThreaded.thread} (last worked ${formatLocalDateTime(lastThreaded.endedAt)})`,
      activityIds: [lastThreaded.id],
      range: { start: lastThreaded.startedAt, end: lastThreaded.endedAt },
      thread: lastThreaded.thread,
    });
    if (stats) {
      add('continuity.last_thread_sessions', `Sessions this period on “${lastThreaded.thread}”`, stats.sessions, 'count', 'continuity', {
        thread: lastThreaded.thread,
      });
    }
  }

  // ── Focus sessions (existing Focus data, not a second analytics engine) ──
  if (input.focus.length > 0) {
    add('focus.session_count', 'Focus sessions', input.focus.length, 'count', 'focus');
    add('focus.total_minutes', 'Time in Focus sessions', input.focus.reduce((s, f) => s + f.elapsedMinutes, 0), 'minutes', 'focus');
    add('focus.interruption_count', 'Focus session interruptions', input.focus.reduce((s, f) => s + f.interruptionCount, 0), 'count', 'focus');
    const blocked = input.focus.reduce((s, f) => s + f.blockedAttemptCount, 0);
    if (blocked > 0) add('focus.blocked_attempt_count', 'Blocked attempts during Focus sessions', blocked, 'count', 'focus');

    let overlap = 0;
    const threadOverlap = new Map<string, { minutes: number }>();
    for (const a of activities) {
      const s = Date.parse(a.startedAt);
      const e = Date.parse(a.endedAt);
      if (!(e > s)) continue;
      let within = 0;
      for (const f of input.focus) {
        within += Math.max(0, Math.min(e, Date.parse(f.endedAt)) - Math.max(s, Date.parse(f.startedAt)));
      }
      if (within <= 0) continue;
      const minutes = a.durationMinutes * Math.min(1, within / (e - s));
      overlap += minutes;
      if (a.thread) {
        const entry = threadOverlap.get(a.thread) ?? { minutes: 0 };
        entry.minutes += minutes;
        threadOverlap.set(a.thread, entry);
      }
    }
    add('focus.tracked_overlap_minutes', 'Tracked activity during Focus sessions', overlap, 'minutes', 'focus');
    const top = topEntries(threadOverlap)[0];
    if (top && top[1].minutes >= 1) {
      add('focus.top_thread', 'Main thread worked on during Focus sessions', top[0], 'text', 'focus', {
        display: `${top[0]} (${formatMinutes(top[1].minutes)})`,
        thread: top[0],
      });
    }
  }

  // ── Each Focus session of a day: planned vs actual, and how it ended ──
  if (!multiDay) {
    const sessions = [...(input.focusSessions ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(0, MAX_FOCUS_SESSION_METRICS);
    sessions.forEach((f, index) => {
      add(`focus.s${index + 1}`, `Focus session “${f.task}” (${formatLocalDateTime(f.startedAt)})`, describeFocusSession(f), 'text', 'focus', {
        range: { start: f.startedAt, end: f.endedAt },
      });
    });
  }

  // ── Series: how the period moved across its natural sub-divisions ──
  const buckets = subBuckets(period);
  if (buckets.length > 0) {
    const bucketOfDay = new Map<string, string>();
    for (const b of buckets) for (const d of listDays(b.start, b.end)) bucketOfDay.set(d.key, b.key);
    const perBucket = new Map<
      string,
      { tracked: number; focused: number; switches: number; threads: Map<string, { minutes: number }>; intents: Map<string, { minutes: number }> }
    >();
    const entryFor = (bucketKey: string) => {
      let entry = perBucket.get(bucketKey);
      if (!entry) {
        entry = { tracked: 0, focused: 0, switches: 0, threads: new Map(), intents: new Map() };
        perBucket.set(bucketKey, entry);
      }
      return entry;
    };
    for (const s of slices) {
      const bucketKey = bucketOfDay.get(s.dayKey);
      if (!bucketKey) continue;
      const entry = entryFor(bucketKey);
      entry.tracked += s.minutes;
      if (isFocused(s.activity)) entry.focused += s.minutes;
      if (s.activity.thread) {
        const t = entry.threads.get(s.activity.thread) ?? { minutes: 0 };
        t.minutes += s.minutes;
        entry.threads.set(s.activity.thread, t);
      }
      if (s.activity.intentId) {
        const i = entry.intents.get(s.activity.intentId) ?? { minutes: 0 };
        i.minutes += s.minutes;
        entry.intents.set(s.activity.intentId, i);
      }
    }
    for (const sw of switches) {
      const bucketKey = bucketOfDay.get(localDayKey(sw.at));
      if (bucketKey) entryFor(bucketKey).switches++;
    }
    for (const b of buckets) {
      const entry = perBucket.get(b.key);
      if (!entry || entry.tracked < 1) continue;
      const range = { start: b.start, end: b.end };
      add(`series.${b.key}.tracked_minutes`, `Tracked time — ${b.label}`, entry.tracked, 'minutes', 'series', { range });
      if (qualityKnown) add(`series.${b.key}.focused_minutes`, `Focused time — ${b.label}`, entry.focused, 'minutes', 'series', { range });
      add(`series.${b.key}.switches`, `Context switches — ${b.label}`, entry.switches, 'count', 'series', { range });
      const topThread = topEntries(entry.threads)[0];
      if (topThread && topThread[1].minutes >= SHORT_ACTIVITY_MINUTES) {
        add(`series.${b.key}.top_thread`, `Main thread — ${b.label}`, topThread[0], 'text', 'series', {
          range,
          thread: topThread[0],
          display: `${topThread[0]} (${formatMinutes(topThread[1].minutes)})`,
        });
      }
      const topIntent = topEntries(entry.intents)[0];
      if (topIntent && topIntent[1].minutes >= SHORT_ACTIVITY_MINUTES) {
        const name = taxonomy.intents[topIntent[0]] ?? topIntent[0];
        add(`series.${b.key}.top_intent`, `Main intent — ${b.label}`, name, 'text', 'series', {
          range,
          display: `${name} (${formatMinutes(topIntent[1].minutes)})`,
        });
      }
    }
  }

  return metrics;
}

const MAX_FOCUS_SESSION_METRICS = 6;

const FOCUS_END_PHRASES: Record<string, string> = {
  completed: 'ran its full planned time',
  finished: 'ended by you',
  'ended-early': 'ended early',
  abandoned: 'left unfinished',
};

/** `38m of 45m planned · 2 interruptions · ended early · note: "call came in"`. */
export function describeFocusSession(f: FocusSessionFacts): string {
  const parts = [f.plannedMinutes ? `${formatMinutes(f.elapsedMinutes)} of ${formatMinutes(f.plannedMinutes)} planned` : `${formatMinutes(f.elapsedMinutes)}, no time limit`];
  if (f.interruptionCount > 0) parts.push(`${f.interruptionCount} interruption${f.interruptionCount === 1 ? '' : 's'}`);
  if (f.blockedAttemptCount > 0) parts.push(`${f.blockedAttemptCount} blocked attempt${f.blockedAttemptCount === 1 ? '' : 's'}`);
  parts.push(f.endReason ? FOCUS_END_PHRASES[f.endReason] ?? f.endReason : 'still running');
  if (f.note) parts.push(`note: “${f.note.replace(/\s+/g, ' ').trim().slice(0, 140)}”`);
  return parts.join(' · ');
}

// ── Recent days ─────────────────────────────────────────────────────────────

export interface RecentDay {
  key: string;
  /** `Fri, Oct 2`. */
  label: string;
  range: { start: string; end: string };
  /** Core metrics of that day, however little was tracked. */
  metrics: MetricSet;
}

/**
 * The days just before a day, as citable measurements: each day's totals, and
 * how often each current priority / thread appeared across them. This is what
 * lets a reflection say "this has happened three times recently" from
 * evidence instead of from memory.
 */
export function buildRecentDayMetrics(input: {
  /** Earlier days, any order. */
  days: RecentDay[];
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  /** Threads of the day being reflected on. */
  threads: string[];
  lookback: number;
}): MetricSet {
  const out: MetricSet = {};
  const days = [...input.days].sort((a, b) => (a.key < b.key ? 1 : -1));
  const put = (metric: Metric) => {
    out[metric.key] = metric;
  };
  const span = `the previous ${input.lookback} days`;
  const tracked = (d: RecentDay) => numberOf(d.metrics['time.tracked_minutes']) ?? 0;
  const active = days.filter((d) => tracked(d) >= ACTIVE_DAY_MIN_MINUTES);
  if (days.length === 0) return out;

  put({ key: 'recent.active_days', label: `Days with tracked activity in ${span}`, value: active.length, unit: 'count', display: String(active.length), group: 'series' });

  for (const d of active) {
    const copy = (source: string, suffix: string, label: string) => {
      const metric = d.metrics[source];
      if (!metric) return;
      put({ key: `recent.${d.key}.${suffix}`, label: `${label} — ${d.label}`, value: metric.value, unit: metric.unit, display: metric.display, group: 'series', range: d.range });
    };
    copy('time.tracked_minutes', 'tracked_minutes', 'Tracked time');
    copy('time.focused_minutes', 'focused_minutes', 'Focused time');
    copy('behavior.switches', 'switches', 'Context switches');
    copy('focus.session_count', 'focus_sessions', 'Focus sessions');
    const top = Object.values(d.metrics)
      .filter((m) => /^thread\.[^.]+\.minutes$/.test(m.key) && typeof m.value === 'number' && m.thread)
      .sort((a, b) => (b.value as number) - (a.value as number))[0];
    if (top && (top.value as number) >= SHORT_ACTIVITY_MINUTES) {
      put({ key: `recent.${d.key}.top_thread`, label: `Main thread — ${d.label}`, value: top.thread!, unit: 'text', display: `${top.thread} (${top.display})`, group: 'series', range: d.range, thread: top.thread });
    }
  }

  const presence = (key: (d: RecentDay) => string, minMinutes: number) => {
    const hits = active.filter((d) => (numberOf(d.metrics[key(d)]) ?? 0) >= minMinutes);
    const minutes = active.reduce((sum, d) => sum + (numberOf(d.metrics[key(d)]) ?? 0), 0);
    return { days: hits.length, minutes, last: hits[0] ?? null };
  };

  for (const p of input.priorities) {
    const seen = presence(() => `priority.${p.id}.minutes`, MEANINGFUL_ACTIVITY_MINUTES);
    put({ key: `recent.priority.${p.id}.active_days`, label: `Days with work linked to the priority “${p.text}” in ${span}`, value: seen.days, unit: 'count', display: `${seen.days} of ${active.length}`, group: 'series', priorityId: p.id });
    put({ key: `recent.priority.${p.id}.minutes`, label: `Time linked to the priority “${p.text}” in ${span}`, value: Math.round(seen.minutes), unit: 'minutes', display: formatMinutes(seen.minutes), group: 'series', priorityId: p.id });
    if (seen.last) {
      put({ key: `recent.priority.${p.id}.last_day`, label: `Most recent earlier day with work linked to the priority “${p.text}”`, value: seen.last.label, unit: 'text', display: seen.last.label, group: 'series', priorityId: p.id, range: seen.last.range });
    }
  }

  for (const thread of input.threads.slice(0, MAX_THREAD_METRICS)) {
    const slug = threadSlug(thread);
    if (!slug) continue;
    const seen = presence(() => `thread.${slug}.minutes`, MEANINGFUL_ACTIVITY_MINUTES);
    put({ key: `recent.thread.${slug}.active_days`, label: `Days with work on “${thread}” in ${span}`, value: seen.days, unit: 'count', display: `${seen.days} of ${active.length}`, group: 'series', thread });
  }
  return out;
}

// ── Data sufficiency ────────────────────────────────────────────────────────

const INSUFFICIENT_MESSAGES: Record<ReflectionPeriodType, string> = {
  day: 'Not enough activity yet to generate a meaningful reflection.',
  week: 'Not enough activity this week to reflect on yet.',
  month: 'Not enough activity this month to reflect on yet.',
  year: 'Not enough activity this year to reflect on yet.',
};

export function assessSufficiency(metrics: MetricSet, type: ReflectionPeriodType, config: ReflectionConfig): SufficiencyAssessment {
  const tracked = numberOf(metrics['time.tracked_minutes']) ?? 0;
  const days = numberOf(metrics['days.active']) ?? 0;
  const limits = config.sufficiency[type];
  if (tracked < 1) return { enough: false, reason: 'no_activity', message: INSUFFICIENT_MESSAGES[type] };
  if (tracked < limits.minTrackedMinutes || days < limits.minActiveDays) {
    return { enough: false, reason: 'too_little_activity', message: INSUFFICIENT_MESSAGES[type] };
  }
  return { enough: true, reason: null, message: null };
}

function numberOf(metric: Metric | undefined): number | null {
  return metric && typeof metric.value === 'number' ? metric.value : null;
}

// ── Comparisons ─────────────────────────────────────────────────────────────

/** Measurements that stay comparable while the current period is unfinished. */
const RATE_KEYS = new Set([
  'behavior.avg_activity_minutes',
  'behavior.median_activity_minutes',
  'behavior.longest_activity_minutes',
  'block.longest_minutes',
  'time.tracked_per_active_day',
]);

/**
 * Buckets where a missing metric means a real zero — provided the other
 * period observed that dimension at all.
 */
const ZERO_FILL_PREFIXES = ['time.area.', 'time.intent.', 'time.quality.', 'time.context.', 'daypart.', 'thread.', 'app.'];

function zeroFillPrefix(key: string): string | null {
  return ZERO_FILL_PREFIXES.find((p) => key.startsWith(p)) ?? null;
}

/** Some labels describe the current period's instance; comparisons name the measure. */
const COMPARISON_LABELS: Record<string, string> = {
  'block.longest_minutes': 'Longest uninterrupted block',
  'behavior.longest_activity_minutes': 'Longest single activity',
  'fragmentation.peak_switches': 'Most context switches in one stretch',
};

function comparable(metric: Metric, mode: 'full' | 'partial'): boolean {
  if (typeof metric.value !== 'number') return false;
  if (metric.group === 'series' || metric.group === 'comparison') return false;
  if (metric.key === 'attention.peak_hour') return false;
  if (mode === 'full') return true;
  return metric.unit === 'percent' || metric.unit === 'per_hour' || metric.unit === 'clock' || RATE_KEYS.has(metric.key);
}

/** The value of `key` in another period: a number, a real zero, or unknown. */
function valueIn(set: MetricSet, key: string): number | null {
  const direct = numberOf(set[key]);
  if (direct !== null) return direct;
  const prefix = zeroFillPrefix(key);
  if (!prefix) return null;
  if ((numberOf(set['time.tracked_minutes']) ?? 0) <= 0) return null;
  // Focused time is only a real zero where Quality was determined at all.
  if (key.endsWith('focused_minutes') && numberOf(set['time.focused_minutes']) === null) return null;
  // Threads (forced into comparison periods) and dayparts are always observed
  // when there is tracked time; a classification dimension must have been seen.
  const observed = prefix === 'thread.' || prefix === 'daypart.' || Object.keys(set).some((k) => k.startsWith(prefix));
  return observed ? 0 : null;
}

function displayDelta(delta: number, previous: number, unit: MetricUnit): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const abs = Math.abs(delta);
  switch (unit) {
    case 'minutes': {
      const pct = previous > 0 ? ` (${sign}${Math.round((abs / previous) * 100)}%)` : '';
      return `${sign}${formatMinutes(abs)}${pct}`;
    }
    case 'percent':
      return `${sign}${Math.round(abs)} pts`;
    case 'per_hour':
      return `${sign}${abs.toFixed(1)} per hour`;
    case 'clock':
      return delta === 0 ? 'same time' : `${formatMinutes(abs)} ${delta > 0 ? 'later' : 'earlier'}`;
    default:
      return `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}`;
  }
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export interface ComparisonInput {
  current: MetricSet;
  /** The immediately preceding period, when it holds enough data. */
  previous: MetricSet | null;
  /** `previous week`. */
  previousName: string;
  /** Earlier periods that hold enough data, any order. */
  baselines: MetricSet[];
  /** `week` → "average of the previous 4 weeks". */
  baselineUnit: string;
  minBaselinePeriods: number;
  /** 'partial' while the current period is still running: totals of an
   * unfinished period are not compared with totals of a finished one. */
  mode: 'full' | 'partial';
}

/**
 * previous-period and personal-baseline values for every comparable metric.
 * Emitted as `prev.<key>`, `delta.<key>` and `baseline.<key>`. A comparison
 * that cannot be made is simply absent.
 */
export function buildComparisons(input: ComparisonInput): MetricSet {
  const out: MetricSet = {};
  const baseOf = (metric: Metric) => ({
    unit: metric.unit,
    group: 'comparison' as const,
    ...(metric.priorityId ? { priorityId: metric.priorityId } : {}),
    ...(metric.thread ? { thread: metric.thread } : {}),
  });

  for (const source of Object.values(input.current)) {
    if (!comparable(source, input.mode)) continue;
    const metric = { ...source, label: COMPARISON_LABELS[source.key] ?? source.label };
    const current = metric.value as number;

    if (input.previous) {
      const previous = valueIn(input.previous, metric.key);
      if (previous !== null && !(previous === 0 && current === 0)) {
        out[`prev.${metric.key}`] = {
          key: `prev.${metric.key}`,
          label: `${metric.label} — ${input.previousName}`,
          value: previous,
          display: displayValue(previous, metric.unit),
          ...baseOf(metric),
        };
        const delta = roundFor(current - previous, metric.unit);
        out[`delta.${metric.key}`] = {
          key: `delta.${metric.key}`,
          label: `Change in ${lowerFirst(metric.label)} vs the ${input.previousName}`,
          value: delta,
          display: displayDelta(delta, previous, metric.unit),
          ...baseOf(metric),
        };
      }
    }

    const values = input.baselines.map((set) => valueIn(set, metric.key)).filter((v): v is number => v !== null);
    if (values.length >= input.minBaselinePeriods && values.length > 0) {
      const mean = roundFor(values.reduce((s, v) => s + v, 0) / values.length, metric.unit);
      out[`baseline.${metric.key}`] = {
        key: `baseline.${metric.key}`,
        label: `${metric.label} — your average over the previous ${values.length} ${input.baselineUnit}s`,
        value: mean,
        display: displayValue(mean, metric.unit),
        ...baseOf(metric),
      };
    }
  }
  return out;
}

// ── Staleness + presentation helpers ────────────────────────────────────────

const STALE_PREFIXES = ['time.tracked_minutes', 'time.area.', 'time.intent.', 'time.quality.', 'time.context.'];

/**
 * Has the underlying activity changed enough that a report written from
 * `snapshot` no longer describes it? Returns the first key that moved, or
 * `null`. Tolerant by design: small re-groupings are not a meaningful change.
 */
export function findMeaningfulDifference(
  snapshot: MetricSet,
  current: MetricSet,
  config: Pick<ReflectionConfig, 'staleMinMinutes' | 'staleMinRatio'>,
): string | null {
  const keys = new Set([...Object.keys(snapshot), ...Object.keys(current)]);
  for (const key of [...keys].sort()) {
    if (!STALE_PREFIXES.some((p) => key === p || (p.endsWith('.') && key.startsWith(p)))) continue;
    if (key.endsWith('.share')) continue;
    const before = numberOf(snapshot[key]) ?? 0;
    const after = numberOf(current[key]) ?? 0;
    const diff = Math.abs(before - after);
    if (diff > Math.max(config.staleMinMinutes, config.staleMinRatio * Math.max(before, after))) return key;
  }
  return null;
}

/** The handful of numbers shown beneath a reflection, in display order. */
export function selectSupportingMetrics(metrics: MetricSet, type: ReflectionPeriodType): Metric[] {
  const keys = [
    'time.tracked_minutes',
    'time.focused_minutes',
    ...Object.keys(metrics)
      .filter((k) => /^priority\.[^.]+\.minutes$/.test(k))
      .slice(0, 1),
    'block.longest_minutes',
    'behavior.switches',
    ...(type === 'day' ? [] : ['days.active']),
  ];
  return keys.map((k) => metrics[k]).filter((m): m is Metric => m !== undefined);
}
