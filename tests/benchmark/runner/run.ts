import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiClient } from '../../../src/intelligence/GeminiClient';
import { diagnoseRun, renderDiagnostics } from '../evaluators/coachDiagnostics';
import { stateOf } from '../evaluators/coachDimensions';
import { EVALUATOR_VERSION, checkAnswerKeyVocabulary, evaluateDay, summarize, type BenchmarkSummary, type DayEvaluation } from '../evaluators/index';
import { buildLeakDetector, scanDatabaseForLeaks } from '../evaluators/leakage';
import { captureDay, captureTaxonomy, type CapturedDay } from './capture';
import { SimulatedClock } from './clock';
import { REPO_ROOT, applyTimezone, type BenchmarkConfig } from './config';
import { loadDataset, splitDataset, type EvaluationOnlyDay } from './dataset';
import { applyActionPolicy, processDay, type DayProcessing } from './day';
import { PRODUCTION_WATCHER, initializeProfile, type IngestionMapping } from './ingest';
import { RANDOMNESS_NOTE, describeEnvironment, describeVersions, type RunManifest } from './manifest';
import { MeteredGemini, summarizeCalls, type GeminiCallRecord } from './meteredGemini';
import { renderCoachReview, renderReport, renderReviewPacket } from './report';
import { createRuntime } from './runtime';
import { decideOnDay, followThrough, seedHistory, type FollowThroughRecord, type PendingFollowThrough } from './simulatedUser';

/**
 * The benchmark, end to end:
 *
 *   validate dataset → isolated database + normal migrations → onboarding as
 *   the persona → for each day: raw events in, one production cycle, capture,
 *   evaluate against the held-out answer key, persist → aggregate report.
 *
 * ONE database carries all thirty days, so day 10 sees what days 1–9 left
 * behind — reports, coach actions, memory, baselines — as a real user's would.
 */

export interface BenchmarkRunResult {
  manifest: RunManifest;
  summary: BenchmarkSummary;
  resultsDir: string;
  archiveDir: string;
}

export class BenchmarkAbortedError extends Error {
  constructor(
    message: string,
    public readonly result: BenchmarkRunResult,
  ) {
    super(message);
    this.name = 'BenchmarkAbortedError';
  }
}

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, (_key, v) => (v instanceof Set ? [...v] : v), 2));
};

/** Read GEMINI_API_KEY the way the app does in development: from a git-ignored `.env` in the project root. */
function loadApiKey(): void {
  if (process.env.GEMINI_API_KEY?.trim()) return;
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env'));
  } catch {
    // No .env file — rely on the real environment.
  }
}

