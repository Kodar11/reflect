import type { CoachAction } from '../../../src/coach/CoachModels';
import type { ClassificationScores, DimensionScore } from '../evaluators/classification';
import type { CoachDimensionSummary, Ratio } from '../evaluators/coachDimensions';
import type { BenchmarkSummary, DayEvaluation, SegmentationSummary, VerdictCounts } from '../evaluators/index';
import type { Criterion } from '../evaluators/text';
import type { CapturedDay } from './capture';
import type { EvaluationOnlyDay } from './dataset';
import type { RunManifest } from './manifest';

/** Human-readable renderings of a run: the summary report and the review packet. */

const pct = (value: number | null | undefined, digits = 1) => (typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—');
const num = (value: number | null | undefined, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—');
const minutes = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 60_000).toFixed(1)} min` : '—');
const table = (header: string[], rows: (string | number)[][]) =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** `HH:MM` of an instant in a fixed UTC offset such as `+05:30`. */
export function clockAt(iso: string, utcOffset: string): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h, m] = utcOffset.slice(1).split(':').map(Number);
  const shifted = new Date(Date.parse(iso) + sign * (h * 60 + m) * 60_000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

function segmentationRows(timeline: SegmentationSummary, baseline: SegmentationSummary): (string | number)[][] {
  const t = timeline;
  const b = baseline;
  return [
    ['Ground-truth activities', t.micro.groundTruthCount, b.micro.groundTruthCount],
    ['Predicted blocks', t.micro.predictedCount, b.micro.predictedCount],
    ['Matched', t.micro.matchedCount, b.micro.matchedCount],
    ['Precision', pct(t.micro.precision), pct(b.micro.precision)],
    ['Recall', pct(t.micro.recall), pct(b.micro.recall)],
    ['F1', pct(t.micro.f1), pct(b.micro.f1)],
    ['Mean temporal IoU (matched pairs)', num(t.meanPerDay.meanIouMatched, 3), num(b.meanPerDay.meanIouMatched, 3)],
    ['Mean best IoU (every GT activity)', num(t.meanPerDay.meanBestIou, 3), num(b.meanPerDay.meanBestIou, 3)],
    ['Duration-weighted temporal IoU', num(t.micro.durationWeightedIou, 3), num(b.micro.durationWeightedIou, 3)],
    ['Ground-truth coverage', pct(t.micro.groundTruthCoverage), pct(b.micro.groundTruthCoverage)],
    ['Over-segmentation ratio (blocks per GT activity)', num(t.meanPerDay.overSegmentationRatio), num(b.meanPerDay.overSegmentationRatio)],
    ['Under-segmentation ratio (GT activities per block)', num(t.meanPerDay.underSegmentationRatio), num(b.meanPerDay.underSegmentationRatio)],
    ['Boundary precision', pct(t.micro.boundaryPrecision), pct(b.micro.boundaryPrecision)],
    ['Boundary recall', pct(t.micro.boundaryRecall), pct(b.micro.boundaryRecall)],
    ['Boundary F1', pct(t.micro.boundaryF1), pct(b.micro.boundaryF1)],
    ['Boundary MAE', minutes(t.meanPerDay.boundaryMaeMs), minutes(b.meanPerDay.boundaryMaeMs)],
    ['Duration absolute error (matched)', minutes(t.meanPerDay.durationAbsErrorMs), minutes(b.meanPerDay.durationAbsErrorMs)],
    ['Duration relative error (matched)', pct(t.meanPerDay.durationRelError), pct(b.meanPerDay.durationRelError)],
  ];
}

function classificationRows(scores: ClassificationScores, unit: 'pairs' | 'time'): (string | number)[][] {
  const amount = (value: number) => (unit === 'time' ? `${(value / 3_600_000).toFixed(1)} h` : String(value));
  const row = (name: string, s: DimensionScore) => [name, pct(s.accuracy), pct(s.strictAccuracy), amount(s.evaluated), amount(s.ambiguous), amount(s.unmappable)];
  return [
    row('Context (dataset) → Reflect Area', scores.context),
    row('Area (dataset) → Reflect priority link', scores.area),
    row('Intent', scores.intent),
    row('Quality', scores.quality),
    ['**Full classification** (every mappable dimension)', pct(scores.full.accuracy), '—', amount(scores.full.evaluated), '—', '—'],
  ];
}

function verdictRows(groups: Record<string, VerdictCounts & { label: string; method: string; confidence: string }>): (string | number)[][] {
  return Object.entries(groups).map(([id, g]) => [cell(g.label), g.PASS, g.PARTIAL, g.FAIL, g.NOT_APPLICABLE, pct(g.score, 0), `${g.method}${g.confidence === 'low' ? ' · low confidence' : ''}`, `\`${id}\``]);
}

