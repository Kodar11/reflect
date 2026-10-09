import { describe, it, expect } from 'vitest';
import { buildCoachContext, renderCoachSection, type CoachContext } from '../../src/coach/CoachContext';
import { isBlocked, signalOf, summarizeEffectiveness } from '../../src/coach/CoachEffectiveness';
import { DEFAULT_COACH_CONFIG, type CoachAction, type CoachMemory } from '../../src/coach/CoachModels';
import type { CoachOpportunity } from '../../src/coach/CoachOpportunities';
import { isVagueTitle, validateDailyCoach } from '../../src/coach/CoachValidator';
import type { MetricSet } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { createEvidenceToolkit } from '../../src/reflection/ReflectionValidator';
import { iso, local, makeReflectionHarness, projectX, seedThreads, workday } from '../reflection/helpers';
import { coachAction, modelAction, modelCoach, modelDay, notDone, worked } from './helpers';

/**
 * The action-vs-null decision, and what the record does to it.
 *
 * The policy is: an action when a concrete next move is supported; nothing
 * when none is — never an action to fill a quota, never silence because the
 * day was "generally fine". These tests hold both halves, at the validator
 * (what Reflect accepts from the model) and through the whole daily pass
 * (prompt → response → validation → coach_actions → next day's prompt).
 */

const NOW = local(12, '22:05');
const day = periodContaining('day', local(12));
const PRIORITIES = [{ id: 'pr-1', text: 'Launching Project X' }];

const metrics: MetricSet = {
  'thread.project-x.minutes': { key: 'thread.project-x.minutes', label: 'Time on “Project X”', value: 172, unit: 'minutes', display: '2h 52m', group: 'thread', thread: 'Project X' },
  'priority.pr-1.minutes': { key: 'priority.pr-1.minutes', label: 'Time linked to the priority “Launching Project X”', value: 172, unit: 'minutes', display: '2h 52m', group: 'priority', priorityId: 'pr-1' },
};
const morningBlock = projectX(12, '09:00', 80);
const evidence = createEvidenceToolkit({ metrics, activityByRef: new Map([['a1', morningBlock]]), priorities: PRIORITIES, periodLabel: 'Today Mon, Oct 12' });

function context(options: { actions?: CoachAction[]; memories?: CoachMemory[]; opportunities?: CoachOpportunity[]; now?: Date } = {}): CoachContext {
  return buildCoachContext({
    now: options.now ?? NOW,
    reportDay: day,
    actions: options.actions ?? [],
    memories: options.memories ?? [],
    messages: [],
    priorities: PRIORITIES,
    knownThreads: ['Project X', 'Project Y'],
    config: DEFAULT_COACH_CONFIG,
    opportunities: options.opportunities ?? [],
    activityRefOf: (id) => (id === morningBlock.id ? 'a1' : null),
  });
}
const daily = (raw: unknown, ctx: CoachContext = context()) => validateDailyCoach({ raw, context: ctx, evidence });
const decision = (verdict: string, candidate = 'none') => ({ matters: 'Launching Project X', moved: 'the sync engine', open: 'nothing visible', displaced: 'none', tried: 'nothing yet', candidate, verdict });

// ── The decision itself ─────────────────────────────────────────────────────

