#!/usr/bin/env node
// Combined report over every persona run in a results directory — no database, no Gemini.
//
//   node tests/benchmark/tools/combined.mjs <results dir> [--baseline <other results dir>] [--notes <file.html>]
//
// <results dir> holds one folder per persona, each with the `latest/` of an ordinary run. Written next to them:
//
//   combined.json   every number below, for further use
//   combined.md     the tables as Markdown
//   combined.html   the same as one page (with --notes, that file's HTML is placed under the title)
//
// With --baseline, a before/after table compares the headline numbers persona by persona. The baseline is read
// exactly as stored; when its runs were scored by an older evaluator or answer key, say so next to the table.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'tests/benchmark/results/v2');
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const baselineRoot = valueOf('--baseline') ? path.resolve(valueOf('--baseline')) : null;
const notesFile = valueOf('--notes');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const NAMES = {
  founder_freelancer: 'Founder / freelancer',
  college_student: 'College student',
  researcher: 'Researcher',
  content_creator: 'Content creator',
  sofware_developer: 'Software developer',
  graphic_designer: 'Graphic designer',
};
const ORDER = Object.keys(NAMES);

// ── Extraction ──────────────────────────────────────────────────────────────

function readPersona(dir, persona) {
  const latest = path.join(dir, persona, 'latest');
  if (!fs.existsSync(path.join(latest, 'summary.json'))) return null;
  const summary = readJson(path.join(latest, 'summary.json'));
  const manifest = readJson(path.join(latest, 'manifest.json'));
  const diagPath = path.join(latest, 'coach_diagnostics.json');
  const diag = fs.existsSync(diagPath) ? readJson(diagPath) : null;
  const t = summary.segmentation.timeline;
  const b = summary.segmentation.deterministic;
  const cls = summary.classification.timeline.byTime;
  const dim = (d) => ({ accuracy: d.accuracy, strict: d.strictAccuracy, scorable: d.evaluated + d.unmappable > 0 ? d.evaluated / (d.evaluated + d.unmappable) : null, evaluatedH: d.evaluated / 3_600_000, ambiguousH: d.ambiguous / 3_600_000, unmappableH: d.unmappable / 3_600_000 });
  const overall = (group) => {
    let got = 0;
    let of = 0;
    for (const v of Object.values(group)) {
      got += v.PASS + v.PARTIAL * 0.5;
      of += v.PASS + v.PARTIAL + v.FAIL;
    }
    return of ? got / of : null;
  };

  const reflection = { dailyReports: 0, attempts: 0, firstAttempt: 0, fallback: 0, repaired: 0, removed: 0, validationFailures: 0 };
  const profile = { changes: 0, days: 0 };
  const soft = { uncertainActivities: 0, merged: 0 };
  const days = [];
  const failures = [];
  const samples = [];
  for (const file of fs.readdirSync(path.join(latest, 'days')).sort()) {
    const day = readJson(path.join(latest, 'days', file));
    const ev = day.evaluation;
    const m = ev.timeline.segmentation.metrics;
    const a = ev.coach.assessment ?? {};
    const report = day.captured.reflection?.report ?? null;
    if (report) {
      reflection.dailyReports++;
      reflection.attempts += report.attemptCount ?? 0;
      if ((report.attemptCount ?? 0) === 1) reflection.firstAttempt++;
    }
    for (const line of day.pipelineLog ?? []) {
      if (line.includes('writing the measured summary only')) reflection.fallback++;
      const repaired = /\[REFLECTION\] Repaired (\d+) presentation/.exec(line);
      if (repaired) reflection.repaired += Number(repaired[1]);
      const removed = /\[REFLECTION\] Removed (\d+) unsupported/.exec(line);
      if (removed) reflection.removed += Number(removed[1]);
      if (line.includes('[REFLECTION] Validation failed')) reflection.validationFailures++;
    }
    if (ev.softBoundaries) {
      soft.uncertainActivities += ev.softBoundaries.uncertainActivities;
      soft.merged += ev.softBoundaries.merged;
    }
    const actions = day.captured.coach?.actions ?? [];
    days.push({
      n: day.dayNumber,
      date: day.date,
      gt: m.groundTruthCount,
      blocks: m.predictedCount,
      f1: m.f1,
      f1Baseline: ev.deterministic.segmentation.metrics.f1,
      report: report ? report.status : null,
      insights: report ? report.insights.length : null,
      attempts: report ? report.attemptCount : null,
      actions: ev.coach.actionCount,
      verdict: a.verdict ?? null,
      strength: a.opportunity?.strength ?? null,
      gemini: day.gemini.length,
    });
    if (!report) failures.push({ day: day.dayNumber, subsystem: 'Reflection', expected: 'a daily report', actual: 'no report was written', why: (day.pipelineLog ?? []).filter((l) => l.includes('Generation failed')).pop()?.replace(/^.*Generation failed/, 'Generation failed').slice(0, 300) ?? 'unknown' });
    if (['wrong', 'missed', 'unnecessary'].includes(a.verdict)) {
      failures.push({
        day: day.dayNumber,
        subsystem: 'Coach',
        verdict: a.verdict,
        expected: a.opportunity?.strength === 'none' ? 'silence' : (a.expectedPrimary ?? '').split(' — ')[0],
        actual: actions.length ? actions.map((x) => x.title).join(' / ') : `nothing${a.noActionReason ? ` (“${a.noActionReason}”)` : ''}`,
        why: a.why ?? '',
        aim: (a.actions ?? [])[0]?.aim ?? null,
      });
    }
    if (m.f1 < 0.5) failures.push({ day: day.dayNumber, subsystem: 'Activity reconstruction', expected: `${m.groundTruthCount} activities`, actual: `${m.predictedCount} blocks, ${m.matchedCount} matched (F1 ${(m.f1 * 100).toFixed(0)}%)`, why: m.predictedCount > m.groundTruthCount * 1.3 ? 'more blocks than activities: work split into several pieces' : m.predictedCount < m.groundTruthCount * 0.77 ? 'fewer blocks than activities: separate work joined' : 'boundaries placed differently' });
    samples.push({
      n: day.dayNumber,
      date: day.date,
      headline: report?.headline ?? null,
      narrative: report?.narrative ?? null,
      insights: (report?.insights ?? []).map((i) => ({ title: i.title, observation: i.observation })),
      noActionReason: report?.coach?.noActionReason ?? null,
      actions: actions.map((x) => ({ title: x.title, description: x.description, type: x.actionType })),
      expected: a.expectedPrimary ?? null,
      verdict: a.verdict ?? null,
      timeline: day.captured.timeline.map((x) => ({ start: x.startedAt, end: x.endedAt, title: x.title })),
    });
  }
  const runLog = fs.existsSync(path.join(latest, 'run.log')) ? fs.readFileSync(path.join(latest, 'run.log'), 'utf8').split('\n') : [];
  for (const line of runLog) {
    const m = /: profile \((morning|evening)\) — (.*)$/.exec(line);
    if (m) {
      profile.days++;
      profile.changes += m[2].split('; ').length;
    }
  }

  const d = summary.coach.dimensions;
  return {
    persona,
    name: NAMES[persona] ?? persona,
    status: manifest.status,
    statusReason: manifest.statusReason,
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    durationMin: manifest.durationMs / 60000,
    commit: manifest.environment.gitCommit,
    dirty: manifest.environment.gitDirty,
    evaluator: manifest.versions.evaluator,
    model: manifest.gemini.model,
    prompts: manifest.versions.prompts,
    actionPolicy: manifest.config.actionPolicy,
    daysCount: manifest.days.count,
    gemini: manifest.gemini,
    totals: manifest.totals,
    safeguards: manifest.safeguards,
    rawEvents: summary.classification.timeline.byTime.samples,
    trackedH: (t.meanPerDay.groundTruthTrackedMs * summary.daysEvaluated) / 3_600_000,
    seg: {
      gt: t.micro.groundTruthCount,
      blocks: t.micro.predictedCount,
      matched: t.micro.matchedCount,
      precision: t.micro.precision,
      recall: t.micro.recall,
      f1: t.micro.f1,
      f1Baseline: b.micro.f1,
      iouMatched: t.meanPerDay.meanIouMatched,
      overSeg: t.meanPerDay.overSegmentationRatio,
      underSeg: t.meanPerDay.underSegmentationRatio,
      boundaryF1: t.micro.boundaryF1,
      boundaryMaeMin: t.meanPerDay.boundaryMaeMs / 60000,
      durRelErr: t.meanPerDay.durationRelError,
      soft,
    },
    cls: { context: dim(cls.context), area: dim(cls.area), intent: dim(cls.intent), quality: dim(cls.quality), full: { accuracy: cls.full.accuracy, evaluatedH: cls.full.evaluated / 3_600_000 } },
    reflection: {
      ...reflection,
      days: summary.daysEvaluated,
      generated: summary.reflection.reportsGenerated,
      attemptsPerReport: reflection.dailyReports ? reflection.attempts / reflection.dailyReports : null,
      firstAttemptShare: reflection.dailyReports ? reflection.firstAttempt / reflection.dailyReports : null,
      structural: overall(summary.reflection.deterministic),
      answerKey: overall(summary.reflection.semantic),
      semantic: Object.fromEntries(Object.entries(summary.reflection.semantic).map(([k, v]) => [k, { score: v.score, label: v.label, method: v.method }])),
      pipeline: manifest.totals.reflection,
    },
    coach: {
      days: { strong: d.daysExpectedAction, optional: d.daysOptionalAction, silent: d.daysExpectedNull, withActions: d.daysWithActions },
      actions: d.actionsGenerated,
      recall: d.opportunityRecall,
      fullyCorrect: d.fullyCorrect,
      precision: d.opportunityPrecision,
      appropriateNull: d.appropriateNull,
      notRepeated: d.notRepeated,
      restated: d.restatedWhileOpen ?? null,
      grounding: d.evidenceGrounding,
      specificity: d.actionSpecificity,
      alignment: d.actionAlignment,
      concentration: d.targetConcentration,
      verdicts: d.verdicts,
      lifecycle: d.lifecycle,
      executionSeen: d.executionSeenByReflect,
      adaptation: d.adaptation,
      criteria: Object.fromEntries(Object.entries(summary.coach.criteria).map(([k, v]) => [k, { score: v.score, label: v.label }])),
    },
    diag: diag ? { byReason: diag.byReason, byLayer: diag.byLayer, unanswered: diag.unanswered } : null,
    profile,
    days,
    failures,
    samples,
  };
}

