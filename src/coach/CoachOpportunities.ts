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
import type { CoachAction, CoachActionType, CoachMemory } from './CoachModels.js';
import type { PrioritySituation } from './CoachSituation.js';

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
 * as EVIDENCE, never as decisions. Each signal says what was measured, how
 * clearly, what it is about and what to cite for it. None of them says what to
 * do, none is ranked by importance, and every one can be ignored: the Coach
 * still decides whether any of them deserves an action, and a day with no
 * signal is a day on which silence is the expected answer.
 */

export type OpportunityKind =
  /** A priority's work was under way when the day ended — where it stopped. */
  | 'left_off'
  /** The same piece of work has ended the day unfinished several days in a row. */
  | 'carried_over'
  /** A stated priority got far less time than is usual for this user, or none for days. */
  | 'displaced_priority'
  /** A priority has been worked on steadily, today and on most recent days. */
  | 'momentum'
  /** Switching well above this user's own norm, or two pieces of work interleaved over the same stretch. */
  | 'fragmentation'
  /** Several long days in a row — rest may be supported. */
  | 'sustained_load'
  /** Most of the day is linked to no stated priority. */
  | 'unlinked_time'
  /** Something the USER said was left hanging (never the Coach's own earlier inference). */
  | 'open_loop'
  /** An earlier suggestion has just been settled: it helped, partly helped, did not help, or could not happen. */
  | 'tried_before';

export interface CoachOpportunity {
  kind: OpportunityKind;
  /** How clearly the measurements show it. */
  strength: 'clear' | 'possible';
  /** The same thing as a number (0–1): how clearly the evidence shows the thing itself — never how important it is. */
  confidence: number;
  priorityId: string | null;
  thread: string | null;
  /** One plain statement of what was measured; every number in it comes from `metricKeys`. */
  summary: string;
  metricKeys: string[];
  activityIds: string[];
  /** Aliases of earlier actions this signal rests on (`tried_before`). */
  actionRefs?: string[];
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
  /\b(sen[td]|sending|submi(t|tted|tting|ssion)|deploy(ed|ing|ment)?|releas(e|ed|ing)|ship(ped|ping)|merg(e|ed|ing)|publish(ed|ing)?|deliver(ed|ing|y)|finish(ed|ing)|complet(ed|ing|ion)|finali[sz](ed|ing)|clos(ed|ing)|resolv(ed|ing)|invoiced|approved|accepted|launch(ed|ing)|wrapp(ed|ing) up|signed off|hand(ed)?[- ]?off)\b/i;
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
  /** Where each priority stands across the recent days — lets one unusual day be told from a recurring pattern. */
  situations?: PrioritySituation[];
}

/** Thresholds, in one place. Relative to the user's own norm wherever a norm exists. */
export const OPPORTUNITY_RULES = {
  /** Below this a priority "got no real time" today. */
  untouchedMinutes: 15,
  /** A stated priority present on at most this fraction of the recent days has gone quiet. */
  quietShareOfRecentDays: 1 / 3,
  /** Displacement on this many tracked days in a row is a pattern, not a circumstance. */
  recurringDays: 2,
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
  /** Interleaving: two activities sharing at least this long a stretch, each active for at most this share of its own span. */
  interleavedOverlapMinutes: 45,
  interleavedActiveShare: 0.75,
  /** Sustained load: a day this long, on this many of the recent days. */
  longDayMinutes: 9.5 * 60,
  longDays: 3,
  /** Unlinked time: share of the day linked to no stated priority. */
  unlinkedShare: 0.6,
  maxSignals: 7,
} as const;

const numberOf = (metric: Metric | undefined): number | null => (metric && typeof metric.value === 'number' ? metric.value : null);

/**
 * The signals of one day. Deterministic: the same dataset always yields the
 * same list. Ordered by how clearly each is measured, with every priority's
 * clearest signal ahead of any priority's second — so that no priority drops
 * off the list merely because another one produced more lines.
 */
