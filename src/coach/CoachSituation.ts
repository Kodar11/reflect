import { formatMinutes } from '../reflection/ReflectionMetrics.js';
import {
  MEANINGFUL_ACTIVITY_MINUTES,
  type Metric,
  type MetricSet,
  type ReflectionActivity,
  type ReflectionPriority,
} from '../reflection/ReflectionModels.js';
import { formatClock } from '../reflection/ReflectionPeriods.js';
import { itemTokensOf, sharedWords } from './CoachMatching.js';
import type { CoachAction } from './CoachModels.js';
import { workStateOf, type WorkState } from './CoachWorkState.js';

/**
 * Where each stated priority stands. Pure.
 *
 * A day's totals say how much time a priority got; they do not say what was
 * being done, where it stopped, whether the same thing was left unfinished
 * yesterday too, or whether the Coach has been talking about nothing else all
 * week. Asked to choose a next move from totals alone, a model picks whatever
 * is most conspicuous — the longest thread, the newest activity, the open loop
 * it has already mentioned five times.
 *
 * This module lays the priorities side by side — today's trail, the days before
 * it, how long it has gone without time, and what the Coach has already said
 * about it — so that the choice is made across ALL of them. It states evidence
 * only: nothing here ranks the priorities or recommends anything.
 */

/** One earlier day, as loaded for the situation board. */
export interface SituationDay {
  dayKey: string;
  dayLabel: string;
  activities: ReflectionActivity[];
}

export interface SituationTrailItem {
  activityId: string;
  title: string;
  minutes: number;
  endedAt: string;
}

/** One piece of work toward a priority on one day: every activity that names the same item, taken together. */
export interface SituationItem {
  /** The most recent activity of the item. */
  activityId: string;
  title: string;
  /** Minutes spent on it that day, over all its activities. */
  minutes: number;
  sessions: number;
  endedAt: string;
  /** How its most recent activity reads. */
  state: WorkState;
}

export interface SituationRecentDay {
  dayKey: string;
  dayLabel: string;
  minutes: number;
  /** Where the priority's work stood that day: its main piece of work, or the activity that finished it. */
  endedOn: string | null;
  state: WorkState | null;
}

export interface SituationCoachHistory {
  /** Suggestions aimed at this priority in the recent window, and across every target. */
  recentActions: number;
  ofTotal: number;
  /** Consecutive most-recent suggestion days that were about this priority. */
  daysRunning: number;
  last: { title: string; state: string } | null;
}

export interface PrioritySituation {
  priorityId: string;
  text: string;
  todayMinutes: number;
  /** Today's work linked to it, in order. */
  trail: SituationTrailItem[];
  /** How the last piece of today's work reads: left open, at a stopping point, or not stated. */
  lastState: WorkState | null;
  /**
   * Where today's work toward it stands: the piece that took most of the time
   * since its last finish — not merely whatever was touched last. Null when
   * nothing was linked to it today.
   */
  main: SituationItem | null;
  /** Earlier tracked days, most recent first. */
  recent: SituationRecentDay[];
  /** Tracked days in a row, ending today, on which it got no real time. */
  untouchedStreak: number;
  /**
   * Of those days, how many in a row (ending today) had most of their tracked
   * time linked to NONE of the stated priorities: the time did not go to
   * another thing the user said matters.
   */
  elsewhereStreak: number;
  /** The same piece of work ended the day unfinished on this many days in a row (today included). */
  carriedOver: { days: number; item: string; activityId: string; state: WorkState } | null;
  coach: SituationCoachHistory;
}

export interface SituationInput {
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  /** Today's activities. */
  activities: ReflectionActivity[];
  metrics: MetricSet;
  /** Earlier days, most recent first. Days with nothing tracked are skipped. */
  recentDays: SituationDay[];
  /** Coach actions of the recent window (any status). */
  actions: Pick<CoachAction, 'title' | 'targetKey' | 'status' | 'execution' | 'outcome' | 'originDayKey' | 'createdAt' | 'reasonCode'>[];
}

export const SITUATION_RULES = {
  /** Below this a priority "got no real time" on a day. */
  untouchedMinutes: 15,
  /** A day with less tracked time than this says nothing about displacement. */
  minTrackedMinutes: 90,
  /** Two day-ending titles naming the same specific thing: this share of the shorter one's item words in common. */
  sameItemShare: 0.5,
  /** A day on which at least this share of tracked time was linked to no stated priority went "elsewhere". */
  elsewhereShare: 0.6,
  maxTrail: 6,
  maxRecentDays: 4,
  /** Suggestions older than this many days are not counted as "recent". */
  coachWindowDays: 7,
} as const;

