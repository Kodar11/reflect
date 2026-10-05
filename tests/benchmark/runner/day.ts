import type { AnalysisResult, BacklogResult } from '../../../src/intelligence/IntelligenceModels';
import type { ReflectionPeriod } from '../../../src/reflection/ReflectionModels';
import { periodContaining } from '../../../src/reflection/ReflectionPeriods';
import type { ReflectionCycleResult } from '../../../src/reflection/ReflectionScheduler';
import type { SimulatedClock } from './clock';
import type { ActionPolicy, IntelligenceWindowMode, UrlMode } from './config';
import type { ReflectDayInput } from './dataset';
import { ingestDay, type StoredEventRef } from './ingest';
import type { BenchmarkRuntime } from './runtime';

/**
 * One simulated day, start to finish, through the production pipeline:
 *
 *   raw events → events table → (clock moves to the end of the day)
 *     → one intelligence cycle → one reflection cycle → coach observation
 *
 * This module sees `ReflectDayInput` only. It imports nothing from the answer
 * key and nothing from `evaluators/`; what the day really was is unknown here,
 * exactly as it is unknown to Reflect.
 */

/** Failures of the service behind Gemini, as opposed to failures of what it returned. */
const INFRASTRUCTURE = ['quota', 'network', 'api', 'missing_api_key'];

/** Mirrors of two production constants that are not exported. */
const AFTER_HOUR_DELAY_MS = 2 * 60 * 1000; // IntelligenceScheduler: the hourly tick fires 2 minutes past the hour
const AFTER_DUE_DELAY_MS = 30_000; // ReflectionScheduler: the end-of-day wake-up fires 30 seconds past the reflection time

export interface DayProcessingOptions {
  intelligenceWindow: IntelligenceWindowMode;
  urlMode: UrlMode;
  actionPolicy: ActionPolicy;
  cycleRetries: number;
  cycleRetryDelayMs: number;
  log: (message: string) => void;
  /**
   * Runs after the day's activity has been reconstructed and before its
   * reflection is written — the part of the day in which a user answers what
   * the Coach panel is asking them. Opaque to this module.
   */
  beforeReflection?: () => Promise<void>;
}

export interface DayProcessing {
  dayNumber: number;
  date: string;
  period: ReflectionPeriod;
  /** Simulated instant the day's cycle ran at. */
  processedAt: string;
  events: StoredEventRef[];
  intelligence: {
    mode: IntelligenceWindowMode;
    /** One entry per cycle (more than one only when a cycle stopped on an infrastructure failure and was run again). */
    cycles: (BacklogResult | AnalysisResult)[];
  };
  reflection: { cycles: ReflectionCycleResult[] };
  /** How many coach actions the closing observation sweep changed. */
  coachObserved: number;
  /** Report ids of longer periods (a closed week…) written during this day's cycle. */
  otherReportIds: string[];
  /** Coach actions / memories that existed before the day was processed. */
  actionIdsBefore: Set<string>;
  memoryIdsBefore: Set<string>;
  /** Set when the day could not be completed because Gemini itself was unavailable. */
  infrastructureFailure: string | null;
}

/**
 * When the day's cycle runs: at the user's reflection time, or — on a day that
 * ran later than that — at the first hourly tick after the last event, so the
 * whole day has been analysed before it is reflected on. One cycle per day.
 */
export function endOfDayInstant(period: ReflectionPeriod, lastEventEndIso: string, reflectionMinutes: number, mode: IntelligenceWindowMode): Date {
  const start = new Date(period.start);
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const offset = (((reflectionMinutes - startMinutes) % 1440) + 1440) % 1440;
  const reflectionDue = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + offset).getTime() + AFTER_DUE_DELAY_MS;

  const lastEnd = Date.parse(lastEventEndIso);
  let afterLastEvent = lastEnd + 60_000;
  if (mode === 'hour') {
    const hour = new Date(lastEnd);
    hour.setMinutes(0, 0, 0);
    const nextBoundary = hour.getTime() < lastEnd ? hour.getTime() + 60 * 60 * 1000 : hour.getTime();
    afterLastEvent = nextBoundary + AFTER_HOUR_DELAY_MS;
  }
  return new Date(Math.max(reflectionDue, afterLastEvent));
}

function infrastructureStop(result: BacklogResult | AnalysisResult | ReflectionCycleResult): string | null {
  if ('results' in result) {
    if (result.status === 'unavailable') return result.reason ?? 'missing_api_key';
    if (result.status === 'stopped' && result.reason && INFRASTRUCTURE.includes(result.reason)) return result.reason;
    return null;
  }
  return result.status === 'failed' && INFRASTRUCTURE.includes(result.category) ? result.category : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `cycle`; when it stops because Gemini is unavailable, wait and run it
 * again — the app's next tick. Anything else (including model output that was
 * rejected) is a result, not something to retry here.
 */
