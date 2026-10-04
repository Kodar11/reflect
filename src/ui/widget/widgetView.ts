import { formatFocusClock, formatPauseEnd, formatTrackedDuration, trackingLabel } from '../../background/statusFormat';

/**
 * What the floating widget shows for a background status — pure, so it is
 * testable without a DOM. The widget owns none of this: every value comes from
 * the status the main process pushed, and Focus values are the ones
 * FocusService reported.
 */

export type WidgetTone = 'running' | 'paused' | 'focus' | 'focus-paused';

export interface WidgetButton {
  label: string;
  action: WidgetActionDto | 'choose-pause' | 'cancel-pause';
  primary?: boolean;
}

export interface WidgetView {
  tone: WidgetTone;
  pill: { label: string; value: string };
  card: {
    title: string;
    /** The Focus clock; empty outside Focus. */
    clock: string;
    /** Label / value rows. */
    rows: { label: string; value: string }[];
    /** Free lines (the Focus task, a "reflection ready" note). */
    lines: { text: string; kind: 'plain' | 'muted' | 'note' }[];
    buttons: WidgetButton[];
    /** The pause choices are laid out as a grid. */
    grid: boolean;
  };
  /** The Focus clock is counting, so it needs a per-second repaint. */
  ticking: boolean;
}

const PAUSE_BUTTONS: WidgetButton[] = [
  { label: '15 minutes', action: { type: 'pause-tracking', duration: '15m' } },
  { label: '1 hour', action: { type: 'pause-tracking', duration: '1h' } },
  { label: 'Until tomorrow', action: { type: 'pause-tracking', duration: 'tomorrow' } },
  { label: 'Until I resume', action: { type: 'pause-tracking', duration: 'manual' } },
];

/** The Focus clock at `now`: the status' value, counted on while the session runs. */
export function focusClockMs(status: BackgroundStatusDto, now: Date): number {
  const focus = status.focus;
  if (!focus) return 0;
  const drift = focus.isRunning ? Math.max(0, now.getTime() - Date.parse(status.asOf)) : 0;
  return focus.remainingMs !== null ? Math.max(0, focus.remainingMs - drift) : focus.elapsedMs + drift;
}

export function buildWidgetView(status: BackgroundStatusDto, now: Date, choosingPause = false): WidgetView {
  const paused = status.tracking === 'paused';
  const focus = status.focus;
  const tracking = trackingLabel(status, now);

  const trackingButton: WidgetButton = paused
    ? { label: 'Resume', action: { type: 'resume-tracking' } }
    : { label: 'Pause', action: 'choose-pause' };
  const openButton: WidgetButton = status.reflectionPending
    ? { label: 'Open reflection', action: { type: 'open-reflection' }, primary: true }
    : { label: 'Open Reflect', action: { type: 'open-main' }, primary: true };
  const hideButton: WidgetButton = { label: 'Hide', action: { type: 'hide' } };

  if (choosingPause && !paused) {
    return {
      tone: focus ? (focus.isRunning ? 'focus' : 'focus-paused') : 'running',
      pill: pillFor(status, now),
      card: {
        title: 'Pause tracking for…',
        clock: '',
        rows: [],
        lines: [],
        buttons: [...PAUSE_BUTTONS, { label: 'Cancel', action: 'cancel-pause' }],
        grid: true,
      },
      ticking: false,
    };
  }

  if (focus) {
    const clock = formatFocusClock(focusClockMs(status, now));
    return {
      tone: focus.isRunning ? 'focus' : 'focus-paused',
      pill: pillFor(status, now),
      card: {
        title: focus.isRunning ? 'Focus' : 'Focus paused',
        clock: focus.remainingMs !== null ? `${clock} left` : clock,
        rows: [],
        lines: [
          { text: focus.task, kind: 'plain' },
          { text: `${focus.profileName} · ${paused ? tracking : 'Tracking on'}`, kind: 'muted' },
        ],
        // Pausing and ending Focus live on the Focus page, behind their own flows.
        buttons: [{ label: 'Open Focus', action: { type: 'open-focus' }, primary: true }, trackingButton, hideButton],
        grid: false,
      },
      ticking: focus.isRunning,
    };
  }

  return {
    tone: paused ? 'paused' : 'running',
    pill: pillFor(status, now),
    card: {
      title: paused ? 'Tracking paused' : 'Tracking',
      clock: '',
      rows: [
        { label: 'Today', value: formatTrackedDuration(status.todayTrackedMs) },
        paused
          ? { label: 'Resumes', value: status.pausedUntil ? formatPauseEnd(status.pausedUntil, now) : 'When you resume it' }
          : { label: 'Current', value: status.currentActivity?.label ?? '—' },
      ],
      lines: status.reflectionPending ? [{ text: 'Your reflection is ready', kind: 'note' }] : [],
      buttons: [openButton, { label: 'Focus', action: { type: 'open-focus' } }, trackingButton, hideButton],
      grid: false,
    },
    ticking: false,
  };
}

function pillFor(status: BackgroundStatusDto, now: Date): { label: string; value: string } {
  if (status.focus) {
    return { label: status.focus.isRunning ? 'Focus' : 'Focus paused', value: formatFocusClock(focusClockMs(status, now)) };
  }
  if (status.tracking === 'paused') return { label: 'Tracking paused', value: '' };
  return { label: 'Tracking', value: formatTrackedDuration(status.todayTrackedMs) };
}
