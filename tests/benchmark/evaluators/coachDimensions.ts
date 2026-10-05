import type { CoachAction } from '../../../src/coach/CoachModels';
import { DEFAULT_COACH_CONFIG } from '../../../src/coach/CoachModels';
import type { CapturedDay } from '../runner/capture';
import type { SemanticConfig } from '../runner/config';
import type { DatasetActionOpportunity, DatasetExpectedAction, EvaluationOnlyDay, OpportunityStrength } from '../runner/dataset';
import { actionText, streamOfAction } from './corpus';
import { GENERIC_ADVICE, conceptsOf, coverage, normalizeText } from './text';

/**
 * Coach evaluation, by dimension.
 *
 * The thirteen criteria in `coach.ts` ask "did the Coach avoid doing something
 * wrong?" — and a Coach that never says anything passes most of them. These
 * dimensions ask the other half, and keep apart three questions that must
 * never be folded into one number:
 *
 *   1. Was the recommendation right?       (opportunity, precision, alignment,
 *                                           specificity, grounding, feasibility,
 *                                           appropriate null)
 *   2. Did the user follow it?             (decision, execution)
 *   3. Did it help?                        (outcome)
 *
 * plus a fourth: did the Coach change what it recommends because of 2 and 3?
 * (adaptation).
 *
 * Nothing here rewards volume. An action on a day with no opportunity is
 * "unnecessary", and counts against precision exactly as silence on a day
 * with a strong opportunity counts against recall.
 */

// ── Answer-key vocabulary ───────────────────────────────────────────────────

/** Answer-key action types → Reflect's `CoachActionType`s that mean the same / are a reasonable form of it. */
export const ACTION_TYPE_MAPPING: Record<string, { exact: string[]; compatible: string[] }> = {
  protect_priority: { exact: ['protect_priority'], compatible: ['focus_session', 'change_timing', 'reduce_fragmentation', 'continue_behavior'] },
  start_focus: { exact: ['focus_session'], compatible: ['protect_priority', 'reduce_fragmentation', 'continue_behavior', 'close_open_loop'] },
  complete_open_loop: { exact: ['close_open_loop'], compatible: ['focus_session', 'protect_priority'] },
  continue_successful_behavior: { exact: ['continue_behavior'], compatible: ['protect_priority', 'focus_session'] },
  clarify_priority: { exact: ['clarify_priority'], compatible: ['close_open_loop'] },
  experiment: { exact: ['experiment'], compatible: ['change_approach'] },
  reduce_fragmentation: { exact: ['reduce_fragmentation'], compatible: ['focus_session', 'protect_priority', 'change_timing', 'avoid_pattern'] },
  schedule_change: { exact: ['change_timing'], compatible: ['protect_priority', 'experiment'] },
  deliberate_rest: { exact: ['rest'], compatible: [] },
  stop_recurring_pattern: { exact: ['avoid_pattern'], compatible: ['change_approach', 'reduce_fragmentation', 'experiment'] },
};

/** Work streams the founder/freelancer answer key names instead of a priority. */
export const KNOWN_TARGETS = ['Own SaaS', 'Freelance'];

export function opportunityOf(expected: EvaluationOnlyDay['expectedCoachOutcome']): DatasetActionOpportunity {
  if (expected.action_opportunity) return expected.action_opportunity;
  const primary = expected.primary_action;
  return {
    should_exist: primary !== null,
    strength: primary !== null ? 'strong' : 'none',
    reason: primary?.reason ?? 'the answer key expects no action',
    priority: primary?.target ?? null,
    type: primary?.action_type ?? null,
  };
}

/** Whether `action` is aimed at what the answer key calls `target` (a work stream, or a stated priority's text). */
export function targetMatches(target: string | null, action: CoachAction, priorities: { id: string; text: string }[]): boolean {
  if (target === null) return false;
  if (KNOWN_TARGETS.includes(target)) return streamOfAction(action, priorities) === target;
  const priority = priorities.find((p) => p.text === target);
  if (priority && action.priorityId === priority.id) return true;
  // Not linked by id: the action names the priority, or shares most of its wording.
  return coverage(target, actionText(action)).score >= 0.6;
}

