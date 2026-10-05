import type { CoachAction, CoachConfig, CoachReasonCode } from './CoachModels.js';
import { describeStrategy } from './CoachMatching.js';

/**
 * What has worked for this user, and what has not. Pure.
 *
 * Nothing here is stored: every figure is derived from the actions themselves
 * (decision, observed execution, stated outcome), so the record can never
 * drift from what actually happened. There is deliberately no single "coach
 * score" — acceptance, follow-through, usefulness and applicability are kept
 * apart, because they answer different questions.
 */

export type ActionSignal = 'success' | 'partial_success' | 'failure' | 'neutral' | 'pending';

/** Reasons that say "not needed", not "did not work". */
const NEUTRAL_REJECTIONS: readonly CoachReasonCode[] = ['already_doing'];

/**
 * Reasons for not carrying an action out that say nothing about the action:
 * something outside the user's control took the time. Not following a
 * recommendation is never, by itself, proof that it was a bad one.
 */
const NEUTRAL_NOT_DONE: readonly CoachReasonCode[] = ['external_constraint'];

/** How one action counts toward learning. */
export function signalOf(action: CoachAction): ActionSignal {
  switch (action.status) {
    case 'withdrawn':
    case 'expired':
      return action.reasonCode === 'bad_timing' ? 'failure' : 'neutral';
    case 'rejected':
      return action.reasonCode && NEUTRAL_REJECTIONS.includes(action.reasonCode) ? 'neutral' : 'failure';
    case 'suggested':
    case 'snoozed':
    case 'accepted':
      return 'pending';
    case 'review':
    case 'closed':
      break;
  }
  if (action.outcome === 'worked') return 'success';
  if (action.outcome === 'partly_worked') return 'partial_success';
  if (action.outcome === 'did_not_work' || action.outcome === 'not_applicable') return 'failure';
  if (action.execution === 'not_done') return action.reasonCode && NEUTRAL_NOT_DONE.includes(action.reasonCode) ? 'neutral' : 'failure';
  // Its window passed, nothing was seen, and the user never said otherwise.
  if (action.execution === null && action.observation?.kind === 'not_observed' && action.observation.final) return 'failure';
  // Carried out, but nobody said whether it helped: not evidence either way.
  return action.status === 'review' ? 'pending' : 'neutral';
}

export interface StrategyRecord {
  strategyKey: string;
  /** null = across every target. */
  targetKey: string | null;
  suggested: number;
  accepted: number;
  rejected: number;
  /** Never decided. */
  ignored: number;
  carriedOut: number;
  /** The user said it did not happen. */
  notCarriedOut: number;
  /** Its window passed with nothing seen and nothing said. */
  notObserved: number;
  worked: number;
  partlyWorked: number;
  didNotWork: number;
  notApplicable: number;
  reasons: Partial<Record<CoachReasonCode, number>>;
  successes: number;
  failures: number;
  lastAt: string;
}

function emptyRecord(strategyKey: string, targetKey: string | null): StrategyRecord {
  return {
    strategyKey,
    targetKey,
    suggested: 0,
    accepted: 0,
    rejected: 0,
    ignored: 0,
    carriedOut: 0,
    notCarriedOut: 0,
    notObserved: 0,
    worked: 0,
    partlyWorked: 0,
    didNotWork: 0,
    notApplicable: 0,
    reasons: {},
    successes: 0,
    failures: 0,
    lastAt: '',
  };
}

function tally(record: StrategyRecord, action: CoachAction): void {
  record.suggested++;
  if (action.acceptedAt) record.accepted++;
  if (action.status === 'rejected') record.rejected++;
  if (action.status === 'expired') record.ignored++;
  if (action.execution === 'done' || action.execution === 'partial') record.carriedOut++;
  if (action.execution === 'not_done') record.notCarriedOut++;
  if (action.execution === null && action.observation?.kind === 'not_observed' && action.observation.final) record.notObserved++;
  if (action.outcome === 'worked') record.worked++;
  if (action.outcome === 'partly_worked') record.partlyWorked++;
  if (action.outcome === 'did_not_work') record.didNotWork++;
  if (action.outcome === 'not_applicable') record.notApplicable++;
  if (action.reasonCode) record.reasons[action.reasonCode] = (record.reasons[action.reasonCode] ?? 0) + 1;
  const signal = signalOf(action);
  if (signal === 'success' || signal === 'partial_success') record.successes++;
  if (signal === 'failure') record.failures++;
  if (action.updatedAt > record.lastAt) record.lastAt = action.updatedAt;
}

