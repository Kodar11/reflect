import { threadSlug } from '../reflection/ReflectionActivities.js';
import { formatMinutes } from '../reflection/ReflectionMetrics.js';
import type { ReflectionActivity, ReflectionPeriod } from '../reflection/ReflectionModels.js';
import { formatClock, formatDay, periodContaining, shiftPeriod } from '../reflection/ReflectionPeriods.js';
import { priorityKey } from '../reflection/ReflectionPriorities.js';
import type {
  CoachAction,
  CoachActionType,
  CoachConfig,
  CoachDaypart,
  CoachExecution,
  CoachObservation,
  CoachWhen,
} from './CoachModels.js';

/**
 * Deterministic matching. Pure.
 *
 * Three jobs, none of which is the model's:
 *   - identity: what "the same recommendation" and "the same strategy" mean
 *   - timing:   turning "tomorrow morning" into an actual window
 *   - execution: did an accepted action actually happen, judged from the
 *     Focus sessions and timeline activities Reflect already has
 */

// ── Text identity ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'you', 'that', 'this', 'one', 'two', 'before', 'after', 'then',
  'work', 'working', 'session', 'sessions', 'focus', 'block', 'blocks', 'minute', 'minutes', 'hour', 'hours', 'task',
  'project', 'today', 'tomorrow', 'morning', 'afternoon', 'evening', 'night', 'time', 'day', 'first', 'next', 'start',
  'run', 'try', 'keep', 'protect', 'continue', 'spend', 'finish', 'single', 'small', 'short', 'long',
]);

/** Significant lowercase tokens of a text. */
export function tokensOf(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const token of priorityKey(text).split(' ')) {
    if (token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token)) out.add(token);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Share of the smaller set that both texts have in common. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Whether two tokens are forms of one word ("verify" / "verification", "invoice" / "invoices"). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 4 && a.slice(0, Math.max(4, n - 2)) === b.slice(0, Math.max(4, n - 2));
}

/** Tokens of `of` that occur (as a form of the same word) in `within`. */
export function sharedWords(of: Set<string>, within: Set<string>): string[] {
  const out: string[] = [];
  for (const token of of) for (const other of within) if (sameWord(token, other)) { out.push(token); break; }
  return out;
}

/**
 * Words that say an action is to be taken, or which stage comes next, without
 * saying on what. Left out when asking what specific thing an action names:
 * "confirm", "send" and "verify" are the step, never the item.
 */
const ACTION_VERBS = new Set([
  'confirm', 'confirming', 'confirmation', 'send', 'sending', 'verify', 'verifying', 'verification', 'submit', 'submitting', 'deliver', 'delivering',
  'ship', 'shipping', 'deploy', 'deploying', 'publish', 'publishing', 'test', 'testing', 'ask', 'decide', 'reply', 'respond', 'follow', 'followup',
  'schedule', 'share', 'update', 'fix', 'fixing', 'hand', 'handoff', 'handover', 'wrap', 'settle', 'choose', 'define', 'open', 'unfinished', 'pending',
  'complete', 'completing', 'completed', 'finalize', 'finalise', 'finalizing', 'finishing', 'finished', 'resume', 'resuming', 'continuing',
  'develop', 'developing', 'development', 'draft', 'drafting', 'write', 'writing', 'review', 'reviewing', 'check', 'checking', 'close', 'closing',
  'carry', 'move', 'push', 'make', 'return', 'pick', 'get', 'put', 'use', 'give', 'take', 'set', 'begin', 'remaining', 'rest', 'more', 'further',
  'implement', 'implementing', 'implementation', 'study', 'studying', 'prepare', 'preparing', 'preparation', 'practice', 'practicing', 'organize', 'organizing',
  'through', 'until', 'done', 'another', 'current', 'specific', 'details', 'items', 'steps', 'part', 'parts', 'section', 'sections', 'progress',
]);

/**
 * What an action names beyond the priority or thread it serves: the specific
 * item. "Finish the methods section of the report" for the priority "Publish
 * the annual report" names `methods`; "Continue working on the annual report"
 * names nothing.
 */
export function itemTokensOf(action: { title: string; focusTask?: string | null }, targetTexts: (string | null | undefined)[]): Set<string> {
  const target = new Set<string>();
  for (const text of targetTexts) for (const token of tokensOf(text)) target.add(token);
  const out = new Set<string>();
  for (const token of tokensOf(`${action.title} ${action.focusTask ?? ''}`)) {
    if (ACTION_VERBS.has(token)) continue;
    if ([...target].some((t) => sameWord(t, token))) continue;
    out.add(token);
  }
  return out;
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokensOf(a), tokensOf(b));
}