export type TypeFit = 'exact' | 'compatible' | 'different';

export function typeFit(expectedType: string, actionType: string): TypeFit {
  const mapping = ACTION_TYPE_MAPPING[expectedType];
  return mapping?.exact.includes(actionType) ? 'exact' : mapping?.compatible.includes(actionType) ? 'compatible' : 'different';
}

/** How well one actual action answers one expected action. */
export function matchExpected(expected: DatasetExpectedAction, action: CoachAction, priorities: { id: string; text: string }[]) {
  const type = typeFit(expected.action_type, action.actionType);
  // A day-wide action (rest, fewer switches) has no target to hit: the kind of action is the match.
  const target = expected.target === null ? type !== 'different' : targetMatches(expected.target, action, priorities);
  const wording = coverage(`${expected.title}. ${expected.reason}`, actionText(action)).score;
  return { type, target, wording, rank: (target ? 2 : 0) + (type === 'exact' ? 2 : type === 'compatible' ? 1 : 0) + wording };
}

// ── Per-action quality ──────────────────────────────────────────────────────

export interface ActionAssessment {
  actionId: string;
  title: string;
  actionType: string;
  strategyKey: string;
  targetKey: string | null;
  /** Which expected action it answers, if either. */
  matches: 'primary' | 'secondary' | null;
  typeFit: TypeFit | null;
  /** Its cited metrics / activities exist, and it has a rationale. */
  grounded: boolean;
  /** Tied to a stated priority, or to a thread the day linked to one. */
  aligned: boolean;
  /** Names what to do, on what, and when — in terms of this user's own day. */
  specific: boolean;
  /** Small enough, and aimed at a moment that is still ahead. */
  feasible: boolean;
  /** Advice that would fit anyone on any day. */
  generic: boolean;
  /** Resembles something the answer key says must not be recommended. */
  prohibited: boolean;
  /** Says the same thing as an action of the previous few days, in the same words. */
  repeated: boolean;
  /** The day called for (or allowed) an action, and this one holds up on every count above. */
  justified: boolean;
  notes: string[];
}

export type OpportunityVerdict =
  | 'correct'
  | 'partially_correct'
  | 'wrong'
  | 'unnecessary'
  | 'missed'
  | 'correct_null'
  | 'acceptable_null'
  | 'no_report';

/** One action as the record holds it — decision, execution and outcome kept apart. */
export interface ActionStateRecord {
  id: string;
  title: string;
  originDayKey: string;
  actionType: string;
  strategyKey: string;
  targetKey: string | null;
  parentActionId: string | null;
  status: CoachAction['status'];
  decision: 'accepted' | 'rejected' | 'deferred' | 'undecided';
  execution: CoachAction['execution'];
  /** Who established whether it happened: Reflect's own observation, or the user's word. */
  executionSource: CoachAction['executionSource'];
  observationKind: string | null;
  outcome: CoachAction['outcome'];
  reasonCode: CoachAction['reasonCode'];
  settledAt: string | null;
}

export type AdaptationKind = 'rejected_not_repeated' | 'failed_not_repeated' | 'worked_reused' | 'partly_refined' | 'external_not_penalised';

export interface AdaptationCheck {
  kind: AdaptationKind;
  pass: boolean;
  /** What the Coach did next: repeated, adapted, backed off, reused, refined… */
  behaviour: string;
  earlierActionId: string;
  earlierTitle: string;
  detail: string;
}

export interface CoachAssessment {
  opportunity: { strength: OpportunityStrength; reason: string; type: string | null; target: string | null };
  expectedPrimary: string | null;
  expectedSecondary: string | null;
  actual: string[];
  noActionReason: string | null;
  actions: ActionAssessment[];
  verdict: OpportunityVerdict;
  why: string;
  /** Every action known when the day was captured, as it stood then. */
  actionStates: ActionStateRecord[];
  adaptation: AdaptationCheck[];
}

export interface CoachDimensionContext {
  semantic: SemanticConfig;
  knownBlockIds: Set<string>;
  /** When the previous day was captured; earlier actions settled after it are "newly settled". */
  previousProcessedAt: string | null;
}

