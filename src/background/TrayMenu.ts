import type { PauseDuration } from './AppSettings.js';
import type { BackgroundStatus } from './BackgroundStatus.js';
import { trackingLabel } from './statusFormat.js';
import type { UiNavigation } from './backgroundIpc.js';

/**
 * What the tray shows, as plain data.
 *
 * The tray is the background app's control centre: it is always there, also
 * with every window closed. It renders the same `BackgroundStatus` as the
 * widget and holds no state of its own. `main.ts` turns this model into an
 * Electron menu and routes each action; keeping the model free of Electron
 * makes the menu's contents testable.
 *
 * Focus entries keep their existing rule: ending a session — and quitting
 * while one runs — goes through the deliberate exit flow on the Focus page.
 * The tray is never a shortcut around a commitment.
 */

export type FocusIntentKind = 'open' | 'pause' | 'end';

export type TrayAction =
  | { type: 'open-main' }
  | { type: 'open-settings' }
  | { type: 'open-reflection' }
  | { type: 'open-focus'; intent: FocusIntentKind }
  | { type: 'resume-focus' }
  | { type: 'pause-tracking'; duration: PauseDuration }
  | { type: 'resume-tracking' }
  | { type: 'set-widget'; visible: boolean }
  | { type: 'quit' };

export interface TrayItem {
  label?: string;
  separator?: true;
  /** Informational line; not clickable. */
  disabled?: true;
  action?: TrayAction;
  submenu?: TrayItem[];
}

export interface TrayModel {
  tooltip: string;
  /** Tracking is paused — the icon is drawn dimmed. */
  paused: boolean;
  /** Changes exactly when the menu's contents change; the menu is rebuilt only then. */
  key: string;
  items: TrayItem[];
}

export const APP_DISPLAY_NAME = 'Reflect';

const SEPARATOR: TrayItem = { separator: true };

const PAUSE_CHOICES: { label: string; duration: PauseDuration }[] = [
  { label: 'For 15 minutes', duration: '15m' },
  { label: 'For 1 hour', duration: '1h' },
  { label: 'Until tomorrow', duration: 'tomorrow' },
  { label: 'Until I resume', duration: 'manual' },
];

const BLOCKING_LABELS: Record<NonNullable<BackgroundStatus['focus']>['blocking'], string> = {
  active: 'Blocking active',
  off: 'Blocking off',
  recovering: 'Restoring blocking…',
  unavailable: 'Blocking unavailable',
  degraded: 'Blocking stopped',
};

export function buildTrayModel(status: BackgroundStatus, now: Date = new Date()): TrayModel {
  const tracking = trackingLabel(status, now);
  const paused = status.tracking === 'paused';
  const focus = status.focus;
  const items: TrayItem[] = [];
  let tooltip = `${APP_DISPLAY_NAME} — ${tracking}`;
  let focusKey = 'idle';

  items.push({ label: `${APP_DISPLAY_NAME} — ${tracking}`, disabled: true }, SEPARATOR);

  // Tracking
  if (paused) {
    items.push({ label: 'Resume Tracking', action: { type: 'resume-tracking' } });
  } else {
    items.push({
      label: 'Pause Tracking',
      submenu: PAUSE_CHOICES.map((c) => ({ label: c.label, action: { type: 'pause-tracking', duration: c.duration } })),
    });
  }
  items.push(SEPARATOR);

  // Focus
  if (focus) {
    const focusPaused = !focus.isRunning;
    const task = focus.task.length > 48 ? `${focus.task.slice(0, 47)}…` : focus.task;
    const timeLabel =
      focus.remainingMs !== null
        ? `${Math.ceil(focus.remainingMs / 60_000)} min left`
        : `${Math.floor(focus.elapsedMs / 60_000)} min`;
    const blockingLabel = BLOCKING_LABELS[focus.blocking];
    tooltip = `${focusPaused ? 'Focus paused' : 'Focus'} · ${timeLabel} — ${task}${paused ? ' · tracking paused' : ''}`.slice(0, 120);
    focusKey = [focus.sessionId, focusPaused, timeLabel, blockingLabel].join('|');
    items.push(
      { label: `${focusPaused ? 'Focus paused' : 'Focus'}: ${timeLabel}`, disabled: true },
      { label: task, disabled: true },
      { label: blockingLabel, disabled: true },
      { label: 'Open Focus', action: { type: 'open-focus', intent: 'open' } },
      focusPaused
        ? { label: 'Resume Focus', action: { type: 'resume-focus' } }
        : { label: 'Pause Focus…', action: { type: 'open-focus', intent: 'pause' } },
      { label: 'End Focus…', action: { type: 'open-focus', intent: 'end' } },
    );
  } else {
    items.push({ label: 'Start Focus', action: { type: 'open-focus', intent: 'open' } });
  }
  items.push(SEPARATOR);

  // Windows
  items.push({ label: `Open ${APP_DISPLAY_NAME}`, action: { type: 'open-main' } });
  if (status.reflectionPending) items.push({ label: 'Open your reflection', action: { type: 'open-reflection' } });
  items.push(
    status.widgetVisible
      ? { label: 'Hide Widget', action: { type: 'set-widget', visible: false } }
      : { label: 'Show Widget', action: { type: 'set-widget', visible: true } },
    SEPARATOR,
    { label: 'Settings', action: { type: 'open-settings' } },
    SEPARATOR,
  );

  // Quitting would drop a running session's enforcement, so it goes through
  // the same exit flow as ending Focus.
  items.push(
    focus
      ? { label: 'Quit (end Focus first)…', action: { type: 'open-focus', intent: 'end' } }
      : { label: `Quit ${APP_DISPLAY_NAME}`, action: { type: 'quit' } },
  );

  const key = [tracking, focusKey, status.widgetVisible, status.reflectionPending].join('#');
  return { tooltip, paused, key, items };
}

export interface TrayDispatcherDeps {
  openMain: (target?: UiNavigation) => void;
  /** Where an unread reflection lives; null lets the tab decide. */
  reflectionAnchor: () => string | null;
  resumeFocus: () => void;
  pauseTracking: (duration: PauseDuration) => void;
  resumeTracking: () => void;
  setWidgetVisible: (visible: boolean) => void;
  quit: () => void;
}

/** Turns a clicked tray entry into the one thing it does. */
export function createTrayDispatcher(deps: TrayDispatcherDeps): (action: TrayAction) => void {
  return (action) => {
    switch (action.type) {
      case 'open-main':
        deps.openMain();
        break;
      case 'open-settings':
        deps.openMain({ route: 'settings' });
        break;
      case 'open-reflection':
        deps.openMain({ route: 'reflection', anchor: deps.reflectionAnchor() });
        break;
      case 'open-focus':
        deps.openMain({ route: 'focus', intent: action.intent });
        break;
      case 'resume-focus':
        deps.resumeFocus();
        break;
      case 'pause-tracking':
        deps.pauseTracking(action.duration);
        break;
      case 'resume-tracking':
        deps.resumeTracking();
        break;
      case 'set-widget':
        // Showing or hiding the widget is only that — tracking is not involved.
        deps.setWidgetVisible(action.visible);
        break;
      case 'quit':
        deps.quit();
        break;
    }
  };
}
