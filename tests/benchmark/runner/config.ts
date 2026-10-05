import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Benchmark configuration. Every knob that can change a result lives here and
 * is written to the run manifest, so two runs can be compared knowing exactly
 * what differed. Values come from `REFLECT_BENCH_*` environment variables
 * (set by `cli.mjs` from its flags); anything unset uses the default.
 */

export const BENCHMARK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BENCHMARK_ROOT, '..', '..');

export type IntelligenceWindowMode = 'hour' | 'day';
export type ActionPolicy = 'none' | 'accept_all' | 'scenario';
export type UrlMode = 'domain' | 'raw';

export interface MatchingConfig {
  /** A predicted block matches a ground-truth activity at or above this temporal IoU. */
  iouThreshold: number;
  /** A predicted boundary matches a ground-truth boundary within this distance. */
  boundaryToleranceMs: number;
  /** Two segments "overlap" for over/under-segmentation at or above this shared time. */
  minOverlapMs: number;
}

export interface SemanticConfig {
  /** Concept coverage at or above which a lexical criterion PASSES. */
  passCoverage: number;
  /** …and at or above which it is PARTIAL. */
  partialCoverage: number;
}

export interface BenchmarkConfig {
  datasetDir: string;
  resultsDir: string;
  /** How many day files the dataset must contain. */
  expectedDays: number;
  /** Run only days 1..maxDays (history must accumulate, so a run always starts at day 1). */
  maxDays: number | null;

  /** Keep the benchmark database after the run (it is copied into the results either way when true). */
  keepDb: boolean;

  /** IANA zone the simulated user lives in; must agree with the dataset's UTC offset. */
  timezone: string;

  /**
   * How raw events become AI activities.
   *   hour  production cadence: `processBacklog()` over hour-aligned windows (one request per hour with events)
   *   day   one `analyzeWindow()` over the whole local day (one request per day)
   */
  intelligenceWindow: IntelligenceWindowMode;

  /**
   * What is stored in `events.url`.
   *   domain  what Reflect's tracker stores: the host only (via the tracker's own `getDomain`)
   *   raw     the dataset's URL verbatim
   */
  urlMode: UrlMode;

  /**
   * What the simulated user does with a recommendation.
   *   none        never answers (the dataset contains no user decisions) — suggestions expire
   *   accept_all  accepts every suggestion a few minutes after the report
   *   scenario    answers as the day's `execution_scenario` says: decides that evening, and the next
   *               day says whether it happened and whether it helped (see `runner/simulatedUser.ts`)
   */
  actionPolicy: ActionPolicy;

  matching: MatchingConfig;
  semantic: SemanticConfig;

  /** Harness-level pacing between Gemini requests (0 = none). Does not alter what is sent. */
  minCallIntervalMs: number;
  /**
   * When a cycle stops on an infrastructure failure (quota / network / API),
   * the production app simply tries again at its next tick. The harness
   * simulates that many further ticks before giving the day up.
   */
  cycleRetries: number;
  cycleRetryDelayMs: number;

  /** Write every prompt and raw response to the results directory. */
  savePrompts: boolean;
}

const DEFAULT_MATCHING: MatchingConfig = { iouThreshold: 0.5, boundaryToleranceMs: 60_000, minOverlapMs: 60_000 };
const DEFAULT_SEMANTIC: SemanticConfig = { passCoverage: 0.6, partialCoverage: 0.35 };

function numberFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value.trim() === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
  return value as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BenchmarkConfig {
  const maxDays = env.REFLECT_BENCH_DAYS ? numberFrom(env.REFLECT_BENCH_DAYS, 0, 'REFLECT_BENCH_DAYS') : null;
  if (maxDays !== null && (!Number.isInteger(maxDays) || maxDays < 1)) throw new Error('REFLECT_BENCH_DAYS must be a positive integer');
  return {
    datasetDir: env.REFLECT_BENCH_DATASET ? path.resolve(env.REFLECT_BENCH_DATASET) : path.join(BENCHMARK_ROOT, 'data', 'founder_freelancer'),
    resultsDir: env.REFLECT_BENCH_RESULTS ? path.resolve(env.REFLECT_BENCH_RESULTS) : path.join(BENCHMARK_ROOT, 'results'),
    expectedDays: numberFrom(env.REFLECT_BENCH_EXPECTED_DAYS, 30, 'REFLECT_BENCH_EXPECTED_DAYS'),
    maxDays,
    keepDb: flag(env.REFLECT_BENCH_KEEP_DB),
    timezone: env.REFLECT_BENCH_TZ?.trim() || 'Asia/Kolkata',
    intelligenceWindow: oneOf(env.REFLECT_BENCH_INTELLIGENCE_WINDOW, ['hour', 'day'] as const, 'hour', 'REFLECT_BENCH_INTELLIGENCE_WINDOW'),
    urlMode: oneOf(env.REFLECT_BENCH_URL_MODE, ['domain', 'raw'] as const, 'domain', 'REFLECT_BENCH_URL_MODE'),
    actionPolicy: oneOf(env.REFLECT_BENCH_ACTION_POLICY, ['none', 'accept_all', 'scenario'] as const, 'none', 'REFLECT_BENCH_ACTION_POLICY'),
    matching: {
      iouThreshold: numberFrom(env.REFLECT_BENCH_IOU, DEFAULT_MATCHING.iouThreshold, 'REFLECT_BENCH_IOU'),
      boundaryToleranceMs: numberFrom(env.REFLECT_BENCH_BOUNDARY_TOLERANCE_MS, DEFAULT_MATCHING.boundaryToleranceMs, 'REFLECT_BENCH_BOUNDARY_TOLERANCE_MS'),
      minOverlapMs: numberFrom(env.REFLECT_BENCH_MIN_OVERLAP_MS, DEFAULT_MATCHING.minOverlapMs, 'REFLECT_BENCH_MIN_OVERLAP_MS'),
    },
    semantic: {
      passCoverage: numberFrom(env.REFLECT_BENCH_PASS_COVERAGE, DEFAULT_SEMANTIC.passCoverage, 'REFLECT_BENCH_PASS_COVERAGE'),
      partialCoverage: numberFrom(env.REFLECT_BENCH_PARTIAL_COVERAGE, DEFAULT_SEMANTIC.partialCoverage, 'REFLECT_BENCH_PARTIAL_COVERAGE'),
    },
    minCallIntervalMs: numberFrom(env.REFLECT_BENCH_MIN_CALL_INTERVAL_MS, 0, 'REFLECT_BENCH_MIN_CALL_INTERVAL_MS'),
    cycleRetries: numberFrom(env.REFLECT_BENCH_CYCLE_RETRIES, 2, 'REFLECT_BENCH_CYCLE_RETRIES'),
    cycleRetryDelayMs: numberFrom(env.REFLECT_BENCH_CYCLE_RETRY_DELAY_MS, 60_000, 'REFLECT_BENCH_CYCLE_RETRY_DELAY_MS'),
    savePrompts: flag(env.REFLECT_BENCH_SAVE_PROMPTS),
  };
}

/**
 * Put the process in the simulated user's timezone and prove it took effect.
 * Every period boundary Reflect computes is a LOCAL calendar boundary, so a
 * run in the wrong zone would silently cut the days in the wrong place.
 */
export function applyTimezone(timezone: string, utcOffset: string, sampleDate: string): void {
  process.env.TZ = timezone;
  const [y, m, d] = sampleDate.split('-').map(Number);
  const offsetMinutes = -new Date(y, m - 1, d, 12).getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const actual = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  if (actual !== utcOffset) {
    throw new Error(
      `Timezone mismatch: the dataset's timestamps are ${utcOffset} but this process is at ${actual} on ${sampleDate} ` +
        `(TZ=${timezone}). Start the benchmark through tests/benchmark/cli.mjs, or set TZ before launching.`,
    );
  }
}
