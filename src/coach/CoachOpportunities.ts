import { threadSlug } from '../reflection/ReflectionActivities.js';
import { formatMinutes } from '../reflection/ReflectionMetrics.js';
import {
  MEANINGFUL_ACTIVITY_MINUTES,
  SUSTAINED_ACTIVITY_MINUTES,
  type Metric,
  type MetricSet,
  type ReflectionActivity,
  type ReflectionPriority,
} from '../reflection/ReflectionModels.js';
import { formatClock } from '../reflection/ReflectionPeriods.js';
import type { CoachActionType, CoachMemory } from './CoachModels.js';

/**
 * Where could a next move come from? Pure.
 *
 * "Nothing is wrong" and "there is no useful next step" are different
 * statements, and a day that looks steady in its totals can still hold an
 * obvious next move: the thing that was being built when the day ended, the
 * priority that got no time for the third day running, the block that keeps
 * breaking up. Left to find those in ninety metrics, a model reports the
 * totals and concludes that nothing needs changing.
 *
 * This module reads the day's deterministic dataset and names those places —
 * as SIGNALS, never as decisions. Each one carries the measurements it rests
 * on, so an action built on it is traceable, and each can be ignored: the
 * Coach still decides whether any of them deserves an action, and a day with
 * no signal is a day on which silence is the expected answer.
 */

export type OpportunityKind =
  /** A priority's work was under way when the day ended — where it stopped. */
  | 'left_off'
  /** A stated priority got far less time than is usual for this user, or none for days. */
  | 'displaced_priority'
  /** A priority has been worked on steadily, today and on most recent days. */
  | 'momentum'
  /** Switching well above this user's own norm. */
  | 'fragmentation'
  /** Several long days in a row — rest may be supported. */
  | 'sustained_load'
  /** Most of the day is linked to no stated priority. */
  | 'unlinked_time'
  /** Something the USER said was left hanging (never the Coach's own earlier inference). */
  | 'open_loop';

export interface CoachOpportunity {
  kind: OpportunityKind;
  /** How clearly the measurements show it. */
  strength: 'clear' | 'possible';
  priorityId: string | null;
  thread: string | null;
  /** One plain sentence; every number in it comes from `metricKeys`. */
  summary: string;
  metricKeys: string[];
  activityIds: string[];
  /** Action types that would be a sensible answer — a hint, not a rule. */
  fits: CoachActionType[];
}

/**
 * Where a piece of work stood when it was last touched, read from how Reflect
 * itself described the activity. A hint only, and deliberately strict about
 * what counts as open:
 *
 *   open            the description itself says it is unfinished — a failing
 *                   test, a draft, something being debugged, blocked or waiting
 *   stopping_point  it says the work was sent, submitted, merged, deployed…
 *   unknown         an ordinary activity verb ("developing", "studying",
 *                   "reviewing") says what was done, not whether it is done
 */
export type WorkState = 'open' | 'stopping_point' | 'unknown';

const STOPPING_POINT =
  /\b(sen[td]|sending|submi(t|tted|tting|ssion)|deploy(ed|ing|ment)?|releas(e|ed|ing)|ship(ped|ping)|merg(e|ed|ing)|publish(ed|ing)?|deliver(ed|ing|y)|finish(ed|ing)|complet(ed|ing|ion)|finali[sz](ed|ing)|clos(ed|ing)|resolv(ed|ing)|invoic(ed|ing)|approved|accepted|launch(ed|ing)|wrapp(ed|ing) up|signed off|hand(ed)?[- ]?off)\b/i;
const EXPLICITLY_OPEN =
  /\b(draft(s|ing|ed)?|debug\w*|troubleshoot\w*|investigat\w+|diagnos\w+|fail(s|ed|ing|ure)?|error(s)?|broken|bug(s)?|in progress|unfinished|incomplete|not (yet )?(finished|submitted|sent|done|complete|resolved)|still (open|failing|pending|under way|unresolved)|pending|blocked|waiting (on|for)|awaiting|to be continued|partway|part-way|halfway|half-done|remaining|left (open|unfinished)|work in progress|wip|todo|unresolved|unsent|overdue|due (today|tomorrow))\b/i;

