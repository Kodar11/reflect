import type { ActiveFocusSessionDto } from '../focus/FocusModels.js';
import type { Event } from '../models/Event.js';
import type { TrackingState } from './TrackingController.js';

/**
 * The single description of what the background runtime is doing.
 *
 * The main process owns it. The tray, the floating widget and the main window
 * all render this same object — none of them keeps a copy of its own, and
 * none of them computes any part of it.
 */
export interface BackgroundStatus {
  tracking: 'running' | 'paused';
  pausedSince: string | null;
  /** Null while running, and for a pause that waits for the user. */
  pausedUntil: string | null;
  /** Tracked time since the start of the user's day. */
  todayTrackedMs: number;
  /** What is in front right now; null when paused or nothing was seen lately. */
  currentActivity: BackgroundActivity | null;
  /** The running Focus session, as FocusService reports it. */
  focus: BackgroundFocus | null;
  widgetVisible: boolean;
  /** A reflection was written that the user has not opened yet. */
  reflectionPending: boolean;
  /** When this snapshot was taken — clocks shown from it count on from here. */
  asOf: string;
}

export interface BackgroundActivity {
  /** App name, with the site for a browser: "Chrome · github.com". */
  label: string;
  since: string;
}

export interface BackgroundFocus {
  sessionId: string;
  task: string;
  profileName: string;
  isRunning: boolean;
  pauseKind: 'manual' | 'idle' | null;
  /** Remaining time at `asOf`; null for a stopwatch. */
  remainingMs: number | null;
  /** Worked time at `asOf`. */
  elapsedMs: number;
  blocking: 'active' | 'off' | 'recovering' | 'degraded' | 'unavailable';
}

export interface BackgroundStatusDeps {
  tracking: { getState(): TrackingState };
  events: { sumTrackedMs(from: string, to: string): number; getLatest(): Event | null };
  focus: { getActiveSession(): ActiveFocusSessionDto | null };
  widgetVisible: () => boolean;
  /** Start of the user's current day (honours their day boundary). */
  dayStart: (now: Date) => Date;
  now?: () => Date;
  logger?: { error(m: string): void };
  /** How often the time-based parts are recomputed while nothing else changes. */
  refreshIntervalMs?: number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
}

/** An event counts as "current" only if it was still being extended this recently. */
const CURRENT_ACTIVITY_WINDOW_MS = 30_000;
const DEFAULT_REFRESH_MS = 60_000;

/**
 * Builds the status and tells listeners when it changed.
 *
 * Updates are event-driven: tracking, Focus, settings and reflection changes
 * call `refresh()`. The only timer is one slow tick (a minute) for the parts
 * that move with the clock — today's total and the current activity. Nothing
 * here runs per second and nothing here calls a model.
 */
export class BackgroundStatusService {
  private readonly now: () => Date;
  private readonly listeners = new Set<(status: BackgroundStatus) => void>();
  private readonly timers: NonNullable<BackgroundStatusDeps['timers']>;
  private timer: unknown = null;
  private lastKey = '';
  /** undefined = nothing pending; null = pending, let the Reflection tab pick the day. */
  private pendingReflectionAnchor: string | null | undefined = undefined;

  constructor(private readonly deps: BackgroundStatusDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? {
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.timers.setInterval(() => this.refresh(), this.deps.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
    this.refresh();
  }

  stop(): void {
    if (this.timer === null) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** A fresh snapshot. Never throws: a failing source degrades to "nothing known". */
  getStatus(): BackgroundStatus {
    const now = this.now();
    const tracking = this.safe(() => this.deps.tracking.getState(), {
      state: 'running',
      pausedSince: null,
      pausedUntil: null,
    } as TrackingState);
    const dayStart = this.safe(() => this.deps.dayStart(now), startOfLocalDay(now));
    const todayTrackedMs = this.safe(() => this.deps.events.sumTrackedMs(dayStart.toISOString(), now.toISOString()), 0);
    const currentActivity = tracking.state === 'running' ? this.safe(() => this.currentActivity(now), null) : null;
    const focus = this.safe(() => toBackgroundFocus(this.deps.focus.getActiveSession()), null);

    return {
      tracking: tracking.state,
      pausedSince: tracking.pausedSince,
      pausedUntil: tracking.pausedUntil,
      todayTrackedMs,
      currentActivity,
      focus,
      widgetVisible: this.safe(() => this.deps.widgetVisible(), false),
      reflectionPending: this.pendingReflectionAnchor !== undefined,
      asOf: now.toISOString(),
    };
  }

  /** Recompute and, if anything a surface shows has changed, tell the listeners. */
  refresh(): BackgroundStatus {
    const status = this.getStatus();
    const key = JSON.stringify({ ...status, asOf: null });
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const listener of this.listeners) {
        try {
          listener(status);
        } catch (err) {
          this.deps.logger?.error(`[STATUS] Listener failed: ${messageOf(err)}`);
        }
      }
    }
    return status;
  }

  onChanged(listener: (status: BackgroundStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A reflection was written in the background; `anchor` is an instant inside its day. */
  markReflectionPending(anchor: string | null): void {
    this.pendingReflectionAnchor = anchor;
    this.refresh();
  }

  /** The user opened the Reflection tab. */
  clearReflectionPending(): void {
    if (this.pendingReflectionAnchor === undefined) return;
    this.pendingReflectionAnchor = undefined;
    this.refresh();
  }

  /** Where "open the reflection" should land; null = let the tab decide. */
  get reflectionAnchor(): string | null {
    return this.pendingReflectionAnchor ?? null;
  }

  private currentActivity(now: Date): BackgroundActivity | null {
    const event = this.deps.events.getLatest();
    if (!event || event.watcher !== 'window') return null;
    if (now.getTime() - Date.parse(event.endedAt) > CURRENT_ACTIVITY_WINDOW_MS) return null;
    const label = activityLabel(event);
    return label ? { label, since: event.startedAt } : null;
  }

  private safe<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (err) {
      this.deps.logger?.error(`[STATUS] ${messageOf(err)}`);
      return fallback;
    }
  }
}

/** App name, plus the site when the app is a browser. Window titles are left out on purpose. */
export function activityLabel(event: Pick<Event, 'app' | 'browser' | 'url'>): string | null {
  const app = event.browser ?? event.app;
  if (!app) return event.url ?? null;
  return event.url ? `${app} · ${event.url}` : app;
}

export function toBackgroundFocus(dto: ActiveFocusSessionDto | null): BackgroundFocus | null {
  if (!dto) return null;
  return {
    sessionId: dto.session.id,
    task: dto.session.task,
    profileName: dto.profile.name,
    isRunning: dto.isRunning,
    pauseKind: dto.pauseKind,
    remainingMs: dto.remainingMs,
    elapsedMs: dto.liveElapsedMs,
    blocking: dto.blocking.status,
  };
}

function startOfLocalDay(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
