import {
  MEANINGFUL_ACTIVITY_MINUTES,
  type CarryItem,
  type DayFacts,
  type EntityChange,
  type Metric,
  type MetricSet,
  type PriorityEvent,
  type ReflectionPeriod,
  type ReflectionPriority,
  type TaxonomyNames,
  type WorkTrajectory,
} from './ReflectionModels.js';
import { threadSlug } from './ReflectionActivities.js';
import { entityTotals, isTrackedDay } from './ReflectionLedger.js';
import { formatMinutes } from './ReflectionMetrics.js';
import { formatDay, formatDayShort } from './ReflectionPeriods.js';
import { priorityStateAt } from './ReflectionPriorities.js';

/**
 * Change over time, as structure. Pure.
 *
 * Three questions a single period cannot answer on its own:
 *
 *   detectEntityChanges  what meaningfully appeared, disappeared or shifted
 *                        versus history — over the UNION of what either side
 *                        contained, so work that vanished is still seen;
 *   buildTrajectories    how each body of work moved across the tracked days;
 *   buildCarryItems      what is still unresolved from earlier periods.
 *
 * Everything here is measured and classified deterministically. The model is
 * handed the result to interpret; it never decides what vanished, what
 * stalled or what was completed.
 */

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Less than this in a period is "none". */
const ABSENT_MAX_MINUTES = MEANINGFUL_ACTIVITY_MINUTES;
/** At least this in a period is "really there". */
const PRESENT_MIN_MINUTES = 30;
/** A disappearance matters when the work was substantial, or habitual. */
const SUBSTANTIAL_MINUTES = 60;
const HABITUAL_PERIODS = 2;
/** A shift (still present on both sides) matters beyond both of these. */
const SHIFT_MIN_MINUTES = 60;
const SHIFT_MIN_RATIO = 0.5;
const MAX_CHANGES = 8;
const MAX_TRAJECTORIES = 8;
/** A day is compared with a habit, not with yesterday: present on at least this many earlier days… */
const DAILY_HABIT_MIN_DAYS = 3;
/** …and on at least this share of the earlier days that hold data. */
const DAILY_HABIT_MIN_SHARE = 0.5;
/** A one-off needs at least this much time before its absence means anything. */
const TRAJECTORY_MIN_MINUTES = 60;

// ── Entity changes ──────────────────────────────────────────────────────────

const ENTITY_KEYS: { entity: EntityChange['entity']; pattern: RegExp }[] = [
  { entity: 'priority', pattern: /^priority\.([^.]+)\.minutes$/ },
  { entity: 'thread', pattern: /^thread\.([^.]+)\.minutes$/ },
  { entity: 'area', pattern: /^time\.area\.([^.]+)$/ },
  { entity: 'intent', pattern: /^time\.intent\.([^.]+)$/ },
];

const numberOf = (metric: Metric | undefined): number | null => (metric && typeof metric.value === 'number' ? metric.value : null);
const trackedIn = (set: MetricSet): number => numberOf(set['time.tracked_minutes']) ?? 0;

export interface EntityChangeInput {
  current: MetricSet;
  /** The immediately preceding period, when it holds enough data. */
  previous: MetricSet | null;
  /** Earlier comparable periods that hold enough data (may include `previous`). */
  baselines: MetricSet[];
  /** Totals of an unfinished period are not compared with a finished one. */
  mode: 'full' | 'partial';
  /**
   * Single days: working on something yesterday and not today is how days
   * normally go. A day's change must break a habit, not differ from yesterday;
   * the reference is then every recent tracked day, and `previous` may be absent.
   */
  daily?: boolean;
  /** Every priority ever stated, for "why did it stop?". */
  priorities: ReflectionPriority[];
  /** The end of what the current period covers. */
  asOf: string;
  taxonomy: TaxonomyNames;
}