describe('the action-vs-null decision', () => {
  it('"no useful move" is a complete answer, with its real reason kept', () => {
    const result = daily(modelCoach({ decision: decision('no_useful_move'), actions: [], noActionReason: 'Nothing was left mid-way and no priority was displaced.' }));
    expect(result).toMatchObject({ ok: true, errors: [], proposed: 0, decision: { verdict: 'no_useful_move', candidate: 'none' } });
    expect(result.coach).toMatchObject({ actions: [], noActionReason: 'Nothing was left mid-way and no priority was displaced.' });
  });

  it('an action that follows from the decision is accepted as it is', () => {
    const result = daily(modelCoach({ decision: decision('act', 'One Focus session on Project X') }));
    expect(result).toMatchObject({ ok: true, proposed: 1, decision: { verdict: 'act', candidate: 'One Focus session on Project X' } });
    expect(result.coach.actions).toHaveLength(1);
  });

  it('holds the model to its own conclusion: "act" with no action is sent back', () => {
    const result = daily(modelCoach({ decision: decision('act', 'Finish the sync engine tests'), actions: [], noActionReason: null }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('the verdict is "act" (candidate: “Finish the sync engine tests”) but no action was returned');
    // Nothing is invented on the model's behalf: the valid subset is still "no action".
    expect(result.coach.actions).toEqual([]);
  });

  it('never demands an action: a "no useful move" verdict stands whatever signals were raised', () => {
    const signal: CoachOpportunity = { kind: 'left_off', strength: 'clear', priorityId: 'pr-1', thread: 'Project X', summary: 'Work last stood at “Implement Project X sync engine”.', metricKeys: ['priority.pr-1.minutes'], activityIds: [morningBlock.id], fits: ['close_open_loop'] };
    const result = daily(modelCoach({ decision: decision('no_useful_move'), actions: [], noActionReason: 'The sync engine work is continuing on its own schedule.' }), context({ opportunities: [signal] }));
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.coach.actions).toEqual([]);
  });

  it('a response written without a decision (an older shape) is still validated', () => {
    const result = daily(modelCoach());
    expect(result).toMatchObject({ ok: true, decision: null });
    expect(result.coach.actions).toHaveLength(1);
  });
});

// ── The quality contract ────────────────────────────────────────────────────

describe('what counts as an action', () => {
  const rejected = (overrides: Record<string, unknown>) => daily(modelCoach({ actions: [modelAction(overrides)] })).errors.join(' | ');

  it('refuses advice that would fit anyone on any day', () => {
    for (const title of ['Study more.', 'Focus better', 'Work on your goals', 'Be more consistent', 'Stay focused', 'Keep going', 'Manage your time better']) {
      expect(isVagueTitle(title), title).toBe(true);
      expect(rejected({ title }), title).toContain('title is too vague to act on');
    }
    for (const title of ['Finish the staging check of the client settings change', 'Continue the onboarding fix in one 90-minute block', 'Keep the first block for the sync engine tests']) {
      expect(isVagueTitle(title), title).toBe(false);
    }
  });

  it('an action must be aimed at something — unless it is about the day as a whole', () => {
    const untargeted = { priorityId: null, thread: null, focusTask: null, focusMinutes: null };
    expect(rejected({ ...untargeted, actionType: 'protect_priority', title: 'Protect a block before the afternoon starts' })).toContain('a protect_priority action must say what it is aimed at');
    expect(rejected({ ...untargeted, actionType: 'close_open_loop', title: 'Close the thing that was left open' })).toContain('a close_open_loop action must say what it is aimed at');
    // Rest and fewer switches concern the day, not a target.
    for (const actionType of ['rest', 'reduce_fragmentation']) {
      const result = daily(modelCoach({ actions: [modelAction({ ...untargeted, actionType, title: 'Stop after the afternoon block and leave the evening free' })] }));
      expect(result.coach.actions, actionType).toHaveLength(1);
    }
  });

  it('an action without evidence is not an action', () => {
    expect(rejected({ metricKeys: [], activityRefs: [], actionRefs: [] })).toContain('cites no evidence');
    expect(rejected({ metricKeys: ['thread.made-up.minutes'] })).toContain('metric "thread.made-up.minutes" does not exist');
    expect(rejected({ rationale: 'Because.' })).toContain('rationale is missing');
  });

  it('ties an action to the stated priority it serves, and refuses a priority that does not exist', () => {
    const result = daily(modelCoach({ actions: [modelAction({ priorityId: 'pr-1', thread: null })] }));
    expect(result.coach.actions[0]).toMatchObject({ priorityId: 'pr-1', targetKey: 'p:pr-1' });
    expect(result.coach.actions[0].evidence.some((e) => e.kind === 'priority' || e.priorityId === 'pr-1')).toBe(true);
    expect(rejected({ priorityId: 'pr-ghost' })).toContain('priority "pr-ghost" does not exist');
  });

  it('keeps an open loop out of memory when today\'s action already tracks it', () => {
    const result = daily(
      modelCoach({
        actions: [modelAction({ title: 'Finish the Project X sync engine conflict tests', focusTask: 'Project X sync engine conflict tests' })],
        memoryUpdates: [
          { op: 'add', kind: 'open_loop', text: 'Project X sync engine conflict tests were in progress.', memoryRef: null, metricKeys: ['thread.project-x.minutes'], activityRefs: [], actionRefs: [] },
          { op: 'add', kind: 'open_loop', text: 'The Project Y billing fix was started and left without a decision.', memoryRef: null, metricKeys: ['thread.project-x.minutes'], activityRefs: [], actionRefs: [] },
        ],
      }),
    );
    expect(result.coach.memoryAdds.map((m) => m.text)).toEqual(['The Project Y billing fix was started and left without a decision.']);
  });

  it('survives malformed output without throwing, and keeps nothing from it', () => {
    for (const raw of [undefined, null, 'garbage', 42, { actions: 'many' }, { actions: [{ title: 7 }] }]) {
      const result = daily(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      expect(result.coach.actions).toEqual([]);
      expect(result.decision).toBeNull();
    }
  });
});

// ── What the record does to the decision ────────────────────────────────────

describe('learning from what happened', () => {
  const repeat = modelCoach({ actions: [modelAction({ actionRefs: [], metricKeys: ['thread.project-x.minutes'] })] });
  const closedAt = (dayOfMonth: number) => ({ closedAt: iso(dayOfMonth, '21:00'), updatedAt: iso(dayOfMonth, '21:00') });

  it('previous rejection: the same suggestion does not come back, and "not relevant" closes the whole target', () => {
    const turnedDown = coachAction({ status: 'rejected', rejectedAt: iso(11, '22:10'), reasonCode: 'not_relevant', ...closedAt(11) });
    const ctx = context({ actions: [turnedDown] });
    expect(daily(repeat, ctx).errors[0]).toContain('the user rejected this');
    // A different strategy, in different words, for the same target — still refused.
    const reworded = modelCoach({ actions: [modelAction({ title: 'Close the Project X conflict-resolution branch this evening', actionType: 'close_open_loop', daypart: 'evening', focusMinutes: null, focusTask: null })] });
    expect(daily(reworded, ctx).errors[0]).toContain('the user rejected this');
    expect(daily(reworded, ctx).coach.actions).toEqual([]);
    expect(renderCoachSection(ctx)).toContain('REJECTED BY THE USER (never bring these back, in any wording)');
  });

  it('previous failure: once the user says it did not help, the same form is refused — a changed one is not', () => {
    const failed = worked(10, { outcome: 'did_not_work', reasonCode: 'bad_timing' });
    const ctx = context({ actions: [failed] });
    expect(ctx.failedRecently.map((a) => a.id)).toEqual([failed.id]);
    const again = daily(repeat, ctx);
    expect(again.coach.actions).toEqual([]);
    expect(again.errors[0]).toContain('did not work (bad timing)');
    expect(again.errors[0]).toContain('change the time of day, the size or the type, or leave it');

    const adapted = daily(
      modelCoach({
        actions: [modelAction({ title: 'Run a 25-minute Focus session on Project X after lunch', daypart: 'afternoon', focusMinutes: 25, adaptsActionRef: 'k1', metricKeys: [], rationale: 'The morning block did not help; this moves it later and makes it smaller.' })],
      }),
      ctx,
    );
    expect(adapted).toMatchObject({ ok: true });
    expect(adapted.coach.actions[0]).toMatchObject({ strategyKey: 'focus_session|afternoon|short', parentActionId: failed.id });
    expect(renderCoachSection(ctx)).toContain('The user said it DID NOT HELP — do not offer it again unchanged');
  });

  it('a "bad timing" failure is about the time of day: another kind of action in the same slot is refused too', () => {
    const mistimed = worked(10, { outcome: 'did_not_work', reasonCode: 'bad_timing' }); // a morning Focus session
    const ctx = context({ actions: [mistimed] });
    const sameSlot = daily(
      modelCoach({ actions: [modelAction({ title: 'Keep the first hour of the morning for Project X', actionType: 'protect_priority', focusMinutes: null, focusTask: null, daypart: 'morning' })] }),
      ctx,
    );
    expect(sameSlot.coach.actions).toEqual([]);
    expect(sameSlot.errors[0]).toContain('did not work because of bad timing; this is again in the morning — choose a different time of day');
    const moved = daily(
      modelCoach({ actions: [modelAction({ title: 'Keep the first hour after lunch for Project X', actionType: 'protect_priority', focusMinutes: null, focusTask: null, daypart: 'afternoon' })] }),
      ctx,
    );
    expect(moved.coach.actions).toHaveLength(1);
    // A failure for another reason does not pin the time of day.
    const tooBig = context({ actions: [worked(10, { outcome: 'did_not_work', reasonCode: 'too_difficult' })] });
    expect(daily(modelCoach({ actions: [modelAction({ title: 'Keep the first hour of the morning for Project X', actionType: 'protect_priority', focusMinutes: null, focusTask: null, daypart: 'morning' })] }), tooBig).coach.actions).toHaveLength(1);
  });

  it('successful strategy: one "it worked" is recorded as reusable — the approach, not the sentence', () => {
    const helped = worked(10);
    const ctx = context({ actions: [helped] });
    expect(renderCoachSection(ctx)).toContain('HELPED when it was tried — reasonable to reuse when the situation is similar.');
    expect(renderCoachSection(ctx)).toContain('CARRIED OUT IN THE LAST FEW DAYS');
    // The same strategy for the same target, naming what is open now: accepted.
    const reused = daily(
      modelCoach({ actions: [modelAction({ title: 'Run one 45-minute Focus session on the Project X conflict-resolution tests', actionRefs: ['k1'], rationale: 'The same morning session helped on Saturday, and the conflict tests are where Project X stands now.' })] }),
      ctx,
    );
    expect(reused).toMatchObject({ ok: true });
    expect(reused.coach.actions[0]).toMatchObject({ strategyKey: helped.strategyKey, targetKey: helped.targetKey });
    // The identical sentence again, two days after the user did it: refused, with the reason.
    const verbatim = daily(modelCoach({ actions: [modelAction({ actionRefs: ['k1'] })] }), ctx);
    expect(verbatim.coach.actions).toEqual([]);
    expect(verbatim.errors[0]).toContain('the user already carried out');
    expect(verbatim.errors[0]).toContain('name what specifically');
    // Once it is no longer recent, the wording is free again.
    expect(daily(modelCoach({ actions: [modelAction({ actionRefs: [] })] }), context({ actions: [worked(5)] })).coach.actions).toHaveLength(1);
  });

  it('partial success: the record asks for a refinement, not a repeat and not a retreat', () => {
    const ctx = context({ actions: [worked(10, { outcome: 'partly_worked' })] });
    expect(renderCoachSection(ctx)).toContain('PARTLY HELPED — keep the idea and refine one thing');
    // Said again word for word it is refused; refined (smaller, and naming what is open) it is kept.
    expect(daily(repeat, ctx).coach.actions).toEqual([]);
    const refined = modelCoach({ actions: [modelAction({ title: 'Run a 25-minute Focus session on the Project X sync retries', focusMinutes: 25, adaptsActionRef: 'k1', metricKeys: [], rationale: 'The longer session partly helped; a shorter one on the retries alone.' })] });
    expect(daily(refined, ctx).coach.actions).toHaveLength(1);
  });

  it('not following an action is not proof it was wrong: an external constraint never counts against the strategy', () => {
    const interrupted = [notDone(9, { reasonCode: 'external_constraint' }), notDone(10, { reasonCode: 'external_constraint' })];
    expect(interrupted.map(signalOf)).toEqual(['neutral', 'neutral']);
    const summary = summarizeEffectiveness(interrupted, NOW.toISOString(), DEFAULT_COACH_CONFIG);
    expect(isBlocked(summary, { strategyKey: interrupted[0].strategyKey, targetKey: interrupted[0].targetKey }, DEFAULT_COACH_CONFIG)).toBeNull();
    const ctx = context({ actions: interrupted });
    expect(ctx.escalations).toEqual([]);
    expect(daily(repeat, ctx).coach.actions).toHaveLength(1);
    // The same two misses for a reason that IS about the action do block it.
    expect(daily(repeat, context({ actions: [notDone(9), notDone(10)] })).coach.actions).toEqual([]);
  });

  it('a suggestion nobody answered is not sent again as it was — a smaller, more specific one may be', () => {
    const unanswered = coachAction({ status: 'expired', ...closedAt(11) });
    const ctx = context({ actions: [unanswered] });
    expect(ctx.ignored.map((a) => a.id)).toEqual([unanswered.id]);
    expect(renderCoachSection(ctx)).toContain('SUGGESTED IN THE LAST FEW DAYS, NEVER DECIDED');
    expect(daily(repeat, ctx).errors[0]).toContain('was suggested recently and never taken up');
    const sharper = daily(modelCoach({ actions: [modelAction({ title: 'Write the two failing conflict tests for the Project X sync engine', focusMinutes: 25, focusTask: 'Project X conflict tests' })] }), ctx);
    expect(sharper.coach.actions).toHaveLength(1);
    // After a few days it is forgotten rather than held against the idea for ever.
    expect(context({ actions: [unanswered], now: local(16, '22:05') }).ignored).toEqual([]);
  });
});

// ── The context the decision is made in ─────────────────────────────────────

describe('what the Coach is told about the moment', () => {
  it('an end-of-day reflection plans tomorrow; "still in progress" is not offered as a reason for silence', () => {
    const evening = renderCoachSection(context());
    expect(evening).toContain('This is the end-of-day reflection');
    expect(evening).toContain('That the day is "still in progress" is not a reason to recommend nothing.');
    expect(renderCoachSection(context({ now: local(12, '11:00') }))).toContain('The day is still running: "today" means what is left of it.');
    expect(renderCoachSection(context({ now: local(13, '09:00') }))).toContain('This day is over');
  });

  it('with no signal measured, the context itself says silence is the expected answer', () => {
    expect(renderCoachSection(context())).toContain('NEXT-MOVE SIGNALS (measured by Reflect)\nNone measured today');
  });
});

// ── Through the whole daily pass ────────────────────────────────────────────

const history = () => [5, 6, 7, 8, 9, 12].flatMap(workday);
function harness(now = local(12, '22:05'), days = [5, 6, 7, 8, 9, 12]) {
  const h = makeReflectionHarness({ activities: days.flatMap(workday), now, priorities: ['Launching Project X'], coach: true });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0]?.id ?? 'none' });
  return { ...h, priorityId: priorities[0]?.id as string };
}
const section = (prompt: string, heading: string) => {
  const start = prompt.indexOf(heading);
  const end = prompt.indexOf('\n\n', start);
  return start < 0 ? '' : prompt.slice(start, end < 0 ? undefined : end);
};

