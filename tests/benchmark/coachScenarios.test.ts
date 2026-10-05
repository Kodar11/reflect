import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { CoachAction } from '../../src/coach/CoachModels';
import { stateOf, summarizeCoachDimensions, type CoachAssessment, type CoachDimensionSummary } from './evaluators/coachDimensions';
import { checkAnswerKeyVocabulary } from './evaluators/index';
import { BENCHMARK_ROOT, loadConfig } from './runner/config';
import { loadDataset, splitDataset } from './runner/dataset';
import { coachDimensionRows } from './runner/report';
import { BenchmarkAbortedError, runBenchmark } from './runner/run';

/**
 * The Coach scenario set: fifteen small multi-day datasets, each asking the
 * Coach one question (open loop? stay silent? adapt after a failure?).
 *
 * Two halves:
 *   - always on: every scenario directory is a valid dataset whose answer key
 *     the evaluator can read, and the set covers what it claims to cover;
 *   - `REFLECT_COACH_SCENARIOS=1` (`npm run benchmark -- --coach-scenarios`):
 *     each scenario is run through the real pipeline and the real model, with
 *     the simulated user answering as its answer key says, and the results
 *     are written to `results/coach_scenarios/`.
 *
 * As with the 30-day benchmark, the live half asserts that the HARNESS did its
 * job; how well the Coach did is a measurement, not a gate.
 */

