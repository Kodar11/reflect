import type { GenerateResult, ReflectionErrorCategory, ReflectionLogger } from './ReflectionModels.js';
import type { ReflectionService } from './ReflectionService.js';

/**
 * Cadence only — no reflection logic of its own.
 *
 * It has no timer. A cycle is run right after every cycle of the existing
 * `IntelligenceScheduler` (startup, then shortly after each hour), so the AI
 * activities of the hour that just ended always exist before a reflection is
 * written from them. Each cycle asks the service which reports are due —
 * closed days / weeks / months / years without one, then today's reflection
 * once the daily reflection time has passed — and generates them in order. A
 * missed tick (sleep, restart, Gemini outage) is simply picked up next time.
 */

/** Failures that will hit every other report too — stop the cycle. */
const CYCLE_STOPPING_CATEGORIES: ReflectionErrorCategory[] = ['missing_api_key', 'quota', 'network', 'api'];

export interface ReflectionCycleResult {
  status: 'completed' | 'stopped' | 'unavailable';
  /** Why the cycle stopped early, when it did. */
  reason?: string;
  results: GenerateResult[];
}

export interface ReflectionSchedulerOptions {
  logger?: ReflectionLogger;
  /** Called after a cycle that persisted at least one reflection. */
  onGenerated?: () => void;
}

export class ReflectionScheduler {
  private started = false;
  private cycle: Promise<ReflectionCycleResult> | null = null;

  constructor(
    private readonly service: Pick<
      ReflectionService,
      'isConfigured' | 'pendingScheduledPeriods' | 'generate' | 'recoverInterrupted'
    >,
    private readonly options: ReflectionSchedulerOptions = {},
  ) {}

  /** Recover generations interrupted by the previous shutdown. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.service.recoverInterrupted();
  }

  stop(): void {
    this.started = false;
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
        this.options.onGenerated?.();
      } catch {
        // A UI notification must never affect scheduling.
      }
    }
    return outcome;
  }
}