const numberOf = (metric: Metric | undefined): number | null => (metric && typeof metric.value === 'number' ? metric.value : null);

const meaningfulFor = (activities: ReflectionActivity[], priorityId: string): ReflectionActivity[] =>
  activities
    .filter((a) => a.priorityId === priorityId && a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)
    .sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

/**
 * Whether two activity titles name the same specific piece of work. Judged on
 * what each names BEYOND the priority or thread it belongs to: two days both
 * titled after the project are the same project, not the same unfinished item.
 */
export function sameItem(a: string, b: string, targetTexts: (string | null | undefined)[] = []): boolean {
  const [x, y] = [itemTokensOf({ title: a }, targetTexts), itemTokensOf({ title: b }, targetTexts)];
  if (x.size === 0 || y.size === 0) return false;
  const shared = sharedWords(x, y).length;
  return shared >= 1 && shared / Math.min(x.size, y.size) >= SITUATION_RULES.sameItemShare;
}

const sumMinutes = (activities: ReflectionActivity[]): number => activities.reduce((sum, a) => sum + a.durationMinutes, 0);

/**
 * Where a priority's work stood at the end of a day, given that day's
 * activities linked to it in order.
 *
 * The last thing touched is often not the work: twenty minutes on the roadmap
 * after two hours on the dashboard leave the DASHBOARD mid-way. So:
 *
 *   - a day that ended on a finish stands at that finish;
 *   - a day whose last activity says outright that it is unfinished stands there;
 *   - otherwise it stands at whichever piece took the most time since the
 *     day's last finish — activities naming the same item counted together.
 */
export function mainItem(linked: ReflectionActivity[], priorityText: string): SituationItem | null {
  const last = linked[linked.length - 1];
  if (!last) return null;
  const single = (a: ReflectionActivity, state: WorkState): SituationItem => ({ activityId: a.id, title: a.title, minutes: a.durationMinutes, sessions: 1, endedAt: a.endedAt, state });
  const lastState = workStateOf(last);
  if (lastState === 'stopping_point') return single(last, lastState);

  let from = 0;
  linked.forEach((a, index) => {
    if (workStateOf(a) === 'stopping_point') from = index + 1;
  });
  const groups: ReflectionActivity[][] = [];
  for (const a of linked.slice(from)) {
    const group = groups.find((g) => g[0].title === a.title || sameItem(g[0].title, a.title, [priorityText, a.thread, g[0].thread]));
    if (group) group.push(a);
    else groups.push([a]);
  }
  const describe = (group: ReflectionActivity[]): SituationItem => {
    const latest = group[group.length - 1];
    return { ...single(latest, workStateOf(latest)), minutes: sumMinutes(group), sessions: group.length };
  };
  if (lastState === 'open') return describe(groups.find((g) => g.includes(last))!);
  // The longest piece; between equals, the later one.
  return groups.map(describe).reduce((best, item) => (item.minutes >= best.minutes ? item : best));
}

/** Share of a day's tracked minutes linked to none of the stated priorities (0–1), or null for a day too thin to say. */
function shareElsewhere(activities: ReflectionActivity[], minTrackedMinutes: number): number | null {
  const tracked = sumMinutes(activities);
  if (tracked < minTrackedMinutes) return null;
  return sumMinutes(activities.filter((a) => a.priorityId === null)) / tracked;
}

/** How an earlier suggestion ended, in a few plain words. */
export function describeActionOutcome(action: Pick<CoachAction, 'status' | 'execution' | 'outcome' | 'reasonCode'>): string {
  if (action.status === 'rejected') return action.reasonCode === 'not_relevant' ? 'rejected as not relevant' : 'rejected';
  if (action.status === 'expired') return 'never decided';
  if (action.status === 'snoozed') return 'postponed';
  if (action.status === 'suggested') return 'not decided yet';
  if (action.status === 'withdrawn') return 'withdrawn';
  const did = action.execution === 'done' ? 'carried out' : action.execution === 'partial' ? 'partly carried out' : action.execution === 'not_done' ? 'not carried out' : 'accepted';
  const helped =
    action.outcome === 'worked'
      ? ', helped'
      : action.outcome === 'partly_worked'
        ? ', partly helped'
        : action.outcome === 'did_not_work'
          ? ', did not help'
          : action.execution === 'not_done' && action.reasonCode === 'external_constraint'
            ? ' (something outside the user\'s control took the time)'
            : '';
  return `${did}${helped}`;
}