export async function runBenchmark(config: BenchmarkConfig, log: (message: string) => void = console.log): Promise<BenchmarkRunResult> {
  const startedAt = new Date();
  const runId = `bench-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;

  // ── Dataset: validated, then split. From here on the two halves travel separately. ──
  const { dataset, validation } = loadDataset(config.datasetDir, config.expectedDays);
  const { input, evaluation } = splitDataset(dataset);
  const vocabulary = checkAnswerKeyVocabulary(evaluation);
  if (vocabulary.errors.length > 0) throw new Error(`The answer key uses labels the evaluator cannot read:\n  ${vocabulary.errors.join('\n  ')}`);

  const dayCount = Math.min(config.maxDays ?? input.days.length, input.days.length);
  applyTimezone(config.timezone, input.utcOffset, input.days[0].date);

  loadApiKey();
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('GEMINI_API_KEY is not set. The benchmark evaluates the real Gemini-backed pipeline; put the key in .env or the environment.');
  }

  // ── Results directory: `latest` is replaced, every run is also archived ──
  const latestDir = path.join(config.resultsDir, 'latest');
  const archiveDir = path.join(config.resultsDir, 'archived', runId);
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(latestDir, 'days'), { recursive: true });
  const runLog: string[] = [];
  const say = (message: string) => {
    runLog.push(`${new Date().toISOString()} ${message}`);
    log(`[benchmark] ${message}`);
  };

  // ── Isolated database: a fresh temporary file, never the app's own ──
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-benchmark-'));
  const dbPath = path.join(dbDir, 'benchmark.db');

  const detector = buildLeakDetector(evaluation, input);
  const [y, m, d] = input.days[0].date.split('-').map(Number);
  // Onboarding happens the evening before the first tracked day.
  const clock = new SimulatedClock(new Date(y, m - 1, d - 1, 20, 0, 0));
  const gemini = new MeteredGemini(new GeminiClient(), {
    simulatedNow: () => clock.peek(),
    findLeaks: detector.findLeaks,
    onResponseText: detector.allowOwnOutput,
    minCallIntervalMs: config.minCallIntervalMs,
    onCall: config.savePrompts
      ? (record, request, responseText, error) => {
          const dir = path.join(latestDir, 'prompts', `day_${String(record.dayNumber ?? 0).padStart(2, '0')}`);
          writeJson(path.join(dir, `${String(record.seq).padStart(4, '0')}_${record.stage}.json`), { record, request, responseText, error });
        }
      : undefined,
  });
  const pipelineLog: string[] = [];
  const logger = {
    info: (message: string) => pipelineLog.push(`${clock.peek().toISOString()} INFO  ${message}`),
    warn: (message: string) => pipelineLog.push(`${clock.peek().toISOString()} WARN  ${message}`),
    error: (message: string) => pipelineLog.push(`${clock.peek().toISOString()} ERROR ${message}`),
  };

  const runtime = createRuntime(dbPath, gemini, clock, logger);
  const profile = initializeProfile(runtime, input.persona);
  const taxonomy = captureTaxonomy(runtime);
  const ingestion: IngestionMapping = {
    watcher: { from: [...new Set(input.days.flatMap((day) => day.rawEvents.map((e) => e.watcher)))], to: PRODUCTION_WATCHER },
    timestamps: 'UTC ISO-8601 (Date#toISOString), as the heartbeat engine writes them',
    url: config.urlMode,
    payload: 'not stored (null in the dataset)',
  };

  say(`run ${runId}: ${dayCount} day(s), dataset ${dataset.version}, model ${gemini.model}, intelligence window "${config.intelligenceWindow}", database ${dbPath}`);
  writeJson(path.join(latestDir, 'validation.json'), { ...validation, vocabulary });

  const processed: { processing: DayProcessing; captured: CapturedDay; evaluation: DayEvaluation; answer: EvaluationOnlyDay; calls: GeminiCallRecord[] }[] = [];
  const knownBlockIds = new Set<string>();
  let abortReason: string | null = null;
  // The simulated user's open commitments, and what became of each.
  let pendingFollowThrough: PendingFollowThrough[] = [];
  const followThroughLog: FollowThroughRecord[] = [];

  try {
    for (let index = 0; index < dayCount; index++) {
      const day = input.days[index];
      const logMark = pipelineLog.length;
      gemini.dayNumber = day.dayNumber;

      // ── Reflect's side: raw events in, one production cycle ──
      const processing = await processDay(runtime, clock, day, {
        intelligenceWindow: config.intelligenceWindow,
        urlMode: config.urlMode,
        actionPolicy: config.actionPolicy,
        cycleRetries: config.cycleRetries,
        cycleRetryDelayMs: config.cycleRetryDelayMs,
        log: say,
        beforeReflection: async () => {
          // Yesterday's accepted action: Reflect looks for it, then the user says what it could not see.
          for (const pending of pendingFollowThrough) {
            const record = await followThrough(runtime, pending);
            if (!record) continue;
            followThroughLog.push(record);
            say(
              `day ${String(day.dayNumber).padStart(2, '0')}: follow-through on "${record.title}" — Reflect saw ${record.observedBefore.kind ?? 'nothing yet'}` +
                `${record.statedExecution ? `, user said ${record.statedExecution}` : ''}${record.statedOutcome ? `, outcome ${record.statedOutcome}` : ''}`,
            );
          }
          pendingFollowThrough = [];
          // History the scenario starts from: what was on the Coach panel since last night, and the user's answer.
          const seeds = evaluation.days[index].coachHistory;
          if (seeds.length > 0) {
            const records = await seedHistory(runtime, evaluation.days[index], clock.peek(), runtime.reflectionService.syncPriorities());
            followThroughLog.push(...records);
            say(`day ${String(day.dayNumber).padStart(2, '0')}: ${seeds.length} seeded earlier recommendation(s) — ${seeds.map((s) => `${s.user_decision}/${s.execution}/${s.outcome}`).join(', ')}`);
          }
        },
      });
      const captured = await captureDay(runtime, processing);
      const calls = gemini.callsFor(day.dayNumber);

      const leaked = calls.filter((c) => c.leaks.length > 0);
      if (leaked.length > 0) abortReason = `answer-key wording reached a Gemini prompt on day ${day.dayNumber}: ${leaked[0].leaks[0]}`;
      else if (processing.infrastructureFailure) abortReason = `day ${day.dayNumber} could not be processed — Gemini unavailable (${processing.infrastructureFailure})`;

      // ── The evaluator's side: only now is the answer key for this day read ──
      for (const block of captured.timeline) knownBlockIds.add(block.id);
      const answer = evaluation.days[index];
      const dayEvaluation = evaluateDay(captured, answer, {
        config,
        taxonomy,
        knownBlockIds,
        hasHistory: processed.some((p) => p.captured.reflection.report !== null),
        previousProcessedAt: processed[processed.length - 1]?.captured.processedAt ?? null,
        findLeaks: detector.findLeaks,
      });
      processed.push({ processing, captured, evaluation: dayEvaluation, answer, calls });

      writeJson(path.join(latestDir, 'days', `day_${String(day.dayNumber).padStart(2, '0')}.json`), {
        dayNumber: day.dayNumber,
        date: day.date,
        processing,
        gemini: calls,
        pipelineLog: pipelineLog.slice(logMark),
        captured,
        evaluation: dayEvaluation,
      });

      const metrics = dayEvaluation.timeline.segmentation.metrics;
      say(
        `day ${String(day.dayNumber).padStart(2, '0')} ${day.date}: ${calls.length} Gemini request(s); ` +
          `${metrics.predictedCount} block(s) vs ${metrics.groundTruthCount} GT, F1 ${(metrics.f1 * 100).toFixed(0)}%; ` +
          `report ${captured.reflection.report?.status ?? 'none'}; ${captured.coach.actions.length} action(s)`,
      );
      if (abortReason) break;

      // ── The simulated user's decision on today's suggestions (none by default) ──
      if (config.actionPolicy === 'scenario') {
        const pending = await decideOnDay(runtime, day.dayNumber, captured.coach.actions, answer, captured.priorities);
        if (pending) pendingFollowThrough.push(pending);
      } else {
        await applyActionPolicy(
          runtime,
          config.actionPolicy,
          captured.coach.actions.filter((a) => a.status === 'suggested').map((a) => a.id),
        );
      }
    }
  } catch (err) {
    abortReason = `internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  }

  // ── After the last day: final state, safeguards, clean-up ──
  const reportsChangedAfterEvaluation = processed
    .map((p) => {
      const final = runtime.reflectionRepo.getCurrentReport('day', p.processing.period.key);
      return { dayNumber: p.processing.dayNumber, date: p.processing.date, evaluatedReportId: p.captured.reflection.report?.id ?? null, finalReportId: final?.id ?? null };
    })
    .filter((r) => r.evaluatedReportId !== r.finalReportId);

  const count = (sql: string) => runtime.db.prepare(sql).get() as Record<string, number | null>;
  const intelligenceRuns = count(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(attempt_count), 0) AS attempts, COALESCE(SUM(status = 'failed'), 0) AS failed FROM intelligence_runs WHERE attempt_count > 0`,
  );
  const reflectionRuns = count(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(attempt_count), 0) AS attempts, COALESCE(SUM(status = 'failed'), 0) AS failed FROM reflection_reports WHERE attempt_count > 0`,
  );
  const insufficient = count(`SELECT COUNT(*) AS n FROM reflection_reports WHERE status = 'insufficient_data'`);
  const schemaVersion = (runtime.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? null;
  const databaseScan = scanDatabaseForLeaks(runtime.db, detector);
  // Every coach action as the run leaves it: the closing state of each lifecycle.
  const finalActions = runtime.coachRepo.listActions(new Date(0).toISOString());
  if (!abortReason && databaseScan.leaks.length > 0) abortReason = `answer-key wording was found in the benchmark database: ${databaseScan.leaks[0].table}.${databaseScan.leaks[0].column}`;

  runtime.close();
  let keptDatabase: string | null = null;
  if (config.keepDb) {
    keptDatabase = path.join(latestDir, 'benchmark.db');
    fs.copyFileSync(dbPath, keptDatabase);
  }
  fs.rmSync(dbDir, { recursive: true, force: true });

  const finishedAt = new Date();
  const usage = summarizeCalls(gemini.calls, gemini.model);
  const cycleReruns = processed.reduce((sum, p) => sum + Math.max(0, p.processing.intelligence.cycles.length - 1) + Math.max(0, p.processing.reflection.cycles.length - 1), 0);
  const totalsOf = (row: Record<string, number | null>) => ({ runs: row.runs ?? 0, attempts: row.attempts ?? 0, retries: Math.max(0, (row.attempts ?? 0) - (row.runs ?? 0)) });
  const first = processed[0]?.processing;
  const last = processed[processed.length - 1]?.processing;

  const manifest: RunManifest = {
    runId,
    status: abortReason ? 'aborted' : 'completed',
    statusReason: abortReason,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dataset: {
      path: path.relative(REPO_ROOT, dataset.dir).replace(/\\/g, '/'),
      version: dataset.version,
      inputVersion: dataset.inputVersion,
      files: dataset.files.length,
      persona: { id: input.persona.id, type: input.persona.type },
      utcOffset: input.utcOffset,
      validationWarnings: validation.warnings.length,
    },
    days: { count: processed.length, first: first?.dayNumber ?? 0, last: last?.dayNumber ?? 0, firstDate: first?.date ?? '', lastDate: last?.date ?? '' },
    environment: describeEnvironment(config.timezone),
    versions: describeVersions(EVALUATOR_VERSION, schemaVersion),
    input: { profile, ingestion, taxonomy },
    config,
    randomness: { harnessSeed: null, note: RANDOMNESS_NOTE },
    gemini: usage,
    totals: {
      geminiCalls: usage.totalCalls,
      retries: totalsOf(intelligenceRuns).retries + totalsOf(reflectionRuns).retries,
      failedGeminiCalls: usage.failed,
      intelligence: { ...totalsOf(intelligenceRuns), failedRuns: intelligenceRuns.failed ?? 0 },
      reflection: { ...totalsOf(reflectionRuns), failedReports: reflectionRuns.failed ?? 0, insufficientData: insufficient.n ?? 0 },
      cycleReruns,
    },
    safeguards: {
      answerKeyShinglesWatched: detector.shingleCount,
      promptLeaks: usage.leaks,
      answerKeyPhrasesWrittenByModel: detector.coincidences(),
      databaseTablesScanned: databaseScan.tablesScanned,
      databaseValuesScanned: databaseScan.valuesScanned,
      databaseLeaks: databaseScan.leaks.length,
    },
    reportsChangedAfterEvaluation,
    database: { kept: config.keepDb, path: keptDatabase ? path.relative(REPO_ROOT, keptDatabase).replace(/\\/g, '/') : null },
  };

  const summary = summarize(
    processed.map((p) => p.evaluation),
    finalActions.map(stateOf),
  );
  writeJson(path.join(latestDir, 'coach_final.json'), finalActions);
  writeJson(path.join(latestDir, 'follow_through.json'), followThroughLog);
  writeJson(path.join(latestDir, 'manifest.json'), manifest);
  writeJson(path.join(latestDir, 'summary.json'), summary);
  writeJson(path.join(latestDir, 'gemini_calls.json'), gemini.calls);
  fs.writeFileSync(
    path.join(latestDir, 'report.md'),
    renderReport({ manifest, summary, days: processed.map((p) => ({ evaluation: p.evaluation, captured: p.captured, geminiCalls: p.calls.length })) }),
  );
  const reviewed = processed.map((p) => ({ evaluation: p.evaluation, captured: p.captured, answer: p.answer }));
  fs.writeFileSync(path.join(latestDir, 'review.md'), renderReviewPacket(reviewed));
  fs.writeFileSync(path.join(latestDir, 'coach_review.md'), renderCoachReview(reviewed, summary, finalActions));
  say(
    `${manifest.status}: ${processed.length} day(s), ${usage.totalCalls} Gemini request(s) ` +
      `(${Object.entries(usage.byStage).map(([stage, s]) => `${stage} ${s.calls}`).join(', ')}), ${manifest.totals.retries} retry(ies), ${usage.failed} failed`,
  );
  fs.writeFileSync(path.join(latestDir, 'run.log'), [...runLog, '', '--- pipeline log ---', ...pipelineLog].join('\n'));
  // Why each unanswered day was unanswered — read back from what was just stored, with the measurement layer replayed.
  const diagnostics = diagnoseRun(latestDir);
  writeJson(path.join(latestDir, 'coach_diagnostics.json'), diagnostics);
  fs.writeFileSync(path.join(latestDir, 'coach_diagnostics.md'), renderDiagnostics(diagnostics));

  // The archive is a copy of `latest` without the (large) database.
  fs.cpSync(latestDir, archiveDir, { recursive: true, filter: (source) => path.basename(source) !== 'benchmark.db' });

  const result: BenchmarkRunResult = { manifest, summary, resultsDir: latestDir, archiveDir };
  if (abortReason) throw new BenchmarkAbortedError(`Benchmark aborted: ${abortReason}`, result);
  return result;
}
