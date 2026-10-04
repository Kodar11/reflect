import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig } from './runner/config';
import { reevaluate } from './runner/reevaluate';

/**
 * Re-score the stored run in results/latest with the current evaluators and
 * thresholds. Makes no Gemini request and opens no database, so it changes
 * nothing about what Reflect produced — only how it is measured.
 *
 * Enabled by `REFLECT_BENCH_REEVALUATE=1` (`npm run benchmark -- --reevaluate`).
 */
describe.skipIf(process.env.REFLECT_BENCH_REEVALUATE !== '1')('re-evaluate the stored benchmark run', () => {
  it('rewrites the evaluation, summary, report and review packet', () => {
    const result = reevaluate(loadConfig());
    console.log(`[benchmark] re-evaluated ${result.runId}: ${result.days} day(s) → ${path.join(result.resultsDir, 'report.md')}`);
    expect(result.days).toBeGreaterThan(0);
    expect(result.summary.daysEvaluated).toBe(result.days);
  });
});
