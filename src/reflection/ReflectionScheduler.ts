import type { GenerateResult, ReflectionErrorCategory, ReflectionLogger } from './ReflectionModels.js';
import type { ReflectionService } from './ReflectionService.js';

/**
 * Cadence only — no reflection logic of its own.
 *
 * A cycle is run right after every cycle of the existing
 * `IntelligenceScheduler` (startup, then shortly after each hour), so the AI
 * activities of the hour that just ended always exist before a reflection is
 * written from them. Each cycle asks the service which reports are due —
 * closed days / weeks / months / years without one, then today's reflection
 * once the user's reflection time has passed (or the day has wound down) —
 * and generates them in order. A missed tick (sleep, restart, Gemini outage)
 * is simply picked up next time.
 *
 * Its one timer exists so the end-of-day reflection does not wait for the
 * next hourly tick: it wakes at the user's reflection time and asks for a
 * cycle then.
 */

/** Failures that will hit every other report too — stop the cycle. */
const CYCLE_STOPPING_CATEGORIES: ReflectionErrorCategory[] = ['missing_api_key', 'quota', 'network', 'api'];

/** Wake a little after the reflection time, so "now >= due" holds. */
const AFTER_DUE_DELAY_MS = 30_000;
const MIN_WAKE_DELAY_MS = 60_000;

export interface ReflectionCycleResult {
  status: 'completed' | 'stopped' | 'unavailable';
  /** Why the cycle stopped early, when it did. */
  reason?: string;
  results: GenerateResult[];
}

export interface ReflectionSchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReflectionSchedulerOptions {
  logger?: ReflectionLogger;
  /** Called after a cycle that persisted at least one reflection. */
  onGenerated?: (results: GenerateResult[]) => void;
  /**
   * Called when the day's reflection time arrives. The host uses it to bring
   * the AI activities up to date first; by default a cycle is simply run.
   */
  onDailyReflectionDue?: () => void;
  now?: () => Date;
  timers?: ReflectionSchedulerTimers;
}

type SchedulableService = Pick<ReflectionService, 'isConfigured' | 'pendingScheduledPeriods' | 'generate' | 'recoverInterrupted'> &
  Partial<Pick<ReflectionService, 'nextDailyReflectionAt'>>;

export class ReflectionScheduler {
  private started = false;
  private cycle: Promise<ReflectionCycleResult> | null = null;
  private handle: unknown = null;
  private readonly now: () => Date;
  private readonly timers: ReflectionSchedulerTimers;

  constructor(
    private readonly service: SchedulableService,
    private readonly options: ReflectionSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /** Recover generations interrupted by the previous shutdown and arm the end-of-day wake-up. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.service.recoverInterrupted();
    this.scheduleDailyWake();
  }

  stop(): void {
    this.started = false;
    this.clearWake();
  }

  /** The reflection time (or the day boundary) changed: aim the wake-up at the new time. */
  reschedule(): void {
    if (!this.started) return;
    this.clearWake();
    this.scheduleDailyWake();
  }

  /** Milliseconds until the next end-of-day wake-up; null when the service has no reflection time. */
  msUntilDailyWake(): number | null {
    const due = this.service.nextDailyReflectionAt?.();
    if (!due) return null;
    return Math.max(MIN_WAKE_DELAY_MS, due.getTime() - this.now().getTime() + AFTER_DUE_DELAY_MS);
  }

  private clearWake(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  private scheduleDailyWake(): void {
    if (!this.started) return;
    const delay = this.msUntilDailyWake();
    if (delay === null) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      if (!this.started) return;
      try {
        if (this.options.onDailyReflectionDue) this.options.onDailyReflectionDue();
        else void this.runCycle();
      } catch (err) {
        this.options.logger?.error(`[REFLECTION] End-of-day wake-up failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.scheduleDailyWake();
    }, delay);
  }

  /** One scheduling cycle. Overlapping calls share the in-flight cycle. */
  runCycle(): Promise<ReflectionCycleResult> {
    if (this.cycle) return this.cycle;
    this.cycle = this.run()
      .catch((err): ReflectionCycleResult => {
        this.options.logger?.error(`[REFLECTION] Scheduler cycle error: ${err instanceof Error ? err.message : String(err)}`);
        return { status: 'stopped', reason: 'internal', results: [] };
      })
      .finally(() => {
        this.cycle = null;
      });
    return this.cycle;
  }

  private async run(): Promise<ReflectionCycleResult> {
    const results: GenerateResult[] = [];
    if (!this.started) return { status: 'stopped', reason: 'not_started', results };
    if (!this.service.isConfigured()) return { status: 'unavailable', reason: 'missing_api_key', results };

    let outcome: ReflectionCycleResult = { status: 'completed', results };
    for (const period of await this.service.pendingScheduledPeriods()) {
      if (!this.started) {
        outcome = { status: 'stopped', reason: 'stopped', results };
        break;
      }
      const result = await this.service.generate(period, { trigger: 'scheduled' });
      results.push(result);
      if (result.status === 'failed' && CYCLE_STOPPING_CATEGORIES.includes(result.category)) {
        this.options.logger?.warn(`[REFLECTION] Cycle stopped (${result.category}); remaining reports wait for the next cycle.`);
        outcome = { status: 'stopped', reason: result.category, results };
        break;
      }
    }

    if (results.some((r) => r.status === 'succeeded')) {
      try {
        this.options.onGenerated?.(results);
      } catch {
        // A UI notification must never affect scheduling.
      }
    }
    return outcome;
  }
}