export function workStateOf(activity: Pick<ReflectionActivity, 'title' | 'summary'>): WorkState {
  const summary = activity.summary ?? '';
  // What the summary says about how it ended outranks the title's verb.
  if (EXPLICITLY_OPEN.test(summary)) return 'open';
  if (STOPPING_POINT.test(activity.title) || STOPPING_POINT.test(summary)) return EXPLICITLY_OPEN.test(activity.title) && !STOPPING_POINT.test(summary) ? 'open' : 'stopping_point';
  return EXPLICITLY_OPEN.test(activity.title) ? 'open' : 'unknown';
}

export interface OpportunityInput {
  activities: ReflectionActivity[];
  metrics: MetricSet;
  /** Priorities that applied on the day. */
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  /** Active coach memory. Only open loops the user stated become signals. */
  memories: Pick<CoachMemory, 'kind' | 'text' | 'targetKey' | 'createdAt' | 'source'>[];
  /** Open loops older than this instant are no longer raised (they stay in memory). */
  openLoopsSince?: string;
  /**
   * For a priority with no work today: the last tracked activity linked to it
   * on its most recent earlier day. Lets "displaced" be told apart from "done".
   */
  lastKnown?: Record<string, { title: string; summary: string | null; dayLabel: string }>;
}

/** Thresholds, in one place. Relative to the user's own norm wherever a norm exists. */
export const OPPORTUNITY_RULES = {
  /** Below this a priority "got no real time" today. */
  untouchedMinutes: 15,
  /** A priority seen on at least this many recent days is one the user is actively working. */
  activeRecentDays: 2,
  /** A stated priority present on at most this fraction of the recent days has gone quiet. */
  quietShareOfRecentDays: 1 / 3,
  /** Today's share at or below this fraction of the user's own average share counts as displaced. */
  displacedShareRatio: 0.5,
  /** …but only for a priority that normally gets at least this share. */
  displacedMinBaselineShare: 15,
  /** Not enough tracked time to say anything about shares. */
  minTrackedMinutes: 90,
  /** Momentum: this much linked time today, on a priority present on most recent days. */
  momentumMinutes: 60,
  momentumRecentDays: 3,
  /** Fragmentation: switches per hour, absolute floor and multiple of the user's baseline. */
  fragmentedPerHour: 2,
  fragmentedBaselineRatio: 1.5,
  /** Sustained load: a day this long, on this many of the recent days. */
  longDayMinutes: 9.5 * 60,
  longDays: 3,
  /** Unlinked time: share of the day linked to no stated priority. */
  unlinkedShare: 0.6,
  maxSignals: 6,
} as const;

const numberOf = (metric: Metric | undefined): number | null => (metric && typeof metric.value === 'number' ? metric.value : null);

/**
 * The signals of one day, most useful first. Deterministic: the same dataset
 * always yields the same list.
 */