/**
 * What changed versus history, over the union of both sides.
 *
 * A change is reported only when it passes a deterministic test of meaning:
 * work that was substantial or habitual and is now absent; work that is
 * substantial now and was absent; a shift of at least an hour AND half its
 * size. Ordinary fluctuation produces nothing. Without a comparable previous
 * period, or while the current one is unfinished, nothing is claimed.
 *
 * For a single day the reference is the user's recent TRACKED days, not the
 * calendar day before (which may be a weekend with nothing recorded), and the
 * bar is a habit: something is only "no longer present" when it was there on
 * most of those days (and on at least three). Day-to-day shifts in amount are
 * not reported at all — alternating between projects from one day to the
 * next is normal, not a change.
 */
export function detectEntityChanges(input: EntityChangeInput): EntityChange[] {
  if (input.mode === 'partial') return [];
  if (input.daily) return detectDailyChanges(input);
  if (!input.previous) return [];
  const { current, previous } = input;
  const earlier = input.baselines.filter((set) => set !== previous);
  const priorityById = new Map(input.priorities.map((p) => [p.id, p]));
  const explain = (priorityId: string | null): EntityChange['explained'] => {
    const priority = priorityId ? priorityById.get(priorityId) : undefined;
    if (!priority) return null;
    const state = priorityStateAt(priority, input.asOf);
    return state === 'completed' ? 'completed' : state === 'paused' ? 'paused' : state === 'archived' ? 'dropped' : null;
  };

  const changes: EntityChange[] = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(previous), ...earlier.flatMap((set) => Object.keys(set))]);
  for (const key of [...keys].sort()) {
    const match = ENTITY_KEYS.map((e) => ({ entity: e.entity, m: e.pattern.exec(key) })).find((x) => x.m);
    if (!match?.m) continue;
    const id = match.m[1];
    const source = current[key] ?? previous[key] ?? earlier.map((set) => set[key]).find(Boolean);
    const now = numberOf(current[key]) ?? 0;
    const before = numberOf(previous[key]) ?? 0;
    const history = [previous, ...earlier];
    const presentIn = history.filter((set) => (numberOf(set[key]) ?? 0) >= PRESENT_MIN_MINUTES).length;

    let change: EntityChange['change'] | null = null;
    if (now < ABSENT_MAX_MINUTES && before >= PRESENT_MIN_MINUTES) {
      if (before >= SUBSTANTIAL_MINUTES || presentIn >= HABITUAL_PERIODS) change = 'vanished';
    } else if (now >= PRESENT_MIN_MINUTES && before < ABSENT_MAX_MINUTES) {
      const everBefore = earlier.some((set) => (numberOf(set[key]) ?? 0) >= PRESENT_MIN_MINUTES);
      if (now >= SUBSTANTIAL_MINUTES || everBefore) change = everBefore ? 'returned' : 'appeared';
    } else if (Math.abs(now - before) >= SHIFT_MIN_MINUTES && Math.abs(now - before) >= SHIFT_MIN_RATIO * Math.max(now, before)) {
      change = now > before ? 'increased' : 'decreased';
    }
    if (!change) continue;

    const priorityId = match.entity === 'priority' ? id : [current, previous, ...earlier].map((set) => set[key]?.priorityId).find(Boolean) ?? null;
    const label =
      match.entity === 'priority'
        ? priorityById.get(id)?.text ?? id
        : match.entity === 'thread'
          ? source?.thread ?? id
          : match.entity === 'area'
            ? input.taxonomy.areas[id] ?? id
            : input.taxonomy.intents[id] ?? id;
    changes.push({
      entity: match.entity,
      key: id,
      label,
      change,
      nowMinutes: now,
      previousMinutes: before,
      presentIn,
      outOf: history.length,
      explained: change === 'vanished' || change === 'decreased' ? explain(priorityId) : null,
      priorityId,
      thread: match.entity === 'thread' ? source?.thread ?? null : null,
    });
  }

  // A thread that moved with its own priority says the same thing twice.
  const priorityMoves = new Set(changes.filter((c) => c.entity === 'priority').map((c) => `${c.key}|${c.change}`));
  const order: Record<EntityChange['entity'], number> = { priority: 0, thread: 1, area: 2, intent: 3 };
  return changes
    .filter((c) => !(c.entity === 'thread' && c.priorityId && priorityMoves.has(`${c.priorityId}|${c.change}`)))
    .sort((a, b) => order[a.entity] - order[b.entity] || Math.abs(b.nowMinutes - b.previousMinutes) - Math.abs(a.nowMinutes - a.previousMinutes) || (a.key < b.key ? -1 : 1))
    .slice(0, MAX_CHANGES);
}

