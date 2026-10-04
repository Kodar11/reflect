import { DEFAULT_REFLECTION_CONFIG, REFLECTION_INSIGHT_TYPES } from '../../../src/reflection/ReflectionModels';
import type { CapturedDay } from '../runner/capture';
import type { SemanticConfig } from '../runner/config';
import type { EvaluationOnlyDay } from '../runner/dataset';
import { coachText, reflectionText, streamOfAction, uncertaintyText } from './corpus';
import {
  HEDGE,
  bestSentence,
  conceptsOf,
  coverage,
  splitSentences,
  streamOfText,
  verdictFromCoverage,
  type Criterion,
} from './text';

/**
 * Reflection evaluation, in two layers.
 *
 *   A. deterministic  Was a report written, is it well-formed, does every id
 *      and metric it cites exist, do its numbers hold together, and does it
 *      contain nothing it could not have known? Computed from stored
 *      structure; no judgment involved.
 *
 *   B. semantic       Does it say what the answer key says mattered? Never by
 *      exact wording. Priority alignment is compared through Reflect's own
 *      measured time per priority; the free-text criteria use concept
 *      coverage and are marked low-confidence.
 */

export interface ReflectionEvaluationContext {
  semantic: SemanticConfig;
  /** Ids of every timeline block Reflect has shown up to and including this day. */
  knownBlockIds: Set<string>;
  findLeaks: (text: string) => string[];
}

export interface ReflectionEvaluation {
  generated: boolean;
  deterministic: Criterion[];
  semantic: Criterion[];
}

const MINUTES_PER_DAY = 24 * 60;

/** Minutes of every duration written in `text` ("2h 13m", "90 minutes", "3 hours"). */
function durationsIn(text: string): { raw: string; minutes: number }[] {
  const out: { raw: string; minutes: number }[] = [];
  const hm = /\b(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b(?:\s*(\d+)\s*(?:m|mins?|minutes?)\b)?/gi;
  const consumed: [number, number][] = [];
  for (const match of text.matchAll(hm)) {
    out.push({ raw: match[0], minutes: Number(match[1]) * 60 + Number(match[2] ?? 0) });
    consumed.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?)\b/gi)) {
    if (consumed.some(([s, e]) => match.index >= s && match.index < e)) continue;
    out.push({ raw: match[0], minutes: Number(match[1]) });
  }
  return out;
}

/**
 * How much progress an assessment in the answer key states, on a 0–4 scale.
 * `null` when the wording is not recognised.
 */
export function progressLevel(assessment: string): number | null {
  const text = assessment.toLowerCase();
  if (/\bno (substantial|meaningful|visible)\b|\blittle visible\b|\bnone\b/.test(text)) return 0;
  if (/\bmaintenance\b|\blimited\b|\bsmall\b|\bcontained\b|\bbrief\b/.test(text) && !/\bstrong\b/.test(text)) return 1;
  if (/\bsome\b|\bmoderate\b/.test(text) && !/\bstrong\b/.test(text)) return 2;
  if (/\bstrong(er)?\b|\bcompleted\b/.test(text)) return 4;
  if (/\bmeaningful(ly)?\b/.test(text)) return 3;
  return null;
}