/** Whether `phrase` (normalized) occurs as whole words inside `text`. */
function containsPhrase(text: string, phrase: string | null | undefined): boolean {
  const needle = priorityKey(phrase ?? '');
  if (needle.length < 2) return false;
  return ` ${priorityKey(text)} `.includes(` ${needle} `);
}

// ── Strategy + target identity ──────────────────────────────────────────────

export type SizeBucket = 'none' | 'short' | 'medium' | 'long';

export function sizeBucket(focusMinutes: number | null): SizeBucket {
  if (focusMinutes === null) return 'none';
  if (focusMinutes <= 30) return 'short';
  if (focusMinutes <= 60) return 'medium';
  return 'long';
}

/**
 * How an intervention is shaped: its type, when in the day, and how big.
 * Changing any of the three is a different strategy — which is exactly what
 * the Coach must do after one keeps not working.
 */
export function strategyKeyOf(a: { actionType: CoachActionType; daypart: CoachDaypart; focusMinutes: number | null }): string {
  return `${a.actionType}|${a.daypart}|${sizeBucket(a.focusMinutes)}`;
}

/** What an intervention is aimed at. */
export function targetKeyOf(a: { priorityId: string | null; thread: string | null }): string | null {
  if (a.priorityId) return `p:${a.priorityId}`;
  if (a.thread && threadSlug(a.thread)) return `t:${threadSlug(a.thread)}`;
  return null;
}

const TYPE_PHRASES: Record<CoachActionType, string> = {
  continue_behavior: 'continuing something that worked',
  focus_session: 'a Focus session',
  change_timing: 'moving the work to a different time',
  protect_priority: 'protecting time for a priority',
  reduce_fragmentation: 'reducing switching',
  close_open_loop: 'closing an open loop',
  avoid_pattern: 'avoiding a recurring pattern',
  experiment: 'a small experiment',
  change_approach: 'approaching the task differently',
  rest: 'deliberate rest',
  clarify_priority: 'clarifying a priority',
  drop: 'dropping something',
};

const SIZE_PHRASES: Record<SizeBucket, string> = { none: '', short: ' (30 minutes or less)', medium: ' (up to an hour)', long: ' (over an hour)' };

/** `a Focus session (30 minutes or less) in the morning`. */
export function describeStrategy(strategyKey: string): string {
  const [type, daypart, size] = strategyKey.split('|') as [CoachActionType, CoachDaypart, SizeBucket];
  const when = daypart && daypart !== 'any' ? ` ${daypart === 'night' ? 'at night' : `in the ${daypart}`}` : '';
  return `${TYPE_PHRASES[type] ?? type}${SIZE_PHRASES[size] ?? ''}${when}`;
}

/** Two suggestions are the same thing when they share strategy + target, or read alike. */
export function isSameSuggestion(
  a: Pick<CoachAction, 'strategyKey' | 'targetKey' | 'title'>,
  b: Pick<CoachAction, 'strategyKey' | 'targetKey' | 'title'>,
  titleOverlap: number,
): boolean {
  if (a.strategyKey === b.strategyKey && a.targetKey === b.targetKey) return true;
  return titleSimilarity(a.title, b.title) >= titleOverlap;
}

// ── Timing ──────────────────────────────────────────────────────────────────

const DAYPART_HOURS: Record<Exclude<CoachDaypart, 'any'>, [number, number]> = {
  morning: [5, 12],
  afternoon: [12, 17],
  evening: [17, 22],
  night: [22, 29],
};

/** The part of `day` a daypart covers (clipped to the day itself). */
export function daypartWindow(day: Pick<ReflectionPeriod, 'start' | 'end'>, daypart: CoachDaypart): { start: string; end: string } {
  if (daypart === 'any') return { start: day.start, end: day.end };
  const s = new Date(day.start);
  const [from, to] = DAYPART_HOURS[daypart];
  // The logical day may begin after midnight; its calendar date anchors the clock hours.
  const at = (hour: number) => new Date(s.getFullYear(), s.getMonth(), s.getDate(), hour).getTime();
  const start = Math.max(at(from), Date.parse(day.start));
  const end = Math.min(at(to), Date.parse(day.end));
  return end > start ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : { start: day.start, end: day.end };
}

/**
 * Turn the model's "tomorrow morning" into a window. `reportDay` is the day
 * the reflection is about; "today" only exists while that day is still running
 * and the window has not already passed.
 */
