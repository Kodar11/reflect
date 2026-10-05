import fs from 'node:fs';
import path from 'node:path';
import type { CoachOpportunity } from '../../../src/coach/CoachOpportunities';
import type { CapturedDay } from '../runner/capture';
import { replayCoachSignals, type ReplayedDay } from '../runner/coachReplay';
import { KNOWN_TARGETS, type CoachAssessment } from './coachDimensions';
import { streamOfPriority } from './text';

/**
 * Why was a day not answered? Read from a stored run — no database, no Gemini.
 *
 * "The Coach missed it" names an outcome, not a cause, and the cause decides
 * what to change. A candidate that was never measured is a different problem
 * from one the model declined, and both differ from an action the validator
 * refused. For every day that was not answered correctly this puts one reason
 * next to it, taken from three things the run already stored:
 *
 *   - the verdict, and the answer key's target and kind of move;
 *   - the Coach's own decision log for that day (every attempt: what it
 *     concluded, what it proposed, what the validator kept, and why not);
 *   - the measurement layer, replayed over the day's stored activities
 *     (`runner/coachReplay.ts`): which signals existed for the expected target.
 *
 * The reasons are grouped by the layer they point at, because that is the
 * question the next iteration has to answer: DATA, OPPORTUNITY GENERATION,
 * REASONING, VALIDATION, PERSISTENCE — or the benchmark itself.
 */

export type MissReason =
  | 'missing_upstream_evidence'
  | 'candidate_not_generated'
  | 'candidate_too_weak'
  | 'historical_context_missing'
  | 'gemini_decision'
  | 'unstable_decision'
  | 'withdrawn_after_refusal'
  | 'priority_choice'
  | 'wrong_kind_of_action'
  | 'false_opportunity'
  | 'validator_suppression'
  | 'previous_action_suppression'
  | 'repeat'
  | 'retry_persistence_loss'
  | 'evaluator_mismatch';

export type DiagnosticLayer = 'data' | 'opportunity_generation' | 'reasoning' | 'validation' | 'persistence' | 'evaluation';

export const REASON_LAYER: Record<MissReason, DiagnosticLayer> = {
  missing_upstream_evidence: 'data',
  candidate_not_generated: 'opportunity_generation',
  candidate_too_weak: 'opportunity_generation',
  historical_context_missing: 'opportunity_generation',
  gemini_decision: 'reasoning',
  unstable_decision: 'reasoning',
  withdrawn_after_refusal: 'validation',
  priority_choice: 'reasoning',
  wrong_kind_of_action: 'reasoning',
  false_opportunity: 'reasoning',
  validator_suppression: 'validation',
  previous_action_suppression: 'validation',
  repeat: 'validation',
  retry_persistence_loss: 'persistence',
  evaluator_mismatch: 'evaluation',
};

export const REASON_MEANING: Record<MissReason, string> = {
  missing_upstream_evidence: 'nothing tracked that day was linked to the expected target, so there was nothing to measure',
  candidate_not_generated: 'work on the expected target existed, but the measurement layer raised no signal for it',
  candidate_too_weak: 'a signal for the expected target existed only as "possible", and the model declined it',
  historical_context_missing: 'the expected move rests on a multi-day pattern that was not measured as one',
  gemini_decision: 'a clear candidate was on the table and the model chose silence',
  unstable_decision: 'the model answered the same day differently on different attempts; its first valid answer — silence — is the one that was kept',
  withdrawn_after_refusal: 'the model proposed a move, was refused for how it was worded, and answered the retry with silence',
  priority_choice: 'the Coach acted, on a different target than the one the day called for',
  wrong_kind_of_action: 'the Coach acted on the right target, with a different kind of move than the day called for',
  false_opportunity: 'the Coach acted on a day that called for nothing',
  validator_suppression: 'the model proposed an action and the validator refused it (wording, grounding, or its own reading)',
  previous_action_suppression: 'the model kept proposing something the record already covers, and nothing else',
  repeat: 'the action was aimed at the right target but restated a recent one',
  retry_persistence_loss: 'an attempt produced a valid action that the stored report does not hold',
  evaluator_mismatch: 'the action answers the day; the evaluator did not count it',
};

/** One attempt of the day's request, as the Coach logged it. */
export interface DecisionAttempt {
  verdict: 'act' | 'no_useful_move' | null;
  candidate: string | null;
  readings: Record<string, string>;
  proposed: number;
  kept: number;
  problems: string;
}