function deterministicChecks(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: ReflectionEvaluationContext): Criterion[] {
  const report = captured.reflection.report;
  const out: Criterion[] = [];
  const structural = (id: string, label: string, problems: string[], okDetail: string): Criterion => ({
    id,
    label,
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    method: 'structural',
    confidence: 'high',
    detail: problems.length === 0 ? okDetail : `${problems.length} problem(s)`,
    ...(problems.length > 0 ? { evidence: problems.slice(0, 12) } : {}),
  });

  const rawMinutes = answer.events.reduce((sum, e) => sum + (e.endMs - e.startMs), 0) / 60_000;

  // ── Generated ──
  const attempt = captured.reflection.latestAttempt;
  out.push({
    id: 'report_generated',
    label: 'A report was generated for the day',
    verdict: report ? 'PASS' : 'FAIL',
    method: 'structural',
    confidence: 'high',
    detail: report
      ? `status ${report.status}, ${report.attemptCount} attempt(s), ${report.insights.length} insight(s)`
      : attempt
        ? `no report; last attempt ${attempt.status}${attempt.errorCategory ? ` (${attempt.errorCategory})` : ''}${attempt.error ? `: ${attempt.error.slice(0, 200)}` : ''}`
        : 'no report and no attempt recorded',
  });

  out.push({
    id: 'not_empty_when_data_exists',
    label: 'No empty output where meaningful data exists',
    verdict:
      rawMinutes < DEFAULT_REFLECTION_CONFIG.sufficiency.day.minTrackedMinutes
        ? 'NOT_APPLICABLE'
        : report && (report.headline?.trim() || report.narrative?.trim() || report.insights.length > 0)
          ? 'PASS'
          : 'FAIL',
    method: 'structural',
    confidence: 'high',
    detail: `${Math.round(rawMinutes)} tracked minutes in the raw events; ${report ? `headline ${report.headline ? 'present' : 'empty'}, ${report.insights.length} insight(s)` : 'no report'}`,
  });

  if (!report) return out;

  const metricKeys = new Set(Object.keys(report.metricsSnapshot ?? {}));
  const dayEventIds = new Set(captured.events.map((e) => e.eventId));
  const text = `${reflectionText(report)}\n${coachText(captured)}`;

  // ── Structure ──
  {
    const problems: string[] = [];
    if (!report.headline?.trim()) problems.push('headline is empty');
    if (report.period.key !== answer.date) problems.push(`report period ${report.period.key} is not the day ${answer.date}`);
    if (report.insights.length > DEFAULT_REFLECTION_CONFIG.maxInsights.day) problems.push(`${report.insights.length} insights, more than the maximum ${DEFAULT_REFLECTION_CONFIG.maxInsights.day}`);
    report.insights.forEach((insight, i) => {
      if (!insight.title?.trim() || !insight.observation?.trim() || !insight.interpretation?.trim()) problems.push(`insight ${i + 1}: title, observation or interpretation is empty`);
      if (!REFLECTION_INSIGHT_TYPES.includes(insight.type)) problems.push(`insight ${i + 1}: unknown type "${insight.type}"`);
      if (!(insight.confidence >= 0 && insight.confidence <= 1)) problems.push(`insight ${i + 1}: confidence ${insight.confidence} is outside 0..1`);
      if (insight.evidence.length === 0) problems.push(`insight ${i + 1}: no evidence`);
    });
    if (report.coach) {
      const ids = new Set(captured.coach.actions.map((a) => a.id));
      for (const id of report.coach.actionIds) if (!ids.has(id)) problems.push(`coach block lists action ${id}, which was not stored`);
    }
    out.push(structural('valid_structure', 'The report is well-formed', problems, `${report.insights.length} insight(s), narrative ${report.narrative ? 'present' : 'absent'}, coach block ${report.coach ? 'present' : 'absent'}`));
  }

  // ── Evidence: activities ──
  {
    const problems: string[] = [];
    const cited: string[] = [];
    report.insights.forEach((insight, i) => {
      for (const id of [...insight.sourceActivityIds, ...insight.evidence.map((e) => e.activityId).filter((x): x is string => !!x)]) {
        cited.push(id);
        if (!ctx.knownBlockIds.has(id)) problems.push(`insight ${i + 1} cites activity ${id}, which is not on the timeline`);
      }
    });
    out.push(structural('evidence_activities_exist', 'Every cited activity exists on the timeline', problems, `${cited.length} activity reference(s), all resolved`));
  }

  // ── Evidence: metrics ──
  {
    const problems: string[] = [];
    let cited = 0;
    report.insights.forEach((insight, i) => {
      for (const key of [...insight.sourceMetricKeys, ...insight.evidence.map((e) => e.metricKey).filter((x): x is string => !!x)]) {
        cited++;
        if (!metricKeys.has(key)) problems.push(`insight ${i + 1} cites metric "${key}", which is not in the report's metric snapshot`);
      }
    });
    out.push(structural('metric_keys_exist', 'Every cited metric key exists', problems, `${cited} metric reference(s), all resolved`));
  }

  // ── Event references ──
  {
    const problems: string[] = [];
    const owners = new Map<number, string>();
    for (const block of captured.timeline) {
      if (block.eventIds.length === 0) problems.push(`timeline block ${block.id} owns no events`);
      for (const id of block.eventIds) {
        if (!dayEventIds.has(id)) problems.push(`timeline block ${block.id} owns event ${id}, which is not one of the day's raw events`);
        const other = owners.get(id);
        if (other) problems.push(`event ${id} is owned by both ${other} and ${block.id}`);
        owners.set(id, block.id);
      }
    }
    for (const id of dayEventIds) if (!owners.has(id)) problems.push(`raw event ${id} is on no timeline block`);
    out.push(structural('no_unsupported_event_references', 'Timeline blocks reference only real raw events, each exactly once', problems, `${owners.size} event(s) across ${captured.timeline.length} block(s)`));
  }

  // ── Hallucinated activities ──
  {
    const problems: string[] = [];
    const timelineIds = new Set(captured.timeline.map((b) => b.id));
    const startMs = Date.parse(report.period.start);
    const endMs = Date.parse(report.coveredUntil ?? report.period.end);
    for (const activity of report.dataSnapshot?.activities ?? []) {
      if (!timelineIds.has(activity.id)) problems.push(`the report was written from activity ${activity.id} ("${activity.title}"), which is not on the day's timeline`);
      if (Date.parse(activity.startedAt) < startMs || Date.parse(activity.endedAt) > endMs + 1000) problems.push(`activity ${activity.id} lies outside the period the report covers`);
    }
    out.push(structural('no_hallucinated_activities', 'Every activity the report was written from exists', problems, `${report.dataSnapshot?.activities.length ?? 0} activity(ies) in the report's snapshot`));
  }

  // ── Internal consistency ──
  {
    const problems: string[] = [];
    const tracked = report.metricsSnapshot?.['time.tracked_minutes']?.value;
    const coveredMs = Date.parse(report.coveredUntil ?? report.period.end);
    const rawCovered = answer.events.reduce((sum, e) => sum + Math.max(0, Math.min(e.endMs, coveredMs) - e.startMs), 0) / 60_000;
    if (typeof tracked !== 'number') problems.push('the metric snapshot has no numeric time.tracked_minutes');
    else if (Math.abs(tracked - rawCovered) > 1) problems.push(`time.tracked_minutes is ${tracked.toFixed(1)} but the raw events it covers total ${rawCovered.toFixed(1)} minutes`);
    if (report.coveredUntil && (coveredMs <= Date.parse(report.period.start) || coveredMs > Date.parse(report.period.end))) problems.push(`coveredUntil ${report.coveredUntil} lies outside the period`);
    const focused = report.metricsSnapshot?.['time.focused_minutes']?.value;
    if (typeof focused === 'number' && typeof tracked === 'number' && focused > tracked + 1) problems.push(`focused time ${focused.toFixed(1)}m exceeds tracked time ${tracked.toFixed(1)}m`);
    for (const p of captured.priorities) {
      const linked = report.metricsSnapshot?.[`priority.${p.id}.minutes`]?.value;
      if (typeof linked === 'number' && typeof tracked === 'number' && linked > tracked + 1) problems.push(`time linked to "${p.text}" (${linked.toFixed(1)}m) exceeds tracked time`);
    }
    out.push(structural('internally_consistent', "The report's measurements agree with the raw events and with each other", problems, `tracked ${typeof tracked === 'number' ? tracked.toFixed(0) : '?'}m matches the raw events`));
  }

  // ── Impossible values ──
  {
    const problems: string[] = [];
    for (const d of durationsIn(text)) if (d.minutes > MINUTES_PER_DAY) problems.push(`duration "${d.raw}" is longer than a day`);
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) if (Number(match[1]) > 100) problems.push(`percentage "${match[0]}" is above 100`);
    for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/gi)) {
      const hour = Number(match[1]);
      if (Number(match[2]) > 59 || hour > (match[3] ? 12 : 23)) problems.push(`clock time "${match[0]}" is not a valid time`);
    }
    out.push(structural('no_impossible_values', 'No impossible dates or numbers in the text', problems, 'every duration, percentage and clock time is possible'));
  }

  // ── Hidden ground truth ──
  {
    const fragments = ctx.findLeaks(text);
    const meta = splitSentences(text).filter((s) => /\b(ground[- ]truth|answer key|benchmark|expected_reflection|evaluation objective)\b/i.test(s));
    out.push(structural('no_ground_truth_reference', 'No reference to hidden ground truth', [...fragments.map((f) => `answer-key wording: "${f}"`), ...meta], 'no answer-key wording in the report'));
  }

  return out;
}