/**
 * A day against the user's recent tracked days. `previousMinutes` is what a
 * typical day WITH that work held — the size of the habit, not yesterday.
 */
function detectDailyChanges(input: EntityChangeInput): EntityChange[] {
  const { current } = input;
  const history = [...new Set([...(input.previous ? [input.previous] : []), ...input.baselines])];
  if (history.length < DAILY_HABIT_MIN_DAYS) return [];
  const priorityById = new Map(input.priorities.map((p) => [p.id, p]));

  const changes: EntityChange[] = [];
  const keys = new Set([...Object.keys(current), ...history.flatMap((set) => Object.keys(set))]);
  for (const key of [...keys].sort()) {
    const match = ENTITY_KEYS.map((e) => ({ entity: e.entity, m: e.pattern.exec(key) })).find((x) => x.m);
    // A day's habits are its priorities and projects; areas and intents shift too freely to be one.
    if (!match?.m || (match.entity !== 'priority' && match.entity !== 'thread')) continue;
    const id = match.m[1];
    const now = numberOf(current[key]) ?? 0;
    const present = history.map((set) => numberOf(set[key]) ?? 0).filter((minutes) => minutes >= PRESENT_MIN_MINUTES);
    const typical = present.length > 0 ? present.reduce((sum, m) => sum + m, 0) / present.length : 0;

    let change: EntityChange['change'] | null = null;
    if (now < ABSENT_MAX_MINUTES && present.length >= DAILY_HABIT_MIN_DAYS && present.length >= DAILY_HABIT_MIN_SHARE * history.length) change = 'vanished';
    else if (now >= SUBSTANTIAL_MINUTES && present.length === 0) change = 'appeared';
    if (!change) continue;

    const source = [current, ...history].map((set) => set[key]).find(Boolean);
    const priorityId = match.entity === 'priority' ? id : [current, ...history].map((set) => set[key]?.priorityId).find(Boolean) ?? null;
    const priority = priorityId ? priorityById.get(priorityId) : undefined;
    const state = priority ? priorityStateAt(priority, input.asOf) : 'active';
    changes.push({
      entity: match.entity,
      key: id,
      label: match.entity === 'priority' ? priority?.text ?? id : source?.thread ?? id,
      change,
      nowMinutes: now,
      previousMinutes: Math.round(typical),
      presentIn: present.length,
      outOf: history.length,
      explained: change === 'vanished' ? (state === 'completed' ? 'completed' : state === 'paused' ? 'paused' : state === 'archived' ? 'dropped' : null) : null,
      priorityId,
      thread: match.entity === 'thread' ? source?.thread ?? null : null,
    });
  }
  const priorityMoves = new Set(changes.filter((c) => c.entity === 'priority').map((c) => `${c.key}|${c.change}`));
  return changes
    .filter((c) => !(c.entity === 'thread' && c.priorityId && priorityMoves.has(`${c.priorityId}|${c.change}`)))
    .sort((a, b) => (a.entity === b.entity ? b.previousMinutes + b.nowMinutes - (a.previousMinutes + a.nowMinutes) || (a.key < b.key ? -1 : 1) : a.entity === 'priority' ? -1 : 1))
    .slice(0, MAX_CHANGES);
}

const CHANGE_WORDS: Record<EntityChange['change'], string> = {
  vanished: 'no longer present',
  appeared: 'new',
  returned: 'back after an absence',
  decreased: 'down',
  increased: 'up',
};

const EXPLAINED_WORDS: Record<NonNullable<EntityChange['explained']>, string> = {
  completed: 'you marked this priority completed',
  paused: 'you paused this priority',
  dropped: 'you removed this priority',
};

