import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { diagnoseRun, renderDiagnostics } from './evaluators/coachDiagnostics';
import type { CapturedDay } from './runner/capture';
import { loadConfig } from './runner/config';
import { renderReplay, replayCoachSignals } from './runner/coachReplay';

/**
 * Diagnose a stored run: why each unanswered day was unanswered, and what the
 * Coach's measurement layer holds for every day when replayed over the stored
 * activities. Reads files only — no database, no Gemini.
 *
 * Enabled by `REFLECT_BENCH_DIAGNOSE=1` (`npm run benchmark -- --diagnose [--run <dir>]`).
 * Writes `coach_diagnostics.md` / `.json` and `coach_signals.md` next to the run.
 */
describe.skipIf(process.env.REFLECT_BENCH_DIAGNOSE !== '1')('diagnose the stored benchmark run', () => {
  it('classifies every unanswered day and replays the measurement layer', () => {
    const runDir = process.env.REFLECT_BENCH_RUN_DIR ? path.resolve(process.env.REFLECT_BENCH_RUN_DIR) : path.join(loadConfig().resultsDir, 'latest');
    const diagnostics = diagnoseRun(runDir);
    fs.writeFileSync(path.join(runDir, 'coach_diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    fs.writeFileSync(path.join(runDir, 'coach_diagnostics.md'), renderDiagnostics(diagnostics));

    const days = fs
      .readdirSync(path.join(runDir, 'days'))
      .filter((f) => /^day_\d{2}\.json$/.test(f))
      .sort()
      .map((f) => (JSON.parse(fs.readFileSync(path.join(runDir, 'days', f), 'utf8')) as { captured: CapturedDay }).captured);
    const priorities = new Map(days.flatMap((d) => d.priorities.map((p) => [p.id, p.text] as const)));
    fs.writeFileSync(path.join(runDir, 'coach_signals.md'), renderReplay(replayCoachSignals(days), (id) => priorities.get(id) ?? id));

    console.log(`[benchmark] diagnosed ${diagnostics.days.length} day(s), ${diagnostics.unanswered} unanswered → ${path.join(runDir, 'coach_diagnostics.md')}`);
    console.log(`[benchmark] by layer: ${Object.entries(diagnostics.byLayer).map(([layer, n]) => `${layer} ${n}`).join(', ') || 'nothing unanswered'}`);
    expect(diagnostics.days.length).toBeGreaterThan(0);
  });
});
