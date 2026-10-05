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
import { formatClock, formatDay, periodFromKey } from '../reflection/ReflectionPeriods.js';
import { itemTokensOf, sharedWords, tokensOf } from './CoachMatching.js';
import type { CoachAction, CoachActionType, CoachConfig, CoachMemory, CoachReasonCode } from './CoachModels.js';
import { mainItem, type PrioritySituation } from './CoachSituation.js';
import { openEvidenceOf, wasDelivered, workStateOf } from './CoachWorkState.js';

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
 *
 * A measurement is then read against the RECORD (`withRecord`): what was
 * already suggested about that same thing, and what became of it. A signal
 * the user has already heard, decided on or acted on is still true — it is
 * just not news, and it is shown to the model as covered rather than as a
 * candidate. One that was tried and did not help stays a candidate, with the
 * form it may not take again.
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
  /** The specific piece of work it is about, as the activity names it. Absent for a signal about a priority or the day as a whole. */
  item?: string | null;
  /** Tracked days in a row it has held, today included — one day is a circumstance, several are a pattern. */
  days?: number;
  /** What the record of earlier suggestions already says about this same thing. Absent = nothing. */
  record?: SignalRecord;
  /**
   * Reflect cannot tell whether this is something to act on or something that is no longer current — only the
   * user can. The one honest answer is a question (`clarify_priority`), never a prescription.
   */
  ask?: boolean;
}

export { openEvidenceOf, wasDelivered, workStateOf, type WorkState } from './CoachWorkState.js';

// ── What the record already says ────────────────────────────────────────────

/**
 * How an earlier suggestion about the same thing stands.
 *
 * A measurement can be perfectly true and still not be news: the proposal that
 * reads as "being drafted" every day was pointed at on Monday and worked on on
 * Tuesday. Without this, the clearest signal of the day is the one the user
 * has already heard — and the validator, which does know, then refuses it,
 * leaving the day with nothing.
 */
export type SignalStanding =
  /** Already on the user's list (suggested, accepted, or waiting for their word). */
  | 'on_the_list'
  /** Postponed with "not now": it comes back by itself. */
  | 'postponed'
  /** Turned down. */
  | 'rejected'
  /** Suggested, carried out and reported as helping, in the last few days. */
  | 'acted_on'
  /** Suggested and carried out repeatedly: ongoing work the user already handles. */
  | 'routine'
  /** Carried out, and only partly helped (or only partly carried out): worth refining. */
  | 'partly_helped'
  /** Tried and reported as not helping, or accepted and not carried out. */
  | 'did_not_help'
  /** Not carried out because something outside the user's control took the time. */
  | 'could_not_happen'
  /** Offered in the last few days and never answered. */
  | 'unanswered';

export interface SignalRecord {
  standing: SignalStanding;
  /** Earlier suggestions about this same thing inside the lookback. */
  attempts: number;
  lastTitle: string;
  /** One plain sentence: what happened, and what that leaves room for. */
  note: string;
  /** The record already covers it — raising it again today would repeat what the user has seen, decided or done. */
  settled: boolean;
}

type RecordAction = Pick<
  CoachAction,
  'title' | 'focusTask' | 'targetKey' | 'thread' | 'actionType' | 'status' | 'execution' | 'outcome' | 'reasonCode' | 'originDayKey' | 'createdAt' | 'acceptedAt' | 'rejectedAt' | 'executedAt' | 'outcomeAt' | 'closedAt' | 'updatedAt'
>;

export interface SignalRecordInput {
  /** Every action inside the effectiveness lookback, any status. */
  actions: RecordAction[];
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  nowIso: string;
  config: Pick<CoachConfig, 'ignoredMemoryMs' | 'rejectionMemoryMs' | 'recentFailureMs'>;
  reasonLabel?: (code: CoachReasonCode) => string;
}

