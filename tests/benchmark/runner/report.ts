import type { ClassificationScores, DimensionScore } from '../evaluators/classification';
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