/** Each change as a citable comparison: `change.<entity>.<key>`. */
export function changeMetrics(
  changes: EntityChange[],
  ctx: { previousName: string; unit: string; currentRange: { start: string; end: string }; previousRange: { start: string; end: string }; daily?: boolean },
): MetricSet {
  const out: MetricSet = {};
  for (const c of changes) {
    const key = `change.${c.entity}.${c.entity === 'thread' ? threadSlug(c.key) || c.key : c.key}`;
    const history = c.outOf > 1 ? `; present in ${c.presentIn} of the previous ${c.outOf} ${ctx.unit}s` : '';
    const explained = c.explained ? `; ${EXPLAINED_WORDS[c.explained]}` : '';
    // A day is set against the recent tracked days it was (or was not) part of.
    const display = ctx.daily
      ? c.change === 'vanished'
        ? `${CHANGE_WORDS.vanished}: worked on ${c.presentIn} of the previous ${c.outOf} tracked days (${formatMinutes(c.previousMinutes)} on such a day), ${formatMinutes(c.nowMinutes)} today${explained}`
        : `${CHANGE_WORDS[c.change]}: on none of the previous ${c.outOf} tracked days, ${formatMinutes(c.nowMinutes)} today`
      : `${CHANGE_WORDS[c.change]}: ${formatMinutes(c.previousMinutes)} in the ${ctx.previousName}, ${formatMinutes(c.nowMinutes)} now${history}${explained}`;
    out[key] = {
      key,
      label: ctx.daily ? `Change in “${c.label}” vs your recent tracked days` : `Change in “${c.label}” vs the ${ctx.previousName}`,
      value: c.change,
      unit: 'text',
      display,
      group: 'comparison',
      // Where to look: at the period that still held it, when it is gone.
      range: c.change === 'vanished' && !ctx.daily ? ctx.previousRange : ctx.currentRange,
      ...(c.priorityId ? { priorityId: c.priorityId } : {}),
      ...(c.thread ? { thread: c.thread } : {}),
    };
  }
  return out;
}

// ── Trajectories ────────────────────────────────────────────────────────────

export interface TrajectoryInput {
  /** Ledger days of the look-back window, any order (today computed live when it is running). */
  days: DayFacts[];
  /** Every priority ever stated. */
  priorities: ReflectionPriority[];
  /** The end of what is covered; later days are ignored. */
  asOf: string;
  /** Tracked days without work after which multi-day work counts as stalled. */
  stalledAfter: number;
  /**
   * Thread keys that are not a body of work: an activity nobody named a
   * project for carries its Context ("Browsing", "Coding") as its thread, and
   * a category is not something that can be left open or picked up again.
   */
  genericThreads?: ReadonlySet<string>;
}

/**
 * How each body of work moved across the TRACKED days — a stated priority, or
 * a thread that serves none. Unobserved days are skipped entirely: a weekend
 * with the tracker off is neither progress nor neglect.
 *
 *   new       first appeared on the latest tracked day
 *   ongoing   being worked on; a day off in between is normal
 *   resumed   picked up again after a real gap
 *   stalled   multi-day (or substantial) work untouched for a while, while
 *             other work happened — displaced, postponed or simply left
 *   completed / paused / dropped   the user said so; never a failure
 */