function readAll(dir) {
  const found = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return [...ORDER.filter((p) => found.includes(p)), ...found.filter((p) => !ORDER.includes(p)).sort()].map((p) => readPersona(dir, p)).filter(Boolean);
}

const data = readAll(root);
if (data.length === 0) {
  console.error(`No persona runs found under ${root}`);
  process.exit(1);
}
const baseline = baselineRoot ? readAll(baselineRoot) : [];

// ── Formatting ──────────────────────────────────────────────────────────────

const pct = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const ratio = (r) => (r.value === null ? '—' : `${pct(r.value)} (${num(r.numerator, Number.isInteger(r.numerator) ? 0 : 1)}/${r.denominator})`);
const sum = (f) => data.reduce((s, r) => s + f(r), 0);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every table once, as { title, note, head, rows } — rendered to Markdown and to HTML from the same cells. */
const tables = [];
const add = (id, title, note, head, rows, numeric = []) => tables.push({ id, title, note, head, rows, numeric });

add(
  'scoreboard',
  'Scoreboard',
  'One row per persona. The reflection and coach columns measure different things and are not to be averaged.',
  ['Persona', 'Activity F1', 'No-AI baseline F1', 'Daily reports', 'Reflection attempts / report', 'Reflection: structural', 'Coach: opportunity recall', 'Coach: opportunity precision', 'Coach: silence kept', 'Leaks'],
  data.map((r) => [r.name, pct(r.seg.f1, 1), pct(r.seg.f1Baseline, 1), `${r.reflection.generated} / ${r.reflection.days}`, num(r.reflection.attemptsPerReport, 2), pct(r.reflection.structural), ratio(r.coach.recall), ratio(r.coach.precision), ratio(r.coach.appropriateNull), r.safeguards.promptLeaks + r.safeguards.databaseLeaks]),
);