/** One situation per stated priority, in the order the user stated them. */
export function buildSituations(input: SituationInput): PrioritySituation[] {
  const rules = SITUATION_RULES;
  const trackedToday = numberOf(input.metrics['time.tracked_minutes']) ?? sumMinutes(input.activities);
  const recentDays = input.recentDays.filter((d) => d.activities.length > 0).slice(0, rules.maxRecentDays);

  // Suggestions, newest first, grouped by the day they were made on.
  const suggestions = [...input.actions].filter((a) => a.status !== 'withdrawn').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const suggestionDays = [...new Set(suggestions.map((a) => a.originDayKey))].slice(0, rules.coachWindowDays);
  const inWindow = suggestions.filter((a) => suggestionDays.includes(a.originDayKey));

  return input.priorities.map((p) => {
    const today = meaningfulFor(input.activities, p.id);
    const todayMinutes = numberOf(input.metrics[`priority.${p.id}.minutes`]) ?? sumMinutes(today);
    const last = today[today.length - 1] ?? null;
    const lastState = last ? workStateOf(last) : null;
    const main = mainItem(today, p.text);

    const recent: SituationRecentDay[] = recentDays.map((day) => {
      const linked = meaningfulFor(day.activities, p.id);
      const end = mainItem(linked, p.text);
      return { dayKey: day.dayKey, dayLabel: day.dayLabel, minutes: Math.round(sumMinutes(linked)), endedOn: end?.title ?? null, state: end?.state ?? null };
    });

    // Days in a row without real time — counted only over days that were tracked at all.
    let untouchedStreak = 0;
    // …and, of those, the days on which the time went to nothing the user named.
    let elsewhereStreak = 0;
    if (trackedToday >= rules.minTrackedMinutes && todayMinutes < rules.untouchedMinutes) {
      untouchedStreak = 1;
      const unlinkedToday = numberOf(input.metrics['priority.unlinked_minutes']);
      const elsewhereToday = unlinkedToday !== null ? unlinkedToday / trackedToday : shareElsewhere(input.activities, rules.minTrackedMinutes);
      let elsewhereRuns = elsewhereToday !== null && elsewhereToday >= rules.elsewhereShare;
      if (elsewhereRuns) elsewhereStreak = 1;
      for (const day of recentDays) {
        if (sumMinutes(day.activities) < rules.minTrackedMinutes) continue;
        if (sumMinutes(meaningfulFor(day.activities, p.id)) >= rules.untouchedMinutes) break;
        untouchedStreak++;
        elsewhereRuns &&= (shareElsewhere(day.activities, rules.minTrackedMinutes) ?? 0) >= rules.elsewhereShare;
        if (elsewhereRuns) elsewhereStreak++;
      }
    }

    // The same piece of work ending the day unfinished, day after day.
    let carriedOver: PrioritySituation['carriedOver'] = null;
    if (main && main.state !== 'stopping_point') {
      let days = 1;
      for (const day of recent) {
        if (day.endedOn === null) continue; // a day without this priority does not break the run
        if (day.state === 'stopping_point' || !sameItem(day.endedOn, main.title, [p.text, last?.thread])) break;
        days++;
      }
      if (days >= 2) carriedOver = { days, item: main.title, activityId: main.activityId, state: main.state };
    }

    const mine = inWindow.filter((a) => a.targetKey === `p:${p.id}`);
    let daysRunning = 0;
    for (const dayKey of suggestionDays) {
      if (!inWindow.some((a) => a.originDayKey === dayKey && a.targetKey === `p:${p.id}`)) break;
      daysRunning++;
    }

    return {
      priorityId: p.id,
      text: p.text,
      todayMinutes,
      trail: today.slice(-rules.maxTrail).map((a) => ({ activityId: a.id, title: a.title, minutes: Math.round(a.durationMinutes), endedAt: a.endedAt })),
      lastState,
      main,
      recent,
      untouchedStreak,
      elsewhereStreak,
      carriedOver,
      coach: {
        recentActions: mine.length,
        ofTotal: inWindow.length,
        daysRunning,
        last: mine[0] ? { title: mine[0].title, state: describeActionOutcome(mine[0]) } : null,
      },
    };
  });
}

/**
 * The target, if any, that recent suggestions have concentrated on: most of
 * the last several suggestions, while another stated priority had none.
 */
export function concentratedTarget(situations: PrioritySituation[]): PrioritySituation | null {
  const total = situations[0]?.coach.ofTotal ?? 0;
  if (total < 3 || situations.length < 2) return null;
  const top = [...situations].sort((a, b) => b.coach.recentActions - a.coach.recentActions)[0];
  return top.coach.recentActions / total >= 0.6 ? top : null;
}

