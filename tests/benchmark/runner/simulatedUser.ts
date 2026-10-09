import { randomUUID } from 'node:crypto';
import { daypartWindow, strategyKeyOf, targetKeyOf } from '../../../src/coach/CoachMatching';
import type { CoachAction, CoachActionType, CoachDaypart, CoachReasonCode } from '../../../src/coach/CoachModels';
import { COACH_ACTION_TYPES, COACH_DAYPARTS, COACH_REASON_CODES } from '../../../src/coach/CoachModels';
import { periodContaining, shiftPeriod } from '../../../src/reflection/ReflectionPeriods';
import { matchExpected } from '../evaluators/coachDimensions';
import { aimOfAction, type StreamContext } from '../evaluators/streams';
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

/**
 * Seeded history: a recommendation that was on the user's Coach panel since
 * the evening before, and their answer to it. The action is stored through the
 * Coach's own repository exactly as the daily pass stores one; everything that
 * then happens to it — the decision, Reflect's own observation, "I did it",
 * "it didn't help" — goes through the same service calls the Coach panel makes.
 * Nothing about what the Coach SHOULD do next is passed along.
 */
export async function seedHistory(runtime: BenchmarkRuntime, answer: EvaluationOnlyDay, now: Date, priorities: { id: string; text: string }[]): Promise<FollowThroughRecord[]> {
  const records: FollowThroughRecord[] = [];
  const today = periodContaining('day', now);
  const yesterday = shiftPeriod(today, -1);
  for (const seed of answer.coachHistory) {
    const priority = priorities.find((p) => p.text === seed.priority);
    const actionType = (COACH_ACTION_TYPES as readonly string[]).includes(seed.action_type) ? (seed.action_type as CoachActionType) : 'focus_session';
    const daypart = (COACH_DAYPARTS as readonly string[]).includes(seed.daypart) ? (seed.daypart as CoachDaypart) : 'any';
    const window = daypartWindow(today, daypart);
    // Suggested at 10 PM the evening before, for today.
    const suggestedAt = new Date(Date.parse(yesterday.end) - 2 * 3_600_000).toISOString();
    const shape = { actionType, daypart, focusMinutes: seed.focus_minutes };
    const action: CoachAction = {
      id: randomUUID(),
      source: 'daily',
      reportId: null,
      originDayKey: yesterday.key,
      parentActionId: null,
      title: seed.title,
      description: null,
      rationale: 'Suggested the evening before.',
      actionType,
      daypart,
      targetStart: window.start,
      targetEnd: window.end,
      focusMinutes: seed.focus_minutes,
      focusTask: seed.focus_minutes ? seed.title : null,
      priorityId: priority?.id ?? null,
      thread: null,
      strategyKey: strategyKeyOf(shape),
      targetKey: targetKeyOf({ priorityId: priority?.id ?? null, thread: null }),
      evidence: [],
      sourceMetricKeys: [],
      sourceActivityIds: [],
      confidence: 0.8,
      status: 'suggested',
      execution: null,
      executionSource: null,
      outcome: null,
      reasonCode: null,
      note: null,
      observation: null,
      linkedFocusSessionId: null,
      snoozedUntil: null,
      snoozeCount: 0,
      userEdited: false,
      createdAt: suggestedAt,
      acceptedAt: null,
      rejectedAt: null,
      executedAt: null,
      outcomeAt: null,
      closedAt: null,
      updatedAt: suggestedAt,
    };
    runtime.coachRepo.insertAction(action);
    runtime.coachRepo.insertActionEvent({ id: randomUUID(), actionId: action.id, type: 'suggested', fromStatus: null, toStatus: 'suggested', detail: { seeded: true }, createdAt: suggestedAt });

    if (seed.user_decision === 'rejected') runtime.coachService.decide(action.id, 'reject', { reasonCode: reasonOf(seed.reason_code) });
    else if (seed.user_decision === 'deferred') runtime.coachService.decide(action.id, 'not_now');
    else runtime.coachService.decide(action.id, 'accept');
    await runtime.coachService.observe();
    if (seed.user_decision !== 'accepted') continue;

    const record = await followThrough(runtime, {
      dayNumber: answer.dayNumber - 1,
      actionId: action.id,
      scenario: { user_decision: 'accepted', execution: seed.execution, outcome: seed.outcome, reason: 'seeded history', reason_code: seed.reason_code ?? null },
    });
    if (record) records.push(record);
  }
  return records;
}

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
function pickAction(actions: CoachAction[], answer: EvaluationOnlyDay, priorities: { id: string; text: string }[], streams: StreamContext | null): CoachAction | null {
  const open = actions.filter((a) => a.status === 'suggested');
  if (open.length === 0) return null;
  const expected = answer.expectedCoachOutcome.primary_action;
  if (!expected) return [...open].sort((a, b) => b.confidence - a.confidence)[0];
  const rank = (a: CoachAction) => matchExpected(expected, a, priorities, streams ? aimOfAction(a, priorities, streams) : null).rank;
  return [...open].sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence)[0];
}

/**
 * What the user does with THIS recommendation. Where the answer key says how each body of work fared the next day
 * (`response_by_stream`), the response is the one for the work the action is actually aimed at — an action that
 * points somewhere the user did not go is declined or left undone, whatever the day's expected move was. Without
 * that table, the day's single `execution_scenario` applies to whichever action was picked.
 */
function scenarioFor(action: CoachAction, answer: EvaluationOnlyDay, priorities: { id: string; text: string }[], streams: StreamContext | null): DatasetExecutionScenario | null {
  const expected = answer.expectedCoachOutcome;
  if (expected.response_by_stream && streams) {
    const aim = aimOfAction(action, priorities, streams);
    const key = aim.streams.find((stream) => expected.response_by_stream![stream] !== undefined);
    // An action about nothing the user has as work gets no answer: it is simply left on the panel.
    return key ? expected.response_by_stream[key] : null;
  }
  return expected.execution_scenario ?? null;
}

/** Evening of day N: accept, reject or postpone. Returns what to follow up tomorrow, if anything. */
export async function decideOnDay(
  runtime: BenchmarkRuntime,
  dayNumber: number,
  actions: CoachAction[],
  answer: EvaluationOnlyDay,
  priorities: { id: string; text: string }[],
  streams: StreamContext | null = null,
): Promise<PendingFollowThrough | null> {
  const action = pickAction(actions, answer, priorities, streams);
  if (!action) return null;
  const scenario = scenarioFor(action, answer, priorities, streams);
  if (!scenario || scenario.user_decision === 'not_applicable') return null;

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