describe('unified daily intelligence → coach action → history → adaptation', () => {
  it('measures the day\'s signals, shows them to the model, and persists the action it leads to', async () => {
    void history;
    const h = harness();
    h.gemini.push(modelDay(day, { decision: decision('act', 'One Focus session on Project X'), actions: [modelAction({ priorityId: h.priorityId })] }));
    const result = await h.service.generate(day, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 1 });

    const { prompt } = h.gemini.requests[0];
    const signals = section(prompt, 'NEXT-MOVE SIGNALS');
    expect(signals).toContain('a candidate to weigh, not an instruction');
    expect(signals).toContain(`"priorityId":"${h.priorityId}"`);
    expect(signals).toMatch(/"activityRefs":\["a\d+"\]/);

    const report = h.repo.getCurrentReport('day', day.key)!;
    const [stored] = h.coachRepo.listActionsByReport(report.id);
    expect(stored).toMatchObject({ status: 'suggested', priorityId: h.priorityId, targetKey: `p:${h.priorityId}`, sourceMetricKeys: ['thread.project-x.minutes'] });
    expect(report.coach).toMatchObject({ actionIds: [stored.id], noActionReason: null });
    expect(h.coachRepo.events).toMatchObject([{ actionId: stored.id, type: 'suggested', toStatus: 'suggested' }]);
  });

  it('a null decision is persisted as a report with no action and its reason', async () => {
    const h = harness();
    h.gemini.push(modelDay(day, { decision: decision('no_useful_move'), actions: [], noActionReason: 'Nothing was left mid-way and no priority was displaced.' }));
    await h.service.generate(day, { trigger: 'scheduled' });
    const report = h.repo.getCurrentReport('day', day.key)!;
    expect(report.coach).toMatchObject({ actionIds: [], noActionReason: 'Nothing was left mid-way and no priority was displaced.' });
    expect(h.coachRepo.actions).toEqual([]);
  });

  it('a retry asked for by the reflection does not re-roll a coaching decision that was already sound', async () => {
    const h = harness();
    // First response: a valid action, but the only insight quotes a number nothing supports — nothing of the
    // reflection is left, so it is asked for again.
    const unsupported = [{ type: 'progress', title: 'Project X got the morning', observation: 'You spent 9999 minutes on Project X today.', interpretation: 'Most of your sustained attention went to one thread.', relevance: null, metricKeys: ['thread.project-x.minutes'], activityRefs: [], priorityIds: [], confidence: 0.9 }];
    const first = modelDay(day, { actions: [modelAction()] }, { insights: unsupported });
    // The retry fixes the reflection — and, as the old run showed, quietly drops the action.
    const second = modelDay(day, { actions: [], noActionReason: 'Your time was aligned with your priorities.' });
    h.gemini.push(first, second);
    const result = await h.service.generate(day, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 2 });
    // The retry was told which half to leave alone.
    expect(h.gemini.requests[1].prompt).toContain('The coach part was ACCEPTED. Return it exactly as before.');
    const report = h.repo.getCurrentReport('day', day.key)!;
    expect(JSON.stringify(report.insights)).not.toContain('9999');
    expect(h.coachRepo.listActionsByReport(report.id).map((a) => a.title)).toEqual(['Run one 45-minute Focus session on Project X before switching threads']);
    expect(report.coach!.noActionReason).toBeNull();
  });

  it('a retry asked for by the coaching does not re-roll a reflection that was already sound', async () => {
    const h = harness();
    // First response: a sound reflection beside an action that cites a metric that does not exist.
    const first = modelDay(day, { actions: [modelAction({ metricKeys: ['thread.made-up.minutes'] })] });
    // The retry fixes the action — and rewrites the reflection into something that would not validate.
    const second = modelDay(day, { actions: [modelAction()] }, { headline: 'A different day entirely.', narrative: null, insights: [] });
    h.gemini.push(first, second);
    expect(await h.service.generate(day, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 2, insightCount: 1 });
    expect(h.gemini.requests[1].prompt).toContain('The reflection part (headline, narrative, insights) was ACCEPTED. Return it exactly as before');
    expect(h.gemini.requests[1].prompt).not.toContain('Drop any claim you cannot support');
    const report = h.repo.getCurrentReport('day', day.key)!;
    // What was accepted in the first response is what is stored.
    expect(report.headline).toBe('Project X took your morning; the afternoon moved between threads.');
    expect(report.insights.map((i) => i.title)).toEqual(['Project X got the morning']);
    expect(h.coachRepo.listActionsByReport(report.id)).toHaveLength(1);
  });

  it('an unsupported headline costs no retry: it is replaced and the day is kept', async () => {
    const h = harness();
    h.gemini.push(modelDay(day, { actions: [modelAction()] }, { headline: 'You spent 9999 minutes on Project X today.' }));
    expect(await h.service.generate(day, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    const report = h.repo.getCurrentReport('day', day.key)!;
    expect(report.headline).toBe('Project X got the morning');
    expect(h.coachRepo.listActionsByReport(report.id)).toHaveLength(1);
  });

  it('tracks decision, execution and outcome separately, then adapts the next recommendation to them', async () => {
    const h = harness(local(12, '22:05'), [5, 6, 7, 8, 9, 12, 13]);
    const generate = async (d: number, ...responses: unknown[]) => {
      h.setNow(local(d, '22:05'));
      h.gemini.push(...responses);
      const period = periodContaining('day', local(d));
      const result = await h.service.generate(period, { trigger: 'scheduled' });
      return { result, report: h.repo.getCurrentReport('day', period.key)!, request: h.gemini.requests[h.gemini.requests.length - 1] };
    };

    // Mon evening: suggested, then accepted — a decision, nothing more.
    const mon = await generate(12, modelDay(day));
    const actionId = h.coachRepo.listActionsByReport(mon.report.id)[0].id;
    expect(h.coach.decide(actionId, 'accept').ok).toBe(true);
    expect(h.coachRepo.getAction(actionId)).toMatchObject({ status: 'accepted', execution: null, outcome: null });

    // Tue: the user did it (execution) — and separately says it did not help (outcome).
    h.setNow(local(13, '19:00'));
    expect(h.coach.reportExecution(actionId, 'done').ok).toBe(true);
    expect(h.coachRepo.getAction(actionId)).toMatchObject({ status: 'review', execution: 'done', executionSource: 'user', outcome: null });
    expect(h.coach.reportOutcome(actionId, 'did_not_work', { reasonCode: 'bad_timing' }).ok).toBe(true);
    expect(h.coachRepo.getAction(actionId)).toMatchObject({ status: 'closed', execution: 'done', outcome: 'did_not_work', reasonCode: 'bad_timing' });
    expect(h.coachRepo.events.filter((e) => e.actionId === actionId).map((e) => e.type)).toEqual(['suggested', 'accept', 'execution', 'outcome']);

    // Tue evening: the history is in the prompt; repeating the action is refused; the adapted one is stored.
    const tuesday = periodContaining('day', local(13));
    const same = modelDay(tuesday, { actions: [modelAction({ metricKeys: [], actionRefs: ['k1'], rationale: 'Project X still needs a block of time.' })] });
    const adapted = modelDay(tuesday, {
      followups: [{ actionRef: 'k1', note: 'You ran the morning session and said it did not help; the timing was wrong.', learned: 'Mornings are not the slot for this.' }],
      actions: [modelAction({ title: 'Run a 25-minute Focus session on Project X after lunch', daypart: 'afternoon', focusMinutes: 25, adaptsActionRef: 'k1', metricKeys: [], rationale: 'The morning block did not help; this moves it later and makes it smaller.' })],
    });
    const tue = await generate(13, same, adapted);
    expect(tue.result).toMatchObject({ status: 'succeeded', attempts: 2 });
    const previous = section(tue.request.prompt, 'PREVIOUS ACTIONS');
    // Who established that it happened is stated as it is: the user's word, not Reflect's observation.
    expect(previous).toMatch(/"execution":"carried out \((the user said so, and Reflect saw matching work|reported by the user; [^)]+)\)"/);
    expect(previous).not.toContain('"execution":"carried out (observed by Reflect)"');
    expect(previous).toContain('"outcome":"the user said it did not work"');
    expect(section(tue.request.prompt, 'WHAT HAS AND HAS NOT WORKED')).toContain('The user said it DID NOT HELP');
    expect(tue.request.prompt).toContain('did not work (bad timing)');
    const [next] = h.coachRepo.listActionsByReport(tue.report.id);
    expect(next).toMatchObject({ strategyKey: 'focus_session|afternoon|short', parentActionId: actionId, status: 'suggested' });
    expect(tue.report.coach!.followups).toMatchObject([{ actionId, learned: 'Mornings are not the slot for this.' }]);
  });
});