function semanticChecks(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: ReflectionEvaluationContext): Criterion[] {
  const report = captured.reflection.report;
  const expected = answer.expectedReflection;
  const out: Criterion[] = [];
  const reflection = reflectionText(report);
  const coach = coachText(captured);
  const everything = `${reflection}\n${coach}`;
  const said = conceptsOf(everything);

  // ── Key observations ──
  expected.key_observations.forEach((observation, i) => {
    const c = coverage(observation, said);
    const best = bestSentence(observation, everything);
    out.push({
      id: `key_observation_${i + 1}`,
      label: 'Key observation is reflected',
      verdict: report ? verdictFromCoverage(c.score, ctx.semantic) : 'FAIL',
      method: 'lexical',
      confidence: 'low',
      expected: observation,
      score: c.score,
      detail: report ? `concept coverage ${(c.score * 100).toFixed(0)}%${c.missing.length ? `; not found: ${c.missing.slice(0, 8).join(', ')}` : ''}` : 'no report',
      ...(best ? { evidence: [best.sentence] } : {}),
    });
  });

  // ── Priority alignment: the answer key's stated progress vs the time Reflect linked to each priority ──
  {
    const rows = expected.priority_alignment.map((p) => {
      const priority = captured.priorities.find((x) => x.text === p.priority) ?? null;
      const metric = priority ? report?.metricsSnapshot?.[`priority.${priority.id}.minutes`]?.value : undefined;
      return { priority: p.priority, assessment: p.assessment, level: progressLevel(p.assessment), minutes: typeof metric === 'number' ? metric : 0, known: priority !== null };
    });
    const judged = rows.filter((r) => r.level !== null);
    const checks: number[] = [];
    const notes: string[] = [];
    for (const row of judged) {
      if (row.level === 1) continue; // "maintenance only" says nothing about how much time to expect.
      const ok = row.level === 0 ? row.minutes < 15 : row.minutes >= 5;
      checks.push(ok ? 1 : 0);
      if (!ok) notes.push(`"${row.priority}": answer key says "${row.assessment}", Reflect linked ${Math.round(row.minutes)}m`);
    }
    for (let a = 0; a < judged.length; a++) {
      for (let b = a + 1; b < judged.length; b++) {
        const [hi, lo] = judged[a].level! >= judged[b].level! ? [judged[a], judged[b]] : [judged[b], judged[a]];
        // Adjacent levels are too close to demand an order of minutes.
        if (hi.level! - lo.level! < 2) continue;
        const concordance = hi.minutes > lo.minutes ? 1 : hi.minutes === lo.minutes ? 0.5 : 0;
        checks.push(concordance);
        if (concordance < 1) notes.push(`"${hi.priority}" (${Math.round(hi.minutes)}m) was expected well ahead of "${lo.priority}" (${Math.round(lo.minutes)}m)`);
      }
    }
    const score = checks.length > 0 ? checks.reduce((s, v) => s + v, 0) / checks.length : null;
    out.push({
      id: 'priority_alignment',
      label: 'Priority alignment matches the answer key',
      verdict: !report ? 'FAIL' : score === null ? 'NOT_APPLICABLE' : score >= 0.8 ? 'PASS' : score >= 0.5 ? 'PARTIAL' : 'FAIL',
      method: 'structural',
      confidence: judged.length === rows.length && rows.every((r) => r.known) ? 'high' : 'low',
      expected: rows.map((r) => `${r.priority}: ${r.assessment}`).join(' | '),
      ...(score !== null ? { score } : {}),
      detail:
        `time Reflect linked — ${rows.map((r) => `${r.priority}: ${Math.round(r.minutes)}m`).join(', ')}` +
        (rows.length !== judged.length ? `; ${rows.length - judged.length} assessment(s) not recognised` : '') +
        (notes.length ? `; ${notes.join('; ')}` : ''),
    });
  }

  // ── Uncertainty: acknowledged, silent, or contradicted ──
  {
    const unsure = uncertaintyText(captured);
    const hedged = splitSentences(everything).filter((s) => HEDGE.test(s)).join('\n');
    const stated = conceptsOf(`${unsure}\n${hedged}`);
    expected.important_uncertainty.forEach((uncertainty, i) => {
      const c = coverage(uncertainty, stated);
      // A confident sentence about the very thing the answer key calls unknowable.
      const overclaims = splitSentences(everything).filter((s) => !HEDGE.test(s) && coverage(uncertainty, s).score >= ctx.semantic.passCoverage);
      const verdict = !report ? 'FAIL' : c.score >= ctx.semantic.passCoverage ? 'PASS' : overclaims.length > 0 ? 'FAIL' : 'PARTIAL';
      out.push({
        id: `uncertainty_${i + 1}`,
        label: 'Uncertainty is acknowledged (PARTIAL = not acknowledged, but nothing contradicts it)',
        verdict,
        method: 'lexical',
        confidence: 'low',
        expected: uncertainty,
        score: c.score,
        detail: !report
          ? 'no report'
          : verdict === 'PASS'
            ? `acknowledged (concept coverage ${(c.score * 100).toFixed(0)}% in uncertain statements)`
            : verdict === 'FAIL'
              ? 'a confident statement covers what the answer key says cannot be known'
              : `not acknowledged (coverage ${(c.score * 100).toFixed(0)}%), not contradicted`,
        ...(overclaims.length > 0 && verdict === 'FAIL' ? { evidence: overclaims.slice(0, 3) } : {}),
      });
    });
  }

  // ── Possible next step vs what the Coach recommended ──
  {
    const actions = captured.coach.actions;
    const next = [...actions.map((a) => [a.title, a.description, a.rationale, a.focusTask].filter(Boolean).join(' ')), report?.carryForward?.text ?? ''].join('\n');
    const c = coverage(expected.possible_next_step, next);
    const wantStream = streamOfText(expected.possible_next_step);
    const sameStream = wantStream !== null && actions.some((a) => streamOfAction(a, captured.priorities) === wantStream);
    const verdict = !report
      ? 'FAIL'
      : next.trim() === ''
        ? 'FAIL'
        : c.score >= ctx.semantic.passCoverage || (sameStream && c.score >= ctx.semantic.partialCoverage)
          ? 'PASS'
          : sameStream || c.score >= ctx.semantic.partialCoverage
            ? 'PARTIAL'
            : 'FAIL';
    out.push({
      id: 'possible_next_step',
      label: 'The next step points the same way as the answer key',
      verdict,
      method: 'lexical',
      confidence: 'low',
      expected: expected.possible_next_step,
      score: c.score,
      detail:
        next.trim() === ''
          ? `no recommendation was made${report?.coach?.noActionReason ? ` ("${report.coach.noActionReason}")` : ''}`
          : `concept coverage ${(c.score * 100).toFixed(0)}%; expected work stream ${wantStream ?? 'unclear'}, ${sameStream ? 'an action targets it' : 'no action targets it'}`,
      evidence: actions.map((a) => a.title),
    });
  }

  if (answer.evaluationObjectives !== null && answer.evaluationObjectives !== undefined) {
    out.push({
      id: 'evaluation_objectives',
      label: 'Evaluation objectives stated by the dataset',
      verdict: 'NOT_APPLICABLE',
      method: 'lexical',
      confidence: 'low',
      detail: 'Present in the dataset; free-form objectives are listed in the review packet rather than machine-scored.',
      expected: JSON.stringify(answer.evaluationObjectives).slice(0, 600),
    });
  }

  return out;
}

export function evaluateReflection(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: ReflectionEvaluationContext): ReflectionEvaluation {
  return {
    generated: captured.reflection.report !== null,
    deterministic: deterministicChecks(captured, answer, ctx),
    semantic: semanticChecks(captured, answer, ctx),
  };
}