export interface ReportInput {
  manifest: RunManifest;
  summary: BenchmarkSummary;
  days: { evaluation: DayEvaluation; captured: CapturedDay; geminiCalls: number }[];
}

export function renderReport({ manifest, summary, days }: ReportInput): string {
  const g = manifest.gemini;
  const lines: string[] = [];
  lines.push(`# Reflect benchmark — ${manifest.runId}`, '');
  if (manifest.status !== 'completed') lines.push(`> **Run ${manifest.status}.** ${manifest.statusReason ?? ''}`, '');
  lines.push(
    table(
      ['', ''],
      [
        ['Dataset', `${manifest.dataset.persona.type} · ${manifest.dataset.version} · days ${manifest.days.first}–${manifest.days.last} (${manifest.days.firstDate} → ${manifest.days.lastDate})`],
        ['Reflect commit', `${manifest.environment.gitCommit ?? 'unknown'}${manifest.environment.gitDirty ? ' (uncommitted changes under src/)' : ''}`],
        ['Gemini model', `${g.model}${g.modelVersions.length ? ` (answered as ${g.modelVersions.join(', ')})` : ''}`],
        ['Prompt versions', Object.entries(manifest.versions.prompts).map(([k, v]) => `${k}: ${v}`).join(' · ')],
        ['Intelligence window', manifest.config.intelligenceWindow === 'hour' ? 'hour (production cadence)' : 'day (one request per day)'],
        ['Action policy', manifest.config.actionPolicy],
        ['Started / finished', `${manifest.startedAt} / ${manifest.finishedAt}`],
      ],
    ),
    '',
  );

  lines.push('## Gemini usage', '');
  lines.push(
    table(
      ['Stage', 'Requests', 'Failed', 'Mean latency'],
      [
        ...Object.entries(g.byStage).map(([stage, s]) => [stage, s.calls, s.failed, s.meanLatencyMs === null ? '—' : `${s.meanLatencyMs} ms`]),
        ['**Total**', `**${g.totalCalls}**`, `**${g.failed}**`, g.meanLatencyMs === null ? '—' : `${g.meanLatencyMs} ms`],
      ],
    ),
    '',
    `Retries inside production pipelines: **${manifest.totals.retries}** (activity reconstruction ${manifest.totals.intelligence.retries}, reflection ${manifest.totals.reflection.retries}). ` +
      `Failed pipeline runs: activity reconstruction ${manifest.totals.intelligence.failedRuns}, reflection ${manifest.totals.reflection.failedReports}. ` +
      `Cycles re-run after an infrastructure stop: ${manifest.totals.cycleReruns}.`,
    '',
  );

  lines.push('## Activity reconstruction', '');
  lines.push(
    `Matching: temporal IoU ≥ ${manifest.config.matching.iouThreshold}, boundary tolerance ${manifest.config.matching.boundaryToleranceMs / 1000}s. ` +
      'Titles are never compared. "Timeline" is what the user sees (AI activities, deterministic sessions where no AI activity exists); "Sessionizer" is the no-AI baseline.',
    '',
    table(['Metric', 'Timeline', 'Sessionizer only'], segmentationRows(summary.segmentation.timeline, summary.segmentation.deterministic)),
    '',
  );

  lines.push('## Classification', '');
  lines.push(
    'Lenient accuracy judges an ambiguous dataset label against its accept-set; strict accuracy counts only labels with a single Reflect twin. See `evaluators/taxonomyMapping.ts`.',
    '',
    '**Timeline, by tracked time** (independent of matching)',
    '',
    table(['Dimension', 'Accuracy', 'Strict', 'Evaluated', 'Ambiguous', 'Unmappable'], classificationRows(summary.classification.timeline.byTime, 'time')),
    '',
    '**Timeline, matched pairs**',
    '',
    table(['Dimension', 'Accuracy', 'Strict', 'Evaluated', 'Ambiguous', 'Unmappable'], classificationRows(summary.classification.timeline.matched, 'pairs')),
    '',
    '**Sessionizer + rules only, by tracked time** (the seeded rules assign a Context only, so without AI activities Area, Intent and Quality are empty)',
    '',
    table(['Dimension', 'Accuracy', 'Strict', 'Evaluated', 'Ambiguous', 'Unmappable'], classificationRows(summary.classification.deterministic.byTime, 'time')),
    '',
    `Reflect's own Context dimension (no dataset counterpart; tracked hours): ${Object.entries(summary.classification.reflectContextMs)
      .sort((a, b) => b[1] - a[1])
      .map(([name, ms]) => `${name} ${(ms / 3_600_000).toFixed(1)}h`)
      .join(', ')}`,
    '',
  );
  if (summary.mappingIssues.length > 0) lines.push('**Mapping issues**', '', ...summary.mappingIssues.map((i) => `- ${i}`), '');

  lines.push('## Reflection', '');
  lines.push(
    `Reports generated: **${summary.reflection.reportsGenerated} / ${summary.daysEvaluated}**.`,
    '',
    `**A. Deterministic checks** — overall ${pct(summary.reflection.deterministicOverall.score, 0)}`,
    '',
    table(['Check', 'PASS', 'PARTIAL', 'FAIL', 'N/A', 'Score', 'Method', 'Id'], verdictRows(summary.reflection.deterministic)),
    '',
    `**B. Answer-key criteria** — overall ${pct(summary.reflection.semanticOverall.score, 0)}`,
    '',
    table(['Criterion', 'PASS', 'PARTIAL', 'FAIL', 'N/A', 'Score', 'Method', 'Id'], verdictRows(summary.reflection.semantic)),
    '',
  );

  lines.push('## Coach', '');
  lines.push(
    `Actions per day: ${Object.entries(summary.coach.actionsPerDay)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, d]) => `${n} action(s) on ${d} day(s)`)
      .join(', ')}. Overall ${pct(summary.coach.overall.score, 0)}.`,
    '',
    table(['Criterion', 'PASS', 'PARTIAL', 'FAIL', 'N/A', 'Score', 'Method', 'Id'], verdictRows(summary.coach.criteria)),
    '',
    ...coachDimensionLines(summary.coach.dimensions),
  );

  lines.push('## Per day', '');
  lines.push(
    table(
      ['Day', 'Date', 'GT', 'Blocks', 'F1', 'Mean best IoU', 'Boundary F1', 'Full class. (time)', 'Report', 'Reflection B', 'Coach', 'Actions', 'Gemini'],
      days.map(({ evaluation: e, captured, geminiCalls }) => {
        const m = e.timeline.segmentation.metrics;
        const score = (criteria: Criterion[]) => {
          const applicable = criteria.filter((c) => c.verdict !== 'NOT_APPLICABLE');
          return applicable.length > 0 ? applicable.reduce((s, c) => s + (c.verdict === 'PASS' ? 1 : c.verdict === 'PARTIAL' ? 0.5 : 0), 0) / applicable.length : null;
        };
        return [
          e.dayNumber,
          e.date,
          m.groundTruthCount,
          m.predictedCount,
          pct(m.f1, 0),
          num(m.meanBestIou),
          pct(m.boundaryF1, 0),
          pct(e.timeline.classification.byTime.full.accuracy, 0),
          captured.reflection.report ? captured.reflection.report.status : captured.reflection.latestAttempt?.status ?? 'none',
          pct(score(e.reflection.semantic), 0),
          pct(score(e.coach.criteria), 0),
          e.coach.actionCount,
          geminiCalls,
        ];
      }),
    ),
    '',
  );

  lines.push('## How to read this', '');
  lines.push(
    '- **Structural** results are computed from ids, intervals and stored numbers. They are exact.',
    '- **Lexical · low confidence** results compare meaning without a second model, by concept coverage and word lists. They are a screening signal, not a verdict: read `review.md`, which puts the answer key next to what Reflect wrote for every day.',
    '- Gemini is not deterministic. The same dataset, code, configuration and model give comparable runs, not identical ones; `manifest.json` records everything needed to explain a difference.',
    `- Answer-key separation: ${manifest.safeguards.promptLeaks} of ${g.totalCalls} prompts contained answer-key wording; ${manifest.safeguards.databaseLeaks} of ${manifest.safeguards.databaseValuesScanned} text values in the benchmark database did.`,
    '',
  );
  return lines.join('\n');
}