const GENERIC_VERBS = /^(focus|work|study|be|stay|keep|try|improve|manage|do|get)\b/i;

export function stateOf(action: CoachAction): ActionStateRecord {
  const decision: ActionStateRecord['decision'] =
    action.status === 'rejected' ? 'rejected' : action.acceptedAt ? 'accepted' : action.status === 'snoozed' || action.snoozeCount > 0 ? 'deferred' : 'undecided';
  return {
    id: action.id,
    title: action.title,
    originDayKey: action.originDayKey,
    actionType: action.actionType,
    strategyKey: action.strategyKey,
    targetKey: action.targetKey,
    parentActionId: action.parentActionId,
    status: action.status,
    decision,
    execution: action.execution,
    executionSource: action.executionSource,
    observationKind: action.observation?.kind ?? null,
    outcome: action.outcome,
    reasonCode: action.reasonCode,
    settledAt: action.outcomeAt ?? action.rejectedAt ?? action.closedAt ?? action.executedAt ?? null,
  };
}

function prohibitedRecommendations(items: string[]): string[] {
  return items
    .filter((item) => /^do not (immediately )?(recommend|add|start|keep|make|expand|continue)\b/i.test(item))
    .map((item) => item.replace(/^do not (immediately )?(recommend|add|start|keep|make|expand|continue)\b/i, '').replace(/\b(merely|simply|solely|just|only) because\b.*$/i, '').trim());
}