add(
  'volume',
  'What ran',
  'Each persona on a fresh database, onboarded with its day-1 profile, its profile changes replayed on their day, one production cycle per day.',
  ['Persona', 'Days', 'Raw events', 'Tracked h', 'Answer-key activities', 'Profile changes replayed', 'Gemini requests', 'Failed', 'Pipeline retries', 'Run time', 'Status'],
  [
    ...data.map((r) => [r.name, r.daysCount, num(r.rawEvents), num(r.trackedH, 1), r.seg.gt, `${r.profile.changes} on ${r.profile.days} day(s)`, num(r.gemini.totalCalls), r.gemini.failed, r.totals.retries, `${r.durationMin.toFixed(0)} min`, r.status + (r.statusReason ? `: ${r.statusReason}` : '')]),
    ['All', sum((r) => r.daysCount), num(sum((r) => r.rawEvents)), num(sum((r) => r.trackedH), 0), sum((r) => r.seg.gt), `${sum((r) => r.profile.changes)}`, num(sum((r) => r.gemini.totalCalls)), sum((r) => r.gemini.failed), sum((r) => r.totals.retries), '', ''],
  ],
);

add(
  'segmentation',
  'Activity reconstruction',
  'A block matches an activity on the overlap of the tracked events it owns (IoU ≥ 0.5); titles are never compared. Stretches the answer key itself marks as unattributable define no boundary ("uncertain" column).',
  ['Persona', 'Activities', 'Blocks', 'Matched', 'Precision', 'Recall', 'F1', 'Overlap of matched pairs', 'Blocks per activity', 'Boundary error', 'Uncertain activities set aside', 'Pieces joined across them'],
  data.map((r) => [r.name, r.seg.gt, r.seg.blocks, r.seg.matched, pct(r.seg.precision), pct(r.seg.recall), pct(r.seg.f1, 1), num(r.seg.iouMatched, 2), num(r.seg.overSeg, 2), `${num(r.seg.boundaryMaeMin, 1)} min`, r.seg.soft.uncertainActivities, r.seg.soft.merged]),
);