export function detectOpportunities(input: OpportunityInput): CoachOpportunity[] {
  const { metrics, priorities } = input;
  const rules = OPPORTUNITY_RULES;
  const out: CoachOpportunity[] = [];
  const tracked = numberOf(metrics['time.tracked_minutes']) ?? 0;
  const recentActive = numberOf(metrics['recent.active_days']) ?? 0;
  const meaningful = input.activities.filter((a) => a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES);
  const situationOf = (priorityId: string) => input.situations?.find((s) => s.priorityId === priorityId) ?? null;

  for (const p of priorities) {
    const minutesKey = `priority.${p.id}.minutes`;
    const today = numberOf(metrics[minutesKey]) ?? 0;
    const share = numberOf(metrics[`priority.${p.id}.share`]);
    const baselineShare = numberOf(metrics[`baseline.priority.${p.id}.share`]);
    const recentDaysKey = `recent.priority.${p.id}.active_days`;
    const recentDays = numberOf(metrics[recentDaysKey]);
    const lastDay = metrics[`recent.priority.${p.id}.last_day`];
    const linked = meaningful.filter((a) => a.priorityId === p.id).sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1));
    const situation = situationOf(p.id);

    // ── Displaced: an actively worked priority that got no real time today, or far less than its own norm ──
    if (tracked >= rules.minTrackedMinutes) {
      const lastKnown = input.lastKnown?.[p.id] ?? null;
      const lastState = lastKnown ? workStateOf(lastKnown) : 'unknown';
      const untouched = today < rules.untouchedMinutes;
      const quiet = recentDays !== null && recentActive >= rules.momentumRecentDays && recentDays <= Math.floor(recentActive * rules.quietShareOfRecentDays);
      const streak = situation?.untouchedStreak ?? (untouched ? 1 : 0);
      if (untouched && recentDays !== null && (recentDays >= 1 || quiet)) {
        // No time today for a stated priority that was being worked on. Four readings:
        //   finished   its last work ended on "submitted" / "deployed" — it may simply be done
        //   recurring  no time on several tracked days in a row, or absent from most of the recent days
        //   left open  one day without it, but it is known to have been left unfinished
        //   one-off    one day without it and nothing says where it stood — a circumstance, not a pattern
        const recurring = streak >= rules.recurringDays || quiet;
        // Finished work going quiet is completion, however many days it lasts.
        const finished = lastState === 'stopping_point';
        const clear = !finished && (recurring || lastState === 'open');
        out.push({
          kind: 'displaced_priority',
          strength: clear ? 'clear' : 'possible',
          confidence: finished ? 0.3 : recurring ? Math.min(0.95, 0.75 + 0.05 * streak) : lastState === 'open' ? 0.7 : 0.45,
          priorityId: p.id,
          thread: null,
          summary:
            `“${p.text}” got ${today >= 1 ? formatMinutes(today) : 'no linked time'} today; it was worked on ${metrics[recentDaysKey].display} recent days` +
            `${lastDay ? ` (last on ${lastDay.display})` : ''}.` +
            (finished ? '' : streak >= rules.recurringDays ? ` That is ${streak} tracked days in a row without it.` : !quiet ? ' That is one day so far.' : '') +
            (lastKnown
              ? finished
                ? ` Its last tracked work, “${lastKnown.title}”, reads as finished — it may simply be done; only the user can say.`
                : lastState === 'open'
                  ? ` It was left unfinished at “${lastKnown.title}”.`
                  : ` It last stood at “${lastKnown.title}”.`
              : '') +
            (quiet && !finished ? ' It has been absent from most of the recent days: either it needs a protected block, or it is no longer current — only the user can say which.' : ''),
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
          confidence: 0.5,
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
      const clear = state === 'open' && last.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES;
      out.push({
        kind: 'left_off',
        strength: clear ? 'clear' : 'possible',
        confidence: clear ? 0.75 : 0.4,
        priorityId: p.id,
        thread,
        summary:
          `Work toward “${p.text}” (${metrics[minutesKey].display} today) last stood at “${last.title}”, which ended at ${formatClock(last.endedAt)}` +
          (state === 'open' ? '; its description says it was not finished.' : '. Nothing states whether it was finished.'),
        metricKeys: [minutesKey, ...(metrics[sessionsKey] ? [sessionsKey] : [])],
        activityIds: [last.id],
        fits: ['close_open_loop', 'focus_session', 'continue_behavior'],
      });
    }

    // ── Carried over: the same piece of work ending the day unfinished, day after day ──
    if (situation?.carriedOver && today >= rules.untouchedMinutes) {
      const { days, item, activityId } = situation.carriedOver;
      out.push({
        kind: 'carried_over',
        // Days of the same item with nothing saying it is unfinished can be ordinary multi-day work.
        strength: state === 'open' ? 'clear' : 'possible',
        confidence: state === 'open' ? Math.min(0.9, 0.6 + 0.1 * days) : Math.min(0.6, 0.35 + 0.05 * days),
        priorityId: p.id,
        thread: last?.thread ?? null,
        summary: `“${item}” has been the last work toward “${p.text}” on ${days} tracked days in a row without reading as finished.`,
        metricKeys: [minutesKey],
        activityIds: [activityId],
        fits: ['close_open_loop', 'focus_session', 'change_approach'],
      });
    }

    // ── Momentum: steady, sustained work ──
    if (
      today >= rules.momentumMinutes &&
      recentDays !== null &&
      recentDays >= rules.momentumRecentDays &&
      linked.some((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES)
    ) {
      out.push({
        kind: 'momentum',
        strength: 'possible',
        confidence: 0.35,
        priorityId: p.id,
        thread: null,
        summary: `“${p.text}” had ${metrics[minutesKey].display} today and was worked on ${metrics[recentDaysKey].display} recent days.`,
        metricKeys: [minutesKey, recentDaysKey],
        activityIds: linked.filter((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES).slice(-2).map((a) => a.id),
        fits: ['continue_behavior', 'protect_priority'],
      });
    }
  }

  // ── Fragmentation, against the user's own norm ──
  const perHour = numberOf(metrics['behavior.switches_per_hour']);
  const basePerHour = numberOf(metrics['baseline.behavior.switches_per_hour']);
  const switching =
    perHour !== null &&
    tracked >= rules.minTrackedMinutes &&
    perHour >= rules.fragmentedPerHour &&
    (basePerHour === null || perHour >= basePerHour * rules.fragmentedBaselineRatio);
  if (switching) {
    const worst = (['morning', 'afternoon', 'evening'] as const)
      .map((part) => ({ part, key: `daypart.${part}.switches`, switches: numberOf(metrics[`daypart.${part}.switches`]) ?? 0 }))
      .sort((a, b) => b.switches - a.switches)[0];
    out.push({
      kind: 'fragmentation',
      strength: basePerHour !== null ? 'clear' : 'possible',
      confidence: basePerHour !== null ? 0.8 : 0.5,
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

  // ── Interleaving: two pieces of work sharing one stretch ──
  // When small pieces were merged into a few long activities, the switch count
  // no longer shows the breaking-up — but the activities still do: each one's
  // span is much longer than the time actually spent in it, and the spans overlap.
  if (!switching) {
    const spanMinutes = (a: ReflectionActivity) => (Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 60_000;
    const stretched = meaningful
      .filter((a) => a.durationMinutes >= SUSTAINED_ACTIVITY_MINUTES && a.durationMinutes <= spanMinutes(a) * rules.interleavedActiveShare)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    let pair: [ReflectionActivity, ReflectionActivity] | null = null;
    for (let i = 0; i < stretched.length && !pair; i++) {
      for (let j = i + 1; j < stretched.length; j++) {
        const overlap = (Math.min(Date.parse(stretched[i].endedAt), Date.parse(stretched[j].endedAt)) - Math.max(Date.parse(stretched[i].startedAt), Date.parse(stretched[j].startedAt))) / 60_000;
        const different = (stretched[i].thread ?? stretched[i].title) !== (stretched[j].thread ?? stretched[j].title);
        if (different && overlap >= rules.interleavedOverlapMinutes) {
          pair = [stretched[i], stretched[j]];
          break;
        }
      }
    }
    if (pair) {
      const [a, b] = pair;
      out.push({
        kind: 'fragmentation',
        strength: 'possible',
        confidence: 0.55,
        priorityId: null,
        thread: null,
        summary:
          `“${a.title}” (${formatClock(a.startedAt)}–${formatClock(a.endedAt)}) and “${b.title}” (${formatClock(b.startedAt)}–${formatClock(b.endedAt)}) ran over the same stretch: ` +
          'the two were interleaved, so neither had that time to itself. How finely it broke up is not recorded.',
        metricKeys: [],
        activityIds: [a.id, b.id],
        fits: ['reduce_fragmentation', 'protect_priority', 'focus_session'],
      });
    }
  }

  // ── Sustained load: rest is only "supported" when the record shows long days in a row ──
  const longDayKeys = Object.keys(metrics).filter(
    (key) => /^recent\.\d{4}-\d{2}-\d{2}\.tracked_minutes$/.test(key) && (numberOf(metrics[key]) ?? 0) >= rules.longDayMinutes,
  );
  if (tracked >= rules.longDayMinutes && longDayKeys.length >= rules.longDays) {
    out.push({
      kind: 'sustained_load',
      strength: 'possible',
      confidence: 0.5,
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
      confidence: 0.4,
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
      confidence: 0.6,
      priorityId: priorityId && priorities.some((p) => p.id === priorityId) ? priorityId : null,
      thread: null,
      summary: `The user said this was left open: “${memory.text}”. Check today's activities for whether it moved.`,
      metricKeys: [],
      activityIds: [],
      fits: ['close_open_loop', 'drop'],
    });
  }

  return orderSignals(out).slice(0, rules.maxSignals);
}

/**
 * Clearest first — but one signal per target before any target's second, so a
 * priority that produced three lines cannot push another priority's only line
 * off the list. Stable for equal confidence.
 */
export function orderSignals(signals: CoachOpportunity[]): CoachOpportunity[] {
  const ranked = signals
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => b.signal.confidence - a.signal.confidence || a.index - b.index)
    .map((x) => x.signal);
  const seen = new Map<string, number>();
  const round = (s: CoachOpportunity) => {
    const key = s.priorityId ?? `·${s.kind}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  };
  return ranked
    .map((signal, index) => ({ signal, index, round: round(signal) }))
    .sort((a, b) => a.round - b.round || a.index - b.index)
    .map((x) => x.signal);
}

/**
 * What the record of earlier suggestions says, as signals: an action that was
 * settled recently is evidence about what to try — or not to try — next.
 * Whether it was followed, and whether it helped, stay two separate facts; an
 * action that could not happen for an outside reason says nothing against it.
 */
export function outcomeSignals(
  followups: { ref: string; action: Pick<CoachAction, 'title' | 'targetKey' | 'status' | 'execution' | 'outcome' | 'reasonCode' | 'thread'> }[],
  reasonLabel: (code: NonNullable<CoachAction['reasonCode']>) => string,
): CoachOpportunity[] {
  const out: CoachOpportunity[] = [];
  for (const { ref, action } of followups) {
    if (action.status !== 'closed' && action.status !== 'review') continue;
    const base = {
      kind: 'tried_before' as const,
      priorityId: action.targetKey?.startsWith('p:') ? action.targetKey.slice(2) : null,
      thread: action.thread,
      metricKeys: [],
      activityIds: [],
      actionRefs: [ref],
    };
    const why = action.reasonCode ? ` (the reason given: ${reasonLabel(action.reasonCode)})` : '';
    if (action.outcome === 'did_not_work') {
      out.push({
        ...base,
        strength: 'clear',
        confidence: 0.8,
        summary: `“${action.title}” was tried and the user said it did not help${why}. The same thing again would repeat it; what it was aimed at may still be open.`,
        fits: ['change_timing', 'change_approach', 'experiment'],
      });
    } else if (action.execution === 'not_done' && action.reasonCode === 'external_constraint') {
      out.push({
        ...base,
        strength: 'clear',
        confidence: 0.7,
        summary: `“${action.title}” could not happen: something outside the user's control took the time. That says nothing against the action — what it was aimed at is where it was left.`,
        fits: ['protect_priority', 'focus_session', 'close_open_loop'],
      });
    } else if (action.execution === 'not_done') {
      out.push({
        ...base,
        strength: 'possible',
        confidence: 0.6,
        summary: `“${action.title}” was accepted and not carried out${why}. One miss is not a pattern.`,
        fits: ['change_timing', 'change_approach', 'focus_session'],
      });
    } else if (action.outcome === 'partly_worked') {
      out.push({
        ...base,
        strength: 'possible',
        confidence: 0.6,
        summary: `“${action.title}” was carried out and the user said it partly helped${why}.`,
        fits: ['change_timing', 'focus_session', 'change_approach'],
      });
    } else if (action.outcome === 'worked') {
      out.push({
        ...base,
        strength: 'possible',
        confidence: 0.5,
        summary: `“${action.title}” was carried out and the user said it helped. The approach is reusable; whether there is anything new to use it ON is a separate question that today's evidence answers.`,
        fits: ['continue_behavior', 'focus_session', 'close_open_loop'],
      });
    }
  }
  return out.slice(0, 3);
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
      confidence: s.confidence,
      ...(s.priorityId ? { priorityId: s.priorityId } : {}),
      ...(s.thread ? { thread: s.thread } : {}),
      what: s.summary,
      cite: {
        metricKeys: s.metricKeys,
        activityRefs: s.activityIds.map(refOf).filter((ref): ref is string => ref !== null),
        ...(s.actionRefs && s.actionRefs.length > 0 ? { actionRefs: s.actionRefs } : {}),
      },
      fits: s.fits,
    }),
  );
  return (
    'NEXT-MOVE SIGNALS (measured by Reflect from today and the days before it)\n' +
    'Each line is EVIDENCE of where a concrete next move may exist — a candidate to weigh, not an instruction, and not a ranking of what matters. ' +
    '"confidence" says how clearly the measurements show the thing itself (that work was left unfinished, that a priority went without time); it says nothing about importance. ' +
    'A left_off line that only says where work last stood, or a momentum line, is the weakest kind: it becomes a next move only when the trail in SITUATION BY PRIORITY shows a specific item with an obvious next stage — never as "continue X". ' +
    'An action that answers a signal should cite that signal\'s metricKeys / activityRefs / actionRefs.\n' +
    lines.join('\n')
  );
}

/** A thread name the day's evidence knows, for a signal that names one. */
export function threadOfSignal(signal: CoachOpportunity, knownThreads: string[]): string | null {
  if (!signal.thread) return null;
  const slug = threadSlug(signal.thread);
  return knownThreads.find((t) => threadSlug(t) === slug) ?? null;
}