function assessAction(
  action: CoachAction,
  captured: CapturedDay,
  answer: EvaluationOnlyDay,
  ctx: CoachDimensionContext,
  strength: OpportunityStrength,
): ActionAssessment {
  const expected = answer.expectedCoachOutcome;
  const notes: string[] = [];
  const metricKeys = new Set(Object.keys(captured.reflection.report?.metricsSnapshot ?? {}));
  const text = actionText(action);

  // ── Which expected action does it answer? ──
  const primary = expected.primary_action ? matchExpected(expected.primary_action, action, captured.priorities) : null;
  const secondary = expected.secondary_action ? matchExpected(expected.secondary_action, action, captured.priorities) : null;
  const matches: ActionAssessment['matches'] = primary?.target ? 'primary' : secondary?.target ? 'secondary' : null;
  const fit = matches === 'primary' ? primary!.type : matches === 'secondary' ? secondary!.type : null;

  // ── Grounding ──
  const missingMetrics = action.sourceMetricKeys.filter((k) => !metricKeys.has(k));
  const missingActivities = action.sourceActivityIds.filter((id) => !ctx.knownBlockIds.has(id));
  const cites = action.sourceMetricKeys.length + action.sourceActivityIds.length > 0 || action.parentActionId !== null;
  const grounded = cites && action.rationale.trim().length >= 15 && missingMetrics.length === 0 && missingActivities.length === 0;
  if (!cites) notes.push('cites no metric, activity or earlier action');
  if (missingMetrics.length > 0) notes.push(`cites unknown metric(s): ${missingMetrics.join(', ')}`);
  if (missingActivities.length > 0) notes.push(`cites unknown activity id(s)`);

  // ── Alignment ──
  const threadPriority = action.thread ? captured.timeline.some((b) => b.thread === action.thread && b.priorityId !== null) : false;
  const aligned = action.priorityId !== null || threadPriority || matches !== null;
  if (!aligned) notes.push('not tied to a stated priority or to a thread linked to one');

  // ── Specificity / executability ──
  const titleWords = action.title.trim().split(/\s+/).length;
  const hasTarget = action.targetKey !== null || (action.focusTask ?? '').trim() !== '';
  const windowDays = action.targetStart && action.targetEnd ? (Date.parse(action.targetEnd) - Date.parse(action.targetStart)) / 86_400_000 : null;
  const hasTimeAnchor = action.daypart !== 'any' || action.focusMinutes !== null || (windowDays !== null && windowDays <= 1.01);
  const dayConcepts = conceptsOf(captured.timeline.map((b) => `${b.title} ${b.thread ?? ''}`).join(' '));
  const own = [...conceptsOf(text)].filter((c) => dayConcepts.has(c));
  const vagueTitle = titleWords < 4 || (GENERIC_VERBS.test(action.title) && titleWords < 6 && !hasTarget);
  const specific = hasTarget && hasTimeAnchor && !vagueTitle && own.length >= 1;
  if (!hasTarget) notes.push('names no target (priority, thread or task)');
  if (!hasTimeAnchor) notes.push('no time anchor (daypart, Focus length or a one-day window)');
  if (vagueTitle) notes.push('title is too vague to act on');
  if (own.length === 0) notes.push("does not refer to anything in the day's own activity");

  // ── Feasibility ──
  const reportAt = captured.reflection.report?.createdAt ?? captured.processedAt;
  const windowAhead = action.targetEnd !== null && Date.parse(action.targetEnd) > Date.parse(reportAt);
  const sizeOk = action.focusMinutes === null || action.focusMinutes <= 120;
  const expectedMinutes = (matches === 'secondary' ? expected.secondary_action : expected.primary_action)?.suggested_focus_minutes ?? null;
  const proportionate = action.focusMinutes === null || expectedMinutes === null || action.focusMinutes <= expectedMinutes * 2;
  const feasible = windowAhead && sizeOk && proportionate;
  if (!windowAhead) notes.push('its target window had already passed when it was suggested');
  if (!sizeOk) notes.push(`a ${action.focusMinutes}-minute block is more than one sitting`);
  if (!proportionate) notes.push(`asks for ${action.focusMinutes}m where the answer key sees about ${expectedMinutes}m as realistic`);

  // ── Generic / prohibited ──
  const lowered = normalizeText(text);
  const genericPhrases = GENERIC_ADVICE.filter((phrase) => lowered.includes(phrase));
  const generic = genericPhrases.length > 0 || (!hasTarget && !cites);
  if (genericPhrases.length > 0) notes.push(`generic phrasing: ${genericPhrases.join(', ')}`);
  const forbidden = prohibitedRecommendations(expected.things_not_to_do)
    .map((item) => ({ item, score: coverage(item, text).score }))
    .filter((f) => f.score >= ctx.semantic.passCoverage);
  const prohibited = forbidden.length > 0;
  if (prohibited) notes.push(`resembles a recommendation the answer key rules out: "${forbidden[0].item}"`);

  // The same sentence as a recent action: whatever happened to that one, saying it again adds nothing.
  const recentSince = Date.parse(action.createdAt) - 3 * 86_400_000;
  const twin = captured.coach.earlierActions.find((e) => e.status !== 'withdrawn' && Date.parse(e.createdAt) >= recentSince && e.targetKey === action.targetKey && sameTitle(e.title, action.title));
  const repeated = twin !== undefined;
  if (twin) notes.push(`says the same thing as "${twin.title}" suggested on ${twin.originDayKey}`);

  // On a strong day an action must answer one of the expected moves; on a moderate day any well-founded, aligned action is acceptable.
  const answersTheDay = strength === 'strong' ? matches !== null : strength === 'moderate' ? matches !== null || aligned : false;
  if (strength === 'none') notes.push('the day held no opportunity worth an action');
  else if (!answersTheDay) notes.push('aimed at something the day did not call for');

  return {
    actionId: action.id,
    title: action.title,
    actionType: action.actionType,
    strategyKey: action.strategyKey,
    targetKey: action.targetKey,
    matches,
    typeFit: fit,
    grounded,
    aligned,
    specific,
    feasible,
    generic,
    prohibited,
    repeated,
    justified: answersTheDay && grounded && !generic && !prohibited && !repeated,
    notes,
  };
}

// ── Adaptation ──────────────────────────────────────────────────────────────

export function sameTitle(a: string, b: string): boolean {
  return coverage(a, conceptsOf(b)).score >= DEFAULT_COACH_CONFIG.duplicateTitleOverlap && coverage(b, conceptsOf(a)).score >= DEFAULT_COACH_CONFIG.duplicateTitleOverlap;
}