/** The answer key next to what Reflect wrote, day by day, for a human reader. */
export function renderReviewPacket(days: { evaluation: DayEvaluation; captured: CapturedDay; answer: EvaluationOnlyDay }[]): string {
  const lines: string[] = ['# Review packet', '', 'Expected (answer key) and actual (Reflect), side by side. Use it to confirm or overrule the low-confidence verdicts.', ''];
  const verdictList = (criteria: Criterion[]) =>
    criteria.map((c) => `- **${c.verdict}** — ${c.label}${c.expected ? ` — _${c.expected}_` : ''}\n  ${c.detail}${c.evidence?.length ? `\n  ${c.evidence.slice(0, 3).map((e) => `> ${e.replace(/\n+/g, ' ')}`).join('\n  ')}` : ''}`);

  for (const { evaluation, captured, answer } of days) {
    const report = captured.reflection.report;
    lines.push(`## Day ${answer.dayNumber} — ${answer.date} (${answer.dayType})`, '');

    lines.push('### Activities', '');
    lines.push(
      table(
        ['Ground truth', 'Time', 'Labels', 'Best predicted block', 'IoU'],
        answer.groundTruth.activities.map((a) => {
          const best = evaluation.timeline.segmentation.bestPerGroundTruth.find((b) => b.groundTruthId === a.id);
          const block = captured.timeline.find((b) => b.id === best?.predictedId);
          return [
            cell(a.title),
            `${a.started_at}–${a.ended_at}`,
            `${a.context} / ${a.area ?? '—'} / ${a.intent} / ${a.quality}`,
            block
              ? cell(`${block.title} (${clockAt(block.startedAt, answer.utcOffset)}–${clockAt(block.endedAt, answer.utcOffset)}; ${block.classification.area ?? '—'} / ${block.classification.intent ?? '—'} / ${block.classification.quality ?? '—'}; ${block.kind})`)
              : '—',
            num(best?.iou ?? 0),
          ];
        }),
      ),
      '',
    );

    lines.push('### Reflection', '', '**Expected**', '');
    lines.push(...answer.expectedReflection.key_observations.map((o) => `- ${o}`));
    lines.push(...answer.expectedReflection.priority_alignment.map((p) => `- _${p.priority}_: ${p.assessment}`));
    lines.push(...answer.expectedReflection.important_uncertainty.map((u) => `- Uncertain: ${u}`));
    lines.push(`- Next step: ${answer.expectedReflection.possible_next_step}`, '', '**Actual**', '');
    if (!report) {
      lines.push(`_No report._ ${captured.reflection.latestAttempt ? `Last attempt: ${captured.reflection.latestAttempt.status} ${captured.reflection.latestAttempt.errorCategory ?? ''} ${captured.reflection.latestAttempt.error ?? ''}` : ''}`, '');
    } else {
      lines.push(`- Headline: ${report.headline ?? ''}`);
      if (report.narrative) lines.push(`- Narrative: ${report.narrative}`);
      for (const insight of report.insights) lines.push(`- [${insight.type}] **${insight.title}** — ${insight.observation} ${insight.interpretation}${insight.relevance ? ` ${insight.relevance}` : ''}`);
      for (const u of report.coach?.uncertainty ?? []) lines.push(`- Uncertain: ${u}`);
      lines.push('');
    }
    lines.push('**Verdicts**', '', ...verdictList([...evaluation.reflection.deterministic.filter((c) => c.verdict !== 'PASS'), ...evaluation.reflection.semantic]), '');

    lines.push('### Coach', '', '**Expected**', '');
    const expected = answer.expectedCoachOutcome;
    lines.push(expected.primary_action ? `- Primary: [${expected.primary_action.action_type} → ${expected.primary_action.target}] ${expected.primary_action.title} — ${expected.primary_action.reason}` : '- Primary: none');
    if (expected.secondary_action) lines.push(`- Secondary: [${expected.secondary_action.action_type} → ${expected.secondary_action.target}] ${expected.secondary_action.title} — ${expected.secondary_action.reason}`);
    lines.push(...expected.things_not_to_do.map((t) => `- Not: ${t}`), '', '**Actual**', '');
    if (captured.coach.actions.length === 0) lines.push(`- No actions.${report?.coach?.noActionReason ? ` Reason given: ${report.coach.noActionReason}` : ''}`);
    for (const action of captured.coach.actions) {
      lines.push(`- [${action.actionType} · ${action.strategyKey} → ${action.targetKey ?? 'general'}] **${action.title}** — ${action.rationale}${action.focusMinutes ? ` (${action.focusMinutes}m focus)` : ''}`);
    }
    for (const followup of report?.coach?.followups ?? []) lines.push(`- Follow-up on "${followup.title}": ${followup.note}${followup.learned ? ` Learned: ${followup.learned}` : ''}`);
    if (report?.coach?.question) lines.push(`- Question: ${report.coach.question.text}`);
    for (const memory of captured.coach.memoriesAdded) lines.push(`- Memory (${memory.kind}): ${memory.text}`);
    lines.push('', '**Verdicts**', '', ...verdictList(evaluation.coach.criteria), '');
  }
  return lines.join('\n');
}

