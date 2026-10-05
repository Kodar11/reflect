import fs from 'node:fs';
import path from 'node:path';
import type { CoachAction } from '../../../src/coach/CoachModels';
import { diagnoseRun, renderDiagnostics } from '../evaluators/coachDiagnostics';
import { stateOf } from '../evaluators/coachDimensions';
import { EVALUATOR_VERSION, checkAnswerKeyVocabulary, evaluateDay, summarize, type BenchmarkSummary, type DayEvaluation } from '../evaluators/index';
import { buildLeakDetector } from '../evaluators/leakage';
import type { CapturedDay } from './capture';
import type { BenchmarkConfig } from './config';
import { loadDataset, splitDataset, type EvaluationOnlyDay } from './dataset';
import type { RunManifest } from './manifest';
import { renderCoachReview, renderReport, renderReviewPacket } from './report';

/**
 * Score a stored run again — no database, no Gemini.
 *
 * A run keeps everything Reflect produced (`days/day_NN.json` → `captured`).
 * Evaluation is a pure function of that and the answer key, so a changed
 * threshold, mapping or criterion can be applied to the SAME model output
 * instead of paying for, and adding the noise of, a new run.
 */

export interface ReevaluationResult {
  runId: string;
  days: number;
  summary: BenchmarkSummary;
  resultsDir: string;
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

interface StoredDay {
  dayNumber: number;
  date: string;
  gemini: unknown[];
  captured: CapturedDay;
  evaluation: DayEvaluation;
}

export function reevaluate(config: BenchmarkConfig, runDir = path.join(config.resultsDir, 'latest')): ReevaluationResult {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No stored run at ${runDir}`);
  const manifest = readJson<RunManifest>(manifestPath);

  const { dataset } = loadDataset(config.datasetDir, config.expectedDays);
  const { input, evaluation } = splitDataset(dataset);
  // The answer key may have gained annotations since the run; what Reflect was
  // GIVEN must not have changed. Runs made before `inputVersion` existed are
  // checked event by event against what they stored.
  const sameInput =
    manifest.dataset.inputVersion !== undefined
      ? manifest.dataset.inputVersion === dataset.inputVersion
      : fs
          .readdirSync(path.join(runDir, 'days'))
          .filter((f) => /^day_\d{2}\.json$/.test(f))
          .every((file) => {
            const stored = readJson<StoredDay>(path.join(runDir, 'days', file));
            const day = input.days.find((d) => d.dayNumber === stored.dayNumber);
            return (
              day !== undefined &&
              day.rawEvents.length === stored.captured.events.length &&
              day.rawEvents.every((e, i) => stored.captured.events[i].datasetId === e.datasetId && Date.parse(stored.captured.events[i].startedAt) === Date.parse(e.startedAt))
            );
          });
  if (dataset.version !== manifest.dataset.version && !sameInput) {
    throw new Error(`The stored run was made from dataset ${manifest.dataset.version}; the raw events on disk (${dataset.version}) are not the ones it was given. Re-scoring it would not be the same run.`);
  }
  const vocabulary = checkAnswerKeyVocabulary(evaluation);
  if (vocabulary.errors.length > 0) throw new Error(`The answer key uses labels the evaluator cannot read:\n  ${vocabulary.errors.join('\n  ')}`);
  const detector = buildLeakDetector(evaluation, input);

  const files = fs.readdirSync(path.join(runDir, 'days')).filter((f) => /^day_\d{2}\.json$/.test(f)).sort();
  const knownBlockIds = new Set<string>();
  const rescored: { evaluation: DayEvaluation; captured: CapturedDay; answer: EvaluationOnlyDay; geminiCalls: number }[] = [];
  let hasHistory = false;
  let previousProcessedAt: string | null = null;

  for (const file of files) {
    const stored = readJson<StoredDay>(path.join(runDir, 'days', file));
    const answer = evaluation.days.find((d) => d.dayNumber === stored.dayNumber);
    if (!answer) throw new Error(`${file}: day ${stored.dayNumber} is not in the dataset`);
    for (const block of stored.captured.timeline) knownBlockIds.add(block.id);
    const dayEvaluation = evaluateDay(stored.captured, answer, {
      // The thresholds in force are the ones passed now; they are written back to the manifest.
      config,
      taxonomy: manifest.input.taxonomy,
      knownBlockIds,
      hasHistory,
      previousProcessedAt,
      findLeaks: detector.findLeaks,
    });
    hasHistory ||= stored.captured.reflection.report !== null;
    previousProcessedAt = stored.captured.processedAt;
    writeJson(path.join(runDir, 'days', file), { ...stored, evaluation: dayEvaluation });
    rescored.push({ evaluation: dayEvaluation, captured: stored.captured, answer, geminiCalls: stored.gemini.length });
  }

  const finalPath = path.join(runDir, 'coach_final.json');
  const finalActions = fs.existsSync(finalPath) ? readJson<CoachAction[]>(finalPath) : [];
  const summary = summarize(
    rescored.map((r) => r.evaluation),
    finalActions.map(stateOf),
  );
  const updated: RunManifest = {
    ...manifest,
    dataset: { ...manifest.dataset, answerKeyVersion: dataset.version, inputVersion: dataset.inputVersion },
    versions: { ...manifest.versions, evaluator: EVALUATOR_VERSION },
    config: { ...manifest.config, matching: config.matching, semantic: config.semantic },
  };
  writeJson(manifestPath, updated);
  writeJson(path.join(runDir, 'summary.json'), summary);
  fs.writeFileSync(path.join(runDir, 'report.md'), renderReport({ manifest: updated, summary, days: rescored }));
  fs.writeFileSync(path.join(runDir, 'review.md'), renderReviewPacket(rescored));
  fs.writeFileSync(path.join(runDir, 'coach_review.md'), renderCoachReview(rescored, summary, finalActions));
  // Why each unanswered day was unanswered — read from the stored run, with the measurement layer replayed.
  const diagnostics = diagnoseRun(runDir);
  writeJson(path.join(runDir, 'coach_diagnostics.json'), diagnostics);
  fs.writeFileSync(path.join(runDir, 'coach_diagnostics.md'), renderDiagnostics(diagnostics));

  // Keep the archived copy of the same run in step.
  const archive = path.join(config.resultsDir, 'archived', manifest.runId);
  if (fs.existsSync(archive) && path.resolve(archive) !== path.resolve(runDir)) {
    for (const name of ['manifest.json', 'summary.json', 'report.md', 'review.md', 'coach_review.md', 'coach_diagnostics.json', 'coach_diagnostics.md']) fs.copyFileSync(path.join(runDir, name), path.join(archive, name));
    fs.cpSync(path.join(runDir, 'days'), path.join(archive, 'days'), { recursive: true });
  }

  return { runId: manifest.runId, days: rescored.length, summary, resultsDir: runDir };
}
