/**
 * Pure view logic for the Reflection page — no React, no Electron.
 *
 * The main process owns reflection state; these helpers only decide how a
 * `ReflectionViewDto` is presented: which screen to show, how to move between
 * periods, where an evidence link lands on the Timeline.
 */
import { DEFAULT_REFLECTION_CONFIG } from '../../reflection/ReflectionModels';
import { formatClockMinutes, formatDay, shiftPeriod } from '../../reflection/ReflectionPeriods';

export const PERIOD_TABS: { type: ReflectionPeriodTypeDto; label: string }[] = [
  { type: 'day', label: 'Today' },
  { type: 'week', label: 'Week' },
  { type: 'month', label: 'Month' },
  { type: 'year', label: 'Year' },
];

/** Section headings, phrased the way a briefing would introduce them. */
export const INSIGHT_TYPE_LABELS: Record<ReflectionInsightTypeDto, string> = {
  progress: 'Progress',
  priority_alignment: 'Priority alignment',
  time_attention_pattern: 'Where attention went',
  fragmentation: 'Fragmentation',
  consistency_momentum: 'Consistency',
  recurring_behavior: 'A pattern emerged',
  change_over_time: 'What changed',
  open_loop: 'Open loop',
  unexpected: 'Unexpected',
};

export const FEEDBACK_OPTIONS: { value: ReflectionFeedbackDto; label: string }[] = [
  { value: 'useful', label: 'Useful' },
  { value: 'not_useful', label: 'Not useful' },
  { value: 'inaccurate', label: 'Not accurate' },
];

export type ReflectionScreen =
  | 'loading'
  | 'error'
  /** A reflection exists for this period. */
  | 'report'
  /** Nothing written yet and one is being written right now. */
  | 'generating'
  /** Nothing written, and the last attempt failed. */
  | 'failed'
  /** Too little activity to reflect on. */
  | 'insufficient'
  /** Gemini is not configured: deterministic numbers only. */
  | 'unconfigured'
  /** Enough activity, nothing written (yet). */
  | 'pending';

export function deriveScreen(state: { view: ReflectionViewDto | null; loading: boolean; error: string | null }): ReflectionScreen {
  const { view } = state;
  if (!view) return state.error ? 'error' : 'loading';
  if (view.report) return 'report';
  if (view.generation.state === 'generating') return 'generating';
  if (!view.sufficiency.enough || view.generation.state === 'insufficient_data') return 'insufficient';
  if (view.generation.state === 'failed') return 'failed';
  if (!view.configured) return 'unconfigured';
  return 'pending';
}

/** An ISO instant inside the period `offset` periods away — what the IPC call takes as `anchor`. */
export function anchorForOffset(period: ReflectionPeriodDto, offset: number): string {
  return shiftPeriod(period, offset).start;
}

/** Can the user step to the previous / next period? Never into the future, never before tracking began. */
export function navigationState(view: ReflectionViewDto | null): { canGoPrevious: boolean; canGoNext: boolean; isCurrent: boolean } {
  if (!view) return { canGoPrevious: false, canGoNext: false, isCurrent: true };
  return { canGoPrevious: view.period.hasPrevious, canGoNext: view.period.hasNext, isCurrent: view.period.isCurrent };
}

export type TimelineViewName = 'day' | 'week' | 'month' | 'year';