/**
 * For every earlier action that was settled since the previous day — rejected,
 * reported as not working, as working, as partly working, or not done for a
 * reason outside the user's control — what did the Coach do next?
 */
function adaptationChecks(captured: CapturedDay, ctx: CoachDimensionContext): AdaptationCheck[] {
  const today = captured.coach.actions;
  const checks: AdaptationCheck[] = [];
  const since = ctx.previousProcessedAt;
  for (const earlier of captured.coach.earlierActions) {
    const state = stateOf(earlier);
    if (since === null || state.settledAt === null || state.settledAt <= since) continue;
    const onTarget = today.filter((a) => earlier.targetKey !== null && a.targetKey === earlier.targetKey);
    const unchanged = today.filter((a) => a.strategyKey === earlier.strategyKey && a.targetKey === earlier.targetKey);
    const alike = today.filter((a) => sameTitle(a.title, earlier.title));
    const base = { earlierActionId: earlier.id, earlierTitle: earlier.title };

    if (earlier.status === 'rejected') {
      const notRelevant = earlier.reasonCode === 'not_relevant';
      const repeats = [...new Set([...unchanged, ...alike, ...(notRelevant ? onTarget : [])])];
      checks.push({
        ...base,
        kind: 'rejected_not_repeated',
        pass: repeats.length === 0,
        behaviour: repeats.length > 0 ? 'repeated' : onTarget.length > 0 ? 'offered something different for the same target' : 'did not bring it back',
        detail:
          repeats.length > 0
            ? `rejected${earlier.reasonCode ? ` (${earlier.reasonCode})` : ''}, and today's "${repeats[0].title}" repeats it`
            : `rejected${earlier.reasonCode ? ` (${earlier.reasonCode})` : ''}; nothing today repeats it`,
      });
    } else if (earlier.execution === 'not_done' && earlier.reasonCode === 'external_constraint') {
      const blamed = /\b(failed|did not follow|didn't follow|ignored|neglected|skipped)\b/i.test((captured.reflection.report?.coach?.followups ?? []).map((f) => `${f.note} ${f.learned ?? ''}`).join(' '));
      checks.push({
        ...base,
        kind: 'external_not_penalised',
        pass: !blamed,
        behaviour: blamed ? 'described it as a failure' : onTarget.length > 0 ? 're-offered the next step' : 'left it open without blame',
        detail: blamed ? 'the follow-up words an external interruption as the user not following through' : 'not done for an external reason; the follow-up does not treat that as a failure',
      });
    } else if (earlier.outcome === 'did_not_work' || earlier.execution === 'not_done') {
      // When the stated reason was the timing, a change that keeps the time of day is not a change.
      const sameSlot = earlier.reasonCode === 'bad_timing' && earlier.daypart !== 'any' ? onTarget.filter((a) => a.daypart === earlier.daypart && !unchanged.includes(a)) : [];
      checks.push({
        ...base,
        kind: 'failed_not_repeated',
        pass: unchanged.length === 0 && sameSlot.length === 0,
        behaviour: unchanged.length > 0 ? 'repeated unchanged' : sameSlot.length > 0 ? 'kept the timing that failed' : onTarget.length > 0 ? 'changed the strategy' : 'backed off',
        detail:
          sameSlot.length > 0 && unchanged.length === 0
            ? `"${earlier.title}" did not work because of bad timing, and today's "${sameSlot[0].title}" is again in the ${earlier.daypart}`
            : unchanged.length > 0
            ? `"${earlier.title}" ${earlier.outcome === 'did_not_work' ? 'did not work' : 'was not done'}, and today's "${unchanged[0].title}" is the same strategy for the same target`
            : onTarget.length > 0
              ? `after "${earlier.title}" ${earlier.outcome === 'did_not_work' ? 'did not work' : 'was not done'}, today's "${onTarget[0].title}" uses ${onTarget[0].strategyKey} instead of ${earlier.strategyKey}`
              : `after "${earlier.title}" ${earlier.outcome === 'did_not_work' ? 'did not work' : 'was not done'}, nothing was recommended for that target`,
      });
    } else if (earlier.outcome === 'worked') {
      // Only a day that offers something for the same target says anything about reuse.
      if (onTarget.length === 0) continue;
      const reused = onTarget.filter((a) => a.actionType === earlier.actionType || a.actionType === 'continue_behavior');
      checks.push({
        ...base,
        kind: 'worked_reused',
        pass: reused.length > 0,
        behaviour: reused.length > 0 ? 'reused what worked' : 'switched approach',
        detail:
          reused.length > 0
            ? `"${earlier.title}" worked; today's "${reused[0].title}" builds on it (${reused[0].actionType})`
            : `"${earlier.title}" worked, yet today's "${onTarget[0].title}" is a different kind of action (${onTarget[0].actionType})`,
      });
    } else if (earlier.outcome === 'partly_worked') {
      if (onTarget.length === 0) continue;
      const refined = onTarget.filter((a) => a.strategyKey !== earlier.strategyKey || a.parentActionId === earlier.id);
      checks.push({
        ...base,
        kind: 'partly_refined',
        pass: refined.length > 0,
        behaviour: refined.length > 0 ? 'refined it' : 'repeated unchanged',
        detail:
          refined.length > 0
            ? `"${earlier.title}" partly worked; today's "${refined[0].title}" changes it (${earlier.strategyKey} → ${refined[0].strategyKey})`
            : `"${earlier.title}" partly worked and was offered again exactly as before`,
      });
    }
  }
  return checks;
}

// ── The day ─────────────────────────────────────────────────────────────────

const describeExpected = (a: DatasetExpectedAction | null) => (a ? `[${a.action_type} → ${a.target ?? 'general'}] ${a.title} — ${a.reason}` : null);

export function assessCoach(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: CoachDimensionContext): CoachAssessment {
  const expected = answer.expectedCoachOutcome;
  const opportunity = opportunityOf(expected);
  const report = captured.reflection.report;
  const actions = captured.coach.actions.map((a) => assessAction(a, captured, answer, ctx, opportunity.strength));
  const noActionReason = report?.coach?.noActionReason ?? null;

  let verdict: OpportunityVerdict;
  let why: string;
  const primaryHit = actions.find((a) => a.matches === 'primary' && a.justified);
  const secondaryHit = actions.find((a) => a.matches === 'secondary' && a.justified);
  const firstProblem = actions.find((a) => !a.justified);

  if (!report) {
    verdict = 'no_report';
    why = 'no daily report was written, so nothing was recommended either way';
  } else if (opportunity.strength === 'none') {
    verdict = actions.length === 0 ? 'correct_null' : 'unnecessary';
    why =
      actions.length === 0
        ? `nothing was recommended${noActionReason ? ` ("${noActionReason}")` : ''} — ${opportunity.reason}`
        : `${actions.length} action(s) on a day that called for none — ${opportunity.reason}`;
  } else if (actions.length === 0) {
    verdict = opportunity.strength === 'strong' ? 'missed' : 'acceptable_null';
    why = `nothing was recommended${noActionReason ? ` ("${noActionReason}")` : ''}; ${opportunity.strength === 'strong' ? 'the day held a clear next move' : 'an action was optional here'} — ${opportunity.reason}`;
  } else if (primaryHit) {
    verdict = primaryHit.typeFit !== 'different' ? 'correct' : 'partially_correct';
    why =
      `"${primaryHit.title}" is aimed at the expected target` +
      (primaryHit.typeFit === 'exact' ? ' with the expected kind of action' : primaryHit.typeFit === 'compatible' ? ' with a compatible kind of action' : `, as ${primaryHit.actionType} where ${expected.primary_action?.action_type} was expected`) +
      (primaryHit.specific ? '' : '; it is not specific enough to act on') +
      (firstProblem ? `; "${firstProblem.title}" does not hold up (${firstProblem.notes[0] ?? 'unjustified'})` : '');
  } else if (secondaryHit) {
    verdict = 'partially_correct';
    why = `"${secondaryHit.title}" addresses the secondary opportunity; the primary one (${expected.primary_action?.target}) was not addressed`;
  } else if (opportunity.strength === 'moderate' && actions.some((a) => a.justified)) {
    verdict = 'partially_correct';
    why = `an action was optional; "${actions.find((a) => a.justified)!.title}" is well-founded but not what the answer key had in mind`;
  } else {
    const matched = actions.find((a) => a.matches !== null);
    verdict = opportunity.strength === 'moderate' ? 'unnecessary' : 'wrong';
    why = matched
      ? `"${matched.title}" is aimed at the right target but does not hold up: ${matched.notes.join('; ') || 'unjustified'}`
      : `"${actions[0].title}" is not aimed at what the day called for (${expected.primary_action?.target ?? 'no target'}): ${actions[0].notes.join('; ') || 'unrelated'}`;
  }

  return {
    opportunity: { strength: opportunity.strength, reason: opportunity.reason, type: opportunity.type, target: opportunity.priority },
    expectedPrimary: describeExpected(expected.primary_action),
    expectedSecondary: describeExpected(expected.secondary_action),
    actual: captured.coach.actions.map((a) => `[${a.actionType} → ${a.targetKey ?? 'general'}] ${a.title} — ${a.rationale}`),
    noActionReason,
    actions,
    verdict,
    why,
    actionStates: [...captured.coach.earlierActions, ...captured.coach.actions].map(stateOf),
    adaptation: adaptationChecks(captured, ctx),
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface Ratio {
  /** null when nothing applied. */
  value: number | null;
  numerator: number;
  denominator: number;
}

const ratio = (numerator: number, denominator: number): Ratio => ({ value: denominator > 0 ? numerator / denominator : null, numerator, denominator });

export interface CoachDimensionSummary {
  daysEvaluated: number;
  daysExpectedAction: number;
  daysOptionalAction: number;
  daysExpectedNull: number;
  daysWithActions: number;
  actionsGenerated: number;

  // ── 1. Was the recommendation right? ──
  /** Strong-opportunity days answered: correct = 1, partially correct = ½. */
  opportunityRecall: Ratio;
  /** Strong-opportunity days on which anything at all was recommended. */
  opportunityDetection: Ratio;
  /** Actions that were justified, of all actions generated. */
  actionPrecision: Ratio;
  actionAlignment: Ratio;
  actionSpecificity: Ratio;
  evidenceGrounding: Ratio;
  feasibility: Ratio;
  nonGeneric: Ratio;
  /** Actions that do not restate an action of the previous few days. */
  notRepeated: Ratio;
  /** No-opportunity days on which nothing was recommended. */
  appropriateNull: Ratio;
  verdicts: Record<OpportunityVerdict, number>;

  // ── 2. Did the user follow it? ──
  lifecycle: {
    suggested: number;
    accepted: number;
    rejected: number;
    deferred: number;
    undecided: number;
    done: number;
    partial: number;
    notDone: number;
    executionUnknown: number;
    observedByReflect: number;
    statedByUser: number;
    worked: number;
    partlyWorked: number;
    didNotWork: number;
    notApplicable: number;
  };
  /** Accepted actions whose window has passed for which the record says whether they happened. */
  executionTracking: Ratio;
  /** …and of those, how many Reflect established from its own data, before anyone said so. */
  executionObserved: Ratio;

  // ── 3. Did it help? ──
  /** Carried-out actions for which the record holds an outcome. */
  outcomeTracking: Ratio;

  // ── 4. Did the Coach adapt? ──
  adaptation: { checks: number; passed: number; byKind: Record<string, { checks: number; passed: number; behaviours: Record<string, number> }> };
}

const SETTLED: CoachAction['status'][] = ['review', 'closed'];

export function summarizeCoachDimensions(days: CoachAssessment[], finalStates: ActionStateRecord[] = []): CoachDimensionSummary {
  const strong = days.filter((d) => d.opportunity.strength === 'strong');
  const none = days.filter((d) => d.opportunity.strength === 'none');
  const actions = days.flatMap((d) => d.actions);
  const count = (pick: (a: ActionAssessment) => boolean) => actions.filter(pick).length;

  const verdicts: Record<OpportunityVerdict, number> = { correct: 0, partially_correct: 0, wrong: 0, unnecessary: 0, missed: 0, correct_null: 0, acceptable_null: 0, no_report: 0 };
  for (const day of days) verdicts[day.verdict]++;

  // The latest known state of every action: the run's closing snapshot when there is one, otherwise the last capture that saw it.
  const latest = new Map<string, ActionStateRecord>();
  for (const day of days) for (const state of day.actionStates) latest.set(state.id, state);
  for (const state of finalStates) latest.set(state.id, state);
  const states = [...latest.values()].filter((s) => s.status !== 'withdrawn');

  const accepted = states.filter((s) => s.decision === 'accepted');
  const windowPassed = accepted.filter((s) => SETTLED.includes(s.status));
  const executionKnown = windowPassed.filter((s) => s.execution !== null);
  const carriedOut = states.filter((s) => s.execution === 'done' || s.execution === 'partial');

  const checks = days.flatMap((d) => d.adaptation);
  const byKind: CoachDimensionSummary['adaptation']['byKind'] = {};
  for (const check of checks) {
    const entry = (byKind[check.kind] ??= { checks: 0, passed: 0, behaviours: {} });
    entry.checks++;
    if (check.pass) entry.passed++;
    entry.behaviours[check.behaviour] = (entry.behaviours[check.behaviour] ?? 0) + 1;
  }

  return {
    daysEvaluated: days.length,
    daysExpectedAction: strong.length,
    daysOptionalAction: days.filter((d) => d.opportunity.strength === 'moderate').length,
    daysExpectedNull: none.length,
    daysWithActions: days.filter((d) => d.actions.length > 0).length,
    actionsGenerated: actions.length,
    opportunityRecall: ratio(strong.reduce((sum, d) => sum + (d.verdict === 'correct' ? 1 : d.verdict === 'partially_correct' ? 0.5 : 0), 0), strong.length),
    opportunityDetection: ratio(strong.filter((d) => d.actions.length > 0).length, strong.length),
    actionPrecision: ratio(count((a) => a.justified), actions.length),
    actionAlignment: ratio(count((a) => a.aligned), actions.length),
    actionSpecificity: ratio(count((a) => a.specific), actions.length),
    evidenceGrounding: ratio(count((a) => a.grounded), actions.length),
    feasibility: ratio(count((a) => a.feasible), actions.length),
    nonGeneric: ratio(count((a) => !a.generic), actions.length),
    notRepeated: ratio(count((a) => !a.repeated), actions.length),
    appropriateNull: ratio(none.filter((d) => d.verdict === 'correct_null').length, none.length),
    verdicts,
    lifecycle: {
      suggested: states.length,
      accepted: accepted.length,
      rejected: states.filter((s) => s.decision === 'rejected').length,
      deferred: states.filter((s) => s.decision === 'deferred').length,
      undecided: states.filter((s) => s.decision === 'undecided').length,
      done: states.filter((s) => s.execution === 'done').length,
      partial: states.filter((s) => s.execution === 'partial').length,
      notDone: states.filter((s) => s.execution === 'not_done').length,
      executionUnknown: windowPassed.length - executionKnown.length,
      observedByReflect: states.filter((s) => s.execution !== null && s.executionSource === 'observed').length,
      statedByUser: states.filter((s) => s.execution !== null && s.executionSource === 'user').length,
      worked: states.filter((s) => s.outcome === 'worked').length,
      partlyWorked: states.filter((s) => s.outcome === 'partly_worked').length,
      didNotWork: states.filter((s) => s.outcome === 'did_not_work').length,
      notApplicable: states.filter((s) => s.outcome === 'not_applicable').length,
    },
    executionTracking: ratio(executionKnown.length, windowPassed.length),
    executionObserved: ratio(executionKnown.filter((s) => s.executionSource === 'observed').length, executionKnown.length),
    outcomeTracking: ratio(carriedOut.filter((s) => s.outcome !== null).length, carriedOut.length),
    adaptation: { checks: checks.length, passed: checks.filter((c) => c.pass).length, byKind },
  };
}