export function buildTrajectories(input: TrajectoryInput): WorkTrajectory[] {
  const tracked = input.days
    .filter((d) => d.start < input.asOf && isTrackedDay(d))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  if (tracked.length === 0) return [];
  const priorityById = new Map(input.priorities.map((p) => [p.id, p]));

  const subjects: { key: string; kind: 'priority' | 'thread'; priorityId: string | null; thread: string | null; label: string; entityKey: string }[] = [];
  for (const e of entityTotals(tracked, 'priority')) {
    const priority = priorityById.get(e.key);
    if (priority) subjects.push({ key: `p:${e.key}`, kind: 'priority', priorityId: e.key, thread: null, label: priority.text, entityKey: e.key });
  }
  for (const e of entityTotals(tracked, 'thread')) {
    // A thread that serves a priority is part of that priority's trajectory.
    if (e.priorityId === null && !input.genericThreads?.has(e.key)) subjects.push({ key: `t:${e.key}`, kind: 'thread', priorityId: null, thread: e.label ?? e.key, label: e.label ?? e.key, entityKey: e.key });
  }

  const out: WorkTrajectory[] = [];
  for (const subject of subjects) {
    const minutesOn = (day: DayFacts) => day.rows.find((r) => r.kind === subject.kind && r.key === subject.entityKey)?.minutes ?? 0;
    const firstIndex = tracked.findIndex((d) => minutesOn(d) >= MEANINGFUL_ACTIVITY_MINUTES);
    if (firstIndex === -1) continue;
    const since = tracked.slice(firstIndex);
    const worked = since.map((d) => minutesOn(d) >= MEANINGFUL_ACTIVITY_MINUTES);
    const lastIndex = worked.lastIndexOf(true);
    const activeDays = worked.filter(Boolean).length;
    const minutes = since.reduce((total, d) => total + minutesOn(d), 0);
    const idle = since.length - 1 - lastIndex;

    // The gap just before the latest run of work.
    let runStart = lastIndex;
    while (runStart > 0 && worked[runStart - 1]) runStart--;
    let gapBefore = 0;
    for (let i = runStart - 1; i >= 0 && !worked[i]; i--) gapBefore++;

    const state = subject.priorityId ? priorityStateAt(priorityById.get(subject.priorityId)!, input.asOf) : 'active';
    let status: WorkTrajectory['status'];
    if (state === 'completed') status = 'completed';
    else if (state === 'paused') status = 'paused';
    else if (state === 'archived') status = 'dropped';
    else if (idle >= input.stalledAfter) {
      // A brief one-off that never came back is not an open thread.
      if (activeDays < 2 && minutes < TRAJECTORY_MIN_MINUTES) continue;
      status = 'stalled';
    } else if (activeDays === 1) status = idle === 0 ? 'new' : 'ongoing';
    else if (idle === 0 && gapBefore >= input.stalledAfter) status = 'resumed';
    else status = 'ongoing';

    out.push({
      key: subject.key,
      kind: subject.kind,
      priorityId: subject.priorityId,
      thread: subject.thread,
      label: subject.label,
      status,
      firstDay: since[0].key,
      lastDay: since[lastIndex].key,
      activeDays,
      trackedDays: since.length,
      idleTrackedDays: idle,
      minutes: Math.round(minutes),
      days: since.map((d) => ({ key: d.key, start: d.start, end: d.end, minutes: Math.round(minutesOn(d)) })),
    });
  }
  return out.sort((a, b) => b.minutes - a.minutes || (a.key < b.key ? -1 : 1)).slice(0, MAX_TRAJECTORIES);
}

const STATUS_WORDS: Record<WorkTrajectory['status'], string> = {
  new: 'started',
  ongoing: 'ongoing',
  resumed: 'resumed after a gap',
  stalled: 'not worked on lately',
  completed: 'marked completed by you',
  paused: 'paused by you',
  dropped: 'removed from your priorities by you',
};

const dayLabel = (day: { start: string }) => formatDay(new Date(day.start));

