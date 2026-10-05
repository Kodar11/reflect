import { describe, it, expect } from 'vitest';
import { buildCoachContext, describeActionState, renderCoachSection, type CoachContext } from '../../src/coach/CoachContext';
import { executionEvidence } from '../../src/coach/CoachLifecycle';
import { itemTokensOf, observationGraceEnd, observeAction } from '../../src/coach/CoachMatching';
import { DEFAULT_COACH_CONFIG, type CoachAction } from '../../src/coach/CoachModels';
import { buildCoachResponseSchema } from '../../src/coach/CoachPrompt';
import { buildSituations, concentratedTarget, renderSituations, sameItem, type SituationDay } from '../../src/coach/CoachSituation';
import { validateDailyCoach } from '../../src/coach/CoachValidator';
import type { Metric, MetricSet } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { createEvidenceToolkit } from '../../src/reflection/ReflectionValidator';
import { activity, iso, local } from '../reflection/helpers';
import { accepted, coachAction, modelAction, modelCoach, worked } from './helpers';

/**
 * Decision quality: the regressions found in the 30-day benchmark and the
 * scenario set, pinned down as deterministic rules.
 *
 *   - a project is not a next action                     ("Continue working on the assignment")
 *   - an action must agree with the model's own reading  (acting on "progressing")
 *   - an open item is something the record shows         (an invented topic)
 *   - every priority is laid out before one is chosen    (nine actions on one salient thread)
 *   - "the user said so" is never "Reflect observed it"  (execution evidence)
 *   - work later the same day still happened             (0% observed execution)
 */

const NOW = local(12, '22:05');
const day = periodContaining('day', local(12));
const ASSIGNMENT = { id: 'pr-db', text: 'Finish the database systems assignment' };
const MIDTERM = { id: 'pr-algo', text: 'Prepare for the algorithms midterm' };
const PRIORITIES = [ASSIGNMENT, MIDTERM];

const metric = (key: string, value: number, display: string, extra: Partial<Metric> = {}): Metric => ({ key, label: key, value, unit: 'minutes', display, group: 'priority', ...extra });
const metrics: MetricSet = {
  'time.tracked_minutes': metric('time.tracked_minutes', 240, '4h 0m', { group: 'time' }),
  'priority.pr-db.minutes': metric('priority.pr-db.minutes', 90, '1h 30m', { priorityId: 'pr-db' }),
  'priority.pr-algo.minutes': metric('priority.pr-algo.minutes', 75, '1h 15m', { priorityId: 'pr-algo' }),
};
const indexing = activity(12, '10:00', 90, {
  title: 'Drafting the indexing section and debugging the composite index test',
  summary: 'Wrote the indexing section; the composite index test was still failing.',
  thread: 'Database Systems',
  priorityId: 'pr-db',
});
const graphs = activity(12, '14:00', 75, { title: 'Practicing graph algorithms', summary: 'Worked through shortest-path problems.', thread: 'Algorithms Midterm', priorityId: 'pr-algo' });
const evidence = createEvidenceToolkit({
  metrics,
  activityByRef: new Map([
    ['a1', indexing],
    ['a2', graphs],
  ]),
  priorities: PRIORITIES,
  periodLabel: 'Today Mon, Oct 12',
});

function context(options: { actions?: CoachAction[]; situationSection?: string } = {}): CoachContext {
  return buildCoachContext({
    now: NOW,
    reportDay: day,
    actions: options.actions ?? [],
    memories: [],
    messages: [],
    priorities: PRIORITIES,
    knownThreads: ['Database Systems', 'Algorithms Midterm'],
    config: DEFAULT_COACH_CONFIG,
    opportunities: [],
    activityRefOf: () => null,
    situationSection: options.situationSection ?? '',
    evidenceText: `${indexing.title} ${indexing.summary} ${graphs.title} ${graphs.summary}`,
  });
}