/** Day-wide signals are answered by one kind of action, whatever it was aimed at. */
const DAY_WIDE_ANSWER: Partial<Record<OpportunityKind, CoachActionType[]>> = {
  fragmentation: ['reduce_fragmentation'],
  sustained_load: ['rest'],
  unlinked_time: ['clarify_priority'],
};

/** "…in Google Docs", "…on GitHub": the tool a title ends on says where the work is done, not what it is. */
const TRAILING_TOOL = /\s+(?:in|on|via|using|with|from)\s+(?:the\s+)?[A-Z][\w.+#-]*(?:\s+[A-Z][\w.+#-]*){0,2}\s*$/;
/** Nouns that say what KIND of thing an item is. Two items are not the same piece of work for sharing one of these. */
const KIND_WORDS = new Set(['component', 'components', 'feature', 'features', 'module', 'modules', 'page', 'pages', 'code', 'app', 'application', 'product', 'project', 'document', 'documents', 'file', 'files', 'item', 'items', 'version', 'new']);

/** The words by which a piece of work is recognised again: what a title names beyond its target, its tool and its kind. */
function identityOf(title: string, focusTask: string | null | undefined, targetTexts: (string | null | undefined)[]): Set<string> {
  const named = itemTokensOf({ title: title.replace(TRAILING_TOOL, ''), focusTask }, targetTexts);
  const specific = new Set([...named].filter((token) => !KIND_WORDS.has(token)));
  // A title made only of kind words ("New feature") is still recognised by them.
  return specific.size > 0 ? specific : named;
}

/** Whether an earlier action was about the same thing a signal measures. */
function concerns(signal: CoachOpportunity, action: RecordAction, priorityText: string | null): boolean {
  if (signal.priorityId === null) {
    if (signal.kind === 'open_loop') {
      const loop = tokensOf(signal.item ?? '');
      return loop.size > 0 && sharedWords(loop, tokensOf(`${action.title} ${action.focusTask ?? ''}`)).length * 2 >= loop.size;
    }
    return DAY_WIDE_ANSWER[signal.kind]?.includes(action.actionType) ?? false;
  }
  if (action.targetKey !== `p:${signal.priorityId}`) return false;
  // A signal about the priority as a whole (no time, steady time) is answered by anything aimed at that priority.
  if (!signal.item || signal.kind === 'displaced_priority' || signal.kind === 'momentum') return true;
  const named = identityOf(signal.item, null, [priorityText, signal.thread]);
  const acted = identityOf(action.title, action.focusTask, [priorityText, action.thread, signal.thread]);
  if (named.size === 0 || acted.size === 0) return false; // neither names anything narrower than the priority: not known to be the same item
  const shared = sharedWords(named, acted).length;
  return shared >= 1 && shared * 2 >= Math.min(named.size, acted.size);
}

/**
 * Each measured signal, joined with what the record of earlier suggestions
 * says about that same thing. Pure and deterministic; `tried_before` signals
 * (which ARE the record) pass through untouched.
 */
export function withRecord(signals: CoachOpportunity[], input: SignalRecordInput): CoachOpportunity[] {
  const now = Date.parse(input.nowIso);
  const since = (ms: number) => new Date(now - ms).toISOString();
  const recently = since(input.config.ignoredMemoryMs);
  const why = (a: RecordAction) => (a.reasonCode && input.reasonLabel ? ` (${input.reasonLabel(a.reasonCode)})` : '');
  const on = (a: RecordAction) => {
    const day = periodFromKey('day', a.originDayKey);
    return day ? ` on ${formatDay(new Date(day.start))}` : '';
  };

  return signals.map((signal) => {
    if (signal.kind === 'tried_before') return signal;
    const priorityText = signal.priorityId ? input.priorities.find((p) => p.id === signal.priorityId)?.text ?? null : null;
    const about = input.actions
      .filter((a) => a.status !== 'withdrawn' && concerns(signal, a, priorityText))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const record = (standing: SignalStanding, action: RecordAction, note: string, settled: boolean): CoachOpportunity => ({
      ...signal,
      record: { standing, attempts: about.length, lastTitle: action.title, note, settled },
    });
    // A signal about a priority as a whole is not "used up" by work on one of its items:
    // a priority that went without time again after an action was carried out is new evidence.
    const wholePriority = signal.priorityId !== null && (!signal.item || signal.kind === 'displaced_priority' || signal.kind === 'momentum');

    // "Not now" is an answer for the whole target: nothing else for it until the suggestion comes back.
    const postponed = signal.priorityId
      ? input.actions.find((a) => a.status === 'snoozed' && a.targetKey === `p:${signal.priorityId}`)
      : about.find((a) => a.status === 'snoozed');
    if (postponed) return record('postponed', postponed, `The user postponed “${postponed.title}” (“not now”); it comes back by itself.`, true);

    const listed = about.find((a) => a.status === 'suggested' || a.status === 'accepted' || a.status === 'review');
    if (listed) return record('on_the_list', listed, `Already on the user's list: “${listed.title}”.`, true);

    const rejectedSince = since(input.config.rejectionMemoryMs);
    const rejected =
      (wholePriority ? undefined : about.find((a) => a.status === 'rejected' && (a.rejectedAt ?? a.updatedAt) >= rejectedSince)) ??
      (signal.priorityId
        ? input.actions.find((a) => a.status === 'rejected' && a.reasonCode === 'not_relevant' && a.targetKey === `p:${signal.priorityId}` && (a.rejectedAt ?? a.updatedAt) >= rejectedSince)
        : undefined);
    if (rejected) return record('rejected', rejected, `The user rejected “${rejected.title}”${rejected.reasonCode === 'not_relevant' ? ' as not relevant' : ''}.`, true);

    const latest = about.find((a) => a.status === 'closed' || a.status === 'expired');
    if (!latest) return signal;
    const settledAt = latest.outcomeAt ?? latest.executedAt ?? latest.closedAt ?? latest.updatedAt;

    if (latest.outcome === 'did_not_work' && settledAt >= since(input.config.recentFailureMs)) {
      return record('did_not_help', latest, `“${latest.title}” was tried${on(latest)} and the user said it did not help${why(latest)}: the same form again would repeat it.`, false);
    }
    if (latest.execution === 'not_done' && settledAt >= recently) {
      return latest.reasonCode === 'external_constraint'
        ? record('could_not_happen', latest, `“${latest.title}” could not happen${on(latest)}: something outside the user's control took the time. Offering that step again is right.`, false)
        : record(
            'did_not_help',
            latest,
            `“${latest.title}” was accepted${on(latest)} and not carried out${why(latest)}` + (latest.reasonCode === 'too_difficult' ? ': only a clearly smaller step is worth offering.' : ': the same form again would repeat it.'),
            false,
          );
    }
    if (latest.execution === 'done' || latest.execution === 'partial') {
      if (wholePriority) return signal;
      const carriedOut = about.filter((a) => a.execution === 'done' || a.execution === 'partial');
      const lastCarriedOutAt = latest.executedAt ?? latest.closedAt ?? latest.updatedAt;
      if (carriedOut.length >= 2 && lastCarriedOutAt >= since(input.config.recentFailureMs)) {
        return record(
          'routine',
          latest,
          `Suggested ${carriedOut.length} times (latest: “${latest.title}”${on(latest)}) and carried out each time: this reads as ongoing work the user already handles, not something left hanging.`,
          true,
        );
      }
      if (lastCarriedOutAt >= recently) {
        // What the user did and what they said about it stay two facts: "partly helped" is only ever their word.
        return latest.outcome === 'partly_worked' || latest.execution === 'partial'
          ? record(
              'partly_helped',
              latest,
              `“${latest.title}” was ${latest.execution === 'partial' ? 'partly carried out' : 'carried out'}${on(latest)}` +
                `${latest.outcome === 'partly_worked' ? ' and the user said it partly helped' : ''}: only a refinement (smaller, a different time, narrower) is worth offering.`,
              false,
            )
          : record('acted_on', latest, `Suggested as “${latest.title}”${on(latest)} and carried out. That it still reads as in progress is not new evidence.`, true);
      }
      return signal;
    }
    if (latest.status === 'expired' && latest.acceptedAt === null && (latest.closedAt ?? latest.updatedAt) >= recently) {
      return signal.strength === 'clear'
        ? record('unanswered', latest, `Offered as “${latest.title}”${on(latest)} and not answered. Today's measurement is clear: offer it again only in a different form — a protected block before other work starts, one clearly smaller first step, or a different time of day.`, false)
        : record('unanswered', latest, `Offered as “${latest.title}”${on(latest)} and not answered; nothing clearer has been measured since.`, true);
    }
    return signal;
  });
}

/** Signals that are candidates for a next move today: measured, and not already covered by the record. */
export function candidateSignals(signals: CoachOpportunity[]): CoachOpportunity[] {
  return signals.filter((s) => !s.record?.settled);
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
  /** No time for a priority on this many tracked days in a row, with the time going to nothing the user named: intention and attention disagree. */
  elsewhereDays: 3,
  /** The same main piece of work this many days running without a finish is a pattern, whatever its description says. */
  persistentDays: 3,
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
/** Confidences are shown to the model: two decimals, never 0.44999999999999996. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

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
        // No time today for a stated priority that was being worked on. Five readings:
        //   finished   its last work ended on "submitted" / "deployed" — it may simply be done
        //   elsewhere  no time for days on end while the time went to nothing the user named — intention and attention disagree
        //   recurring  no time on several tracked days in a row, or absent from most of the recent days
        //   left open  one day without it, but it is known to have been left unfinished
        //   one-off    one day without it and nothing says where it stood — a circumstance, not a pattern
        const recurring = streak >= rules.recurringDays || quiet;
        // Days on which the time did not go to another stated priority either. A step that was merely
        // completed ("finished the practice set") does not explain that away; a hand-over ("submitted") does.
        const elsewhere = situation?.elsewhereStreak ?? 0;
        const adrift = elsewhere >= rules.elsewhereDays && !(lastKnown && wasDelivered(lastKnown));
        // Finished work going quiet is completion, however many days it lasts.
        const finished = lastState === 'stopping_point' && !adrift;
        // Left at a draft, a fix or an investigation under way is left unfinished too.
        const leftOpen = lastState === 'open' || lastState === 'underway';
        const clear = adrift || (!finished && (recurring || leftOpen));
        out.push({
          kind: 'displaced_priority',
          strength: clear ? 'clear' : 'possible',
          confidence: round2(finished ? 0.3 : recurring || adrift ? Math.min(0.95, 0.75 + 0.05 * streak) : leftOpen ? 0.7 : 0.45),
          priorityId: p.id,
          thread: null,
          summary:
            `“${p.text}” got ${today >= 1 ? formatMinutes(today) : 'no linked time'} today; it was worked on ${metrics[recentDaysKey].display} recent days` +
            `${lastDay ? ` (last on ${lastDay.display})` : ''}.` +
            (finished ? '' : streak >= rules.recurringDays ? ` That is ${streak} tracked days in a row without it.` : !quiet ? ' That is one day so far.' : '') +
            (lastKnown
              ? finished
                ? ` Its last tracked work, “${lastKnown.title}”, reads as finished — it may simply be done; only the user can say.`
                : leftOpen
                  ? ` It was left unfinished at “${lastKnown.title}”.`
                  : ` It last stood at “${lastKnown.title}”.`
              : '') +
            (adrift
              ? ` On ${elsewhere} of those days most of the tracked time was linked to none of the stated priorities: either it needs a protected block, or it is no longer current — only the user can say which.`
              : quiet && !finished
                ? leftOpen
                  ? ' It has been absent from most of the recent days while that was left unfinished.'
                  : ' It has been absent from most of the recent days: either it needs a protected block, or it is no longer current — only the user can say which.'
                : ''),
          metricKeys: [...(metrics[minutesKey] ? [minutesKey] : []), recentDaysKey, ...(lastDay ? [lastDay.key] : []), 'time.tracked_minutes'],
          activityIds: [],
          fits: finished ? ['clarify_priority'] : adrift || (quiet && !leftOpen) ? ['clarify_priority', 'protect_priority', 'focus_session'] : ['protect_priority', 'focus_session', 'clarify_priority'],
          item: lastKnown?.title ?? null,
          days: streak,
          ...(adrift ? { ask: true } : {}),
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
          days: 1,
        });
      }
    }

    // ── Left off: where this priority's work stood when the day ended ──
    // Only raised when the day did not end on a finish: a priority whose day
    // ended on "deployed" or "sent" has no loose end here. What it names is the
    // day's main piece of work — the last thing touched only when that is the
    // same thing, or says outright that it is unfinished.
    const last = linked[linked.length - 1];
    const main = situation?.main ?? mainItem(linked, p.text);
    const state = main?.state ?? 'unknown';
    if (last && main && today >= rules.untouchedMinutes && state !== 'stopping_point') {
      const about = linked.find((a) => a.id === main.activityId) ?? last;
      const sessionsKey = `priority.${p.id}.sessions`;
      // An explicit statement ("still failing") and early-stage work ("drafted", "debugging") both say unfinished;
      // the statement says it more plainly, and ranks higher.
      const clear = (state === 'open' || state === 'underway') && main.minutes >= MEANINGFUL_ACTIVITY_MINUTES;
      const said = state === 'open' ? openEvidenceOf(about) : null;
      const ending =
        state === 'open'
          ? `; its description says it was not finished${said && said !== about.title ? ` (“${said}”)` : ''}.`
          : state === 'underway'
            ? '; it is described as work at an early stage (a draft, a fix or an investigation under way), not as finished.'
            : '. Nothing states whether it was finished.';
      out.push({
        kind: 'left_off',
        strength: clear ? 'clear' : 'possible',
        confidence: !clear ? 0.4 : state === 'open' ? 0.75 : 0.6,
        priorityId: p.id,
        thread: about.thread,
        summary:
          about.id === last.id
            ? `Work toward “${p.text}” (${metrics[minutesKey].display} today) last stood at “${last.title}”, which ended at ${formatClock(last.endedAt)}${ending}`
            : `Work toward “${p.text}” (${metrics[minutesKey].display} today) was mainly “${main.title}” (${formatMinutes(main.minutes)}${main.sessions > 1 ? ` in ${main.sessions} sessions` : ''})${ending} ` +
              `The last thing touched was “${last.title}”, which ended at ${formatClock(last.endedAt)}.`,
        metricKeys: [minutesKey, ...(metrics[sessionsKey] ? [sessionsKey] : [])],
        activityIds: about.id === last.id ? [last.id] : [about.id, last.id],
        fits: ['close_open_loop', 'focus_session', 'continue_behavior'],
        item: main.title,
        days: 1,
      });
    }

    // ── Carried over: the same piece of work ending the day unfinished, day after day ──
    if (situation?.carriedOver && today >= rules.untouchedMinutes) {
      const { days, item, activityId } = situation.carriedOver;
      const carried = situation.carriedOver.state ?? state;
      // Unfinished by its own description: a pattern from the second day. With nothing saying so, two days of the same
      // item can be ordinary multi-day work — the third day running without a finish is what makes it one.
      const clear = carried === 'open' || carried === 'underway' || days >= rules.persistentDays;
      out.push({
        kind: 'carried_over',
        strength: clear ? 'clear' : 'possible',
        confidence:
          round2(carried === 'open' ? Math.min(0.9, 0.6 + 0.1 * days) : carried === 'underway' ? Math.min(0.85, 0.5 + 0.1 * days) : clear ? Math.min(0.75, 0.35 + 0.1 * days) : 0.45),
        priorityId: p.id,
        thread: linked.find((a) => a.id === activityId)?.thread ?? last?.thread ?? null,
        summary: `“${item}” has been the last work toward “${p.text}” on ${days} tracked days in a row without reading as finished.`,
        metricKeys: [minutesKey],
        activityIds: [activityId],
        fits: ['close_open_loop', 'focus_session', 'change_approach'],
        item,
        days,
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
      item: memory.text,
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
  // What the record already covers is not competing for a place: it goes last, in the order it was measured.
  const covered = signals.filter((s) => s.record?.settled);
  if (covered.length > 0) return [...orderSignals(signals.filter((s) => !s.record?.settled)), ...covered];
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

const OTHER_EVIDENCE = 'Unless the evidence above shows a concrete next move some other way (a deadline, a failing check, something waiting on someone), the right answer is no action.';

/**
 * The signals as the model reads them. `refOf` turns an activity id into the alias used under ACTIVITIES.
 *
 * Two lists, never one: what is a candidate today, and what was measured but
 * is already covered by the record (suggested and waiting, postponed,
 * rejected, or done). The second list is shown so the model knows WHY those
 * are not candidates — and does not rediscover them from the activities.
 */
export function renderOpportunities(signals: CoachOpportunity[], refOf: (activityId: string) => string | null): string {
  const candidates = candidateSignals(signals);
  const covered = signals.filter((s) => s.record?.settled);
  const coveredBlock =
    covered.length > 0
      ? '\n\nALREADY COVERED BY THE RECORD (measured today as well, but NOT candidates: each was already suggested, decided on or carried out. Naming one of these again repeats what this user has seen)\n' +
        covered
          .map((s) => JSON.stringify({ signal: s.kind, ...(s.priorityId ? { priorityId: s.priorityId } : {}), ...(s.item ? { item: s.item } : {}), record: s.record!.note }))
          .join('\n')
      : '';
  if (candidates.length === 0) {
    return (
      'NEXT-MOVE SIGNALS (measured by Reflect)\n' +
      (covered.length === 0
        ? 'None measured today: no stated priority was visibly left unfinished or displaced, and switching was within this user\'s norm. '
        : 'Nothing new measured today: everything Reflect measured is already covered by the record (listed below). ') +
      OTHER_EVIDENCE +
      coveredBlock
    );
  }
  const lines = candidates.map((s) =>
    JSON.stringify({
      signal: s.kind,
      strength: s.strength,
      confidence: s.confidence,
      ...(s.priorityId ? { priorityId: s.priorityId } : {}),
      ...(s.thread ? { thread: s.thread } : {}),
      ...(s.item ? { item: s.item } : {}),
      ...(s.days && s.days > 1 ? { days: s.days } : {}),
      what: s.summary,
      ...(s.record ? { record: s.record.note } : {}),
      ...(s.ask ? { answer: 'a question to the user (clarify_priority) — not a prescription' } : {}),
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
    '"item" is the piece of work the line is about, "days" how many tracked days in a row it has held (one day is a circumstance; several are a pattern), and ' +
    '"record" what Reflect\'s own history says about that same thing — when present, it limits the form an action may take. ' +
    'A left_off line that only says where work last stood, or a momentum line, is the weakest kind: it becomes a next move only when the trail in SITUATION BY PRIORITY shows a specific item with an obvious next stage — never as "continue X". ' +
    'An action that answers a signal should cite that signal\'s metricKeys / activityRefs / actionRefs.\n' +
    lines.join('\n') +
    coveredBlock
  );
}

/** A thread name the day's evidence knows, for a signal that names one. */
export function threadOfSignal(signal: CoachOpportunity, knownThreads: string[]): string | null {
  if (!signal.thread) return null;
  const slug = threadSlug(signal.thread);
  return knownThreads.find((t) => threadSlug(t) === slug) ?? null;
}