export function resolveTarget(
  when: CoachWhen,
  daypart: CoachDaypart,
  reportDay: ReflectionPeriod,
  now: Date,
): { start: string; end: string } {
  const next = shiftPeriod(reportDay, 1);
  if (when === 'this_week') return { start: next.start, end: shiftPeriod(reportDay, 8).start };
  if (when === 'today' && now.getTime() < Date.parse(reportDay.end)) {
    const window = daypartWindow(reportDay, daypart);
    if (Date.parse(window.end) > now.getTime()) return window;
  }
  // A report written after its day closed speaks about the day now running.
  const day = now.getTime() >= Date.parse(next.end) ? periodContaining('day', now) : next;
  return daypartWindow(day, daypart);
}

/** The same window, one day later (a snoozed suggestion coming back). */
export function shiftWindowByDay(start: string | null, end: string | null): { start: string | null; end: string | null } {
  const shift = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, d.getHours(), d.getMinutes()).toISOString();
  };
  return { start: shift(start), end: shift(end) };
}

/** `Today · morning`, `Tomorrow`, `Sat, Oct 3 · evening`, `This week`. */
export function describeTarget(action: Pick<CoachAction, 'targetStart' | 'targetEnd' | 'daypart'>, now: Date): string | null {
  if (!action.targetStart || !action.targetEnd) return null;
  const spanDays = (Date.parse(action.targetEnd) - Date.parse(action.targetStart)) / 86_400_000;
  if (spanDays > 1.5) return 'This week';
  const today = periodContaining('day', now);
  const day = periodContaining('day', action.targetStart);
  const name =
    day.key === today.key ? 'Today' : day.key === shiftPeriod(today, 1).key ? 'Tomorrow' : day.key === shiftPeriod(today, -1).key ? 'Yesterday' : formatDay(new Date(day.start));
  return action.daypart === 'any' ? name : `${name} · ${action.daypart}`;
}

// ── Execution detection ─────────────────────────────────────────────────────

/** One Focus session as execution evidence. */
export interface FocusFact {
  id: string;
  task: string;
  startedAt: string;
  /** null while the session is still open. */
  endedAt: string | null;
  elapsedMinutes: number;
  plannedMinutes: number | null;
  interruptionCount: number;
  endReason: string | null;
  endNote: string | null;
}

/** Action types that leave no trace in tracked activity. */
const UNOBSERVABLE_TYPES: readonly CoachActionType[] = ['rest', 'clarify_priority', 'drop', 'avoid_pattern', 'reduce_fragmentation'];

export function isObservable(action: Pick<CoachAction, 'actionType' | 'focusMinutes' | 'targetKey' | 'focusTask'>): boolean {
  if (action.focusMinutes !== null) return true;
  if (UNOBSERVABLE_TYPES.includes(action.actionType)) return false;
  return action.targetKey !== null || tokensOf(action.focusTask).size > 0;
}

/** The window in which an accepted action is watched for. */
export function observationWindow(action: CoachAction, config: Pick<CoachConfig, 'defaultWindowMs'>): { start: string; end: string } {
  const start = action.targetStart ?? action.acceptedAt ?? action.createdAt;
  const end = action.targetEnd ?? new Date(Date.parse(action.acceptedAt ?? action.createdAt) + config.defaultWindowMs).toISOString();
  return { start, end };
}

/**
 * Work suggested for "tomorrow morning" that happens tomorrow afternoon still
 * happened. The question "did it happen?" is still raised when the window
 * ends, but a window shorter than a day keeps being looked at until the end of
 * its own day, and what was seen after the window is reported as such.
 */
export function observationGraceEnd(window: { start: string; end: string }): string {
  const spanMs = Date.parse(window.end) - Date.parse(window.start);
  if (!(spanMs > 0) || spanMs >= 86_400_000) return window.end;
  const dayEnd = periodContaining('day', new Date(Date.parse(window.end) - 1)).end;
  return dayEnd > window.end ? dayEnd : window.end;
}

/** Action types that are about one particular item: seeing work on the same priority is not seeing the item done. */
const ITEM_DIRECTED_TYPES: readonly CoachActionType[] = ['close_open_loop', 'change_approach'];

export interface ObserveInput {
  action: CoachAction;
  nowIso: string;
  /** Focus sessions that started inside the window. */
  focus: FocusFact[];
  /** Timeline activities overlapping the window or the rest of its day (thread / priority attached). */
  activities: ReflectionActivity[];
  /** Text of the priority the action targets, when it targets one. */
  priorityText: string | null;
  config: Pick<CoachConfig, 'defaultWindowMs' | 'minAttemptMinutes' | 'minSignalMinutes' | 'doneRatio' | 'partialRatio'>;
}