const reading = (priorityId: string, state: string, item: string | null = null, nextMove: string | null = null) => ({ priorityId, state, item, nextMove });
const decision = (...candidates: ReturnType<typeof reading>[]) => ({ matters: 'm', moved: 'm', candidates, tried: 'nothing yet', candidate: 'c', verdict: 'act' });
const dbAction = (over: Record<string, unknown> = {}) =>
  modelAction({
    title: 'Get the failing composite index test passing and finish the indexing section',
    rationale: 'The indexing section was drafted and its test was still failing when work stopped.',
    actionType: 'close_open_loop',
    focusMinutes: null,
    focusTask: null,
    priorityId: 'pr-db',
    thread: 'Database Systems',
    metricKeys: ['priority.pr-db.minutes'],
    activityRefs: ['a1'],
    ...over,
  });
const daily = (coach: Record<string, unknown>, ctx: CoachContext = context()) => validateDailyCoach({ raw: modelCoach(coach), context: ctx, evidence });

describe('a project is not a next action', () => {
  it('knows what an action names beyond the priority it serves', () => {
    const named = (title: string) => [...itemTokensOf({ title }, [ASSIGNMENT.text, 'Database Systems'])];
    expect(named('Continue working on the database systems assignment')).toEqual([]);
    expect(named('Resume drafting the database assignment')).toEqual([]);
    expect(named('Finish the database systems assignment')).toEqual([]);
    expect(named('Get the failing composite index test passing')).toEqual(expect.arrayContaining(['composite', 'index']));
    // The next stage ("send", "confirm", "verify") is the step, not the item.
    expect([...itemTokensOf({ title: 'Send and confirm it' }, [])]).toEqual([]);
  });

  it.each([
    ['continue_behavior', 'Continue working on the database systems assignment'],
    ['close_open_loop', 'Finish the database systems assignment'],
    ['continue_behavior', 'Resume drafting the database assignment'],
  ])('rejects a %s that names only the priority: "%s"', (actionType, title) => {
    const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the indexing section')), actions: [dbAction({ actionType, title })] });
    expect(result.ok).toBe(false);
    expect(result.coach.actions).toEqual([]);
    expect(result.errors[0]).toContain('names the priority “Finish the database systems assignment”, not a next action');
    // The way out is named: the specific item, or honest silence.
    expect(result.errors[0]).toContain('if the evidence shows no such item, return no action and say what is unclear');
  });

  it('accepts the same move once it names the item', () => {
    const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the failing composite index test', 'get it passing')), actions: [dbAction()] });
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.coach.actions[0]).toMatchObject({ actionType: 'close_open_loop', priorityId: 'pr-db' });
  });

  it('leaves time-shaped actions alone: protecting a block for a displaced priority needs no item', () => {
    const result = daily({
      decision: decision(reading('pr-algo', 'displaced')),
      actions: [dbAction({ actionType: 'protect_priority', title: 'Protect a morning block for the algorithms midterm', priorityId: 'pr-algo', thread: 'Algorithms Midterm', metricKeys: ['priority.pr-algo.minutes'], activityRefs: [], rationale: 'It has had no time on consecutive days.' })],
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe('an action must agree with how the model itself read the priority', () => {
  it.each(['progressing', 'at_stopping_point', 'unclear'])('refuses an action for a priority read as "%s"', (state) => {
    const result = daily({ decision: decision(reading('pr-db', state)), actions: [dbAction()] });
    expect(result.ok).toBe(false);
    expect(result.coach.actions).toEqual([]);
    expect(result.errors[0]).toContain('only an open item or a displaced priority can carry an action');
  });

  it('ambiguity is answered with a question to the user, never with a prescription', () => {
    const ask = dbAction({ actionType: 'clarify_priority', title: 'Settle whether the database assignment is already submitted' });
    expect(daily({ decision: decision(reading('pr-db', 'unclear')), actions: [ask] })).toMatchObject({ ok: true });
    expect(daily({ decision: decision(reading('pr-db', 'at_stopping_point')), actions: [ask] }).ok).toBe(false);
  });

  it('an open item is something the record shows — not a topic that would be reasonable next', () => {
    const invented = dbAction({
      actionType: 'focus_session',
      focusMinutes: 45,
      title: 'Review dynamic programming problems for the algorithms midterm',
      focusTask: 'Dynamic programming problems',
      priorityId: 'pr-algo',
      thread: 'Algorithms Midterm',
      metricKeys: ['priority.pr-algo.minutes'],
      activityRefs: ['a2'],
      rationale: 'Graph algorithms were practiced today, so another topic is next.',
    });
    const result = daily({ decision: decision(reading('pr-algo', 'open_item', 'dynamic programming problems')), actions: [invented] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('the open item “dynamic programming problems” is not something today\'s activities');
    // The same shape about something the day does show is fine.
    const grounded = { ...invented, title: 'Finish the remaining shortest-path problems', focusTask: 'Shortest-path problems' };
    expect(daily({ decision: decision(reading('pr-algo', 'open_item', 'the shortest-path problems')), actions: [grounded] })).toMatchObject({ ok: true });
  });

  it('a decision without candidates is tolerated: older responses are not broken by the new field', () => {
    expect(daily({ actions: [dbAction()] })).toMatchObject({ ok: true });
    expect(daily({ decision: { verdict: 'act', candidate: 'x' }, actions: [dbAction()] })).toMatchObject({ ok: true });
  });

  it('the response schema asks for one reading per stated priority before anything is chosen', () => {
    const schema = buildCoachResponseSchema(['pr-db', 'pr-algo']) as { properties: { decision: { required: string[]; properties: { candidates: { items: { properties: { state: { enum: string[] }; priorityId: { enum: string[] } } } } } } } };
    expect(schema.properties.decision.required).toEqual(['matters', 'moved', 'candidates', 'tried', 'candidate', 'verdict']);
    expect(schema.properties.decision.properties.candidates.items.properties.state.enum).toEqual(['open_item', 'displaced', 'progressing', 'at_stopping_point', 'unclear']);
    expect(schema.properties.decision.properties.candidates.items.properties.priorityId.enum).toEqual(['pr-db', 'pr-algo']);
  });
});

describe('the situation board — every priority, side by side', () => {
  const earlier = (n: number, title: string, priorityId: string, summary: string | null = null): SituationDay => ({
    dayKey: `2026-10-${String(n).padStart(2, '0')}`,
    dayLabel: `Oct ${n}`,
    activities: [activity(n, '10:00', 60, { title, summary, priorityId }), activity(n, '13:00', 120, { title: 'Hobby project', priorityId: null })],
  });
  const suggestion = (n: number, priorityId: string, title: string) => worked(n, { title, priorityId, targetKey: `p:${priorityId}` });

  it('lays out today\'s trail, the days before, and what the Coach already said — for each priority', () => {
    const situations = buildSituations({
      priorities: PRIORITIES,
      activities: [indexing, graphs],
      metrics,
      recentDays: [earlier(11, 'Drafting the indexing section', 'pr-db'), earlier(10, 'Submitting problem set 2', 'pr-algo', 'Submitted it.')],
      actions: [suggestion(11, 'pr-db', 'Finish the schema diagram')],
    });
    expect(situations.map((s) => s.priorityId)).toEqual(['pr-db', 'pr-algo']);
    expect(situations[0]).toMatchObject({ todayMinutes: 90, lastState: 'open', untouchedStreak: 0, coach: { recentActions: 1, ofTotal: 1 } });
    expect(situations[0].carriedOver).toMatchObject({ days: 2 });
    expect(situations[1].recent[1]).toMatchObject({ endedOn: 'Submitting problem set 2', state: 'stopping_point' });

    const text = renderSituations(situations, metrics, (id) => (id === indexing.id ? 'a1' : id === graphs.id ? 'a2' : null));
    expect(text).toContain('read ALL of them before choosing');
    expect(text).toContain('"todayInOrder":["a1 Drafting the indexing section and debugging the composite index test"]');
    expect(text).toContain('its description says it was not finished');
    expect(text).toContain('"coachSoFar":"1 of the last 1 suggestion were about this; latest: “Finish the schema diagram” (carried out, helped)"');
    expect(text).toContain('"coachSoFar":"0 of the last 1 suggestion were about this"');
    // Raw ids never reach the model.
    expect(text).not.toContain(indexing.id);
  });

  it('counts days without time only over days that were tracked, and calls one day what it is', () => {
    const quietMetrics: MetricSet = { ...metrics, 'priority.pr-algo.minutes': metric('priority.pr-algo.minutes', 0, '0m') };
    const today = [indexing];
    const streak = (recentDays: SituationDay[]) => buildSituations({ priorities: PRIORITIES, activities: today, metrics: quietMetrics, recentDays, actions: [] })[1].untouchedStreak;
    expect(streak([earlier(11, 'Practicing graph algorithms', 'pr-algo')])).toBe(1);
    expect(streak([earlier(11, 'Drafting', 'pr-db'), earlier(10, 'Drafting', 'pr-db'), earlier(9, 'Practicing graphs', 'pr-algo')])).toBe(3);
    const text = renderSituations(buildSituations({ priorities: PRIORITIES, activities: today, metrics: quietMetrics, recentDays: [earlier(11, 'Practicing graph algorithms', 'pr-algo')], actions: [] }), quietMetrics, () => null);
    expect(text).toContain('"withoutTime":"today only — one day is not a pattern"');
  });

  it('says so when recent suggestions have concentrated on one priority while another had none', () => {
    const actions = [12, 11, 10, 9].map((n) => suggestion(n, 'pr-db', `Finish section ${n}`));
    const situations = buildSituations({ priorities: PRIORITIES, activities: [indexing, graphs], metrics, recentDays: [], actions });
    expect(concentratedTarget(situations)?.priorityId).toBe('pr-db');
    expect(situations[0].coach).toMatchObject({ recentActions: 4, ofTotal: 4, daysRunning: 4 });
    const text = renderSituations(situations, metrics, () => null);
    expect(text).toContain('NOTE: recent suggestions have concentrated on “Finish the database systems assignment” (4 of the last 4)');
    expect(text).toContain('choose it again only if today\'s evidence shows something NEW that is open there');
    // Spread across priorities: nothing to say.
    const spread = [suggestion(12, 'pr-db', 'A'), suggestion(11, 'pr-algo', 'B'), suggestion(10, 'pr-db', 'C'), suggestion(9, 'pr-algo', 'D')];
    expect(concentratedTarget(buildSituations({ priorities: PRIORITIES, activities: [], metrics, recentDays: [], actions: spread }))).toBeNull();
  });

  it('recognises the same piece of work across differently worded titles', () => {
    expect(sameItem('Investigating the authentication API issue', 'Testing authentication API responses')).toBe(true);
    expect(sameItem('Investigating the authentication API issue', 'Designing the dashboard layout')).toBe(false);
    // Two days both titled after the project are the same project, not the same unfinished item.
    expect(sameItem('Update portfolio site', 'Update portfolio site case study page', ['Update the portfolio site'])).toBe(false);
    expect(sameItem('Portfolio site case study page', 'Editing the case study page', ['Update the portfolio site'])).toBe(true);
  });

  it('reaches the model ahead of the action history, and "what worked" is framed as a shape, not a target', () => {
    const ctx = context({ actions: [worked(10, { priorityId: 'pr-db', targetKey: 'p:pr-db' }), worked(11, { priorityId: 'pr-db', targetKey: 'p:pr-db' })], situationSection: 'SITUATION BY PRIORITY\n{}' });
    const text = renderCoachSection(ctx);
    expect(text.indexOf('SITUATION BY PRIORITY')).toBeLessThan(text.indexOf('PREVIOUS ACTIONS'));
    expect(text).toContain('It is never a reason to pick the same TARGET again');
  });
});

describe('execution: what the user reported and what Reflect observed are two facts', () => {
  const stated = (over: Partial<CoachAction> = {}) => worked(12, { executionSource: 'user', ...over });
  const window = { start: iso(13, '05:00'), end: iso(13, '12:00') };
  const observation = (kind: 'executed' | 'attempted' | 'not_observed' | 'unobservable' | 'ambiguous', final = true) => ({
    kind,
    observedAt: iso(13, '22:00'),
    window,
    final,
    focusSessionIds: [],
    activityIds: [],
    focusMinutes: 0,
    matchedMinutes: 0,
    plannedMinutes: null,
    interruptions: 0,
    facts: [],
  });

  it('keeps the two apart whatever order they arrived in', () => {
    expect(executionEvidence(stated({ observation: observation('not_observed') }))).toEqual({ userReported: true, observed: false });
    expect(executionEvidence(stated({ observation: observation('executed') }))).toEqual({ userReported: true, observed: true });
    expect(executionEvidence(stated({ observation: observation('unobservable') }))).toEqual({ userReported: true, observed: null });
    expect(executionEvidence(stated({ observation: null }))).toEqual({ userReported: true, observed: null });
    expect(executionEvidence(worked(12, { executionSource: 'observed', observation: observation('executed') }))).toEqual({ userReported: false, observed: true });
    // An accepted action that nobody has said anything about: nothing is known.
    expect(executionEvidence(accepted())).toEqual({ userReported: false, observed: null });
  });

  it('tells the model which it was — a report is never worded as an observation', () => {
    expect(describeActionState(stated({ observation: observation('not_observed') })).execution).toBe('carried out (reported by the user; Reflect did not see matching work)');
    expect(describeActionState(stated({ observation: observation('unobservable') })).execution).toBe('carried out (reported by the user; not something Reflect could verify)');
    expect(describeActionState(stated({ observation: observation('attempted') })).execution).toBe('carried out (the user said so, and Reflect saw matching work)');
    expect(describeActionState(worked(12, { observation: observation('executed') })).execution).toBe('carried out (observed by Reflect)');
  });
});

describe('observed execution: later the same day, and the item itself', () => {
  const protect = accepted({ actionType: 'protect_priority', focusMinutes: null, focusTask: null, title: 'Protect a block for the database assignment', priorityId: 'pr-db', thread: null });
  const closeLoop = accepted({
    actionType: 'close_open_loop',
    focusMinutes: null,
    focusTask: null,
    title: 'Get the failing composite index test passing',
    priorityId: 'pr-db',
    thread: null,
  });
  const observe = (action: CoachAction, at: string, activities: ReturnType<typeof activity>[]) =>
    observeAction({ action, nowIso: at, focus: [], activities, priorityText: ASSIGNMENT.text, config: DEFAULT_COACH_CONFIG });

  it('a morning suggestion keeps being looked at until the end of its own day', () => {
    expect(observationGraceEnd({ start: iso(13, '05:00'), end: iso(13, '12:00') })).toBe(periodContaining('day', local(13)).end);
    // A week-long window is its own grace.
    expect(observationGraceEnd({ start: iso(13, '00:00'), end: iso(20, '00:00') })).toBe(iso(20, '00:00'));
  });

  it('work on the target that afternoon is established by Reflect — and said to have been later than suggested', () => {
    const afternoon = activity(13, '15:00', 70, { title: 'Database assignment: transactions section', priorityId: 'pr-db' });
    // At noon nothing has been seen yet: the question is raised, nothing is claimed.
    expect(observe(protect, iso(13, '12:30'), []).observation).toMatchObject({ kind: 'not_observed', final: true });
    const evening = observe(protect, iso(13, '22:00'), [afternoon]);
    expect(evening.observation).toMatchObject({ kind: 'attempted', matchedMinutes: 0, laterMinutes: 70, final: true });
    expect(evening.execution).toBe('done');
    expect(evening.observation.facts).toEqual([
      '1h 10m of tracked work on “Finish the database systems assignment” later that day, after 12:00 PM.',
      'The work happened later than the suggested time.',
    ]);
  });

  it('never infers execution from the action existing: unrelated work is "nothing matching"', () => {
    const unrelated = [activity(13, '09:00', 120, { title: 'Hobby game engine', priorityId: null }), activity(13, '15:00', 60, { title: 'Watching videos', priorityId: null })];
    const result = observe(closeLoop, iso(13, '23:30'), unrelated);
    expect(result).toMatchObject({ execution: null, executedAt: null });
    expect(result.observation.kind).toBe('not_observed');
  });

  it('an action about one item is not "done" because the same priority was worked on', () => {
    const otherPart = activity(13, '09:00', 60, { title: 'Database assignment: writing the transactions section', priorityId: 'pr-db' });
    const result = observe(closeLoop, iso(13, '12:30'), [otherPart]);
    expect(result.execution).toBeNull();
    expect(result.observation).toMatchObject({ kind: 'ambiguous', evidenceLevel: 'target', matchedMinutes: 60 });
    expect(result.observation.facts[1]).toContain('nothing tracked names what this action was about, so Reflect cannot tell whether it was this');
    // Work that names the item is evidence of the item.
    const theItem = activity(13, '09:00', 60, { title: 'Database assignment', summary: 'Fixed the composite index and re-ran the tests.', priorityId: 'pr-db' });
    const seen = observe(closeLoop, iso(13, '12:30'), [theItem]);
    expect(seen.execution).toBe('done');
    expect(seen.observation).toMatchObject({ kind: 'executed', evidenceLevel: 'item' });
  });

  it('a time-shaped action is observed at the level it was made: work on the priority is the action', () => {
    const anyPart = activity(13, '09:00', 60, { title: 'Database assignment: transactions section', priorityId: 'pr-db' });
    expect(observe(protect, iso(13, '12:30'), [anyPart])).toMatchObject({ execution: 'done', observation: { kind: 'executed' } });
  });
});

describe('repeat suppression points somewhere else', () => {
  it('a repeat of something just carried out is refused, and the model is sent to the other priorities', () => {
    const done = worked(11, { title: 'Get the failing composite index test passing and finish the indexing section', actionType: 'close_open_loop', focusMinutes: null, priorityId: 'pr-db', thread: null, targetKey: 'p:pr-db', strategyKey: 'close_open_loop|morning|none', closedAt: iso(12, '21:00'), executedAt: iso(12, '10:00') });
    const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the composite index test')), actions: [dbAction({ thread: null })] }, context({ actions: [done] }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('the user already carried out');
    expect(result.errors[0]).toContain('check SITUATION BY PRIORITY for whether another priority holds the more useful next move');
  });

  it('a suggestion for a different action type that names nothing new is still a project, not an action', () => {
    const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the assignment')), actions: [dbAction({ actionType: 'focus_session', focusMinutes: 45, title: 'Focus on the database systems assignment', focusTask: 'Database systems assignment' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('not a next action');
  });
});

describe('what the user said about an earlier suggestion shapes the next one', () => {
  const dbTarget = { priorityId: 'pr-db', thread: null, targetKey: 'p:pr-db' };

  it('"not now" is an answer for today: nothing else for that target until it comes back by itself', () => {
    const postponed = coachAction({ ...dbTarget, title: 'Complete the indexing write-up before lunch', actionType: 'close_open_loop', focusMinutes: null, status: 'snoozed', snoozeCount: 1, snoozedUntil: iso(13, '00:00') });
    const ctx = context({ actions: [postponed] });
    const other = dbAction({ actionType: 'protect_priority', title: 'Protect an afternoon block for the database assignment', thread: null, daypart: 'afternoon' });
    const result = daily({ decision: decision(reading('pr-db', 'displaced')), actions: [other] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('the user postponed “Complete the indexing write-up before lunch” (“not now”)');
    // A different priority is unaffected.
    const elsewhere = dbAction({ actionType: 'protect_priority', title: 'Protect a morning block for the algorithms midterm', priorityId: 'pr-algo', thread: null, metricKeys: ['priority.pr-algo.minutes'], activityRefs: [] });
    expect(daily({ decision: decision(reading('pr-algo', 'displaced')), actions: [elsewhere] }, ctx)).toMatchObject({ ok: true });
  });

  it('"too difficult" is about size: the same size again is refused, a clearly smaller step is not', () => {
    const tooBig = coachAction({
      ...dbTarget,
      title: 'Finish the whole assignment in one two-hour block',
      focusMinutes: 120,
      strategyKey: 'focus_session|morning|long',
      status: 'closed',
      acceptedAt: iso(11, '22:05'),
      execution: 'not_done',
      executionSource: 'user',
      reasonCode: 'too_difficult',
      closedAt: iso(12, '21:00'),
      updatedAt: iso(12, '21:00'),
    });
    const ctx = context({ actions: [tooBig] });
    const step = (focusMinutes: number, daypart = 'afternoon') =>
      dbAction({ actionType: 'focus_session', focusMinutes, daypart, thread: null, focusTask: 'Composite index test', title: 'Get the failing composite index test passing', actionRefs: ['k1'], adaptsActionRef: 'k1', rationale: 'The earlier block was too large; this is one concrete step.' });
    const same = daily({ decision: decision(reading('pr-db', 'open_item', 'the failing composite index test')), actions: [step(120)] }, ctx);
    expect(same.ok).toBe(false);
    expect(same.errors[0]).toContain('was too difficult at its size; this is no smaller');
    const smaller = daily({ decision: decision(reading('pr-db', 'open_item', 'the failing composite index test')), actions: [step(30)] }, ctx);
    expect(smaller).toMatchObject({ ok: true });
    expect(smaller.coach.actions[0]).toMatchObject({ parentActionId: tooBig.id, focusMinutes: 30 });
  });
});

describe('"continue X" is not an action, and "displaced" is a measurement', () => {
  it.each(['Continue drafting the indexing section report', 'Resume the composite index debugging', 'Focus on the indexing section', 'Work on the composite index test'])(
    'refuses "%s": it says to carry on, not what to finish',
    (title) => {
      const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the indexing section')), actions: [dbAction({ actionType: 'focus_session', focusMinutes: 45, focusTask: 'Indexing section', title })] });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('says to carry on, not what to finish');
    },
  );

  it('"Keep tomorrow morning for …" protects time; it is not a carry-on', () => {
    const result = daily({ decision: decision(reading('pr-db', 'open_item', 'the composite index test')), actions: [dbAction({ title: 'Keep tomorrow morning for the failing composite index test' })] });
    expect(result).toMatchObject({ ok: true });
  });

  it('a priority read as displaced needs Reflect to have measured it: one day is a circumstance', () => {
    const protect = dbAction({ actionType: 'protect_priority', title: 'Protect a morning block for the algorithms midterm', priorityId: 'pr-algo', thread: null, metricKeys: ['priority.pr-algo.minutes'], activityRefs: [], rationale: 'It got little time today.' });
    const withBoard = (signals: Parameters<typeof buildCoachContext>[0]['opportunities']) =>
      buildCoachContext({ now: NOW, reportDay: day, actions: [], memories: [], messages: [], priorities: PRIORITIES, knownThreads: [], config: DEFAULT_COACH_CONFIG, opportunities: signals, activityRefOf: () => null, situationSection: 'SITUATION BY PRIORITY', evidenceText: 'x' });
    const signal = (strength: 'clear' | 'possible') => ({ kind: 'displaced_priority' as const, strength, confidence: 0.8, priorityId: 'pr-algo', thread: null, summary: 's', metricKeys: [], activityIds: [], fits: [] });
    const unmeasured = daily({ decision: decision(reading('pr-algo', 'displaced')), actions: [protect] }, withBoard([signal('possible')]));
    expect(unmeasured.ok).toBe(false);
    expect(unmeasured.errors[0]).toContain('one day with little or no time is a circumstance, not a pattern');
    expect(daily({ decision: decision(reading('pr-algo', 'displaced')), actions: [protect] }, withBoard([signal('clear')]))).toMatchObject({ ok: true });
  });

  it('a Focus block for a displaced priority may not invent what to study', () => {
    const invented = dbAction({ actionType: 'focus_session', focusMinutes: 30, title: 'Review one dynamic programming problem for the algorithms midterm', focusTask: 'Dynamic programming', priorityId: 'pr-algo', thread: null, metricKeys: ['priority.pr-algo.minutes'], activityRefs: [], rationale: 'It has had no time for days.' });
    const result = daily({ decision: decision(reading('pr-algo', 'displaced')), actions: [invented] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('names something today\'s activities, the earlier days and the record do not mention');
  });
});

describe('coachAction helper sanity', () => {
  it('the default fixture is unaffected by the item rule (no reading given)', () => {
    expect(coachAction().actionType).toBe('focus_session');
  });
});