const clsCell = (c) => (c.accuracy === null || c.scorable === null || c.scorable === 0 ? 'not scorable' : `${pct(c.accuracy)} · ${pct(c.scorable)} of time`);
add(
  'classification',
  'Classification',
  'Accuracy by tracked time, with the share of the persona\'s tracked time the answer key could be judged on. An accuracy is a statement about that share only. "Priority link" compares the work stream of an activity with the stated priority Reflect linked it to.',
  ['Persona', 'Area (Work / Leisure / Personal)', 'Priority link', 'Intent', 'Quality', 'All dimensions right'],
  data.map((r) => [r.name, clsCell(r.cls.context), clsCell(r.cls.area), clsCell(r.cls.intent), clsCell(r.cls.quality), pct(r.cls.full.accuracy)]),
);

add(
  'reflection',
  'Reflection',
  'Structural checks are exact. "Matches answer key" compares wording by concept overlap without a second model and is a low-confidence screen. Removed claims are insights that failed validation and were taken out; repairs are presentation fixes that change no claim.',
  ['Persona', 'Daily reports', 'Written on the first attempt', 'Attempts / report', 'Measured-summary-only reports', 'Claims removed', 'Presentation repairs', 'Structural checks', 'Matches answer key (lexical)'],
  data.map((r) => [r.name, `${r.reflection.generated} / ${r.reflection.days}`, pct(r.reflection.firstAttemptShare), num(r.reflection.attemptsPerReport, 2), r.reflection.fallback, r.reflection.removed, r.reflection.repaired, pct(r.reflection.structural), pct(r.reflection.answerKey)]),
);

add(
  'coach',
  'Coach — was the recommendation right?',
  'Recall: of the days that called for a move, how many were answered (a partly correct answer counts half). Precision: of the days the Coach spoke, how many times it answered something the day held. Silence kept: of the days that called for nothing, how many were left alone.',
  ['Persona', 'Days: move / optional / silence', 'Days with an action', 'Opportunity recall', 'Fully correct', 'Opportunity precision', 'Silence kept', 'Not a repeat', 'Restated while open', 'Grounded', 'Aimed at one target'],
  data.map((r) => [r.name, `${r.coach.days.strong} / ${r.coach.days.optional} / ${r.coach.days.silent}`, r.coach.days.withActions, ratio(r.coach.recall), ratio(r.coach.fullyCorrect), ratio(r.coach.precision), ratio(r.coach.appropriateNull), ratio(r.coach.notRepeated), r.coach.restated ?? '—', pct(r.coach.grounding.value), pct(r.coach.concentration.value)]),
);

const VERDICTS = ['correct', 'partially_correct', 'wrong', 'unnecessary', 'missed', 'correct_null', 'acceptable_null', 'no_report'];
add(
  'verdicts',
  'Coach verdict for each day',
  '"Unnecessary" is an action on a day that called for none; "correct null" is silence on such a day.',
  ['Persona', 'Correct', 'Partly correct', 'Wrong', 'Unnecessary', 'Missed', 'Correct silence', 'Acceptable silence', 'No report'],
  data.map((r) => [r.name, ...VERDICTS.map((v) => r.coach.verdicts[v] ?? 0)]),
);

