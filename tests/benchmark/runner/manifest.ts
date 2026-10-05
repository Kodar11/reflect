import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COACH_PROMPT_VERSION } from '../../../src/coach/CoachPrompt';
import { INTELLIGENCE_SCHEMA_VERSION } from '../../../src/intelligence/IntelligenceModels';
import { PROMPT_VERSION } from '../../../src/intelligence/IntelligencePrompt';
import { ANNOTATION_PROMPT_VERSION } from '../../../src/reflection/ReflectionAnnotator';
import { REFLECTION_INPUT_SCHEMA_VERSION, REFLECTION_OUTPUT_SCHEMA_VERSION } from '../../../src/reflection/ReflectionModels';
import { REFLECTION_PROMPT_VERSION } from '../../../src/reflection/ReflectionPrompt';
import type { UserProfileInput } from '../../../src/profile/UserProfile';
import type { CapturedTaxonomy } from './capture';
import { REPO_ROOT, type BenchmarkConfig } from './config';
import type { DatasetPersona } from './dataset';
import type { IngestionMapping } from './ingest';
import type { GeminiUsageSummary } from './meteredGemini';

/**
 * The run manifest: everything needed to say what a run was and to explain
 * why two runs differ. Reproducible here means "same dataset, code,
 * configuration, model and procedure" — not identical Gemini output.
 */

export interface PipelineTotals {
  /** Pipeline runs that made at least one request. */
  runs: number;
  /** Requests those runs made in total. */
  attempts: number;
  /** attempts − runs: requests made because an earlier one was rejected or failed. */
  retries: number;
}

export interface RunManifest {
  runId: string;
  status: 'completed' | 'aborted';
  statusReason: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dataset: {
    path: string;
    version: string;
    /** Hash of the observable half only (persona + raw events). Absent on runs made before it existed. */
    inputVersion?: string;
    /** The answer key the stored evaluation was scored against, when it was re-scored after the run. */
    answerKeyVersion?: string;
    files: number;
    persona: Pick<DatasetPersona, 'id' | 'type'>;
    utcOffset: string;
    validationWarnings: number;
  };
  days: { count: number; first: number; last: number; firstDate: string; lastDate: string };
  environment: {
    gitCommit: string | null;
    /** Uncommitted changes under `src/` at run time. */
    gitDirty: boolean | null;
    node: string;
    electron: string | null;
    vitest: string | null;
    platform: string;
    timezone: string;
  };
  versions: {
    evaluator: string;
    databaseSchema: number | null;
    prompts: { activities: string; threads: string; reflection: string; coach: string };
    schemas: { intelligenceOutput: number; reflectionInput: number; reflectionOutput: number };
  };
  /** The profile Reflect was given, and how raw events were stored. */
  input: { profile: UserProfileInput; ingestion: IngestionMapping; taxonomy: CapturedTaxonomy };
  config: BenchmarkConfig;
  randomness: { harnessSeed: null; note: string };
  gemini: GeminiUsageSummary;
  totals: {
    geminiCalls: number;
    retries: number;
    failedGeminiCalls: number;
    intelligence: PipelineTotals & { failedRuns: number };
    reflection: PipelineTotals & { failedReports: number; insufficientData: number };
    /** Whole cycles run again by the harness after an infrastructure stop. */
    cycleReruns: number;
  };
  safeguards: {
    answerKeyShinglesWatched: number;
    promptLeaks: number;
    /** Answer-key phrases the model wrote on its own and later read back (coincidences, not leaks). */
    answerKeyPhrasesWrittenByModel?: number;
    databaseTablesScanned: number;
    databaseValuesScanned: number;
    databaseLeaks: number;
  };
  /** Days whose current report at the end of the run is not the one evaluated (rewritten later by the scheduler). */
  reportsChangedAfterEvaluation: { dayNumber: number; date: string; evaluatedReportId: string | null; finalReportId: string | null }[];
  database: { kept: boolean; path: string | null };
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function vitestVersion(): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export function describeEnvironment(timezone: string): RunManifest['environment'] {
  const status = git(['status', '--porcelain', '--', 'src']);
  return {
    gitCommit: git(['rev-parse', 'HEAD']),
    gitDirty: status === null ? null : status.length > 0,
    node: process.version,
    electron: process.versions.electron ?? null,
    vitest: vitestVersion(),
    platform: `${process.platform} ${process.arch}`,
    timezone,
  };
}

export function describeVersions(evaluator: string, databaseSchema: number | null): RunManifest['versions'] {
  return {
    evaluator,
    databaseSchema,
    prompts: { activities: PROMPT_VERSION, threads: ANNOTATION_PROMPT_VERSION, reflection: REFLECTION_PROMPT_VERSION, coach: COACH_PROMPT_VERSION },
    schemas: {
      intelligenceOutput: INTELLIGENCE_SCHEMA_VERSION,
      reflectionInput: REFLECTION_INPUT_SCHEMA_VERSION,
      reflectionOutput: REFLECTION_OUTPUT_SCHEMA_VERSION,
    },
  };
}

export const RANDOMNESS_NOTE =
  'The harness uses no randomness: matching, evaluation and ordering are deterministic. Production code mints ids with randomUUID ' +
  '(ids never influence a result) and calls Gemini at the temperature GeminiClient sets (0.2), so model output is not bit-for-bit repeatable.';