export interface DayDiagnosis {
  dayNumber: number;
  date: string;
  strength: string;
  expected: string | null;
  verdict: string;
  /** null when the day was answered (correct, correct null, acceptable null). */
  reason: MissReason | null;
  detail: string;
  /** Signals the replayed measurement layer holds for the expected target: `kind:strength[:days][→standing]`. */
  targetSignals: string[];
  attempts: DecisionAttempt[];
}

export interface CoachDiagnostics {
  days: DayDiagnosis[];
  byReason: Partial<Record<MissReason, number>>;
  byLayer: Partial<Record<DiagnosticLayer, number>>;
  /** Days that were not answered correctly. */
  unanswered: number;
}

const DECISION_LINE = /\[COACH\] Decision: (act|no_useful_move|not stated)(?: — candidate “([^”]*)”)?; (?:read ([^;]*); )?(\d+) action\(s\) proposed, (\d+) kept(?:; problems: (.*?))?(?:; reason given: .*)?$/;

export function parseDecisionAttempts(pipelineLog: string[]): DecisionAttempt[] {
  const attempts: DecisionAttempt[] = [];
  for (const line of pipelineLog) {
    const match = DECISION_LINE.exec(line);
    if (!match) continue;
    const readings: Record<string, string> = {};
    for (const pair of (match[3] ?? '').split(',')) {
      const [id, state] = pair.trim().split('=');
      if (id && state) readings[id] = state;
    }
    attempts.push({
      verdict: match[1] === 'not stated' ? null : (match[1] as 'act' | 'no_useful_move'),
      candidate: match[2] ?? null,
      readings,
      proposed: Number(match[4]),
      kept: Number(match[5]),
      problems: match[6] ?? '',
    });
  }
  return attempts;
}

/** Refusals that rest on the record of earlier actions rather than on how the action was written. */
const RECORD_REFUSAL = /already carried out|already has this|rejected this|never taken up|never answered|postponed|did not work|has not worked out|too difficult at its size/i;
/** Kinds of move that only make sense as the answer to something that held for more than a day. */
const MULTI_DAY_TYPES = new Set(['protect_priority', 'stop_recurring_pattern', 'schedule_change', 'clarify_priority', 'deliberate_rest']);

const describeSignal = (s: CoachOpportunity) => `${s.kind}:${s.strength}${s.days && s.days > 1 ? `:${s.days}d` : ''}${s.record ? `→${s.record.standing}` : ''}`;

function expectedPriorityIds(target: string | null, priorities: { id: string; text: string }[]): string[] {
  if (target === null) return [];
  if (KNOWN_TARGETS.includes(target)) return priorities.filter((p) => streamOfPriority(p.text) === target).map((p) => p.id);
  return priorities.filter((p) => p.text === target).map((p) => p.id);
}