export interface EffectivenessSummary {
  /** One record per strategy + target. */
  byTarget: StrategyRecord[];
  /** One record per strategy, across targets. */
  byStrategy: StrategyRecord[];
}

/** Actions that count: decided or surfaced within the lookback, and not withdrawn. */
function relevant(actions: CoachAction[], nowIso: string, lookbackMs: number): CoachAction[] {
  const since = new Date(Date.parse(nowIso) - lookbackMs).toISOString();
  return actions.filter((a) => a.status !== 'withdrawn' && a.createdAt >= since);
}

export function summarizeEffectiveness(
  actions: CoachAction[],
  nowIso: string,
  config: Pick<CoachConfig, 'effectivenessLookbackMs'>,
): EffectivenessSummary {
  const byTarget = new Map<string, StrategyRecord>();
  const byStrategy = new Map<string, StrategyRecord>();
  for (const action of relevant(actions, nowIso, config.effectivenessLookbackMs)) {
    const pairKey = `${action.strategyKey}→${action.targetKey ?? ''}`;
    if (!byTarget.has(pairKey)) byTarget.set(pairKey, emptyRecord(action.strategyKey, action.targetKey));
    if (!byStrategy.has(action.strategyKey)) byStrategy.set(action.strategyKey, emptyRecord(action.strategyKey, null));
    tally(byTarget.get(pairKey)!, action);
    tally(byStrategy.get(action.strategyKey)!, action);
  }
  const order = (a: StrategyRecord, b: StrategyRecord) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.strategyKey < b.strategyKey ? -1 : 1);
  return { byTarget: [...byTarget.values()].sort(order), byStrategy: [...byStrategy.values()].sort(order) };
}

export type StrategyVerdict = 'working' | 'not_working' | 'unclear';

/**
 * One failure is not a verdict; repeated failure with no success is. Repeated
 * success outweighing failure makes a strategy reusable.
 */
export function verdictOf(record: StrategyRecord, config: Pick<CoachConfig, 'blockAfterFailures'>): StrategyVerdict {
  if (record.failures >= config.blockAfterFailures && record.successes === 0) return 'not_working';
  if (record.successes >= 2 && record.successes > record.failures) return 'working';
  return 'unclear';
}

/** Should this strategy still be suggested for this target? */
export function isBlocked(
  summary: EffectivenessSummary,
  candidate: { strategyKey: string; targetKey: string | null },
  config: Pick<CoachConfig, 'blockAfterFailures'>,
): StrategyRecord | null {
  const record = summary.byTarget.find((r) => r.strategyKey === candidate.strategyKey && r.targetKey === candidate.targetKey);
  return record && verdictOf(record, config) === 'not_working' ? record : null;
}

export interface Escalation {
  targetKey: string;
  failures: number;
  reasons: Partial<Record<CoachReasonCode, number>>;
  /** The actions that did not work out, oldest first. */
  actionIds: string[];
  lastFailureAt: string;
}

/**
 * Targets where advice keeps not working: after enough failures with no
 * success, the Coach stops proposing and asks instead. `resets` holds, per
 * target, when the user last explained what was getting in the way — failures
 * before that no longer count.
 */
export function findEscalations(
  actions: CoachAction[],
  nowIso: string,
  config: Pick<CoachConfig, 'effectivenessLookbackMs' | 'escalateAfterFailures'>,
  resets: Map<string, string> = new Map(),
): Escalation[] {
  const byTarget = new Map<string, { failures: CoachAction[]; successes: number }>();
  for (const action of relevant(actions, nowIso, config.effectivenessLookbackMs)) {
    if (!action.targetKey) continue;
    const reset = resets.get(action.targetKey);
    if (reset && action.updatedAt <= reset) continue;
    const entry = byTarget.get(action.targetKey) ?? { failures: [], successes: 0 };
    const signal = signalOf(action);
    if (signal === 'failure') entry.failures.push(action);
    if (signal === 'success' || signal === 'partial_success') entry.successes++;
    byTarget.set(action.targetKey, entry);
  }
  const out: Escalation[] = [];
  for (const [targetKey, entry] of byTarget) {
    if (entry.successes > 0 || entry.failures.length < config.escalateAfterFailures) continue;
    const ordered = [...entry.failures].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const reasons: Partial<Record<CoachReasonCode, number>> = {};
    for (const a of ordered) if (a.reasonCode) reasons[a.reasonCode] = (reasons[a.reasonCode] ?? 0) + 1;
    out.push({
      targetKey,
      failures: ordered.length,
      reasons,
      actionIds: ordered.map((a) => a.id),
      lastFailureAt: ordered.reduce((latest, a) => (a.updatedAt > latest ? a.updatedAt : latest), ''),
    });
  }
  return out.sort((a, b) => (a.lastFailureAt < b.lastFailureAt ? 1 : -1));
}

