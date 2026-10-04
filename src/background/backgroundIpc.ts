import { isPauseDuration, type PauseDuration } from './AppSettings.js';
import type { BackgroundStatus } from './BackgroundStatus.js';
import type { FocusIntentKind } from './TrayMenu.js';
import type { TrackingState } from './TrackingController.js';

/**
 * IPC for the background runtime — the smallest surface that lets a UI show
 * the status and change the handful of things a user may change.
 *
 * Two audiences, two sets of channels, each accepted only from its own page:
 *   - `background:*` — the main window (Settings, onboarding, sidebar);
 *   - `widget:*`     — the floating widget, which gets the status and five
 *     actions and nothing else: no database, no timeline, no Focus control.
 *
 * Every argument that arrives here is checked; anything unexpected is refused.
 * Renderers ask — the main process decides.
 */

/** Where the main window should go when it is opened from outside (tray, widget, notification). */
export type UiNavigation =
  | { route: 'settings' }
  | { route: 'focus'; intent: FocusIntentKind }
  | { route: 'reflection'; anchor: string | null };

/**
 * A navigation request waiting for the main window. The window may not exist
 * yet (background start) or may still be loading, so the request is parked
 * here and the renderer collects it — on mount, and whenever it is pinged.
 */
export class PendingNavigation {
  private pending: UiNavigation | null = null;

  set(navigation: UiNavigation): void {
    this.pending = navigation;
  }

  take(): UiNavigation | null {
    const navigation = this.pending;
    this.pending = null;
    return navigation;
  }
}

/** The background preferences as Settings and onboarding see them. */
export interface BackgroundSettingsView {
  startWithWindows: boolean;
  widgetEnabled: boolean;
  notificationsEnabled: boolean;
  /** False in a development build: the login item is never registered there. */
  startupAvailable: boolean;
  /** Registered, but switched off in Windows' own startup settings. */
  startupDisabledBySystem: boolean;
}

export type BackgroundSettingsPatch = Partial<Pick<BackgroundSettingsView, 'startWithWindows' | 'widgetEnabled' | 'notificationsEnabled'>>;

export type WidgetAction =
  | { type: 'open-main' }
  | { type: 'open-focus' }
  | { type: 'open-reflection' }
  | { type: 'pause-tracking'; duration: PauseDuration }
  | { type: 'resume-tracking' }
  | { type: 'hide' };

const SETTINGS_KEYS = ['startWithWindows', 'widgetEnabled', 'notificationsEnabled'] as const;
const DRAG_PHASES = ['start', 'move', 'end'] as const;
type DragPhase = (typeof DRAG_PHASES)[number];

/** Only known boolean keys survive; anything else is an error, not a silent no-op. */
export function parseSettingsPatch(payload: unknown): BackgroundSettingsPatch {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('background:updateSettings requires an object');
  const patch: BackgroundSettingsPatch = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) throw new Error(`background:updateSettings does not accept "${key}"`);
    if (typeof value !== 'boolean') throw new Error(`background:updateSettings requires a boolean for "${key}"`);
    patch[key as (typeof SETTINGS_KEYS)[number]] = value;
  }
  return patch;
}

export function parsePauseDuration(payload: unknown, channel: string): PauseDuration {
  const duration = (payload as { duration?: unknown } | null | undefined)?.duration;
  if (!isPauseDuration(duration)) throw new Error(`${channel} requires a valid duration`);
  return duration;
}

export function parseWidgetAction(payload: unknown): WidgetAction {
  const type = (payload as { type?: unknown } | null | undefined)?.type;
  switch (type) {
    case 'open-main':
    case 'open-focus':
    case 'open-reflection':
    case 'resume-tracking':
    case 'hide':
      return { type };
    case 'pause-tracking':
      return { type, duration: parsePauseDuration(payload, 'widget:act') };
    default:
      throw new Error('widget:act received an unknown action');
  }
}

export interface BackgroundIpcDeps {
  status: { getStatus(): BackgroundStatus };
  tracking: { pause(duration: PauseDuration): Promise<TrackingState>; resume(): Promise<TrackingState> };
  settings: { view(): BackgroundSettingsView; update(patch: BackgroundSettingsPatch): BackgroundSettingsView };
  navigation: PendingNavigation;
  widget: {
    setEnabled(enabled: boolean): void;
    setExpanded(expanded: boolean): void;
    dragStart(): void;
    dragMove(): void;
    dragEnd(): void;
  };
  /** Show the main window, optionally at a specific place. */
  openMain: (navigation?: UiNavigation) => void;
  /** Where an unread reflection lives; null lets the tab decide. */
  reflectionAnchor: () => string | null;
}

export interface BackgroundIpcRegistrars {
  /** `ipcMain.handle` restricted to the main window's page. */
  handleMain: (key: string, handler: (payload?: any) => any) => void;
  /** `ipcMain.handle` restricted to the widget's page. */
  handleWidget: (key: string, handler: (payload?: any) => any) => void;
  /** `ipcMain.on` restricted to the widget's page. */
  onWidget: (key: string, handler: (payload: any) => void) => void;
}

export function registerBackgroundIpc(deps: BackgroundIpcDeps, ipc: BackgroundIpcRegistrars): void {
  // ── Main window ────────────────────────────────────────────────────────────
  ipc.handleMain('background:getStatus', () => deps.status.getStatus());
  ipc.handleMain('background:getSettings', () => deps.settings.view());
  ipc.handleMain('background:updateSettings', (p?: unknown) => deps.settings.update(parseSettingsPatch(p)));
  ipc.handleMain('background:pauseTracking', async (p?: unknown) => {
    await deps.tracking.pause(parsePauseDuration(p, 'background:pauseTracking'));
    return deps.status.getStatus();
  });
  ipc.handleMain('background:resumeTracking', async () => {
    await deps.tracking.resume();
    return deps.status.getStatus();
  });
  ipc.handleMain('background:takeNavigation', () => deps.navigation.take());

  // ── Widget ─────────────────────────────────────────────────────────────────
  ipc.handleWidget('widget:getStatus', () => deps.status.getStatus());
  ipc.handleWidget('widget:setExpanded', (p?: unknown) => {
    if (typeof p !== 'boolean') throw new Error('widget:setExpanded requires a boolean');
    deps.widget.setExpanded(p);
  });
  ipc.handleWidget('widget:act', async (p?: unknown) => {
    const action = parseWidgetAction(p);
    switch (action.type) {
      case 'open-main':
        deps.openMain();
        break;
      case 'open-focus':
        // Pausing and ending live on the Focus page, behind their deliberate flows.
        deps.openMain({ route: 'focus', intent: 'open' });
        break;
      case 'open-reflection':
        deps.openMain({ route: 'reflection', anchor: deps.reflectionAnchor() });
        break;
      case 'pause-tracking':
        await deps.tracking.pause(action.duration);
        break;
      case 'resume-tracking':
        await deps.tracking.resume();
        break;
      case 'hide':
        // Hiding the widget is only that: tracking is untouched.
        deps.widget.setEnabled(false);
        break;
    }
  });
  ipc.onWidget('widget:drag', (p: unknown) => {
    if (!(DRAG_PHASES as readonly unknown[]).includes(p)) return;
    const phase = p as DragPhase;
    if (phase === 'start') deps.widget.dragStart();
    else if (phase === 'move') deps.widget.dragMove();
    else deps.widget.dragEnd();
  });
}
