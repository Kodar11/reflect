import type { CoachAction, CoachReasonCode } from '../../../src/coach/CoachModels';
import { COACH_REASON_CODES } from '../../../src/coach/CoachModels';
import { matchExpected } from '../evaluators/coachDimensions';
import type { DatasetExecutionScenario, EvaluationOnlyDay } from './dataset';
import type { BenchmarkRuntime } from './runtime';

/**
 * The simulated user: the person who reads the day's recommendation and then
 * lives the next day.
 *
 * This is the one place under `runner/` that reads the answer key, and it is
 * allowed to because it plays the USER, not Reflect: a real user knows what
 * they decided, whether they did it and whether it helped. What crosses to
 * Reflect is exactly what a real user can give it — the buttons of the Coach
 * panel (`decide`, `reportExecution`, `reportOutcome`) and one of the reasons
 * on its list. No sentence of the answer key is passed along.
 *
 * Deciding, doing and "did it help" stay three separate statements, made at
 * three separate moments:
 *
 *   evening of day N      the decision on that day's recommendation
 *   during day N+1        Reflect looks for the action in tracked activity
 *                         first; the user then says whether it happened (when
 *                         Reflect could not tell, or was wrong) and whether it
 *                         helped — before that evening's reflection is written.
 */

export interface PendingFollowThrough {
  dayNumber: number;
  actionId: string;
  scenario: DatasetExecutionScenario;
}

export interface FollowThroughRecord {
  dayNumber: number;
  actionId: string;
  title: string;
  decision: DatasetExecutionScenario['user_decision'];
  /** What Reflect established on its own before the user said anything. */
  observedBefore: { kind: string | null; execution: CoachAction['execution'] };
  /** What the user then told it. */
  statedExecution: DatasetExecutionScenario['execution'] | null;
  statedOutcome: DatasetExecutionScenario['outcome'] | null;
  /** The action as the record holds it afterwards. */
  after: Pick<CoachAction, 'status' | 'execution' | 'executionSource' | 'outcome' | 'reasonCode'>;
}

const reasonOf = (code: string | null | undefined): CoachReasonCode | null =>
  code && (COACH_REASON_CODES as readonly string[]).includes(code) ? (code as CoachReasonCode) : null;

/** The recommendation the day's scenario is about: the one that best answers the expected action, else the Coach's own first choice. */
function pickAction(actions: CoachAction[], answer: EvaluationOnlyDay, priorities: { id: string; text: string }[]): CoachAction | null {
  const open = actions.filter((a) => a.status === 'suggested');
  if (open.length === 0) return null;
  const expected = answer.expectedCoachOutcome.primary_action;
  if (!expected) return [...open].sort((a, b) => b.confidence - a.confidence)[0];
  return [...open].sort((a, b) => matchExpected(expected, b, priorities).rank - matchExpected(expected, a, priorities).rank || b.confidence - a.confidence)[0];
}

/** Evening of day N: accept, reject or postpone. Returns what to follow up tomorrow, if anything. */
export async function decideOnDay(
  runtime: BenchmarkRuntime,
  dayNumber: number,
  actions: CoachAction[],
  answer: EvaluationOnlyDay,
  priorities: { id: string; text: string }[],
): Promise<PendingFollowThrough | null> {
  const scenario = answer.expectedCoachOutcome.execution_scenario;
  if (!scenario || scenario.user_decision === 'not_applicable') return null;
  const action = pickAction(actions, answer, priorities);
  if (!action) return null;

  if (scenario.user_decision === 'accepted') runtime.coachService.decide(action.id, 'accept');
  else if (scenario.user_decision === 'rejected') runtime.coachService.decide(action.id, 'reject', { reasonCode: reasonOf(scenario.reason_code) });
  else runtime.coachService.decide(action.id, 'not_now');
  // `decide` starts an observation sweep without waiting for it; let it settle.
  await runtime.coachService.observe();
  return scenario.user_decision === 'accepted' ? { dayNumber, actionId: action.id, scenario } : null;
}

/**
 * During day N+1, after its activity has been reconstructed and before the
 * evening reflection: Reflect observes; the user then fills in what it could
 * not see.
 */
export async function followThrough(runtime: BenchmarkRuntime, pending: PendingFollowThrough): Promise<FollowThroughRecord | null> {
  await runtime.coachService.observe();
  const before = runtime.coachRepo.getAction(pending.actionId);
  if (!before) return null;
  const { scenario } = pending;
  const observedBefore = { kind: before.observation?.kind ?? null, execution: before.execution };

  let statedExecution: FollowThroughRecord['statedExecution'] = null;
  if (scenario.execution !== 'not_applicable' && before.execution !== scenario.execution) {
    // Reflect did not see it, or saw it differently: the user's word settles it.
    const result = runtime.coachService.reportExecution(pending.actionId, scenario.execution, {
      reasonCode: scenario.execution === 'not_done' ? reasonOf(scenario.reason_code) : null,
    });
    if (result.ok) statedExecution = scenario.execution;
  }
  let statedOutcome: FollowThroughRecord['statedOutcome'] = null;
  if (scenario.outcome !== 'not_applicable') {
    const result = runtime.coachService.reportOutcome(pending.actionId, scenario.outcome, {
      reasonCode: scenario.outcome === 'did_not_work' ? reasonOf(scenario.reason_code) : null,
    });
    if (result.ok) statedOutcome = scenario.outcome;
  }

  const after = runtime.coachRepo.getAction(pending.actionId)!;
  return {
    dayNumber: pending.dayNumber,
    actionId: pending.actionId,
    title: after.title,
    decision: scenario.user_decision,
    observedBefore,
    statedExecution,
    statedOutcome,
    after: { status: after.status, execution: after.execution, executionSource: after.executionSource, outcome: after.outcome, reasonCode: after.reasonCode },
  };
}