export const REASON_LABELS: Record<CoachReasonCode, string> = {
  not_relevant: 'not relevant',
  bad_timing: 'bad timing',
  too_difficult: 'too difficult',
  different_priority: 'a different priority',
  already_doing: 'already doing it',
  external_constraint: 'an external constraint',
  not_applicable: 'not applicable',
  other: 'another reason',
};

export function describeReasons(reasons: Partial<Record<CoachReasonCode, number>>): string {
  return (Object.entries(reasons) as [CoachReasonCode, number][])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `${REASON_LABELS[code]}${count > 1 ? ` ×${count}` : ''}`)
    .join(', ');
}

/** The record as the model reads it: counts, reasons, and a plain verdict. */
export function effectivenessLines(
  summary: EffectivenessSummary,
  targetLabel: (targetKey: string | null) => string | null,
  config: Pick<CoachConfig, 'blockAfterFailures'>,
  max = 10,
): string[] {
  const lines: string[] = [];
  for (const record of summary.byTarget) {
    // A single undecided suggestion says nothing yet — but one the user keeps not answering does.
    if (record.successes + record.failures === 0 && record.ignored < 2) continue;
    const target = targetLabel(record.targetKey);
    const helped = record.worked + record.partlyWorked;
    const parts = [
      `suggested ${record.suggested}`,
      `accepted ${record.accepted}`,
      `carried out ${record.carriedOut}`,
      `helped ${helped}`,
    ];
    if (record.rejected > 0) parts.push(`rejected ${record.rejected}`);
    if (record.notCarriedOut + record.notObserved > 0) parts.push(`did not happen ${record.notCarriedOut + record.notObserved}`);
    if (record.didNotWork > 0) parts.push(`did not help ${record.didNotWork}`);
    if (record.notApplicable > 0) parts.push(`not applicable ${record.notApplicable}`);
    const reasons = describeReasons(record.reasons);
    const verdict = verdictOf(record, config);
    if (record.ignored > 0) parts.push(`never decided ${record.ignored}`);
    const conclusion =
      verdict === 'working'
        ? 'WORKS for this user — a good candidate to reuse.'
        : verdict === 'not_working'
          ? 'NOT WORKING — do not suggest it again in this form.'
          : record.didNotWork > 0
            ? 'The user said it DID NOT HELP — do not offer it again unchanged; change the time, the size or the type, or leave this target alone.'
            : record.worked > 0 && record.failures === 0
              ? 'HELPED when it was tried — reasonable to reuse when the situation is similar.'
              : record.partlyWorked > 0 && record.failures === 0
                ? 'PARTLY HELPED — keep the idea and refine one thing (size, timing or scope) rather than repeating or dropping it.'
                : record.successes + record.failures === 0
                  ? 'Offered more than once and never taken up — do not send the same thing again.'
                  : 'Not enough evidence yet.';
    lines.push(
      `${describeStrategy(record.strategyKey)}${target ? ` → “${target}”` : ''}: ${parts.join(', ')}${reasons ? `; reasons given: ${reasons}` : ''}. ${conclusion}`,
    );
    if (lines.length >= max) break;
  }
  return lines;
}

/** Short, human statements of what has been learned — shown to the user. */
export function learnedStatements(
  summary: EffectivenessSummary,
  targetLabel: (targetKey: string | null) => string | null,
  config: Pick<CoachConfig, 'blockAfterFailures'>,
  max = 4,
): { kind: 'works' | 'does_not_work'; text: string }[] {
  const out: { kind: 'works' | 'does_not_work'; text: string }[] = [];
  for (const record of summary.byTarget) {
    const verdict = verdictOf(record, config);
    if (verdict === 'unclear') continue;
    const target = targetLabel(record.targetKey);
    const what = `${capitalize(describeStrategy(record.strategyKey))}${target ? ` for “${target}”` : ''}`;
    if (verdict === 'working') {
      out.push({ kind: 'works', text: `${what} has helped ${record.worked + record.partlyWorked} of ${record.successes + record.failures} times.` });
    } else {
      const reasons = describeReasons(record.reasons);
      out.push({
        kind: 'does_not_work',
        text: `${what} has not worked out ${record.failures} times${reasons ? ` (${reasons})` : ''}, so Reflect will not suggest it that way again.`,
      });
    }
    if (out.length >= max) break;
  }
  return out;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
