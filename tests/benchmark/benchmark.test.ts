import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { loadConfig } from './runner/config';
import { BenchmarkAbortedError, runBenchmark } from './runner/run';

/**
 * The end-to-end benchmark: thirty simulated days through the real Reflect
 * pipeline and the real Gemini model, evaluated against held-out ground truth.
 *
 * It makes real, billed model requests, so it never runs as part of the
 * ordinary suite: it is enabled only by `REFLECT_BENCHMARK=1`, which
 * `npm run benchmark` (tests/benchmark/cli.mjs) sets — together with
 * Electron's Node, which the native SQLite binding is built for.
 *
 * The assertions here are about the HARNESS (it ran every day, once, on an
 * isolated database, without leaking the answer key). How well Reflect did is
 * a measurement, written to tests/benchmark/results — not a pass/fail gate.
 */

const enabled = process.env.REFLECT_BENCHMARK === '1';

/** better-sqlite3 is rebuilt for Electron; under plain Node it cannot load. */
function nativeSqliteAvailable(): boolean {
  const prevError = console.error;
  console.error = () => {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-benchmark-probe-'));
  try {
    new Database(path.join(dir, 'probe.db')).close();
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)('Reflect benchmark (real pipeline, real Gemini)', () => {
  it(
    'runs every simulated day once and writes an evaluated report',
    async () => {
      if (!nativeSqliteAvailable()) {
        throw new Error('The SQLite binding does not load in this runtime. Start the benchmark with `npm run benchmark`, which runs it under Electron\'s Node.');
      }
      const config = loadConfig();
      const expectedDays = Math.min(config.maxDays ?? config.expectedDays, config.expectedDays);

      let result;
      try {
        result = await runBenchmark(config);
      } catch (err) {
        if (err instanceof BenchmarkAbortedError) console.log(`[benchmark] partial results: ${err.result.resultsDir}`);
        throw err;
      }
      const { manifest, summary, resultsDir } = result;
      console.log(`[benchmark] report: ${path.join(resultsDir, 'report.md')}`);

      // Every day was processed, in order, on one database.
      expect(manifest.status).toBe('completed');
      expect(manifest.days.count).toBe(expectedDays);
      expect(summary.daysEvaluated).toBe(expectedDays);

      // The answer key never reached Reflect.
      expect(manifest.safeguards.answerKeyShinglesWatched).toBeGreaterThan(0);
      expect(manifest.safeguards.promptLeaks).toBe(0);
      expect(manifest.safeguards.databaseLeaks).toBe(0);

      // One daily intelligence pass per simulated day — no scheduler + explicit double invocation.
      for (let n = 1; n <= expectedDays; n++) {
        const day = JSON.parse(fs.readFileSync(path.join(resultsDir, 'days', `day_${String(n).padStart(2, '0')}.json`), 'utf8'));
        const dailyGenerations = day.processing.reflection.cycles
          .flatMap((cycle: { results: { period: { type: string; key: string } }[] }) => cycle.results)
          .filter((r: { period: { type: string; key: string } }) => r.period.type === 'day' && r.period.key === day.date);
        expect(dailyGenerations.length, `day ${n}: daily reflection generations`).toBe(day.processing.reflection.cycles.length);
        expect(day.captured.timeline.length, `day ${n}: timeline blocks`).toBeGreaterThan(0);
      }
      const daily = (manifest.gemini.byStage.daily_reflection_coach?.calls ?? 0) + (manifest.gemini.byStage.reflection?.calls ?? 0);
      expect(daily).toBeGreaterThanOrEqual(summary.reflection.reportsGenerated);
      expect(manifest.totals.geminiCalls).toBe(manifest.gemini.totalCalls);

      for (const file of ['manifest.json', 'summary.json', 'report.md', 'review.md', 'gemini_calls.json', 'validation.json', 'run.log']) {
        expect(fs.existsSync(path.join(resultsDir, file)), file).toBe(true);
      }
      expect(fs.existsSync(path.join(resultsDir, 'benchmark.db'))).toBe(config.keepDb);
    },
    6 * 60 * 60 * 1000,
  );
});
