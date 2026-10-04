import type { AppSettingsStore, PauseDuration, TrackingPause } from './AppSettings.js';

/**
 * The one place that decides whether tracking is on.
 *
 * Tracking is passive: it starts with the background runtime and keeps running
 * with every window closed. The only thing that stops it is the user pausing
 * it (tray, widget, Settings) — and a pause is persisted, so it survives a
 * restart and is never silently undone.
 *
 * This class adds nothing to how tracking works. It starts and stops the
 * existing `TrackingService` and remembers why:
 *   - the pause itself lives in the application settings (`trackingPause`);
 *   - a finished pause is appended to the pause log, so later readers
 *     (Reflection) can tell "paused" apart from "nothing happened".
 *
 * Every transition goes through one queue: two quick clicks can never start
 * two trackers or stop one twice.
 */

export interface TrackingRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleSystemSuspend(): void;
  readonly isRunning: boolean;
}

export interface TrackingControllerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TrackingControllerDeps {
  tracking: TrackingRunner;
  settings: Pick<AppSettingsStore, 'get' | 'update'>;
  pauses: { recordPause(startedAt: string, endedAt: string): void };
  /** Start of the user's next day — when "until tomorrow" ends. */
  nextDayStart: (now: Date) => Date;
  now?: () => Date;
  timers?: TrackingControllerTimers;
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface TrackingState {
  state: 'running' | 'paused';
  pausedSince: string | null;
  /** Null while running, and for a pause that waits for the user. */
  pausedUntil: string | null;
}

/** setTimeout cannot wait longer than this; a longer pause re-arms. */
const MAX_TIMER_MS = 2_000_000_000;

export class TrackingController {
  private readonly now: () => Date;
  private readonly timers: TrackingControllerTimers;
  private readonly listeners = new Set<(state: TrackingState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private resumeTimer: unknown = null;
  private shutDown = false;

  constructor(private readonly deps: TrackingControllerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  getState(): TrackingState {
    // A timed pause that ran out without its timer firing (sleep, a stalled
    // process) is ended as soon as anyone looks.
    const stored = this.deps.settings.get().trackingPause;
    if (stored && this.isExpired(stored) && !this.shutDown) void this.handleSystemResume();
    const pause = this.activePause();
    return pause
      ? { state: 'paused', pausedSince: pause.since, pausedUntil: pause.until }
      : { state: 'running', pausedSince: null, pausedUntil: null };
  }

  /**
   * Begin with the background runtime. Tracking starts unless a pause from
   * before the restart is still in force; a pause that ran out while the app
   * was not running ends at the time it was meant to.
   */
  start(): Promise<TrackingState> {
    return this.enqueue(async () => {
      const stored = this.deps.settings.get().trackingPause;
      if (stored && this.isExpired(stored)) this.finishPause(stored, stored.until!);
      if (this.activePause()) {
        this.armResumeTimer();
        this.deps.logger?.info('[TRACKING] Paused by the user — not starting.');
      } else {
        await this.deps.tracking.start();
      }
      this.notify();
      return this.getState();
    });
  }

  pause(duration: PauseDuration): Promise<TrackingState> {
    return this.enqueue(async () => {
      if (this.shutDown) return this.getState();
      const now = this.now();
      const until = this.untilFor(duration, now);
      const existing = this.activePause();
      // Re-pausing while paused only moves the end; the pause began when it began.
      const since = existing?.since ?? now.toISOString();
      await this.deps.tracking.stop();
      this.deps.settings.update({ trackingPause: { since, until } });
      this.armResumeTimer();
      this.deps.logger?.info(`[TRACKING] Paused ${until ? `until ${until}` : 'until resumed'}.`);
      this.notify();
      return this.getState();
    });
  }

  resume(): Promise<TrackingState> {
    return this.enqueue(() => this.resumeNow(this.now().toISOString()));
  }

  /** The machine is going to sleep: end what is open so sleep is not tracked. */
  handleSystemSuspend(): void {
    try {
      this.deps.tracking.handleSystemSuspend();
    } catch (err) {
      this.deps.logger?.error(`[TRACKING] Suspend handling failed: ${messageOf(err)}`);
    }
  }

  /** Timers do not run during sleep: a timed pause may have ended meanwhile. */
  handleSystemResume(): Promise<TrackingState> {
    return this.enqueue(async () => {
      const stored = this.deps.settings.get().trackingPause;
      if (stored && this.isExpired(stored)) return this.resumeNow(stored.until!);
      this.armResumeTimer();
      return this.getState();
    });
  }

  /**
   * The app is quitting. Tracking stops and flushes, but the stored pause is
   * left exactly as it is: quitting is neither a pause nor a resume.
   */
  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      this.shutDown = true;
      this.clearResumeTimer();
      await this.deps.tracking.stop();
    });
  }