add(
  'lifecycle',
  'Coach — did the user follow it, did it help, did the Coach adapt?',
  'The simulated user answers each recommendation as the next day\'s ground truth shows for the work it was aimed at. Deciding, doing and helping are three separate facts.',
  ['Persona', 'Suggested', 'Accepted', 'Rejected', 'Not now', 'Undecided', 'Done', 'Partly done', 'Not done', 'Worked', 'Partly worked', 'Did not work', 'Execution Reflect could see', 'Adaptation checks passed'],
  data.map((r) => {
    const l = r.coach.lifecycle;
    return [r.name, l.suggested, l.accepted, l.rejected, l.deferred, l.undecided, l.done, l.partial, l.notDone, l.worked, l.partlyWorked, l.didNotWork, ratio(r.coach.executionSeen), `${r.coach.adaptation.passed} / ${r.coach.adaptation.checks}`];
  }),
);

const reasons = [...new Set(data.flatMap((r) => Object.keys(r.diag?.byReason ?? {})))].map((k) => [k, sum((r) => r.diag?.byReason[k] ?? 0)]).sort((a, b) => b[1] - a[1]);
if (reasons.length > 0) {
  add(
    'reasons',
    'Why Coach days were not answered correctly',
    'One cause per day that was not fully correct (see coach_diagnostics.md in each run for the definitions).',
    ['Cause', ...data.map((r) => r.name), 'Total'],
    [...reasons.map(([k, total]) => [k.replace(/_/g, ' '), ...data.map((r) => r.diag?.byReason[k] ?? '·'), total]), ['Days not answered correctly', ...data.map((r) => r.diag?.unanswered ?? '—'), sum((r) => r.diag?.unanswered ?? 0)]],
  );
}

if (baseline.length > 0) {
  const rows = [];
  for (const r of data) {
    const b = baseline.find((x) => x.persona === r.persona);
    if (!b) continue;
    const line = (label, before, after) => rows.push([r.name, label, before, after]);
    line('Activity F1', pct(b.seg.f1, 1), pct(r.seg.f1, 1));
    line('Daily reports', `${b.reflection.generated} / ${b.reflection.days}`, `${r.reflection.generated} / ${r.reflection.days}`);
    line('Reflection attempts / report', num(b.reflection.attemptsPerReport, 2), num(r.reflection.attemptsPerReport, 2));
    line('Pipeline retries', b.totals.retries, r.totals.retries);
    line('Gemini requests', num(b.gemini.totalCalls), num(r.gemini.totalCalls));
    line('Coach opportunity recall', ratio(b.coach.recall), ratio(r.coach.recall));
    line('Coach opportunity precision', ratio(b.coach.precision), ratio(r.coach.precision));
    line('Coach: not a repeat', ratio(b.coach.notRepeated), ratio(r.coach.notRepeated));
    line('Coach: silence kept', ratio(b.coach.appropriateNull), ratio(r.coach.appropriateNull));
    line('Classification scorable (area / intent / quality)', [b.cls.context, b.cls.intent, b.cls.quality].map((c) => pct(c.scorable)).join(' / '), [r.cls.context, r.cls.intent, r.cls.quality].map((c) => pct(c.scorable)).join(' / '));
    line('Classification accuracy (area / intent / quality)', [b.cls.context, b.cls.intent, b.cls.quality].map((c) => pct(c.accuracy)).join(' / '), [r.cls.context, r.cls.intent, r.cls.quality].map((c) => pct(c.accuracy)).join(' / '));
    line('Answer-key leaks', b.safeguards.promptLeaks + b.safeguards.databaseLeaks, r.safeguards.promptLeaks + r.safeguards.databaseLeaks);
    line('Failed Gemini requests', b.gemini.failed, r.gemini.failed);
  }
  add('before_after', 'Before and after', `Before: ${path.relative(process.cwd(), baselineRoot)} (evaluator ${baseline[0].evaluator}). After: ${path.relative(process.cwd(), root)} (evaluator ${data[0].evaluator}).`, ['Persona', 'Measure', 'Before', 'After'], rows);
}

const failureRows = data.flatMap((r) => r.failures.map((f) => [r.name, f.day, f.subsystem + (f.verdict ? ` (${f.verdict})` : ''), f.expected, f.actual, f.why]));
add('failures', 'Remaining failures', 'Every day without a report, every Coach day scored wrong, unnecessary or missed, and every day with activity F1 under 50%.', ['Persona', 'Day', 'Subsystem', 'Expected', 'Actual', 'Why'], failureRows);

// ── Output ──────────────────────────────────────────────────────────────────

fs.writeFileSync(path.join(root, 'combined.json'), JSON.stringify({ generatedAt: new Date().toISOString(), root, baseline: baselineRoot, personas: data.map(({ samples: _samples, ...r }) => r) }, null, 2));