/** `worked Mon, Oct 5 and Tue, Oct 6; not Wed, Oct 7 or Thu, Oct 8; worked Fri, Oct 9`. */
function describeDays(days: WorkTrajectory['days']): string {
  const runs: { worked: boolean; days: WorkTrajectory['days'] }[] = [];
  for (const day of days) {
    const worked = day.minutes >= MEANINGFUL_ACTIVITY_MINUTES;
    const last = runs[runs.length - 1];
    if (last && last.worked === worked) last.days.push(day);
    else runs.push({ worked, days: [day] });
  }
  const list = (items: string[], joiner: string) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`);
  return runs.map((run) => (run.worked ? `worked ${list(run.days.map(dayLabel), 'and')}` : `not ${list(run.days.map(dayLabel), 'or')}`)).join('; ');
}

/**
 * Each trajectory as citable facts: `trajectory.<key>` (the day-by-day
 * course) and, where it applies, `trajectory.<key>.idle_days`.
 */
export function trajectoryMetrics(trajectories: WorkTrajectory[]): MetricSet {
  const out: MetricSet = {};
  for (const t of trajectories) {
    const slug = t.key.replace(':', '.');
    const links = { ...(t.priorityId ? { priorityId: t.priorityId } : {}), ...(t.thread ? { thread: t.thread } : {}) };
    const course =
      t.days.length <= 7
        ? describeDays(t.days)
        : `worked on ${t.activeDays} of ${t.trackedDays} tracked days since ${formatDayShort(new Date(t.days[0].start))}; last on ${dayLabel(t.days[t.days.length - 1 - t.idleTrackedDays])}`;
    out[`trajectory.${slug}`] = {
      key: `trajectory.${slug}`,
      label: `How “${t.label}” moved across your tracked days`,
      value: t.status,
      unit: 'text',
      display: `${STATUS_WORDS[t.status]} — ${course} (${t.activeDays} of ${t.trackedDays} tracked days)`,
      group: 'history',
      range: { start: t.days[0].start, end: t.days[t.days.length - 1].end },
      ...links,
    };
    if (t.status === 'stalled') {
      const last = t.days[t.days.length - 1 - t.idleTrackedDays];
      out[`trajectory.${slug}.idle_days`] = {
        key: `trajectory.${slug}.idle_days`,
        label: `Tracked days since you last worked on “${t.label}” (${dayLabel(last)})`,
        value: t.idleTrackedDays,
        unit: 'count',
        display: String(t.idleTrackedDays),
        group: 'history',
        range: { start: last.start, end: last.end },
        ...links,
      };
    }
  }
  return out;
}

// ── Carried work ────────────────────────────────────────────────────────────

export interface CarryInput {
  trajectories: WorkTrajectory[];
  /** Subjects earlier reflections raised as open (subject key → how often). */
  raised: Map<string, number>;
  /** Subjects the reflection just before this one raised as open. */
  raisedLast?: ReadonlySet<string>;
  /** Priority events inside the period being reflected on. */
  eventsInPeriod: PriorityEvent[];
}

/**
 * What persisted across periods, and what closed.
 *
 *   open         stalled work on a stated priority, or stalled work an earlier
 *                reflection already raised — still unresolved
 *   progressing  the previous reflection raised it as open, and it is being
 *                worked on again. Reported once: after that it is simply work
 *                in progress.
 *   completed / paused / dropped   it closed in this period, by the user's
 *                own decision. Reported once, then gone.
 *
 * Ongoing multi-day work is NOT carried: something being worked on is not an
 * open loop, however many days it spans.
 */
export function buildCarryItems(input: CarryInput): CarryItem[] {
  const closedNow = new Map<string, PriorityEvent>();
  for (const e of input.eventsInPeriod) {
    if (e.type === 'completed' || e.type === 'paused' || e.type === 'archived') closedNow.set(e.priorityId, e);
    if (e.type === 'reactivated') closedNow.delete(e.priorityId);
  }

  const items: CarryItem[] = [];
  for (const t of input.trajectories) {
    const timesRaised = input.raised.get(t.key) ?? 0;
    const lastWorkedDay = t.days[t.days.length - 1 - t.idleTrackedDays];
    let status: CarryItem['status'] | null = null;
    if (t.status === 'completed' || t.status === 'paused' || t.status === 'dropped') {
      // Closing is news once: in the period it happened.
      if (t.priorityId && closedNow.has(t.priorityId)) status = t.status;
    } else if (t.status === 'stalled') {
      if (t.kind === 'priority' || timesRaised > 0) status = 'open';
    } else if ((t.status === 'resumed' || t.status === 'ongoing') && input.raisedLast?.has(t.key) && t.idleTrackedDays === 0) {
      status = 'progressing';
    }
    if (!status) continue;
    items.push({
      key: t.key,
      title: t.label,
      priorityId: t.priorityId,
      thread: t.thread,
      status,
      since: t.days[Math.min(t.days.length - 1, t.days.length - t.idleTrackedDays)].key,
      idleTrackedDays: t.idleTrackedDays,
      timesRaised,
      lastWorked: lastWorkedDay ? { start: lastWorkedDay.start, end: lastWorkedDay.end } : null,
    });
  }
  const order: Record<CarryItem['status'], number> = { open: 0, progressing: 1, completed: 2, paused: 3, dropped: 4 };
  return items.sort((a, b) => order[a.status] - order[b.status] || b.idleTrackedDays - a.idleTrackedDays || (a.key < b.key ? -1 : 1));
}

/** Each carried item as a citable fact: `carry.<key>`, plus `carry.open_count`. */
export function carryMetrics(items: CarryItem[]): MetricSet {
  const out: MetricSet = {};
  for (const item of items) {
    const slug = item.key.replace(':', '.');
    const worked = item.lastWorked ? formatDay(new Date(item.lastWorked.start)) : null;
    const raised = item.timesRaised > 0 ? `; raised in ${item.timesRaised} earlier reflection${item.timesRaised === 1 ? '' : 's'}` : '';
    const display =
      item.status === 'open'
        ? `still open — no work on it for ${item.idleTrackedDays} tracked day${item.idleTrackedDays === 1 ? '' : 's'}${worked ? `, last worked ${worked}` : ''}${raised}`
        : item.status === 'progressing'
          ? `picked up again${worked ? ` on ${worked}` : ''}${raised}`
          : `closed — ${STATUS_WORDS[item.status]}`;
    out[`carry.${slug}`] = {
      key: `carry.${slug}`,
      label: `Carried work — “${item.title}”`,
      value: item.status,
      unit: 'text',
      display,
      group: 'history',
      ...(item.lastWorked ? { range: item.lastWorked } : {}),
      ...(item.priorityId ? { priorityId: item.priorityId } : {}),
      ...(item.thread ? { thread: item.thread } : {}),
    };
  }
  const open = items.filter((i) => i.status === 'open').length;
  if (items.length > 0) {
    out['carry.open_count'] = { key: 'carry.open_count', label: 'Work still open from earlier periods', value: open, unit: 'count', display: String(open), group: 'history' };
  }
  return out;
}

// ── Coverage: missing is missing ────────────────────────────────────────────

/**
 * Which days of the period were observed at all. A day without tracked
 * activity is reported as unobserved — never read as a day of no work.
 */
export function coverageOf(period: ReflectionPeriod, days: DayFacts[], coveredUntil: string, dayList: Pick<ReflectionPeriod, 'key' | 'start' | 'end'>[]): { metrics: MetricSet; notes: string[] } {
  const elapsed = dayList.filter((d) => d.start < coveredUntil);
  if (period.type === 'day' || elapsed.length === 0) return { metrics: {}, notes: [] };
  const observed = new Set(days.filter(isTrackedDay).map((d) => d.key));
  const missing = elapsed.filter((d) => !observed.has(d.key));
  const metrics: MetricSet = {
    'coverage.tracked_days': {
      key: 'coverage.tracked_days',
      label: `Days of this ${period.type} with tracked activity`,
      value: elapsed.length - missing.length,
      unit: 'count',
      display: `${elapsed.length - missing.length} of ${elapsed.length}`,
      group: 'history',
    },
  };
  if (missing.length === 0) return { metrics, notes: [] };
  const named = missing.length <= 4 ? missing.map((d) => formatDay(new Date(d.start))).join(', ') : `${missing.length} of its ${elapsed.length} days`;
  return {
    metrics,
    notes: [`Nothing was recorded on ${named}. Those days are unobserved — missing data, not idle time. Do not describe them as days without work.`],
  };
}

// ── Fingerprints ────────────────────────────────────────────────────────────

/** Short stable fingerprint of a JSON-serializable value (FNV-1a). */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