  /** How much of the pause in force right now falls inside [from, to), in ms. */
  currentPauseMsBetween(fromIso: string, toIso: string): number {
    const pause = this.activePause();
    if (!pause) return 0;
    const start = Math.max(Date.parse(pause.since), Date.parse(fromIso));
    const end = Math.min(this.now().getTime(), Date.parse(toIso));
    return Math.max(0, end - start);
  }

  onChanged(listener: (state: TrackingState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async resumeNow(endedAtIso: string): Promise<TrackingState> {
    if (this.shutDown) return this.getState();
    const stored = this.deps.settings.get().trackingPause;
    if (stored) this.finishPause(stored, endedAtIso);
    this.clearResumeTimer();
    // start() is a no-op when tracking already runs, so there is never a second tracker.
    await this.deps.tracking.start();
    if (stored) this.deps.logger?.info('[TRACKING] Resumed.');
    this.notify();
    return this.getState();
  }

  /** Log the pause that just ended and clear it from the settings. */
  private finishPause(pause: TrackingPause, endedAtIso: string): void {
    try {
      this.deps.pauses.recordPause(pause.since, endedAtIso);
    } catch (err) {
      this.deps.logger?.error(`[TRACKING] Could not record the pause: ${messageOf(err)}`);
    }
    this.deps.settings.update({ trackingPause: null });
  }

  private activePause(): TrackingPause | null {
    const pause = this.deps.settings.get().trackingPause;
    return pause && !this.isExpired(pause) ? pause : null;
  }

  private isExpired(pause: TrackingPause): boolean {
    return pause.until !== null && Date.parse(pause.until) <= this.now().getTime();
  }

  private untilFor(duration: PauseDuration, now: Date): string | null {
    switch (duration) {
      case '15m':
        return new Date(now.getTime() + 15 * 60_000).toISOString();
      case '1h':
        return new Date(now.getTime() + 60 * 60_000).toISOString();
      case 'tomorrow':
        return this.deps.nextDayStart(now).toISOString();
      case 'manual':
        return null;
    }
  }

  private armResumeTimer(): void {
    this.clearResumeTimer();
    const pause = this.activePause();
    if (!pause || pause.until === null || this.shutDown) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(pause.until) - this.now().getTime()));
    this.resumeTimer = this.timers.setTimeout(() => {
      this.resumeTimer = null;
      void this.enqueue(async () => {
        const stored = this.deps.settings.get().trackingPause;
        if (!stored) return;
        if (this.isExpired(stored)) await this.resumeNow(stored.until!);
        else this.armResumeTimer();
      });
    }, delay);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) this.timers.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        this.deps.logger?.error(`[TRACKING] State listener failed: ${messageOf(err)}`);
      }
    }
  }

  /** Run transitions one at a time; a failed one never blocks the next. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((err) => {
      this.deps.logger?.error(`[TRACKING] Transition failed: ${messageOf(err)}`);
    });
    return run;
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