export function diagnoseDay(captured: CapturedDay, assessment: CoachAssessment, pipelineLog: string[], replay: ReplayedDay | undefined): DayDiagnosis {
  const attempts = parseDecisionAttempts(pipelineLog);
  const targetIds = expectedPriorityIds(assessment.opportunity.target, captured.priorities);
  // A day-wide move (rest, fewer switches) has no target: every day-wide signal is "its" signal.
  const forTarget = (replay?.signals ?? []).filter((s) => (targetIds.length > 0 ? s.priorityId !== null && targetIds.includes(s.priorityId) : s.priorityId === null));
  const measured = forTarget.filter((s) => s.kind !== 'tried_before' && s.kind !== 'momentum');
  const candidates = measured.filter((s) => !s.record?.settled);
  const base = {
    dayNumber: captured.dayNumber,
    date: captured.date,
    strength: assessment.opportunity.strength,
    expected: assessment.expectedPrimary,
    verdict: assessment.verdict,
    targetSignals: forTarget.map(describeSignal),
    attempts,
  };
  const answer = (reason: MissReason | null, detail: string): DayDiagnosis => ({ ...base, reason, detail });

  if (assessment.verdict === 'correct' || assessment.verdict === 'correct_null' || assessment.verdict === 'acceptable_null') return answer(null, '');
  if (assessment.verdict === 'no_report') return answer('retry_persistence_loss', 'no daily report was stored for the day');

  // ── Silence on a day that called for a move ──
  if (assessment.verdict === 'missed') {
    const firstKept = attempts.findIndex((a) => a.kept > 0);
    const firstSilent = attempts.findIndex((a) => a.verdict === 'no_useful_move' && a.proposed === 0);
    const firstRefused = attempts.findIndex((a) => a.proposed > 0 && a.kept === 0);
    // Silence that followed a refusal was not the model's first reading of the day: it had found a move.
    if (firstSilent >= 0 && firstRefused >= 0 && firstRefused < firstSilent && (firstKept < 0 || firstSilent < firstKept)) {
      const refused = attempts[firstRefused];
      return RECORD_REFUSAL.test(refused.problems)
        ? answer('previous_action_suppression', `proposed “${refused.candidate ?? ''}”, which the record already covers, then chose silence`)
        : answer('withdrawn_after_refusal', `proposed “${refused.candidate ?? ''}”; refused: ${refused.problems.slice(0, 160)} — and the retry returned no action`);
    }
    // The first valid answer of a generation is the one that is kept: a later attempt's action does not replace an earlier, sound "no action".
    if (firstKept >= 0 && firstSilent >= 0 && firstSilent < firstKept) return answer('unstable_decision', `attempt ${firstSilent + 1} chose silence and attempt ${firstKept + 1} an action (“${attempts[firstKept].candidate ?? ''}”); the first valid answer stands`);
    if (firstKept >= 0) return answer('retry_persistence_loss', 'an attempt kept an action, but the stored report has none');
    const proposing = attempts.filter((a) => a.proposed > 0);
    if (proposing.length > 0 && proposing.length === attempts.length) {
      const record = proposing.filter((a) => RECORD_REFUSAL.test(a.problems));
      const proposals = [...new Set(proposing.map((a) => a.candidate).filter(Boolean))].slice(0, 2).join('” / “');
      return record.length === proposing.length
        ? answer('previous_action_suppression', `every attempt proposed “${proposals}”, which the record already covers; nothing else was offered`)
        : answer('validator_suppression', `proposed “${proposals}”; refused: ${proposing[proposing.length - 1].problems.slice(0, 220)}`);
    }
    const linked = targetIds.length === 0 || captured.timeline.some((b) => b.priorityId !== null && targetIds.includes(b.priorityId));
    if (!linked && measured.length === 0) return answer('missing_upstream_evidence', 'no activity that day was linked to the expected target, and no signal was measured for it');
    if (candidates.length === 0) {
      return measured.length > 0
        ? answer('previous_action_suppression', `the only signals for the target were already covered by the record (${measured.map(describeSignal).join(', ')})`)
        : answer('candidate_not_generated', 'the target was worked on, and the measurement layer raised nothing for it');
    }
    if (candidates.some((s) => s.strength === 'clear')) {
      const said = attempts[attempts.length - 1];
      return answer('gemini_decision', `a clear candidate existed (${candidates.map(describeSignal).join(', ')}); the model read the target as ${targetIds.map((id) => said?.readings[id] ?? '—').join(' / ')} and chose silence`);
    }
    if (assessment.opportunity.type && MULTI_DAY_TYPES.has(assessment.opportunity.type) && candidates.every((s) => (s.days ?? 1) < 2)) {
      return answer('historical_context_missing', `the expected ${assessment.opportunity.type} rests on a pattern; only single-day signals were measured (${candidates.map(describeSignal).join(', ')})`);
    }
    return answer('candidate_too_weak', `only "possible" signals for the target (${candidates.map(describeSignal).join(', ')})`);
  }

  // ── An action that did not answer the day ──
  const onTarget = assessment.actions.filter((a) => a.matches !== null);
  if (assessment.opportunity.strength === 'none') return answer('false_opportunity', `acted (“${assessment.actions[0]?.title ?? ''}”) on a day that called for nothing`);
  if (onTarget.some((a) => a.repeated)) return answer('repeat', onTarget.find((a) => a.repeated)!.notes.find((n) => n.startsWith('says the same thing')) ?? 'restates a recent action');
  const onPrimary = onTarget.find((a) => a.matches === 'primary');
  if (assessment.verdict === 'partially_correct' && onPrimary && onPrimary.typeFit === 'different') {
    return answer('wrong_kind_of_action', `“${onPrimary.title}” is a ${onPrimary.actionType} where ${assessment.opportunity.type ?? 'another kind of move'} was called for`);
  }
  if (assessment.verdict === 'partially_correct' || onTarget.length === 0) {
    const chosen = assessment.actions[0];
    const available = candidates.length > 0 ? `signals for the expected target: ${candidates.map(describeSignal).join(', ')}` : measured.length > 0 ? 'the expected target’s signals were covered by the record' : 'no signal was measured for the expected target';
    return answer('priority_choice', `chose “${chosen?.title ?? ''}” (${chosen?.targetKey ?? 'no target'}); ${available}`);
  }
  if (assessment.verdict === 'unnecessary') return answer('false_opportunity', `an action was optional, and “${assessment.actions[0]?.title ?? ''}” does not hold up: ${assessment.actions[0]?.notes.join('; ') ?? ''}`);
  // Aimed at the expected target, not a repeat, and still not counted: what the evaluator held against it.
  const flagged = onTarget.find((a) => !a.justified);
  return answer('evaluator_mismatch', `“${flagged?.title ?? onTarget[0].title}” is aimed at the expected target; held against it: ${flagged?.notes.join('; ') || 'nothing recorded'}`);
}

