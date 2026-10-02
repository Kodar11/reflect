import type { BacklogResult } from './IntelligenceModels.js';
import type { IntelligenceLogger, IntelligenceService } from './IntelligenceService.js';

/**
 * Cadence only — no analysis logic of its own.
 *
 * On start it recovers runs interrupted by the previous shutdown and processes
 * the backlog in the background, then wakes shortly after every hour boundary
 * to analyse the hour that just completed. Each cycle is the service's
 * `processBacklog()`, i.e. the same pipeline the manual trigger uses, so a
 * missed tick (sleep, restart, Gemini outage) is simply picked up next time.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Run a little after the hour so the last events of the hour are flushed. */
const AFTER_HOUR_DELAY_MS = 2 * 60 * 1000;

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IntelligenceSchedulerOptions {
  logger?: IntelligenceLogger;
  now?: () => Date;
  timers?: SchedulerTimers;
  /** Called after a cycle that persisted at least one new analysis. */
  onAnalyzed?: () => void;
}

export class IntelligenceScheduler {
  private readonly log?: IntelligenceLogger;
  private readonly now: () => Date;
  private readonly timers: SchedulerTimers;
  private readonly onAnalyzed?: () => void;
  private handle: unknown = null;
  private started = false;
  private cycle: Promise<BacklogResult> | null = null;

  constructor(
    private readonly service: Pick<IntelligenceService, 'processBacklog' | 'recoverInterruptedRuns'>,
    options: IntelligenceSchedulerOptions = {},
  ) {
    this.log = options.logger;
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.onAnalyzed = options.onAnalyzed;
  }

  /** Non-blocking: startup reconciliation runs in the background. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.service.recoverInterruptedRuns();
    void this.runCycle();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  /** One reconciliation cycle. Overlapping calls share the in-flight cycle. */
  runCycle(): Promise<BacklogResult> {
    if (this.cycle) return this.cycle;
    this.cycle = this.service
      .processBacklog()
      .then((result) => {
        if (result.results.some((r) => r.status === 'succeeded')) {
          try {
            this.onAnalyzed?.();
          } catch {
            // A UI notification must never affect scheduling.
          }
        }
        return result;
      })
      .catch((err): BacklogResult => {
        this.log?.error(`[INTELLIGENCE] Scheduler cycle error: ${err instanceof Error ? err.message : String(err)}`);
        return { status: 'stopped', reason: 'internal', windowsConsidered: 0, results: [] };
      })
      .finally(() => {
        this.cycle = null;
      });
    return this.cycle;
  }

  /** Milliseconds until shortly after the next local hour boundary. */
  msUntilNextRun(): number {
    const now = this.now();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 0, 0);
    return nextHour.getTime() + HOUR_MS + AFTER_HOUR_DELAY_MS - now.getTime();
  }

  private scheduleNext(): void {
    if (!this.started) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      if (!this.started) return;
      void this.runCycle();
      this.scheduleNext();
    }, this.msUntilNextRun());
  }
}