const SCENARIO_ROOT = path.join(BENCHMARK_ROOT, 'data', 'coach_scenarios');
const scenarioDirs = fs
  .readdirSync(SCENARIO_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const dayCount = (id: string) => fs.readdirSync(path.join(SCENARIO_ROOT, id)).filter((f) => f.endsWith('.json')).length;

interface ScenarioMeta {
  id: string;
  title: string;
  tests: string;
  probe: boolean;
}
const metaOf = (objectives: unknown): ScenarioMeta | null => (objectives as { coach_scenario?: ScenarioMeta } | null)?.coach_scenario ?? null;

describe('coach scenario set — datasets', () => {
  it('holds the fifteen scenarios, each a valid dataset the evaluator can read', () => {
    expect(scenarioDirs).toHaveLength(15);
    for (const id of scenarioDirs) {
      const { dataset, validation } = loadDataset(path.join(SCENARIO_ROOT, id), dayCount(id));
      expect(validation.errors, id).toEqual([]);
      const { input, evaluation } = splitDataset(dataset);
      expect(checkAnswerKeyVocabulary(evaluation).errors, id).toEqual([]);
      // Exactly one probe day, and nothing of the answer key in what Reflect is given.
      expect(evaluation.days.filter((d) => metaOf(d.evaluationObjectives)?.probe).length, id).toBe(1);
      expect(JSON.stringify(input), id).not.toMatch(/action_opportunity|execution_scenario|coach_scenario|ground_truth/);
    }
  });

  it('covers strong, moderate and no-opportunity days, and every kind of user response', () => {
    const probes = scenarioDirs.map((id) => {
      const { evaluation } = splitDataset(loadDataset(path.join(SCENARIO_ROOT, id), dayCount(id)).dataset);
      return { id, days: evaluation.days, probe: evaluation.days.find((d) => metaOf(d.evaluationObjectives)?.probe)! };
    });
    const strengths = probes.map((p) => p.probe.expectedCoachOutcome.action_opportunity!.strength);
    expect(strengths.filter((s) => s === 'strong').length).toBeGreaterThanOrEqual(6);
    expect(strengths.filter((s) => s === 'moderate').length).toBeGreaterThanOrEqual(2);
    expect(strengths.filter((s) => s === 'none').length).toBeGreaterThanOrEqual(4);
    // A null day really expects nothing; a strong day really expects something.
    for (const p of probes) {
      const expected = p.probe.expectedCoachOutcome;
      expect(expected.primary_action === null, p.id).toBe(expected.action_opportunity!.strength === 'none');
    }
    const scenarios = probes.flatMap((p) => p.days.map((d) => d.expectedCoachOutcome.execution_scenario)).filter((s) => s !== undefined);
    expect(new Set(scenarios.map((s) => s!.user_decision))).toEqual(new Set(['accepted', 'rejected']));
    expect(new Set(scenarios.map((s) => s!.execution))).toEqual(new Set(['done', 'not_done', 'not_applicable']));
    expect(new Set(scenarios.map((s) => s!.outcome))).toEqual(new Set(['worked', 'did_not_work', 'not_applicable']));
  });
});

// ── The live run ────────────────────────────────────────────────────────────

const enabled = process.env.REFLECT_COACH_SCENARIOS === '1';
const filter = process.env.REFLECT_COACH_SCENARIO_FILTER?.trim();

interface ScenarioResult {
  id: string;
  title: string;
  tests: string;
  status: 'completed' | 'aborted';
  statusReason: string | null;
  days: number;
  geminiCalls: number;
  /** The probe day. */
  probe: { dayNumber: number; strength: string; verdict: string; why: string; expected: string | null; actual: string[]; noActionReason: string | null } | null;
  adaptation: CoachAssessment['adaptation'];
  dimensions: CoachDimensionSummary | null;
}

const PASSING = new Set(['correct', 'correct_null', 'acceptable_null']);

function scenarioPassed(result: ScenarioResult): 'pass' | 'partial' | 'fail' {
  if (!result.probe || result.status !== 'completed') return 'fail';
  const adapted = result.adaptation.every((c) => c.pass);
  if (!adapted) return 'fail';
  if (PASSING.has(result.probe.verdict)) return 'pass';
  // On an optional day a well-founded action is as good as silence.
  if (result.probe.strength === 'moderate' && result.probe.verdict === 'partially_correct') return 'pass';
  return result.probe.verdict === 'partially_correct' ? 'partial' : 'fail';
}

describe.skipIf(!enabled)('coach scenario set — real pipeline, real Gemini', () => {
  it(
    'runs every scenario with the simulated user and writes the Coach results',
    async () => {
      const base = loadConfig();
      const outRoot = path.join(base.resultsDir, 'coach_scenarios');
      fs.mkdirSync(outRoot, { recursive: true });
      const selected = scenarioDirs.filter((id) => !filter || id.includes(filter));
      const results: ScenarioResult[] = [];
      const assessments: CoachAssessment[] = [];
      const finalStates: ReturnType<typeof stateOf>[] = [];

      for (const id of selected) {
        const config = {
          ...base,
          datasetDir: path.join(SCENARIO_ROOT, id),
          resultsDir: path.join(outRoot, id),
          expectedDays: dayCount(id),
          maxDays: null,
          // Production cadence by default (one reconstruction request per hour with events); --intelligence-window day is cheaper.
          intelligenceWindow: base.intelligenceWindow,
          actionPolicy: 'scenario' as const,
          savePrompts: true,
          keepDb: false,
        };
        let run;
        try {
          run = await runBenchmark(config, (line) => console.log(line.replace('[benchmark]', `[${id}]`)));
        } catch (err) {
          if (!(err instanceof BenchmarkAbortedError)) throw err;
          run = err.result;
        }
        const latest = run.resultsDir;
        const { evaluation } = splitDataset(loadDataset(config.datasetDir, config.expectedDays).dataset);
        const meta = metaOf(evaluation.days[0].evaluationObjectives)!;
        const days = fs
          .readdirSync(path.join(latest, 'days'))
          .sort()
          .map((f) => JSON.parse(fs.readFileSync(path.join(latest, 'days', f), 'utf8')) as { dayNumber: number; evaluation: { coach: { assessment: CoachAssessment } } });
        const finalPath = path.join(latest, 'coach_final.json');
        const final = fs.existsSync(finalPath) ? (JSON.parse(fs.readFileSync(finalPath, 'utf8')) as CoachAction[]) : [];
        const probeDay = evaluation.days.find((d) => metaOf(d.evaluationObjectives)?.probe)!;
        const probe = days.find((d) => d.dayNumber === probeDay.dayNumber)?.evaluation.coach.assessment ?? null;

        for (const day of days) assessments.push(day.evaluation.coach.assessment);
        finalStates.push(...final.map(stateOf));
        results.push({
          id,
          title: meta.title,
          tests: meta.tests,
          status: run.manifest.status,
          statusReason: run.manifest.statusReason,
          days: days.length,
          geminiCalls: run.manifest.totals.geminiCalls,
          probe: probe
            ? { dayNumber: probeDay.dayNumber, strength: probe.opportunity.strength, verdict: probe.verdict, why: probe.why, expected: probe.expectedPrimary, actual: probe.actual, noActionReason: probe.noActionReason }
            : null,
          adaptation: days.flatMap((d) => d.evaluation.coach.assessment.adaptation),
          dimensions: run.summary.coach.dimensions,
        });
      }

      // Scenario runs each have their own database, so action ids never collide and the states can be pooled.
      const overall = summarizeCoachDimensions(assessments, finalStates);
      // Probe days only: the days each scenario was built to ask about.
      const probeOnly = summarizeCoachDimensions(
        results.flatMap((r) => {
          const days = fs.readdirSync(path.join(outRoot, r.id, 'latest', 'days')).sort();
          const day = days.map((f) => JSON.parse(fs.readFileSync(path.join(outRoot, r.id, 'latest', 'days', f), 'utf8'))).find((d) => d.dayNumber === r.probe?.dayNumber);
          return day ? [day.evaluation.coach.assessment as CoachAssessment] : [];
        }),
        finalStates,
      );
      const outcome = results.map((r) => ({ ...r, result: scenarioPassed(r) }));
      fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify({ scenarios: outcome, overall, probeOnly }, null, 2));

      const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
      const lines = [
        '# Coach scenario set',
        '',
        `${outcome.filter((r) => r.result === 'pass').length} of ${outcome.length} scenarios passed, ${outcome.filter((r) => r.result === 'partial').length} partially. ` +
          'A scenario passes when its probe day is answered correctly (the right action, or silence where silence is right) and every adaptation check holds.',
        '',
        '| Scenario | Probe day expects | Coach did | Verdict | Adaptation | Result |',
        '| --- | --- | --- | --- | --- | --- |',
        ...outcome.map((r) =>
          [
            '',
            `**${cell(r.title)}**`,
            cell(r.probe ? `${r.probe.strength}: ${r.probe.expected ?? 'no action'}` : '—'),
            cell(r.probe ? (r.probe.actual.length > 0 ? r.probe.actual.join(' / ') : `no action${r.probe.noActionReason ? ` ("${r.probe.noActionReason}")` : ''}`) : r.statusReason ?? '—'),
            cell(r.probe ? `${r.probe.verdict.replace(/_/g, ' ')} — ${r.probe.why}` : r.status),
            cell(r.adaptation.length > 0 ? r.adaptation.map((c) => `${c.kind.replace(/_/g, ' ')}: ${c.pass ? 'PASS' : 'FAIL'} (${c.behaviour})`).join('; ') : '—'),
            r.result.toUpperCase(),
            '',
          ].join(' | ').trim(),
        ),
        '',
        '## Dimensions — probe days only',
        '',
        '| Dimension | Value | Meaning |',
        '| --- | --- | --- |',
        ...coachDimensionRows(probeOnly).map(([a, b, c]) => `| ${a} | ${cell(b)} | ${cell(c)} |`),
        '',
        '## Dimensions — every scenario day',
        '',
        '| Dimension | Value | Meaning |',
        '| --- | --- | --- |',
        ...coachDimensionRows(overall).map(([a, b, c]) => `| ${a} | ${cell(b)} | ${cell(c)} |`),
        '',
        'Per-day detail for a scenario: `results/coach_scenarios/<scenario>/latest/coach_review.md`.',
        '',
      ];
      fs.writeFileSync(path.join(outRoot, 'summary.md'), lines.join('\n'));
      console.log(`[coach-scenarios] ${path.join(outRoot, 'summary.md')}`);

      // The harness did its job: every selected scenario ran to the end on its own database, with no answer key leaking.
      expect(results).toHaveLength(selected.length);
      for (const r of results) expect(r.status, `${r.id}: ${r.statusReason ?? ''}`).toBe('completed');
    },
    6 * 60 * 60 * 1000,
  );
});