const mdCell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const md = [
  `# Reflect benchmark — ${data.length} persona(s) × ${data[0].daysCount} day(s)`,
  '',
  `Model ${data[0].model} · commit ${data[0].commit.slice(0, 7)}${data[0].dirty ? ' (with uncommitted changes)' : ''} · evaluator ${data[0].evaluator} · action policy ${data[0].actionPolicy} · prompts ${Object.values(data[0].prompts).join(' · ')}`,
  '',
  ...tables.flatMap((t) => [`## ${t.title}`, '', t.note, '', `| ${t.head.join(' | ')} |`, `| ${t.head.map(() => '---').join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`), '']),
].join('\n');
fs.writeFileSync(path.join(root, 'combined.md'), md);

// HTML: one reading column, a statement then a table per section; the per-day strip and sample output as detail.
const heat = `<div class="scroll"><div class="heat" role="img" aria-label="Activity F1 for every persona on every day">${data
  .map((r) => `<div class="hrow"><div class="hname">${esc(r.name)}</div><div class="hcells" style="grid-template-columns:repeat(${r.days.length},1fr)">${r.days.map((d) => `<span class="hc" tabindex="0" style="--o:${(0.06 + 0.94 * d.f1).toFixed(2)}" data-tip="${esc(r.name)} · day ${d.n} · F1 ${pct(d.f1)} · ${d.blocks} blocks vs ${d.gt} activities"></span>`).join('')}</div></div>`)
  .join('')}</div></div><div class="legend"><span class="mute">Activity F1 per day</span><span class="ramp">${[0, 0.25, 0.5, 0.75, 1].map((v) => `<span class="hc" style="--o:${(0.06 + 0.94 * v).toFixed(2)}"></span>`).join('')}</span><span class="mute">0% → 100%</span></div>`;

const V = [['correct', 'Correct', 'v1'], ['partially_correct', 'Partly correct', 'v2'], ['wrong', 'Wrong', 'v3'], ['unnecessary', 'Unnecessary', 'v7'], ['missed', 'Missed', 'v4'], ['correct_null', 'Correct silence', 'v8'], ['acceptable_null', 'Acceptable silence', 'v5'], ['no_report', 'No report', 'v6']];
const verdictChart = `<div class="pairs" role="img" aria-label="Coach verdict for each day, per persona">${data
  .map((r) => `<div class="pair"><div class="plabel">${esc(r.name)}</div><div class="stack">${V.filter(([k]) => (r.coach.verdicts[k] ?? 0) > 0).map(([k, label, cls]) => `<span class="seg ${cls}" tabindex="0" style="flex:${r.coach.verdicts[k]}" data-tip="${esc(r.name)} · ${label}: ${r.coach.verdicts[k]} day(s)">${r.coach.verdicts[k]}</span>`).join('')}</div></div>`)
  .join('')}</div><div class="legend">${V.map(([, label, cls]) => `<span class="lg"><span class="sw ${cls}"></span>${label}</span>`).join('')}</div>`;

const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const sample = (r) => {
  const s = r.samples.find((x) => x.verdict === 'correct' && x.headline && x.actions.length) ?? r.samples.find((x) => x.headline && x.actions.length) ?? r.samples.find((x) => x.headline);
  if (!s) return '';
  const a = s.actions[0];
  return `<details class="sample"><summary><span class="sname">${esc(r.name)}</span><span class="sub">day ${s.n} · ${s.date}</span></summary><div class="sbody"><div><h4>Timeline Reflect built (${s.timeline.length} blocks)</h4><ol class="tl">${s.timeline.map((t) => `<li><span class="tm">${time(t.start)}–${time(t.end)}</span>${esc(t.title)}</li>`).join('')}</ol></div><div><h4>Daily reflection</h4><p><b>${esc(s.headline)}</b></p>${s.narrative ? `<p>${esc(s.narrative)}</p>` : ''}${s.insights.length ? `<ul>${s.insights.map((i) => `<li><b>${esc(i.title)}.</b> ${esc(i.observation)}</li>`).join('')}</ul>` : ''}<h4>Coach</h4>${a ? `<p><b>${esc(a.title)}</b><br>${esc(a.description)}</p>` : `<p class="mute">No action${s.noActionReason ? `: ${esc(s.noActionReason)}` : ''}</p>`}<p class="sub">Answer key: ${esc(String(s.expected ?? 'silence').split(' — ')[0])} · scored <b>${esc(s.verdict)}</b></p></div></div></details>`;
};

