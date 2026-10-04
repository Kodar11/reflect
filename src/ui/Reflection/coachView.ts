/**
 * Pure view logic for the Coach inside the Reflection tab — no React, no
 * Electron. The main process decides what an action's state means (its status
 * line, what is being asked); these helpers only decide how that is laid out.
 */

export const REASON_OPTIONS: { value: CoachReasonCodeDto; label: string }[] = [
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'bad_timing', label: 'Bad timing' },
  { value: 'too_difficult', label: 'Too difficult' },
  { value: 'different_priority', label: 'Different priority' },
  { value: 'already_doing', label: 'Already doing it' },
  { value: 'external_constraint', label: 'Something outside my control' },
  { value: 'not_applicable', label: 'Doesn’t apply' },
];

/** Reasons that make sense for "it didn't happen" / "it didn't work". */
export const FAILURE_REASON_OPTIONS = REASON_OPTIONS.filter((r) => r.value !== 'already_doing' && r.value !== 'not_relevant');

export const ACTION_TYPE_LABELS: Record<CoachActionTypeDto, string> = {
  continue_behavior: 'Keep going',
  focus_session: 'Focus session',
  change_timing: 'Different timing',
  protect_priority: 'Protect a priority',
  reduce_fragmentation: 'Fewer switches',
  close_open_loop: 'Close a loop',
  avoid_pattern: 'A pattern to avoid',
  experiment: 'A small experiment',
  change_approach: 'A different approach',
  rest: 'Rest',
  clarify_priority: 'Clarify a priority',
  drop: 'Let something go',
};

export const DAYPART_OPTIONS: { value: CoachDaypartDto; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'night', label: 'Night' },
];

export const MEMORY_KIND_LABELS: Record<CoachMemoryDto['kind'], string> = {
  preference: 'Preference',
  constraint: 'Constraint',
  decision: 'Decision',
  priority_note: 'About a priority',
  open_loop: 'Open loop',
  conclusion: 'Learned',
};

/** Things the user can ask with one click. */
export const SUGGESTED_PROMPTS = [
  'What should I focus on tomorrow?',
  'What did I decide last week?',
  'Was this week actually better?',
  'What should I stop doing?',
];

// ── Briefing layout ─────────────────────────────────────────────────────────

const CHANGED_TYPES: readonly ReflectionInsightTypeDto[] = ['change_over_time', 'unexpected'];

/**
 * A day reads as a briefing: what stands out, what changed, what it means for
 * the user's priorities. Order inside each group is the model's own.
 */
export function groupInsights(insights: ReflectionInsightDto[]): {
  standsOut: ReflectionInsightDto[];
  changed: ReflectionInsightDto[];
  priorities: ReflectionInsightDto[];
} {
  return {
    standsOut: insights.filter((i) => i.type !== 'priority_alignment' && !CHANGED_TYPES.includes(i.type)),
    changed: insights.filter((i) => CHANGED_TYPES.includes(i.type)),
    priorities: insights.filter((i) => i.type === 'priority_alignment'),
  };
}

/**
 * What "Next" shows for a report: the suggestions still waiting for a
 * decision (this report's, plus — on the live day — any made in conversation),
 * and the ones from this report the user has already decided on.
 */
export function nextActions(
  report: Pick<ReflectionReportDto, 'id'> | null,
  state: Pick<CoachStateDto, 'next' | 'reportActions'> | null,
  live: boolean,
): { undecided: CoachActionDto[]; decided: CoachActionDto[] } {
  if (!state) return { undecided: [], decided: [] };
  const ofReport = report ? state.reportActions.filter((a) => a.reportId === report.id) : [];
  const undecided = ofReport.filter((a) => a.status === 'suggested');
  if (live) {
    for (const a of state.next) if (!undecided.some((x) => x.id === a.id)) undecided.push(a);
  }
  return { undecided, decided: ofReport.filter((a) => a.status !== 'suggested' && a.status !== 'withdrawn') };
}

/** What the card asks, given where the action stands. */
export type CoachPrompt = 'decide' | 'committed' | 'did_it_happen' | 'did_it_help' | 'settled';

export function promptFor(action: Pick<CoachActionDto, 'status' | 'pending'>): CoachPrompt {
  if (action.status === 'suggested') return 'decide';
  if (action.status === 'accepted' || action.status === 'snoozed') return 'committed';
  if (action.pending === 'execution') return 'did_it_happen';
  if (action.pending === 'outcome') return 'did_it_help';
  return 'settled';
}

/** Whether a finished action went well, badly, or neither — for a quiet tone marker only. */
export function toneOf(action: Pick<CoachActionDto, 'status' | 'outcome' | 'execution'>): 'good' | 'bad' | 'neutral' {
  if (action.outcome === 'worked' || action.outcome === 'partly_worked') return 'good';
  if (action.outcome === 'did_not_work') return 'bad';
  return 'neutral';
}

// ── Settings ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes after midnight → the value of an `<input type="time">`. */
export function minutesToTimeInput(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The value of an `<input type="time">` → minutes after midnight, or null when malformed. */
export function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** The latest a day may start: someone working past midnight, not a night shift. */
export const MAX_DAY_START_MINUTES = 6 * 60;

// ── Conversation ────────────────────────────────────────────────────────────

/** What a coach message changed, in the user's words: "“Protect the morning” — marked as done". */
export function describeMessageChanges(
  message: Pick<CoachMessageDto, 'meta'>,
  titleOf: (actionId: string) => string | null,
): string[] {
  return (message.meta?.actions ?? []).map((change) => {
    const title = titleOf(change.actionId);
    return title ? `“${title}” — ${change.change}` : `An action was ${change.change}`;
  });
}

/** Every action the panel knows about, by id. */
export function actionIndex(state: CoachStateDto | null): Map<string, CoachActionDto> {
  const index = new Map<string, CoachActionDto>();
  if (!state) return index;
  for (const a of [...state.next, ...state.commitments, ...state.recent, ...state.reportActions]) index.set(a.id, a);
  return index;
}
