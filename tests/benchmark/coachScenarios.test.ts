import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { CoachAction } from '../../src/coach/CoachModels';
import { REASON_LAYER, REASON_MEANING, type CoachDiagnostics, type DayDiagnosis } from './evaluators/coachDiagnostics';
import { stateOf, summarizeCoachDimensions, type CoachAssessment, type CoachDimensionSummary } from './evaluators/coachDimensions';
import { checkAnswerKeyVocabulary } from './evaluators/index';
import { BENCHMARK_ROOT, loadConfig } from './runner/config';
import { loadDataset, splitDataset } from './runner/dataset';
import { coachDimensionRows } from './runner/report';
import { BenchmarkAbortedError, runBenchmark } from './runner/run';

/**
 * The Coach scenario set: twenty-two small multi-day datasets across four
 * personas, each asking the Coach one question (open loop? stay silent? which
 * of several priorities? adapt after a failure, a rejection, a postponement?).
 * It is deliberately not all "an action is expected": as many probe days call
 * for silence or leave the choice open as call for one particular move.
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
  it('holds the twenty-two scenarios, each a valid dataset the evaluator can read', () => {
    expect(scenarioDirs).toHaveLength(22);
    for (const id of scenarioDirs) {
      const { dataset, validation } = loadDataset(path.join(SCENARIO_ROOT, id), dayCount(id));
      expect(validation.errors, id).toEqual([]);
      const { input, evaluation } = splitDataset(dataset);
      expect(checkAnswerKeyVocabulary(evaluation).errors, id).toEqual([]);
      // Exactly one probe day, and nothing of the answer key in what Reflect is given.
      expect(evaluation.days.filter((d) => metaOf(d.evaluationObjectives)?.probe).length, id).toBe(1);
      expect(JSON.stringify(input), id).not.toMatch(/action_opportunity|execution_scenario|coach_scenario|ground_truth|coach_history/);
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
    // Silence has to be testable: a set where every day wants an action cannot tell a good Coach from a talkative one.
    expect(strengths.filter((s) => s === 'none').length).toBeGreaterThanOrEqual(7);
    expect(new Set(probes.map((p) => p.days[0].dayType.slice(0, 2))).size).toBe(22);
    const personas = new Set(scenarioDirs.map((id) => loadDataset(path.join(SCENARIO_ROOT, id), dayCount(id)).dataset.days[0].persona.type));
    expect(personas).toEqual(new Set(['student', 'founder', 'researcher', 'designer']));
    // A null day really expects nothing; a strong day really expects something.
    for (const p of probes) {
      const expected = p.probe.expectedCoachOutcome;
      expect(expected.primary_action === null, p.id).toBe(expected.action_opportunity!.strength === 'none');
    }
    // What the user did with a recommendation: answered live (execution_scenario) or as seeded history (coach_history).
    const responses = probes.flatMap((p) =>
      p.days.flatMap((d) => [
        ...(d.expectedCoachOutcome.execution_scenario ? [d.expectedCoachOutcome.execution_scenario] : []),
        ...d.coachHistory.map((h) => ({ user_decision: h.user_decision, execution: h.execution, outcome: h.outcome, reason_code: h.reason_code ?? null })),
      ]),
    );
    expect(new Set(responses.map((s) => s.user_decision))).toEqual(new Set(['accepted', 'rejected', 'deferred']));
    expect(new Set(responses.map((s) => s.execution))).toEqual(new Set(['done', 'partial', 'not_done', 'not_applicable']));
    expect(new Set(responses.map((s) => s.outcome))).toEqual(new Set(['worked', 'partly_worked', 'did_not_work', 'not_applicable']));
    expect(new Set(responses.map((s) => s.reason_code).filter(Boolean))).toEqual(new Set(['bad_timing', 'not_relevant', 'external_constraint', 'too_difficult']));
    // Seeded history is history: it never states what the Coach should do next.
    for (const p of probes) for (const d of p.days) for (const h of d.coachHistory) expect(h.title, p.id).not.toBe(d.expectedCoachOutcome.primary_action?.title);
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
  /** The persona the scenario is about (student, founder, researcher, designer). */
  persona: string;
  /** Why the probe day was not answered, when it was not (`evaluators/coachDiagnostics.ts`). */
  diagnosis: DayDiagnosis | null;
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

        const diagnosticsPath = path.join(latest, 'coach_diagnostics.json');
        const diagnostics = fs.existsSync(diagnosticsPath) ? (JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8')) as CoachDiagnostics) : null;
        const persona = loadDataset(config.datasetDir, config.expectedDays).dataset.days[0].persona.type;
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
          persona,
          diagnosis: diagnostics?.days.find((d) => d.dayNumber === probeDay.dayNumber) ?? null,
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
      // The same Coach, by persona: probe days only. Nothing in the Coach knows which persona it is looking at.
      const probeAssessment = (r: ScenarioResult): CoachAssessment[] => {
        const dir = path.join(outRoot, r.id, 'latest', 'days');
        const day = fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).find((d) => d.dayNumber === r.probe?.dayNumber);
        return day ? [day.evaluation.coach.assessment as CoachAssessment] : [];
      };
      const personas = [...new Set(results.map((r) => r.persona))].sort();
      const byPersona = Object.fromEntries(
        personas.map((persona) => {
          const own = outcome.filter((r) => r.persona === persona);
          return [persona, { scenarios: own.length, passed: own.filter((r) => r.result === 'pass').length, dimensions: summarizeCoachDimensions(own.flatMap(probeAssessment)) }];
        }),
      );
      fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify({ scenarios: outcome, overall, probeOnly, byPersona }, null, 2));

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
        '## Why the probe days that were not answered were not answered',
        '',
        '| Scenario | Verdict | MISS_REASON | Layer | Detail |',
        '| --- | --- | --- | --- | --- |',
        ...outcome
          .filter((r) => r.diagnosis?.reason)
          .map((r) => `| ${cell(r.title)} | ${r.diagnosis!.verdict.replace(/_/g, ' ')} | **${r.diagnosis!.reason}** | ${REASON_LAYER[r.diagnosis!.reason!].replace(/_/g, ' ')} | ${cell(r.diagnosis!.detail)} — _${REASON_MEANING[r.diagnosis!.reason!]}_ |`),
        ...(outcome.some((r) => r.diagnosis?.reason) ? [] : ['| _every probe day was answered_ | | | | |']),
        '',
        '## By persona — probe days only',
        '',
        'The Coach is given no persona-specific rule; this is the same code on different kinds of work.',
        '',
        '| Persona | Scenarios passed | Opportunity recall | Opportunity precision | Action precision | Appropriate null |',
        '| --- | --- | --- | --- | --- | --- |',
        ...personas.map((persona) => {
          const p = byPersona[persona];
          const show = (r: { value: number | null; numerator: number; denominator: number }) => (r.value === null ? 'n/a' : `${Math.round(r.value * 100)}% (${Number.isInteger(r.numerator) ? r.numerator : r.numerator.toFixed(1)} / ${r.denominator})`);
          return `| ${persona} | ${p.passed} / ${p.scenarios} | ${show(p.dimensions.opportunityRecall)} | ${show(p.dimensions.opportunityPrecision)} | ${show(p.dimensions.actionPrecision)} | ${show(p.dimensions.appropriateNull)} |`;
        }),
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