// ── Coach dimensions ────────────────────────────────────────────────────────

const frac = (r: Ratio) => (r.value === null ? 'n/a (nothing applied)' : `${pct(r.value, 0)} (${Number.isInteger(r.numerator) ? r.numerator : r.numerator.toFixed(1)} / ${r.denominator})`);

/** One row per dimension: `[name, value, what it means]`. Shared by the report and the before/after comparison. */
export function coachDimensionRows(d: CoachDimensionSummary): [string, string, string][] {
  const l = d.lifecycle;
  return [
    ['Days evaluated', String(d.daysEvaluated), ''],
    ['Days with an expected action (strong opportunity)', String(d.daysExpectedAction), 'silence is a miss'],
    ['Days where an action is optional (moderate)', String(d.daysOptionalAction), 'action and silence are both fine'],
    ['Days with an expected null (no opportunity)', String(d.daysExpectedNull), 'any action is unnecessary'],
    ['Actions generated', `${d.actionsGenerated} on ${d.daysWithActions} day(s)`, 'reported, never rewarded'],
    ['**Recommendation — opportunity recall**', frac(d.opportunityRecall), 'strong days answered (correct = 1, partial = ½)'],
    ['Recommendation — fully correct', frac(d.fullyCorrect), 'strong days answered with the expected move'],
    ['Recommendation — partially correct', frac(d.partiallyCorrect), 'strong days answered only in part (secondary opportunity / other kind of action)'],
    ['Recommendation — opportunity detection', frac(d.opportunityDetection), 'strong days on which anything was recommended'],
    ['**Recommendation — action precision**', frac(d.actionPrecision), 'actions that were justified'],
    ['Recommendation — alignment', frac(d.actionAlignment), 'tied to a stated priority / open thread'],
    ['Recommendation — specificity', frac(d.actionSpecificity), 'what, on what, when — executable'],
    ['Recommendation — evidence grounding', frac(d.evidenceGrounding), 'cited evidence exists'],
    ['Recommendation — feasibility', frac(d.feasibility), 'one sitting, window still ahead'],
    ['Recommendation — not generic', frac(d.nonGeneric), ''],
    ['Recommendation — not a repeat', frac(d.notRepeated), 'does not restate an action of the previous three days'],
    ['Recommendation — concentration on one target', frac(d.targetConcentration), 'share of all actions aimed at the single most-recommended target (lower = more balanced)'],
    ['**Recommendation — appropriate null**', frac(d.appropriateNull), 'no-opportunity days left alone'],
    ['Adherence — decisions recorded', `accepted ${l.accepted}, rejected ${l.rejected}, deferred ${l.deferred}, undecided ${l.undecided} (of ${l.suggested})`, 'what the user chose — not a quality score'],
    ['**Adherence — execution tracking coverage**', frac(d.executionTracking), 'accepted actions past their window with a known execution'],
    ['Adherence — established by Reflect itself', frac(d.executionObserved), 'observed from tracked activity before anyone said so'],
    ['Adherence — supported by Reflect\'s own observation', frac(d.executionSeenByReflect), 'tracked activity shows it, whoever spoke first'],
    ['Adherence — reported by the user only', frac(d.executionReportedOnly), 'the user said so; Reflect saw nothing matching (not counted as observed)'],
    ['Adherence — execution', `done ${l.done}, partial ${l.partial}, not done ${l.notDone}, unknown ${l.executionUnknown}`, ''],
    ['**Outcome — outcome tracking coverage**', frac(d.outcomeTracking), 'carried-out actions with a recorded outcome'],
    ['Outcome — as stated', `worked ${l.worked}, partly ${l.partlyWorked}, did not work ${l.didNotWork}, n/a ${l.notApplicable}`, 'the user\'s word — no causality is claimed'],
    ['**Adaptation — checks passed**', `${d.adaptation.passed} / ${d.adaptation.checks}`, Object.entries(d.adaptation.byKind).map(([k, v]) => `${k} ${v.passed}/${v.checks}`).join(', ') || 'no settled action preceded a coaching day'],
  ];
}