export interface TimelineTarget {
  /** ISO instant inside the day the Timeline should open on. */
  day: string;
  view: TimelineViewName;
  /** Timeline block to select, when the evidence is one activity. */
  activityId: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * Where "View in timeline" lands: the evidence's own window when it has one,
 * otherwise the reflection's period — in the smallest Timeline view that
 * shows all of it.
 */
export function timelineTargetFor(
  evidence: Pick<ReflectionEvidenceDto, 'period' | 'activityId'> | null,
  period: Pick<ReflectionPeriodDto, 'start' | 'end'>,
): TimelineTarget {
  const window = evidence?.period ?? { start: period.start, end: period.end };
  const start = Date.parse(window.start);
  // `end` is exclusive; step back so a full day does not spill into the next.
  const lastInstant = Math.max(start, Date.parse(window.end) - 1);
  const sameDay = new Date(start).toDateString() === new Date(lastInstant).toDateString();
  const span = lastInstant - start;
  const view: TimelineViewName = sameDay ? 'day' : span <= 7 * 24 * HOUR_MS ? 'week' : span <= 31 * 24 * HOUR_MS ? 'month' : 'year';
  return { day: window.start, view, activityId: evidence?.activityId ?? null };
}

/** Clicking the active choice clears it; clicking another replaces it. */
export function nextFeedback(current: ReflectionFeedbackDto | null, clicked: ReflectionFeedbackDto): ReflectionFeedbackDto | null {
  return current === clicked ? null : clicked;
}

/** `Generated Mon, Oct 19, 12:05 AM`. */
export function formatGeneratedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${formatDay(d)}, ${formatClockMinutes(d.getHours() * 60 + d.getMinutes())}`;
}

export function staleMessage(reason: string | null): string {
  return reason === 'priorities_changed'
    ? 'Your priorities changed after this reflection was written.'
    : 'The activity in this period changed after this reflection was written.';
}

/** The label of the generate / refresh button for this view. */
export function refreshLabel(view: ReflectionViewDto): string {
  if (view.report) return 'Refresh reflection';
  return view.period.isCurrent ? 'Reflect now' : 'Generate reflection';
}

/** Why the refresh button is unavailable, when that is worth telling the user. */
export function refreshHint(view: ReflectionViewDto): string | null {
  switch (view.refreshBlockedReason) {
    case 'cooldown':
      return view.refreshAvailableAt
        ? `You can refresh again at ${formatClockMinutes(new Date(view.refreshAvailableAt).getHours() * 60 + new Date(view.refreshAvailableAt).getMinutes())}.`
        : 'You can refresh again shortly.';
    case 'not_configured':
      return 'Add a Gemini API key to have Reflect write reflections.';
    default:
      return null;
  }
}

/** What to say when a refresh did not produce a new reflection. */
export function generateResultNotice(result: ReflectionGenerateResultDto): string | null {
  if (result.status === 'succeeded') return null;
  if (result.status === 'skipped') {
    switch (result.reason) {
      case 'throttled':
        return 'This reflection was refreshed a moment ago.';
      case 'up_to_date':
        return 'This reflection is already up to date.';
      case 'insufficient_data':
        return 'There is not enough activity in this period to reflect on yet.';
      default:
        return null;
    }
  }
  switch (result.category) {
    case 'missing_api_key':
      return 'Gemini is not configured, so a reflection could not be written.';
    case 'network':
    case 'api':
    case 'quota':
      return 'Reflect could not reach Gemini, so nothing was changed.';
    case 'validation':
    case 'malformed_output':
      return 'The generated reflection did not pass Reflect’s evidence checks, so it was discarded.';
    default:
      return 'Something went wrong while writing this reflection.';
  }
}

/** `10:00 PM` — when today's reflection is written: the user's own time when the view carries it. */
export function dailyReflectionTimeLabel(view?: Pick<ReflectionViewDto, 'dailyReflectionAt'> | null): string {
  if (view?.dailyReflectionAt) {
    const at = new Date(view.dailyReflectionAt);
    if (!Number.isNaN(at.getTime())) return formatClockMinutes(at.getHours() * 60 + at.getMinutes());
  }
  const { dailyReflectionHour, dailyReflectionMinute } = DEFAULT_REFLECTION_CONFIG;
  return formatClockMinutes(dailyReflectionHour * 60 + dailyReflectionMinute);
}

/** Short tile label for a supporting number (the full label stays as its tooltip). */
export function shortMetricLabel(metric: Pick<ReflectionMetricDto, 'key' | 'label'>): string {
  if (metric.key === 'time.tracked_minutes') return 'Tracked';
  if (metric.key === 'time.focused_minutes') return 'Focused';
  if (metric.key === 'block.longest_minutes') return 'Longest block';
  if (metric.key === 'behavior.switches') return 'Context switches';
  if (metric.key === 'days.active') return 'Active days';
  if (/^priority\.[^.]+\.minutes$/.test(metric.key)) return 'Current priority';
  return metric.label;
}