async function withTicks<T extends BacklogResult | AnalysisResult | ReflectionCycleResult>(
  cycle: () => Promise<T>,
  options: DayProcessingOptions,
  what: string,
): Promise<{ cycles: T[]; failure: string | null }> {
  const cycles: T[] = [];
  for (let tick = 0; ; tick++) {
    const result = await cycle();
    cycles.push(result);
    const failure = infrastructureStop(result);
    if (!failure) return { cycles, failure: null };
    if (failure === 'missing_api_key' || tick >= options.cycleRetries) return { cycles, failure };
    options.log(`${what} stopped (${failure}); next tick in ${Math.round(options.cycleRetryDelayMs / 1000)}s (${tick + 1}/${options.cycleRetries})`);
    await sleep(options.cycleRetryDelayMs);
  }
}

export async function processDay(runtime: BenchmarkRuntime, clock: SimulatedClock, day: ReflectDayInput, options: DayProcessingOptions): Promise<DayProcessing> {
  if (day.rawEvents.length === 0) throw new Error(`Day ${day.dayNumber} has no raw events`);

  const actionIdsBefore = new Set(runtime.coachRepo.listActions(new Date(0).toISOString()).map((a) => a.id));
  const memoryIdsBefore = new Set(runtime.coachRepo.listMemories().map((m) => m.id));

  // ── Raw observable events, and nothing else ──
  const events = ingestDay(runtime, day, options.urlMode);

  const period = periodContaining('day', events[0].startedAt);
  if (period.key !== day.date) {
    throw new Error(`Day ${day.dayNumber}: events fall on local day ${period.key}, the dataset says ${day.date} — the process timezone does not match the dataset`);
  }

  // ── The end of the day ──
  const lastEnd = events.reduce((latest, e) => (e.endedAt > latest ? e.endedAt : latest), events[0].endedAt);
  const at = endOfDayInstant(period, lastEnd, runtime.coachService.getSettings().reflectionMinutes, options.intelligenceWindow);
  clock.set(at);
  const processedAt = at.toISOString();

  // ── Raw events → AI activities ──
  const intelligence =
    options.intelligenceWindow === 'hour'
      ? await withTicks(() => runtime.intelligenceScheduler.runCycle(), options, 'Intelligence cycle')
      : await withTicks(
          async () => {
            const result = await runtime.intelligenceService.analyzeWindow(period.start, period.end);
            if (result.status === 'succeeded') runtime.onAnalyzed();
            return result;
          },
          options,
          'Intelligence analysis',
        );

  const result: DayProcessing = {
    dayNumber: day.dayNumber,
    date: day.date,
    period,
    processedAt,
    events,
    intelligence: { mode: options.intelligenceWindow, cycles: intelligence.cycles },
    reflection: { cycles: [] },
    coachObserved: 0,
    otherReportIds: [],
    actionIdsBefore,
    memoryIdsBefore,
    infrastructureFailure: intelligence.failure ? `intelligence: ${intelligence.failure}` : null,
  };
  if (result.infrastructureFailure) return result;

  await options.beforeReflection?.();

  // ── Reflection + Coach: what main.ts runs right behind every intelligence cycle ──
  const reflection = await withTicks(() => runtime.reflectionScheduler.runCycle(), options, 'Reflection cycle');
  result.reflection.cycles = reflection.cycles;
  if (reflection.failure) {
    result.infrastructureFailure = `reflection: ${reflection.failure}`;
    return result;
  }
  result.coachObserved = await runtime.coachService.observe();

  for (const cycle of reflection.cycles) {
    for (const generated of cycle.results) {
      if (generated.status === 'succeeded' && !(generated.period.type === 'day' && generated.period.key === period.key)) {
        result.otherReportIds.push(generated.reportId);
      }
    }
  }
  return result;
}

/**
 * The simulated user's answer to the day's recommendations, under the
 * `accept_all` policy: every new suggestion is accepted through the same
 * service call the "Accept" button makes.
 */
export async function applyActionPolicy(runtime: BenchmarkRuntime, policy: ActionPolicy, actionIds: string[]): Promise<number> {
  if (policy !== 'accept_all') return 0;
  let accepted = 0;
  for (const id of actionIds) {
    if (runtime.coachService.decide(id, 'accept').ok) accepted++;
  }
  // `decide` starts an observation sweep without waiting for it; let it settle.
  await runtime.coachService.observe();
  return accepted;
}
