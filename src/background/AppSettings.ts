/**
 * Application-level preferences owned by the background runtime.
 *
 * One store, read by the main process with no window open: nothing here lives
 * in localStorage or renderer memory. The UI (Settings, onboarding, the
 * widget, the tray) reads and changes these values through IPC only.
 */

/** How long a pause lasts. `manual` = until the user resumes. */
export const PAUSE_DURATIONS = ['15m', '1h', 'tomorrow', 'manual'] as const;
export type PauseDuration = (typeof PAUSE_DURATIONS)[number];

export function isPauseDuration(value: unknown): value is PauseDuration {
  return typeof value === 'string' && (PAUSE_DURATIONS as readonly string[]).includes(value);
}

/** Tracking is paused from `since`; `until: null` means until the user resumes. */
export interface TrackingPause {
  since: string;
  until: string | null;
}

export interface WidgetPosition {
  x: number;
  y: number;
}

export interface AppSettings {
  /** Launch quietly at sign-in (packaged builds only). */
  startWithWindows: boolean;
  /** Null while tracking is on. */
  trackingPause: TrackingPause | null;
  widgetEnabled: boolean;
  /** Top-left of the collapsed widget; null until the user has moved it. */
  widgetPosition: WidgetPosition | null;
  /** Master switch for notifications. */
  notificationsEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  startWithWindows: true,
  trackingPause: null,
  widgetEnabled: true,
  widgetPosition: null,
  notificationsEnabled: true,
};

const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Coerce anything (stored JSON, an IPC payload) into valid settings. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

  let trackingPause: TrackingPause | null = null;
  const pause = src.trackingPause as Record<string, unknown> | null | undefined;
  if (pause && typeof pause === 'object' && isIso(pause.since)) {
    trackingPause = { since: pause.since, until: isIso(pause.until) ? pause.until : null };
  }

  let widgetPosition: WidgetPosition | null = null;
  const position = src.widgetPosition as Record<string, unknown> | null | undefined;
  if (position && typeof position === 'object' && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    widgetPosition = { x: Math.round(position.x as number), y: Math.round(position.y as number) };
  }

  return {
    startWithWindows: bool(src.startWithWindows, DEFAULT_APP_SETTINGS.startWithWindows),
    trackingPause,
    widgetEnabled: bool(src.widgetEnabled, DEFAULT_APP_SETTINGS.widgetEnabled),
    widgetPosition,
    notificationsEnabled: bool(src.notificationsEnabled, DEFAULT_APP_SETTINGS.notificationsEnabled),
  };
}

export interface IAppSettingsRepository {
  getSettings(): AppSettings;
  saveSettings(settings: AppSettings, nowIso: string): void;
}

export type AppSettingsListener = (settings: AppSettings, previous: AppSettings) => void;

/**
 * The in-process view of the stored settings. Reads are served from memory;
 * every change is written through to the repository and announced to
 * listeners (tray, widget, login item, status).
 *
 * A storage failure never throws into the runtime: the change still applies
 * for this run and the failure is logged.
 */
export class AppSettingsStore {
  private current: AppSettings;
  private readonly listeners = new Set<AppSettingsListener>();

  constructor(
    private readonly repo: IAppSettingsRepository,
    private readonly options: { now?: () => Date; log?: (message: string) => void } = {},
  ) {
    try {
      this.current = normalizeAppSettings(repo.getSettings());
    } catch (err) {
      this.options.log?.(`[SETTINGS] Could not read settings, using defaults: ${messageOf(err)}`);
      this.current = { ...DEFAULT_APP_SETTINGS };
    }
  }

  get(): AppSettings {
    return { ...this.current };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const previous = this.current;
    const next = normalizeAppSettings({ ...previous, ...patch });
    if (JSON.stringify(next) === JSON.stringify(previous)) return this.get();
    this.current = next;
    try {
      this.repo.saveSettings(next, (this.options.now?.() ?? new Date()).toISOString());
    } catch (err) {
      this.options.log?.(`[SETTINGS] Could not save settings: ${messageOf(err)}`);
    }
    for (const listener of this.listeners) {
      try {
        listener(this.get(), { ...previous });
      } catch (err) {
        this.options.log?.(`[SETTINGS] Change listener failed: ${messageOf(err)}`);
      }
    }
    return this.get();
  }

  onChanged(listener: AppSettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