export interface ObserveResult {
  observation: CoachObservation;
  /** What the evidence supports; null when it supports nothing either way. */
  execution: CoachExecution | null;
  executedAt: string | null;
}

/**
 * What does Reflect's own data say about this action? Never a judgment:
 * "not observed" means exactly that, and anything in between is "ambiguous"
 * so the user is asked instead of success or failure being invented.
 */
export function observeAction(input: ObserveInput): ObserveResult {
  const { action, nowIso, config } = input;
  const window = observationWindow(action, config);
  const ws = Date.parse(window.start);
  const we = Date.parse(window.end);
  const ge = Date.parse(observationGraceEnd(window));
  const ended = Date.parse(nowIso) >= we;
  const dayEnded = Date.parse(nowIso) >= ge;

  const base = {
    observedAt: nowIso,
    window,
    focusSessionIds: [] as string[],
    activityIds: [] as string[],
    focusMinutes: 0,
    matchedMinutes: 0,
    plannedMinutes: action.focusMinutes,
    interruptions: 0,
  };

  if (!isObservable(action) && !action.linkedFocusSessionId) {
    return {
      observation: { ...base, kind: 'unobservable', final: ended, facts: ['This is not something Reflect can see in tracked activity.'] },
      execution: null,
      executedAt: null,
    };
  }

  const targetTokens = new Set([...tokensOf(action.focusTask), ...tokensOf(action.thread), ...tokensOf(input.priorityText)]);
  const phrases = [action.focusTask, action.thread, input.priorityText];
  const untargeted = targetTokens.size === 0 && !phrases.some((p) => priorityKey(p ?? '').length >= 2);
  const relatedText = (text: string) =>
    phrases.some((p) => containsPhrase(text, p)) || containment(tokensOf(text), targetTokens) >= 0.5;

  // ── Focus sessions ──
  const inWindow = input.focus.filter((f) => {
    const s = Date.parse(f.startedAt);
    return f.id === action.linkedFocusSessionId || (s >= ws && s < we);
  });
  const relevantFocus = inWindow.filter(
    (f) => f.id === action.linkedFocusSessionId || (untargeted ? action.focusMinutes !== null : relatedText(f.task)),
  );
  const otherFocus = inWindow.filter((f) => !relevantFocus.includes(f));
  const running = relevantFocus.some((f) => f.endedAt === null);
  const focusMinutes = relevantFocus.reduce((sum, f) => sum + f.elapsedMinutes, 0);
  const interruptions = relevantFocus.reduce((sum, f) => sum + f.interruptionCount, 0);

  // ── Timeline activity ──
  const slug = action.thread ? threadSlug(action.thread) : null;
  // The specific thing the action names, beyond the priority / thread it serves.
  const itemTokens = itemTokensOf(action, [input.priorityText, action.thread]);
  let matchedMinutes = 0;
  /** Matching work after the suggested window, later the same day. */
  let laterMinutes = 0;
  let itemSeen = false;
  const matched: ReflectionActivity[] = [];
  for (const a of input.activities) {
    const s = Date.parse(a.startedAt);
    const e = Date.parse(a.endedAt);
    const overlap = Math.max(0, Math.min(e, we) - Math.max(s, ws));
    const later = Math.max(0, Math.min(e, ge) - Math.max(s, we));
    if (!(overlap > 0) && !(later > 0)) continue;
    const related =
      (action.priorityId !== null && a.priorityId === action.priorityId) ||
      (slug !== null && a.thread !== null && threadSlug(a.thread) === slug) ||
      (!untargeted && relatedText(`${a.title} ${a.thread ?? ''}`));
    if (!related) continue;
    matched.push(a);
    const share = (ms: number) => (e > s ? a.durationMinutes * Math.min(1, ms / (e - s)) : a.durationMinutes);
    if (overlap > 0) matchedMinutes += share(overlap);
    if (later > 0) laterMinutes += e > s ? share(later) : 0;
    if (itemTokens.size > 0 && sharedWords(itemTokens, tokensOf(`${a.title} ${a.summary ?? ''}`)).length > 0) itemSeen = true;
  }

  const label = action.thread ?? input.priorityText ?? action.focusTask ?? action.title;
  const facts: string[] = [];
  for (const f of relevantFocus) {
    const planned = f.plannedMinutes ? ` of ${formatMinutes(f.plannedMinutes)} planned` : '';
    const breaks = f.interruptionCount > 0 ? `, ${f.interruptionCount} interruption${f.interruptionCount === 1 ? '' : 's'}` : '';
    const how =
      f.endedAt === null
        ? ', still running'
        : f.endReason === 'ended-early'
          ? `, ended early${f.endNote ? ` (“${f.endNote}”)` : ''}`
          : f.endReason === 'abandoned'
            ? ', not finished'
            : '';
    facts.push(`Focus session “${f.task}” ran ${formatMinutes(f.elapsedMinutes)}${planned}${breaks}${how}.`);
  }
  if (matchedMinutes >= 1) {
    facts.push(
      `${formatMinutes(matchedMinutes)} of tracked work on “${label}” between ${formatDay(new Date(ws))}, ${formatClock(window.start)} and ${formatClock(window.end)}.`,
    );
  }
  if (laterMinutes >= 1) {
    facts.push(`${formatMinutes(laterMinutes)} of tracked work on “${label}” later that day, after ${formatClock(window.end)}.`);
  }

  const filled = {
    ...base,
    focusSessionIds: relevantFocus.map((f) => f.id),
    activityIds: matched.map((a) => a.id).slice(0, 12),
    focusMinutes: Math.round(focusMinutes),
    matchedMinutes: Math.round(matchedMinutes),
    laterMinutes: Math.round(laterMinutes),
    evidenceLevel: matched.length === 0 ? null : itemTokens.size === 0 || itemSeen ? ('item' as const) : ('target' as const),
    interruptions,
  };
  const lastEvidenceEnd = [...relevantFocus.map((f) => f.endedAt ?? f.startedAt), ...matched.map((a) => a.endedAt)]
    .sort()
    .pop() ?? null;
  const final = ended && !running;
  const result = (kind: CoachObservation['kind'], execution: CoachExecution | null, extra: string[] = []): ObserveResult => ({
    observation: { ...filled, kind, final, facts: [...facts, ...extra] },
    execution,
    executedAt: execution && execution !== 'not_done' ? lastEvidenceEnd : null,
  });

  // A session still in progress settles nothing yet.
  if (running) return result('ambiguous', null);

  // An action about one particular item is not shown to have happened by work
  // on the same priority that never names the item: that is "something related
  // happened", and the user is asked rather than execution being assumed.
  const itemUnseen =
    relevantFocus.length === 0 && ITEM_DIRECTED_TYPES.includes(action.actionType) && itemTokens.size > 0 && matched.length > 0 && !itemSeen;
  const unseenNote = [`That shows work on “${label}”; nothing tracked names what this action was about, so Reflect cannot tell whether it was this.`];

  const planned = action.focusMinutes;
  const allDay = matchedMinutes + laterMinutes;
  if (planned !== null) {
    if (focusMinutes >= config.doneRatio * planned) return result('executed', 'done');
    if (focusMinutes >= Math.max(config.minSignalMinutes, config.partialRatio * planned)) return result('executed', 'partial');
    if (itemUnseen && allDay >= config.minSignalMinutes) return result('ambiguous', null, unseenNote);
    if (matchedMinutes >= config.doneRatio * planned) {
      return result('attempted', 'partial', ['The work happened, but not as a Focus session.']);
    }
    if (ended && allDay >= config.doneRatio * planned) {
      return result('attempted', 'partial', ['The work happened later than suggested, and not as a Focus session.']);
    }
    if (focusMinutes > 0 || allDay >= config.minSignalMinutes || otherFocus.length > 0) {
      const other = otherFocus.length > 0 ? [`A Focus session on something else ran in that window (“${otherFocus[0].task}”).`] : [];
      return result('ambiguous', null, other);
    }
  } else {
    const minutes = Math.max(focusMinutes, matchedMinutes);
    if (itemUnseen && Math.max(minutes, allDay) >= config.minSignalMinutes) return result('ambiguous', null, unseenNote);
    if (minutes >= config.minAttemptMinutes) return result('executed', 'done');
    if (ended && Math.max(focusMinutes, allDay) >= config.minAttemptMinutes) {
      return result('attempted', 'done', ['The work happened later than the suggested time.']);
    }
    if (Math.max(minutes, allDay) >= config.minSignalMinutes) return result('ambiguous', null);
  }
  return result('not_observed', null, [
    `Nothing matching was observed between ${formatDay(new Date(ws))}, ${formatClock(window.start)} and ${formatClock(window.end)}${dayEnded && ge > we ? ', or later that day' : ''}.`,
  ]);
}