const htmlTable = (t) => {
  const wrap = t.id === 'failures' || t.id === 'before_after' ? ' class="wrap"' : '';
  return `<div class="scroll"><table${wrap}><thead><tr>${t.head.map((h, i) => `<th${i > 0 && t.id !== 'failures' ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((row) => `<tr${row[0] === 'All' || String(row[0]).startsWith('Days not answered') ? ' class="total"' : ''}>${row.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td${t.id !== 'failures' && !(t.id === 'before_after' && i === 1) ? ' class="n"' : ''}>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
};
const section = (t, extra = '') => `<section id="${t.id}"><h2>${esc(t.title)}</h2><p>${esc(t.note)}</p>${extra}${t.rows.length > 0 ? htmlTable(t) : '<p class="mute">None.</p>'}</section>`;
const byId = (id) => tables.find((t) => t.id === id);
const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';

const html = `<title>Reflect Benchmark v2</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column of sections; each is a statement, then a table or a strip chart. */
:root {
  --bg: #f7f8fa; --surface: #ffffff; --ink: #14171c; --ink2: #4a515c; --mute: #7d8592; --line: #e2e5ea; --wash: #eef1f5;
  --accent: #2a78d6; --v1: #0ca30c; --v2: #eda100; --v3: #d03b3b; --v4: #7d8592; --v5: #b9c0cb; --v6: #dfe3e9; --v7: #ec835a; --v8: #1baf7a; --segink: #ffffff;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; --mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1114; --surface: #181b20; --ink: #f2f4f7; --ink2: #c0c6cf; --mute: #8a919d; --line: #2a2e35; --wash: #20242a;
  --accent: #3987e5; --v1: #0ca30c; --v2: #c98500; --v3: #e66767; --v4: #6b727e; --v5: #474d57; --v6: #30353c; --v7: #d95926; --v8: #199e70; --segink: #ffffff; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0f1114; --surface: #181b20; --ink: #f2f4f7; --ink2: #c0c6cf; --mute: #8a919d; --line: #2a2e35; --wash: #20242a;
  --accent: #3987e5; --v1: #0ca30c; --v2: #c98500; --v3: #e66767; --v4: #6b727e; --v5: #474d57; --v6: #30353c; --v7: #d95926; --v8: #199e70; --segink: #ffffff; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
.page { max-width: 1120px; margin: 0 auto; padding-inline: 20px; padding-block: 40px 72px; display: flex; flex-direction: column; gap: 40px; }
header h1 { font-size: 30px; line-height: 1.15; font-weight: 600; margin: 0 0 10px; letter-spacing: -0.01em; text-wrap: balance; }
.meta { font: 12.5px/1.6 var(--mono); color: var(--mute); display: flex; flex-wrap: wrap; gap: 4px 18px; }
section, .notes { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
h2 { font-size: 20px; font-weight: 600; margin: 0; padding-top: 20px; border-top: 1px solid var(--line); text-wrap: balance; }
h3 { font-size: 15px; font-weight: 600; margin: 8px 0 0; }
h4 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--mute); margin: 14px 0 6px; }
p, ul, ol { margin: 0; max-width: 76ch; color: var(--ink2); }
p b, li b { color: var(--ink); font-weight: 600; }
ul, ol { padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.lead { font-size: 17px; color: var(--ink); }
.verdict { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.verdict .big { font-size: 22px; font-weight: 600; color: var(--ink); }
.scroll { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-size: 12px; font-weight: 500; color: var(--mute); background: var(--wash); vertical-align: bottom; line-height: 1.3; }
tbody th { font-weight: 500; white-space: nowrap; color: var(--ink); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.wrap td { min-width: 130px; color: var(--ink2); } table.wrap td:last-child { min-width: 260px; }
tr.total th, tr.total td { background: var(--wash); font-weight: 600; }
.mute { color: var(--mute); } .sub { font-size: 12px; color: var(--mute); }
.figure { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pairs { display: flex; flex-direction: column; gap: 10px; }
.pair { display: grid; grid-template-columns: 150px 1fr; gap: 12px; align-items: center; }
.plabel, .hname { font-size: 13px; }
.stack { display: flex; gap: 2px; height: 26px; min-width: 0; }
.seg { display: flex; align-items: center; justify-content: center; font: 500 12px var(--mono); color: var(--segink); border-radius: 3px; min-width: 14px; outline-offset: 2px; }
.v1 { background: var(--v1); } .v2 { background: var(--v2); } .v3 { background: var(--v3); } .v4 { background: var(--v4); } .v5 { background: var(--v5); color: var(--ink); } .v6 { background: var(--v6); color: var(--ink); } .v7 { background: var(--v7); } .v8 { background: var(--v8); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--ink2); align-items: center; }
.lg { display: inline-flex; align-items: center; gap: 6px; } .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.heat { display: flex; flex-direction: column; gap: 2px; min-width: 620px; padding: 14px 16px; }
.hrow { display: grid; grid-template-columns: 150px 1fr; gap: 12px; align-items: center; }
.hcells { display: grid; gap: 2px; }
.hc { height: 20px; border-radius: 2px; background: var(--accent); opacity: var(--o); display: block; outline-offset: 1px; }
.ramp { display: inline-grid; grid-template-columns: repeat(5, 18px); gap: 2px; } .ramp .hc { height: 12px; }
.sample { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.sample summary { cursor: pointer; padding: 12px 16px; display: flex; gap: 12px; align-items: baseline; }
.sample summary:focus-visible, .seg:focus-visible, .hc:focus-visible { outline: 2px solid var(--accent); }
.sname { font-weight: 600; }
.sbody { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 8px 28px; padding: 0 16px 16px; border-top: 1px solid var(--line); font-size: 13.5px; }
.tl { list-style: none; padding: 0; gap: 4px; font-size: 13px; } .tm { font: 12px var(--mono); color: var(--mute); margin-right: 8px; }
.samples { display: flex; flex-direction: column; gap: 8px; }
code { font: 12.5px var(--mono); background: var(--wash); padding: 1px 5px; border-radius: 3px; overflow-wrap: anywhere; }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); font-size: 12px; padding: 6px 9px; border-radius: 4px; max-width: 300px; z-index: 5; }
@media (max-width: 640px) { .pair, .hrow { grid-template-columns: 1fr; gap: 4px; } .sbody { grid-template-columns: 1fr; } header h1 { font-size: 24px; } .heat { min-width: 560px; } }
</style>
<div class="page">
<header>
  <h1>Reflect Benchmark v2</h1>
  <div class="meta"><span>${data.length} persona(s) × ${data[0].daysCount} day(s)</span><span>model ${esc(data[0].model)}</span><span>commit ${esc(data[0].commit.slice(0, 7))}${data[0].dirty ? ' + uncommitted changes' : ''}</span><span>evaluator ${esc(data[0].evaluator)}</span><span>prompts ${esc(Object.values(data[0].prompts).join(' · '))}</span></div>
</header>
${notes ? `<div class="notes">${notes}</div>` : ''}
${section(byId('scoreboard'))}
${section(byId('volume'))}
${section(byId('segmentation'), heat)}
${section(byId('classification'))}
${section(byId('reflection'))}
${section(byId('coach'), `<div class="figure">${verdictChart}</div>`)}
${section(byId('verdicts'))}
${section(byId('lifecycle'))}
${byId('reasons') ? section(byId('reasons')) : ''}
${byId('before_after') ? section(byId('before_after')) : ''}
<section id="samples"><h2>What Reflect produced</h2><p>One day per persona: the timeline it built, the reflection it wrote and what the Coach said.</p><div class="samples">${data.map(sample).join('')}</div></section>
${section(byId('failures'))}
</div>
<div id="tip" hidden></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  function show(el, x, y) {
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + 'px';
  }
  document.addEventListener('mousemove', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) { tip.hidden = true; return; }
    var r = el.getBoundingClientRect();
    show(el, r.left, r.top);
  });
  document.addEventListener('focusout', function () { tip.hidden = true; });
})();
</script>
`;
fs.writeFileSync(path.join(root, 'combined.html'), html);

console.log(`[combined] ${data.length} persona(s) from ${path.relative(process.cwd(), root)}`);
for (const r of data) {
  console.log(
    `  ${r.name.padEnd(22)} F1 ${pct(r.seg.f1, 1).padStart(6)} · reports ${r.reflection.generated}/${r.reflection.days} · ${num(r.reflection.attemptsPerReport, 2)} attempts/report · coach recall ${pct(r.coach.recall.value)} precision ${pct(r.coach.precision.value)} silence ${ratio(r.coach.appropriateNull)} · leaks ${r.safeguards.promptLeaks + r.safeguards.databaseLeaks} · ${r.status}`,
  );
}
console.log(`[combined] written: combined.json, combined.md, combined.html (${failureRows.length} remaining failure(s) listed)`);