interface StoredDay {
  dayNumber: number;
  captured: CapturedDay;
  evaluation: { coach: { assessment: CoachAssessment } };
  pipelineLog?: string[];
}

/** Diagnose a stored run (`<runDir>/days/day_NN.json`). */
export function diagnoseRun(runDir: string): CoachDiagnostics {
  const daysDir = path.join(runDir, 'days');
  const stored = fs
    .readdirSync(daysDir)
    .filter((f) => /^day_\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(daysDir, f), 'utf8')) as StoredDay);
  const replay = new Map(replayCoachSignals(stored.map((d) => d.captured)).map((d) => [d.dayNumber, d]));
  return summarizeDiagnoses(stored.map((d) => diagnoseDay(d.captured, d.evaluation.coach.assessment, d.pipelineLog ?? [], replay.get(d.dayNumber))));
}

export function summarizeDiagnoses(days: DayDiagnosis[]): CoachDiagnostics {
  const byReason: CoachDiagnostics['byReason'] = {};
  const byLayer: CoachDiagnostics['byLayer'] = {};
  for (const day of days) {
    if (!day.reason) continue;
    byReason[day.reason] = (byReason[day.reason] ?? 0) + 1;
    byLayer[REASON_LAYER[day.reason]] = (byLayer[REASON_LAYER[day.reason]] ?? 0) + 1;
  }
  return { days, byReason, byLayer, unanswered: days.filter((d) => d.reason !== null).length };
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');

export function renderDiagnostics(diagnostics: CoachDiagnostics, title = 'Coach diagnostics'): string {
  const layers: DiagnosticLayer[] = ['data', 'opportunity_generation', 'reasoning', 'validation', 'persistence', 'evaluation'];
  const lines = [
    `# ${title}`,
    '',
    `${diagnostics.unanswered} of ${diagnostics.days.length} day(s) were not answered correctly. For each, the one reason the stored run points to — ` +
      'from the verdict, the Coach\'s own decision log, and the measurement layer replayed over the day\'s stored activities.',
    '',
    '## Where the next bottleneck is',
    '',
    '| Layer | Days | Reasons |',
    '| --- | --- | --- |',
    ...layers.map((layer) => {
      const reasons = (Object.entries(diagnostics.byReason) as [MissReason, number][]).filter(([reason]) => REASON_LAYER[reason] === layer);
      return `| ${layer.replace(/_/g, ' ').toUpperCase()} | ${diagnostics.byLayer[layer] ?? 0} | ${reasons.map(([reason, n]) => `${reason} ${n}`).join(', ') || '—'} |`;
    }),
    '',
    '| Reason | Days | Meaning |',
    '| --- | --- | --- |',
    ...(Object.entries(diagnostics.byReason) as [MissReason, number][]).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `| ${reason} | ${n} | ${REASON_MEANING[reason]} |`),
    '',
    '## Day by day',
    '',
    '| Day | Opportunity | Expected | Verdict | MISS_REASON | Detail | Signals for the expected target (replayed) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...diagnostics.days
      .filter((d) => d.reason !== null)
      .map((d) => `| ${d.dayNumber} | ${d.strength} | ${cell(d.expected ?? 'no action')} | ${d.verdict.replace(/_/g, ' ')} | **${d.reason}** | ${cell(d.detail)} | ${cell(d.targetSignals.join(', ') || '—')} |`),
    '',
    'The replay runs the measurement code as it is now over the activities the run produced; for a run made with older code it shows what today\'s code would have measured on the same days.',
    '',
  ];
  return lines.join('\n');
}