export function detectOpportunities(input: OpportunityInput): CoachOpportunity[] {
  const { metrics, priorities } = input;
  const rules = OPPORTUNITY_RULES;
  const out: CoachOpportunity[] = [];
  const tracked = numberOf(metrics['time.tracked_minutes']) ?? 0;
  const recentActive = numberOf(metrics['recent.active_days']) ?? 0;
  const meaningful = input.activities.filter((a) => a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES);

  for (const p of priorities) {
    const minutesKey = `priority.${p.id}.minutes`;
    const today = numberOf(metrics[minutesKey]) ?? 0;
    const share = numberOf(metrics[`priority.${p.id}.share`]);
    const baselineShare = numberOf(metrics[`baseline.priority.${p.id}.share`]);
    const recentDaysKey = `recent.priority.${p.id}.active_days`;
    const recentDays = numberOf(metrics[recentDaysKey]);
    const lastDay = metrics[`recent.priority.${p.id}.last_day`];
    const linked = meaningful.filter((a) => a.priorityId === p.id).sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1));

    // ── Displaced: an actively worked priority that got no real time today, or far less than its own norm ──
    if (tracked >= rules.minTrackedMinutes) {
      const lastKnown = input.lastKnown?.[p.id] ?? null;
      const lastState = lastKnown ? workStateOf(lastKnown) : 'unknown';
      const untouched = today < rules.untouchedMinutes;
      const quiet = recentDays !== null && recentActive >= rules.momentumRecentDays && recentDays <= Math.floor(recentActive * rules.quietShareOfRecentDays);
      if (untouched && recentDays !== null && (recentDays >= 1 || quiet)) {
        // No time today for a stated priority that was being worked on. Three readings:
        //   finished  its last work ended on "submitted" / "deployed" — it may simply be done
        //   clear     it was left unfinished, or it has now been absent for days
        //   possible  one day without it, and nothing says where it stood
        const finished = lastState === 'stopping_point' && !quiet;
        const clear = !finished && (lastState === 'open' || recentDays >= rules.activeRecentDays || quiet);
        out.push({
          kind: 'displaced_priority',
          strength: clear ? 'clear' : 'possible',
          priorityId: p.id,
          thread: null,
          summary:
            `“${p.text}” got ${today >= 1 ? formatMinutes(today) : 'no linked time'} today; it was worked on ${metrics[recentDaysKey].display} recent days` +
            `${lastDay ? ` (last on ${lastDay.display})` : ''}.` +
            (lastKnown
              ? finished
                ? ` Its last tracked work, “${lastKnown.title}”, reads as finished — it may simply be done; only the user can say.`
                : lastState === 'open'
                  ? ` It was left unfinished at “${lastKnown.title}”.`
                  : ` It last stood at “${lastKnown.title}”.`
              : '') +
            (quiet ? ' A stated priority that has been absent this long is worth one decision: protect a block for it, or say it is no longer current.' : ''),
          metricKeys: [...(metrics[minutesKey] ? [minutesKey] : []), recentDaysKey, ...(lastDay ? [lastDay.key] : []), 'time.tracked_minutes'],
          activityIds: [],
          fits: finished ? ['clarify_priority'] : quiet && lastState !== 'open' ? ['clarify_priority', 'protect_priority', 'focus_session'] : ['protect_priority', 'focus_session', 'clarify_priority'],
        });
      } else if (
        share !== null &&
        baselineShare !== null &&
        baselineShare >= rules.displacedMinBaselineShare &&
        share <= baselineShare * rules.displacedShareRatio
      ) {
        out.push({
          kind: 'displaced_priority',
          strength: 'possible',
          priorityId: p.id,
          thread: null,
          summary: `“${p.text}” took ${metrics[`priority.${p.id}.share`].display} of today's tracked time; its own recent average is ${metrics[`baseline.priority.${p.id}.share`].display}.`,
          metricKeys: [`priority.${p.id}.share`, `baseline.priority.${p.id}.share`, minutesKey],
          activityIds: linked.slice(-2).map((a) => a.id),
          fits: ['protect_priority', 'focus_session', 'change_timing'],
        });
      }
    }

    // ── Left off: where this priority's work stood when the day ended ──
    // Only raised when that last piece of work does not read as finished: a
    // priority whose day ended on "deployed" or "sent" has no loose end here.
    const last = linked[linked.length - 1];
    const state = last ? workStateOf(last) : 'unknown';
    if (last && today >= rules.untouchedMinutes && state !== 'stopping_point') {
      const thread = last.thread;
      const sessionsKey = `priority.${p.id}.sessions`;
      out.push({
        kind: 'left_off',
        strength: state === 'open' && last.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES ? 'clear' : 'possible',
        priorityId: p.id,
        thread,
        summary:
          `Work toward “${p.text}” (${metrics[minutesKey].display} today) last stood at “${last.title}”, which ended at ${formatClock(last.endedAt)}` +
          (state === 'open'
            ? '; its description says it was not finished.'
            : '. Nothing says whether it was finished: on its own this is ordinary ongoing work, not a loose end.'),
        metricKeys: [minutesKey, ...(metrics[sessionsKey] ? [sessionsKey] : [])],
        activityIds: [last.id],
        fits: ['close_open_loop', 'focus_session', 'continue_behavior'],
      });
    }

    // ── Momentum: steady, sustained work — worth protecting, not fixing ──
    if (
      today >= rules.momentumMinutes &&
      recentDays !== null &&
      recentDays >= rules.momentumRecentDays &&
      linked.some((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES)
    ) {
      out.push({
        kind: 'momentum',
        strength: 'possible',
        priorityId: p.id,
        thread: null,
        summary:
          `“${p.text}” had ${metrics[minutesKey].display} today and was worked on ${metrics[recentDaysKey].display} recent days. ` +
          `Steady work needs no advice by itself: this is only worth an action if something specific would protect or finish it.`,
        metricKeys: [minutesKey, recentDaysKey],
        activityIds: linked.filter((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES).slice(-2).map((a) => a.id),
        fits: ['continue_behavior', 'protect_priority'],
      });
    }
  }

  // ── Fragmentation, against the user's own norm ──
  const perHour = numberOf(metrics['behavior.switches_per_hour']);
  const basePerHour = numberOf(metrics['baseline.behavior.switches_per_hour']);
  if (
    perHour !== null &&
    tracked >= rules.minTrackedMinutes &&
    perHour >= rules.fragmentedPerHour &&
    (basePerHour === null || perHour >= basePerHour * rules.fragmentedBaselineRatio)
  ) {
    const worst = (['morning', 'afternoon', 'evening'] as const)
      .map((part) => ({ part, key: `daypart.${part}.switches`, switches: numberOf(metrics[`daypart.${part}.switches`]) ?? 0 }))
      .sort((a, b) => b.switches - a.switches)[0];
    out.push({
      kind: 'fragmentation',
      strength: basePerHour !== null ? 'clear' : 'possible',
      priorityId: null,
      thread: null,
      summary:
        `Today had ${metrics['behavior.switches_per_hour'].display} context switches` +
        (basePerHour !== null ? `; this user's recent average is ${metrics['baseline.behavior.switches_per_hour'].display}` : '') +
        (worst.switches > 0 ? `. The ${worst.part} had the most (${metrics[worst.key].display}).` : '.'),
      metricKeys: [
        'behavior.switches_per_hour',
        ...(basePerHour !== null ? ['baseline.behavior.switches_per_hour'] : []),
        ...(worst.switches > 0 ? [worst.key] : []),
      ],
      activityIds: [],
      fits: ['reduce_fragmentation', 'change_timing', 'focus_session'],
    });
  }

  // ── Sustained load: rest is only "supported" when the record shows long days in a row ──
  const longDayKeys = Object.keys(metrics).filter(
    (key) => /^recent\.\d{4}-\d{2}-\d{2}\.tracked_minutes$/.test(key) && (numberOf(metrics[key]) ?? 0) >= rules.longDayMinutes,
  );
  if (tracked >= rules.longDayMinutes && longDayKeys.length >= rules.longDays) {
    out.push({
      kind: 'sustained_load',
      strength: 'possible',
      priorityId: null,
      thread: null,
      summary: `Today's tracked time was ${metrics['time.tracked_minutes'].display}, and ${longDayKeys.length} of the recent days were as long.`,
      metricKeys: ['time.tracked_minutes', ...longDayKeys.sort().reverse().slice(0, 3)],
      activityIds: [],
      fits: ['rest'],
    });
  }

  // ── Unlinked time: most of the day served none of the stated priorities ──
  const unlinked = numberOf(metrics['priority.unlinked_minutes']);
  if (priorities.length > 0 && unlinked !== null && tracked >= rules.minTrackedMinutes && unlinked / tracked >= rules.unlinkedShare) {
    out.push({
      kind: 'unlinked_time',
      strength: 'possible',
      priorityId: null,
      thread: null,
      summary: `${metrics['priority.unlinked_minutes'].display} of ${metrics['time.tracked_minutes'].display} tracked today is linked to none of the stated priorities. That may be deliberate (rest, other duties) or a sign the priorities are out of date — Reflect cannot tell which.`,
      metricKeys: ['priority.unlinked_minutes', 'time.tracked_minutes'],
      activityIds: [],
      fits: ['clarify_priority'],
    });
  }

  // ── Open loops the user told Reflect about ──
  // What the Coach itself remembered is context (COACH MEMORY), not a
  // measurement: raising it here would let yesterday's guess argue for today's action.
  for (const memory of input.memories
    .filter((m) => m.kind === 'open_loop' && m.source === 'user' && (!input.openLoopsSince || m.createdAt >= input.openLoopsSince))
    .slice(0, 3)) {
    const priorityId = memory.targetKey?.startsWith('p:') ? memory.targetKey.slice(2) : null;
    out.push({
      kind: 'open_loop',
      strength: 'possible',
      priorityId: priorityId && priorities.some((p) => p.id === priorityId) ? priorityId : null,
      thread: null,
      summary: `The user said this was left open: “${memory.text}”. Check today's activities for whether it moved.`,
      metricKeys: [],
      activityIds: [],
      fits: ['close_open_loop', 'drop'],
    });
  }

  // Clear signals first; within a strength, what is unfinished or displaced before what is merely going well.
  const order: OpportunityKind[] = ['displaced_priority', 'left_off', 'open_loop', 'fragmentation', 'momentum', 'sustained_load', 'unlinked_time'];
  return out
    .sort((a, b) => Number(b.strength === 'clear') - Number(a.strength === 'clear') || order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, rules.maxSignals);
}