const STATE_WORDS: Record<WorkState, string> = {
  open: 'its description says it was not finished',
  underway: 'described as work in an early stage (drafting, debugging, investigating); nothing states how it ended',
  stopping_point: 'its description reads as finished or handed off',
  unknown: 'nothing states whether it was finished',
};

/** The board as the model reads it. `refOf` turns an activity id into the alias used under ACTIVITIES. */
export function renderSituations(situations: PrioritySituation[], metrics: MetricSet, refOf: (activityId: string) => string | null): string {
  if (situations.length === 0) return '';
  const lines = situations.map((s) => {
    const share = metrics[`priority.${s.priorityId}.share`];
    const baseline = metrics[`baseline.priority.${s.priorityId}.share`];
    const today =
      s.todayMinutes >= 1
        ? `${formatMinutes(s.todayMinutes)}${share ? ` (${share.display} of tracked time${baseline ? `; own recent average ${baseline.display}` : ''})` : ''}`
        : 'no linked time';
    const last = s.trail[s.trail.length - 1];
    // The main piece of work is named separately only when it is not simply the last thing touched.
    const mainElsewhere = s.main && last && s.main.activityId !== last.activityId ? s.main : null;
    return JSON.stringify({
      priorityId: s.priorityId,
      priority: s.text,
      today,
      ...(s.trail.length > 0
        ? {
            todayInOrder: s.trail.map((t) => `${refOf(t.activityId) ?? '·'} ${t.title}`),
            ...(mainElsewhere
              ? {
                  mainWork:
                    `“${mainElsewhere.title}” (${formatMinutes(mainElsewhere.minutes)}${mainElsewhere.sessions > 1 ? ` in ${mainElsewhere.sessions} sessions` : ''}) — ${STATE_WORDS[mainElsewhere.state]}`,
                }
              : {}),
            lastStoodAt: `“${last.title}”, ended ${formatClock(last.endedAt)} — ${STATE_WORDS[s.lastState ?? 'unknown']}`,
          }
        : {}),
      ...(s.recent.length > 0
        ? { earlierDays: s.recent.map((d) => `${d.dayLabel}: ${d.endedOn ? `ended on “${d.endedOn}”${d.state === 'open' ? ' (not finished)' : d.state === 'stopping_point' ? ' (finished / handed off)' : ''}` : 'no linked work'}`) }
        : {}),
      ...(s.untouchedStreak >= 2
        ? {
            withoutTime:
              `${s.untouchedStreak} tracked days in a row, today included` +
              (s.elsewhereStreak >= 2 ? `; on ${s.elsewhereStreak} of them most tracked time was linked to none of the stated priorities` : ''),
          }
        : s.untouchedStreak === 1
          ? { withoutTime: 'today only — one day is not a pattern' }
          : {}),
      ...(s.carriedOver ? { carriedOver: `“${s.carriedOver.item}” has ended the day unfinished ${s.carriedOver.days} days in a row` } : {}),
      coachSoFar:
        s.coach.ofTotal === 0
          ? 'no suggestions yet'
          : `${s.coach.recentActions} of the last ${s.coach.ofTotal} suggestion${s.coach.ofTotal === 1 ? '' : 's'} were about this` +
            (s.coach.last ? `; latest: “${s.coach.last.title}” (${s.coach.last.state})` : ''),
    });
  });
  const concentrated = concentratedTarget(situations);
  return (
    'SITUATION BY PRIORITY (Reflect\'s own record, one line per stated priority — read ALL of them before choosing)\n' +
    'What each priority got today, the order its work went in, where it last stood, how the previous tracked days ended, and what the Coach has already said about it. ' +
    'Time spent is not importance, and the newest or longest activity is not automatically the next move.\n' +
    lines.join('\n') +
    (concentrated
      ? `\nNOTE: recent suggestions have concentrated on “${concentrated.text}” (${concentrated.coach.recentActions} of the last ${concentrated.coach.ofTotal}). ` +
        'Before choosing it again, check whether another priority holds the more useful next move; choose it again only if today\'s evidence shows something NEW that is open there.'
      : '')
  );
}

/** Every title and day-ending title on the board — what "the evidence shows" for a grounding check. */
export function situationText(situations: PrioritySituation[]): string {
  return situations
    .flatMap((s) => [s.text, s.main?.title ?? '', ...s.trail.map((t) => t.title), ...s.recent.map((d) => d.endedOn ?? ''), s.coach.last?.title ?? ''])
    .join(' ');
}