function coachDimensionLines(d: CoachDimensionSummary): string[] {
  return [
    '**Coach, by dimension** — recommendation quality, adherence, outcome and adaptation are separate questions and are never combined.',
    '',
    table(['Dimension', 'Value', 'Meaning'], coachDimensionRows(d).map(([a, b, c]) => [a, cell(b), cell(c)])),
    '',
    `Verdicts per day: ${Object.entries(d.verdicts).filter(([, n]) => n > 0).map(([v, n]) => `${v} ${n}`).join(', ')}. Every day is laid out in \`coach_review.md\`.`,
    '',
  ];
}

/**
 * For every day: what would have been useful, what the Coach recommended, the
 * verdict and why — then what the user did with it and what the Coach did next.
 */
export function renderCoachReview(
  days: { evaluation: DayEvaluation; captured: CapturedDay; answer: EvaluationOnlyDay }[],
  summary: BenchmarkSummary,
  finalActions: CoachAction[] = [],
): string {
  const lines: string[] = ['# Coach review', '', 'Ground truth next to what the Coach did, day by day. Aggregates cannot tell whether the Coach feels intelligent; this can.', ''];
  lines.push(table(['Dimension', 'Value', 'Meaning'], coachDimensionRows(summary.coach.dimensions).map(([a, b, c]) => [a, cell(b), cell(c)])), '');

  const finalById = new Map(finalActions.map((a) => [a.id, a]));
  const lastSeen = new Map<string, CoachAction>();
  for (const { captured } of days) for (const a of [...captured.coach.earlierActions, ...captured.coach.actions]) lastSeen.set(a.id, a);

  for (const { evaluation, captured, answer } of days) {
    const a = evaluation.coach.assessment;
    lines.push(`## Day ${answer.dayNumber} — ${answer.date} · opportunity: ${a.opportunity.strength}`, '');
    lines.push(`**GROUND TRUTH** — ${a.expectedPrimary ?? 'no action is useful today'}${a.expectedSecondary ? `  \n_also:_ ${a.expectedSecondary}` : ''}`, '');
    lines.push(
      `**REFLECT COACH** — ${a.actual.length > 0 ? a.actual.map((t) => cell(t)).join('  \n') : `no action${a.noActionReason ? ` ("${a.noActionReason}")` : ''}`}`,
      '',
      `**VERDICT** — ${a.verdict.replace(/_/g, ' ')}`,
      '',
      `**WHY** — ${a.why}`,
      '',
    );
    for (const action of a.actions) {
      const flags = [
        action.justified ? 'justified' : 'NOT justified',
        action.grounded ? 'grounded' : 'not grounded',
        action.aligned ? 'aligned' : 'not aligned',
        action.specific ? 'specific' : 'not specific',
        action.feasible ? 'feasible' : 'not feasible',
        ...(action.generic ? ['generic'] : []),
        ...(action.prohibited ? ['prohibited'] : []),
        ...(action.repeated ? ['REPEAT'] : []),
      ];
      lines.push(`- "${cell(action.title)}" — ${flags.join(' · ')}${action.notes.length ? ` — ${cell(action.notes.join('; '))}` : ''}`);
      const state = finalById.get(action.actionId) ?? lastSeen.get(action.actionId);
      if (state) {
        const decision = state.status === 'rejected' ? `rejected${state.reasonCode ? ` (${state.reasonCode})` : ''}` : state.acceptedAt ? 'accepted' : state.snoozeCount > 0 ? 'deferred' : state.status === 'expired' ? 'never decided' : 'not decided yet';
        const execution = state.execution ? `${state.execution} (${state.executionSource === 'user' ? 'the user said so' : 'observed by Reflect'})` : state.observation ? state.observation.kind.replace(/_/g, ' ') : '—';
        lines.push(`  - _Action → decision → execution → outcome:_ ${decision} → ${execution} → ${state.outcome ?? '—'}${state.observation?.facts.length ? `  \n    observed: ${cell(state.observation.facts.join(' '))}` : ''}`);
      }
    }
    for (const followup of captured.reflection.report?.coach?.followups ?? []) lines.push(`- Follow-up on "${cell(followup.title)}": ${cell(followup.note)}${followup.learned ? ` _Learned:_ ${cell(followup.learned)}` : ''}`);
    for (const check of a.adaptation) lines.push(`- **Adaptation (${check.kind.replace(/_/g, ' ')}) — ${check.pass ? 'PASS' : 'FAIL'}**: ${check.behaviour}. ${cell(check.detail)}`);
    if (captured.reflection.report?.coach?.question) lines.push(`- Question asked: ${cell(captured.reflection.report.coach.question.text)}`);
    for (const memory of captured.coach.memoriesAdded) lines.push(`- Remembered (${memory.kind}): ${cell(memory.text)}`);
    lines.push('');
  }
  return lines.join('\n');
}