/** The signals as the model reads them. `refOf` turns an activity id into the alias used under ACTIVITIES. */
export function renderOpportunities(signals: CoachOpportunity[], refOf: (activityId: string) => string | null): string {
  if (signals.length === 0) {
    return (
      'NEXT-MOVE SIGNALS (measured by Reflect)\n' +
      'None measured today: no stated priority was visibly left unfinished or displaced, and switching was within this user\'s norm. ' +
      'Unless the evidence above shows a concrete next move some other way (a deadline, a failing check, something waiting on someone), the right answer is no action.'
    );
  }
  const lines = signals.map((s) =>
    JSON.stringify({
      signal: s.kind,
      strength: s.strength,
      ...(s.priorityId ? { priorityId: s.priorityId } : {}),
      ...(s.thread ? { thread: s.thread } : {}),
      what: s.summary,
      cite: {
        metricKeys: s.metricKeys,
        activityRefs: s.activityIds.map(refOf).filter((ref): ref is string => ref !== null),
      },
      fits: s.fits,
    }),
  );
  return (
    'NEXT-MOVE SIGNALS (measured by Reflect from today and the days before it)\n' +
    'Each line is a place where a concrete next move MAY exist — a candidate to weigh, not an instruction. ' +
    'A "clear" signal is a measured loose end or displacement. A "possible" signal on its own is weak — ordinary ongoing work is not a reason to say "continue": ' +
    'act on it only when the activities show something specific that is unfinished, due, at risk or waiting. When every signal is "possible" and nothing specific is open, the answer is no action. ' +
    'An action that answers one should cite that signal\'s metricKeys / activityRefs.\n' +
    lines.join('\n')
  );
}

/** A thread name the day's evidence knows, for a signal that names one. */
export function threadOfSignal(signal: CoachOpportunity, knownThreads: string[]): string | null {
  if (!signal.thread) return null;
  const slug = threadSlug(signal.thread);
  return knownThreads.find((t) => threadSlug(t) === slug) ?? null;
}
