import { describe, it, expect } from 'vitest';
import { buildCoachContext, type CoachContext } from '../../src/coach/CoachContext';
import { DEFAULT_COACH_CONFIG, type CoachAction, type CoachMemory, type CoachMessage } from '../../src/coach/CoachModels';
import { findSensitiveIssue, validateChat, validateDailyCoach } from '../../src/coach/CoachValidator';
import type { MetricSet } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { addNumbersFrom, createEvidenceToolkit } from '../../src/reflection/ReflectionValidator';
import { iso, local, projectX } from '../reflection/helpers';
import { accepted, coachAction, memory, message, modelAction, modelChat, modelCoach, notDone, worked } from './helpers';

/** Mon Oct 12, 10:05 PM — the day's reflection is being written. */
const NOW = local(12, '22:05');
const day = periodContaining('day', local(12));
const PRIORITIES = [{ id: 'pr-1', text: 'Launching Project X' }];

const metrics: MetricSet = {
  'thread.project-x.minutes': { key: 'thread.project-x.minutes', label: 'Time on “Project X”', value: 172, unit: 'minutes', display: '2h 52m', group: 'thread', thread: 'Project X' },
  'behavior.switches': { key: 'behavior.switches', label: 'Context switches', value: 8, unit: 'count', display: '8', group: 'behavior' },
  'priority.pr-1.minutes': {
    key: 'priority.pr-1.minutes',
    label: 'Time linked to the priority “Launching Project X”',
    value: 172,
    unit: 'minutes',
    display: '2h 52m',
    group: 'priority',
    priorityId: 'pr-1',
  },
};
const morningBlock = projectX(12, '09:00', 80);
const evidence = createEvidenceToolkit({
  metrics,
  activityByRef: new Map([['a1', morningBlock]]),
  priorities: PRIORITIES,
  periodLabel: 'Today Mon, Oct 12',
});

function context(options: { actions?: CoachAction[]; memories?: CoachMemory[]; messages?: CoachMessage[]; now?: Date } = {}): CoachContext {
  return buildCoachContext({
    now: options.now ?? NOW,
    reportDay: day,
    actions: options.actions ?? [],
    memories: options.memories ?? [],
    messages: options.messages ?? [],
    priorities: PRIORITIES,
    knownThreads: ['Project X', 'Project Y'],
    config: DEFAULT_COACH_CONFIG,
  });
}

const daily = (raw: unknown, ctx: CoachContext = context()) => validateDailyCoach({ raw, context: ctx, evidence });

describe('validateDailyCoach — a grounded recommendation', () => {
  it('accepts one concrete, evidence-backed action and resolves everything about it', () => {
    const result = daily(modelCoach());
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.coach.actions).toHaveLength(1);
    expect(result.coach.actions[0]).toMatchObject({
      title: 'Run one 45-minute Focus session on Project X before switching threads',
      actionType: 'focus_session',
      daypart: 'morning',
      // "tomorrow morning", relative to the day the reflection is about
      targetStart: iso(13, '05:00'),
      targetEnd: iso(13, '12:00'),
      focusMinutes: 45,
      focusTask: 'Project X',
      thread: 'Project X',
      strategyKey: 'focus_session|morning|medium',
      targetKey: 't:project-x',
      parentActionId: null,
      sourceMetricKeys: ['thread.project-x.minutes'],
    });
    expect(result.coach.actions[0].evidence[0]).toMatchObject({ kind: 'metric', metricKey: 'thread.project-x.minutes', value: '2h 52m' });
    // No ids come from the model; the backend mints them later.
    expect(result.coach.actions[0]).not.toHaveProperty('id');
    expect(result.coach.noActionReason).toBeNull();
  });

  it('links an action to a stated priority, and to an activity it cites', () => {
    const result = daily(modelCoach({ actions: [modelAction({ priorityId: 'pr-1', thread: null, metricKeys: [], activityRefs: ['a1'] })] }));
    expect(result.ok).toBe(true);
    expect(result.coach.actions[0]).toMatchObject({ priorityId: 'pr-1', targetKey: 'p:pr-1', sourceActivityIds: [morningBlock.id] });
    expect(result.coach.actions[0].evidence.map((e) => e.kind)).toEqual(['activity', 'priority']);
  });

  it('"No useful advice today" is a complete answer', () => {
    const stated = daily(modelCoach({ actions: [], noActionReason: 'Your time went where you said it matters; nothing needs changing.' }));
    expect(stated).toMatchObject({ ok: true });
    expect(stated.coach).toMatchObject({ actions: [], noActionReason: 'Your time went where you said it matters; nothing needs changing.' });

    const silent = daily(modelCoach({ actions: [], noActionReason: null }));
    expect(silent.ok).toBe(true);
    expect(silent.coach.noActionReason).toBe('Nothing in the evidence calls for a change right now.');
  });

  it('accepts two actions and never more', () => {
    const second = modelAction({
      title: 'Decide whether the Project Y billing fix is finished or dropped',
      actionType: 'close_open_loop',
      daypart: 'any',
      focusMinutes: null,
      focusTask: null,
      thread: 'Project Y',
      metricKeys: ['behavior.switches'],
      rationale: 'Project Y was picked up between other threads and left again.',
    });
    expect(daily(modelCoach({ actions: [modelAction(), second] })).coach.actions).toHaveLength(2);

    const third = modelAction({
      title: 'Keep the research reading for the evening',
      actionType: 'change_timing',
      daypart: 'evening',
      focusMinutes: null,
      focusTask: null,
      thread: null,
      confidence: 0.5,
      metricKeys: ['behavior.switches'],
      rationale: 'Research was read in short pieces between other work.',
    });
    const result = daily(modelCoach({ actions: [modelAction(), second, third] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('too many actions: 3 returned, at most 2 allowed');
    // The valid subset keeps the strongest two.
    expect(result.coach.actions.map((a) => a.actionType)).toEqual(['focus_session', 'close_open_loop']);
  });

  it('quietly leaves out a weakly supported action, and merges two versions of one idea', () => {
    expect(daily(modelCoach({ actions: [modelAction({ confidence: 0.2 })] }))).toMatchObject({ ok: true, coach: { actions: [] } });
    const twin = modelAction({ title: 'A 45-minute Project X Focus block first thing' });
    expect(daily(modelCoach({ actions: [modelAction(), twin] })).coach.actions).toHaveLength(1);
  });
});

describe('validateDailyCoach — nothing is trusted', () => {
  const rejected = (action: Record<string, unknown>, ctx?: CoachContext) => {
    const result = daily(modelCoach({ actions: [modelAction(action)] }), ctx);
    expect(result.ok).toBe(false);
    expect(result.coach.actions).toEqual([]);
    // Every proposal fell, so there is no honest reason to state.
    expect(result.coach.noActionReason).toBeNull();
    return result.errors.join(' | ');
  };

  it('rejects an action with no evidence, or with evidence that does not exist', () => {
    expect(rejected({ metricKeys: [] })).toContain('cites no evidence');
    expect(rejected({ metricKeys: ['thread.invented.minutes'] })).toContain('metric "thread.invented.minutes" does not exist');
    expect(rejected({ activityRefs: ['a99'] })).toContain('activity "a99" does not exist');
    expect(rejected({ actionRefs: ['k7'] })).toContain('action "k7" does not exist');
    expect(rejected({ priorityId: 'pr-999' })).toContain('priority "pr-999" does not exist');
  });

  it('rejects numbers that are neither in the cited evidence nor the action\'s own length', () => {
    expect(rejected({ rationale: 'You switched context 31 times this afternoon.' })).toContain('number(s) "31"');
    // Copied from cited evidence, or its own focusMinutes: fine.
    const ok = daily(modelCoach({ actions: [modelAction({ rationale: 'Project X received 2h 52m today, most of it in one block.' })] }));
    expect(ok.ok).toBe(true);
  });

  it('rejects generic self-help, judgment and psychology', () => {
    expect(rejected({ title: 'Try the Pomodoro technique for Project X tomorrow' })).toContain('Pomodoro');
    expect(rejected({ rationale: 'You were unproductive in the afternoon and wasted the day.' })).toMatch(/judgment/);
    expect(rejected({ rationale: 'You seemed stressed and tired after lunch, so start earlier.' })).toMatch(/stress|tired/);
  });

  it('rejects a malformed action', () => {
    expect(rejected({ actionType: 'work_harder' })).toContain('unsupported action type');
    expect(rejected({ focusMinutes: null })).toContain('a focus_session needs focusMinutes');
    expect(rejected({ focusMinutes: 600, title: 'Run a 600-minute Focus session on Project X' })).toContain('focusMinutes must be a whole number');
    expect(rejected({ title: 'Do it' })).toContain('title is too vague to act on');
    expect(rejected({ rationale: 'Because.' })).toContain('rationale is missing');
  });

  it('does not trust a thread name the evidence does not know', () => {
    const result = daily(modelCoach({ actions: [modelAction({ thread: 'Secret Project Z' })] }));
    expect(result.ok).toBe(true);
    expect(result.coach.actions[0]).toMatchObject({ thread: null, targetKey: null });
  });

  it('survives garbage without throwing, and returns nothing usable', () => {
    for (const raw of [undefined, null, 'not an object', 42, { actions: 'many' }, { actions: [{ title: 5 }] }]) {
      const result = daily(raw);
      expect(result.ok).toBe(false);
      expect(result.coach).toMatchObject({ actions: [], followups: [], memoryAdds: [], question: null });
    }
  });
});

describe('validateDailyCoach — what the record already says', () => {
  it('never duplicates something the user already has', () => {
    for (const existing of [coachAction(), accepted(), accepted({ status: 'review' })]) {
      const result = daily(modelCoach(), context({ actions: [existing] }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('the user already has this');
      expect(result.coach.actions).toEqual([]);
    }
    // Same wording, different shape — still the same suggestion.
    const reworded = daily(modelCoach({ actions: [modelAction({ daypart: 'evening' })] }), context({ actions: [accepted()] }));
    expect(reworded.errors[0]).toContain('the user already has this');
  });

  it('never brings back what the user rejected — in any wording', () => {
    const rejected = coachAction({ status: 'rejected', reasonCode: 'bad_timing', rejectedAt: iso(11, '22:10'), createdAt: iso(11, '22:00') });
    const same = daily(modelCoach(), context({ actions: [rejected] }));
    expect(same.errors[0]).toContain('the user rejected this');

    // "Not relevant" was about the target itself: nothing else is proposed for it either.
    const notRelevant = { ...rejected, reasonCode: 'not_relevant' as const };
    const other = modelAction({ title: 'Close the Project X sync loop this week', actionType: 'close_open_loop', daypart: 'any', focusMinutes: null, focusTask: null, when: 'this_week' });
    expect(daily(modelCoach({ actions: [other] }), context({ actions: [notRelevant] })).errors[0]).toContain('the user rejected this');
    // "Bad timing" was about the shape: a different one is fine.
    expect(daily(modelCoach({ actions: [other] }), context({ actions: [rejected] })).ok).toBe(true);
  });

  it('forgets a rejection after its memory window', () => {
    const longAgo = coachAction({ status: 'rejected', reasonCode: 'bad_timing', rejectedAt: iso(-25), createdAt: iso(-25), updatedAt: iso(-25) });
    expect(daily(modelCoach(), context({ actions: [longAgo] })).ok).toBe(true);
  });

  it('does not repeat a strategy that keeps failing for this target', () => {
    const ctx = context({ actions: [notDone(9), notDone(10)] });
    const result = daily(modelCoach(), ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe(
      'action 1: a Focus session (up to an hour) in the morning has not worked out 2 times for this user (bad timing ×2); change the time of day, the size or the type — or drop it',
    );
  });

  it('accepts a real adaptation: a different time and size, tied to what it adapts', () => {
    const failed = notDone(10);
    const ctx = context({ actions: [notDone(9), failed] });
    const ref = ctx.followups.find((f) => f.action.id === failed.id)!.ref;
    const adapted = modelAction({
      title: 'Run a 25-minute Focus session on Project X after your afternoon work',
      daypart: 'evening',
      focusMinutes: 25,
      adaptsActionRef: ref,
      metricKeys: [],
      rationale: 'The morning block did not happen twice, both times for timing; this moves it and makes it smaller.',
    });
    const result = daily(modelCoach({ actions: [adapted] }), ctx);
    expect(result).toMatchObject({ ok: true });
    expect(result.coach.actions[0]).toMatchObject({ strategyKey: 'focus_session|evening|short', parentActionId: failed.id });
  });

  it('one failure is not enough to rule a strategy out', () => {
    expect(daily(modelCoach(), context({ actions: [notDone(9)] })).ok).toBe(true);
  });

  it('prefers what has worked: a proven strategy passes — aimed at what is open now, not as the same sentence', () => {
    const proven = context({ actions: [worked(7), worked(9)] });
    const next = modelCoach({ actions: [modelAction({ title: 'Run one 45-minute Focus session on the Project X conflict-resolution tests' })] });
    expect(daily(next, proven).ok).toBe(true);
    // Word for word what the user did two days ago: refused.
    expect(daily(modelCoach(), proven).errors[0]).toContain('the user already carried out');
  });
});

describe('validateDailyCoach — escalation', () => {
  const evening = { daypart: 'evening' as const, strategyKey: 'focus_session|evening|medium' };
  const failures = [notDone(8), notDone(9), notDone(10, evening)];

  it('after repeated failure it stops advising and asks — whether or not the model remembered to', () => {
    const afternoon = modelAction({ title: 'Run a 45-minute Focus session on Project X after lunch', daypart: 'afternoon' });
    const result = daily(modelCoach({ actions: [afternoon], question: null }), context({ actions: failures }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('advice for “Project X” has not worked out 3 times');
    expect(result.coach.actions).toEqual([]);
    expect(result.coach.question).toEqual({
      text: '3 suggestions about “Project X” have not worked out. Before suggesting another one, what keeps getting in the way?',
      actionId: failures[2].id,
      targetKey: 't:project-x',
    });
  });

  it('uses the model\'s own question when it asks one', () => {
    const result = daily(
      modelCoach({ actions: [], noActionReason: null, question: { text: 'What usually takes over the time you set aside for Project X?', aboutActionRef: null } }),
      context({ actions: failures }),
    );
    expect(result.ok).toBe(true);
    expect(result.coach.question).toMatchObject({ text: 'What usually takes over the time you set aside for Project X?', targetKey: 't:project-x' });
  });

  it('does not ask again while a question is still unanswered — and still recommends nothing for it', () => {
    const asked = message('coach', 'What keeps getting in the way?', iso(11, '22:00'), { kind: 'question', targetKey: 't:project-x' });
    const ctx = context({ actions: failures, messages: [asked] });
    expect(ctx.escalations[0]).toMatchObject({ alreadyAsked: true });
    const result = daily(modelCoach({ actions: [modelAction({ daypart: 'afternoon', title: 'A Project X block after lunch' })] }), ctx);
    expect(result.coach.actions).toEqual([]);
    expect(result.coach.question).toBeNull();
  });

  it('once the user has answered, advice may resume — informed, not blind', () => {
    const asked = message('coach', 'What keeps getting in the way?', iso(11, '22:00'), { kind: 'question', targetKey: 't:project-x' });
    const answer = message('user', 'Mornings are classes until 11.', iso(12, '08:00'));
    const ctx = context({ actions: failures, messages: [asked, answer] });
    expect(ctx.escalations).toEqual([]);
    const afternoon = modelAction({ title: 'Run a 45-minute Focus session on Project X after lunch', daypart: 'afternoon' });
    expect(daily(modelCoach({ actions: [afternoon] }), ctx).ok).toBe(true);
    // The morning version is still known not to work.
    expect(daily(modelCoach(), ctx).errors[0]).toContain('has not worked out 2 times');
  });

  it('drops a question nothing in the record calls for', () => {
    const result = daily(modelCoach({ question: { text: 'How are you feeling about your work lately?', aboutActionRef: null } }));
    expect(result.coach.question).toBeNull();
  });
});

describe('validateDailyCoach — follow-ups, uncertainty, memory', () => {
  const done = accepted({
    status: 'review',
    execution: 'done',
    executionSource: 'observed',
    executedAt: iso(12, '09:42'),
    observation: {
      kind: 'executed',
      observedAt: iso(12, '12:30'),
      window: { start: iso(12, '05:00'), end: iso(12, '12:00') },
      final: true,
      focusSessionIds: ['f1'],
      activityIds: [],
      focusMinutes: 42,
      matchedMinutes: 0,
      plannedMinutes: 45,
      interruptions: 1,
      facts: ['Focus session “Project X” ran 42m of 45m planned, 1 interruption.'],
    },
  });
  const ctx = context({ actions: [done] });
  const followup = (over: Record<string, unknown>) =>
    daily(modelCoach({ actions: [], noActionReason: 'Nothing needs changing today.', followups: [{ actionRef: 'k1', note: 'x', learned: null, ...over }] }), ctx);

  it('keeps a follow-up that says only what the record supports', () => {
    const result = followup({ note: 'The Focus session ran 42m of the 45m you planned, with 1 interruption.', learned: 'A morning block on Project X is realistic for you.' });
    expect(result.ok).toBe(true);
    expect(result.coach.followups).toEqual([
      { actionId: done.id, note: 'The Focus session ran 42m of the 45m you planned, with 1 interruption.', learned: 'A morning block on Project X is realistic for you.' },
    ]);
  });

  it('rejects a follow-up that invents numbers, outcomes, judgment, or an action', () => {
    expect(followup({ note: 'You focused for 90 minutes on Project X this morning.' }).errors[0]).toContain('number(s) "90" are not in that action\'s record');
    expect(followup({ note: 'The session ran as planned and it worked well for you.' }).errors[0]).toContain('the user has not said whether it helped');
    expect(followup({ note: 'You were lazy about this and procrastinated all morning.' }).errors[0]).toMatch(/judgment/);
    expect(followup({ actionRef: 'k9', note: 'This action was carried out as planned.' }).errors[0]).toContain('action "k9" does not exist');
    expect(followup({ note: 'You were lazy about this and procrastinated all morning.' }).coach.followups).toEqual([]);
  });

  it('keeps honest uncertainty and drops anything that reaches beyond the evidence', () => {
    const result = daily(
      modelCoach({
        uncertainty: [
          'I am not sure whether the afternoon research belonged to Project X or was something separate.',
          'You were probably too tired to continue after lunch.',
          'short',
        ],
      }),
    );
    expect(result.coach.uncertainty).toEqual(['I am not sure whether the afternoon research belonged to Project X or was something separate.']);
  });

  it('remembers only evidence-backed open loops and conclusions', () => {
    const add = (over: Record<string, unknown>) =>
      daily(
        modelCoach({
          actions: [],
          noActionReason: 'Nothing needs changing today.',
          memoryUpdates: [{ op: 'add', kind: 'open_loop', text: 'The Project Y billing fix was started and left unfinished.', memoryRef: null, metricKeys: ['behavior.switches'], activityRefs: [], actionRefs: [], ...over }],
        }),
        ctx,
      );
    expect(add({}).coach.memoryAdds).toEqual([{ kind: 'open_loop', text: 'The Project Y billing fix was started and left unfinished.', targetKey: null }]);
    // A conclusion drawn from an action carries that action's target.
    expect(add({ kind: 'conclusion', text: 'A morning Focus block on Project X was carried out as planned.', metricKeys: [], actionRefs: ['k1'] }).coach.memoryAdds[0]).toMatchObject({
      kind: 'conclusion',
      targetKey: 't:project-x',
    });

    expect(add({ metricKeys: [] }).errors.join(' ')).toContain('a memory must cite the evidence it rests on');
    // What the user prefers or is constrained by is theirs to state — never inferred.
    expect(add({ kind: 'preference', text: 'The user prefers working in the morning.' }).errors[0]).toContain('may only remember an open_loop or a conclusion');
    expect(add({ kind: 'constraint' }).coach.memoryAdds).toEqual([]);
  });

  it('never keeps anything about health, feelings, personality or private life', () => {
    for (const text of [
      'The user has ADHD and struggles to start tasks.',
      'The user gets anxious before deadlines.',
      'The user is a perfectionist about Project X.',
      'The user seems depressed on Mondays.',
    ]) {
      const result = daily(
        modelCoach({ memoryUpdates: [{ op: 'add', kind: 'conclusion', text, memoryRef: null, metricKeys: ['behavior.switches'], activityRefs: [], actionRefs: [] }] }),
      );
      expect(result.coach.memoryAdds).toEqual([]);
      expect(result.errors[0]).toContain('Reflect never keeps that');
      expect(findSensitiveIssue(text)).not.toBeNull();
    }
    expect(findSensitiveIssue('Mornings are taken by classes until 11.')).toBeNull();
  });

  it('does not store the same memory twice, and can resolve one by its ref', () => {
    const existing = memory('The Project Y billing fix was started and left unfinished.', { kind: 'open_loop', source: 'coach' });
    const withMemory = context({ memories: [existing] });
    const result = daily(
      modelCoach({
        memoryUpdates: [
          { op: 'add', kind: 'open_loop', text: 'Project Y billing fix was started and left unfinished', memoryRef: null, metricKeys: ['behavior.switches'], activityRefs: [], actionRefs: [] },
          { op: 'resolve', kind: null, text: null, memoryRef: 'm1', metricKeys: [], activityRefs: [], actionRefs: [] },
          { op: 'resolve', kind: null, text: null, memoryRef: 'm9', metricKeys: [], activityRefs: [], actionRefs: [] },
        ],
      }),
      withMemory,
    );
    expect(result.coach.memoryAdds).toEqual([]);
    expect(result.coach.memoryResolveIds).toEqual([existing.id]);
    expect(result.errors).toEqual(['memory update 3: memory "m9" does not exist']);
  });
});

describe('validateChat', () => {
  const open = accepted();
  const suggested = coachAction({ title: 'Decide whether the billing fix is finished', actionType: 'close_open_loop', thread: 'Project Y', focusMinutes: null, daypart: 'any' });
  const remembered = memory('Mornings are taken by classes until 11.');
  const ctx = { ...context({ actions: [open, suggested], memories: [remembered] }) };
  const chat = (raw: Record<string, unknown>, userTexts = ['How did today go?'], numbersFrom = 'Tracked 5h 12m today. Project X 2h 52m.') => {
    const contextNumbers = new Set<string>();
    addNumbersFrom(contextNumbers, numbersFrom);
    return validateChat({
      raw: modelChat(raw),
      context: ctx,
      actionRefs: new Map([['k1', open], ['k2', suggested]]),
      activityRefs: new Map([['a1', { activityId: 'ai-12-0', title: 'Implement Project X sync engine', start: iso(12, '09:00'), end: iso(12, '10:20') }]]),
      contextNumbers,
      userTexts,
    });
  };

  it('accepts a reply grounded in the context', () => {
    const result = chat({ reply: 'Project X received 2h 52m of the 5h 12m you tracked today.' });
    expect(result).toMatchObject({ ok: true, chat: { reply: 'Project X received 2h 52m of the 5h 12m you tracked today.', action: null } });
  });

  it('refuses a reply that invents a number — there is then no answer at all', () => {
    const result = chat({ reply: 'You were about 40% more focused than last week.' });
    expect(result).toMatchObject({ ok: false, chat: null });
    expect(result.errors[0]).toContain('number(s) "40" are not in the context');
    // A number the user themselves gave is fine to repeat.
    expect(chat({ reply: 'A 30 minute block is a reasonable size to start with.' }, ['Would 30 minutes be enough?']).ok).toBe(true);
  });

  it('refuses judgment and diagnosis — unless the user raised the subject', () => {
    expect(chat({ reply: 'You procrastinated on Project Y because you were stressed.' }).chat).toBeNull();
    const raised = chat({ reply: 'You said you felt tired; the record only shows that the afternoon moved between threads.' }, ['I was so tired this afternoon, why?']);
    expect(raised.ok).toBe(true);
  });

  it('records what the user said happened, through the lifecycle', () => {
    const result = chat(
      { actionUpdates: [{ actionRef: 'k1', update: 'done', reasonCode: null, note: 'Did it right after breakfast' }, { actionRef: 'k2', update: 'reject', reasonCode: 'not_relevant', note: null }] },
      ['I actually did the Project X session this morning. And the billing one is not relevant.'],
    );
    expect(result.ok).toBe(true);
    expect(result.chat!.actionUpdates).toEqual([
      { actionId: open.id, update: { kind: 'execution', execution: 'done' }, reasonCode: null, note: 'Did it right after breakfast' },
      { actionId: suggested.id, update: { kind: 'reject' }, reasonCode: 'not_relevant', note: null },
    ]);
  });

  it('keeps the reply but drops a change the record cannot take', () => {
    const result = chat({ actionUpdates: [{ actionRef: 'k2', update: 'worked', reasonCode: null, note: null }, { actionRef: 'k8', update: 'done', reasonCode: null, note: null }] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'actionUpdate 1: “Decide whether the billing fix is finished” is suggested; it cannot be marked "worked"',
      'actionUpdate 2: action "k8" does not exist',
    ]);
    expect(result.chat).toMatchObject({ reply: 'Project X is where most of your tracked time has gone.', actionUpdates: [] });
  });

  it('remembers what the user said — and nothing they did not', () => {
    const said = ['I can only do deep work after 4 PM on weekdays because of my lectures.'];
    const stated = chat({ memoryUpdates: [{ op: 'add', kind: 'constraint', text: 'Deep work only after 4 PM on weekdays (lectures).', memoryRef: null }] }, said);
    expect(stated.ok).toBe(true);
    expect(stated.chat!.memoryAdds).toEqual([{ kind: 'constraint', text: 'Deep work only after 4 PM on weekdays (lectures).', targetKey: null }]);

    const invented = chat({ memoryUpdates: [{ op: 'add', kind: 'preference', text: 'Prefers quiet cafés and jazz while coding.', memoryRef: null }] }, said);
    expect(invented.errors[0]).toContain('is not something the user said');
    expect(invented.chat!.memoryAdds).toEqual([]);

    const health = chat({ memoryUpdates: [{ op: 'add', kind: 'constraint', text: 'Has insomnia, so mornings are hard.', memoryRef: null }] }, ['I have insomnia so mornings are hard.']);
    expect(health.chat!.memoryAdds).toEqual([]);
    expect(health.errors[0]).toContain('Reflect never keeps that');
  });

  it('forgets on request', () => {
    const result = chat({ memoryUpdates: [{ op: 'remove', kind: null, text: null, memoryRef: 'm1' }] }, ['Forget what I said about classes.']);
    expect(result.chat!.memoryRemoveIds).toEqual([remembered.id]);
  });

  it('turns "that wasn\'t what I was doing" into a way to correct the activity', () => {
    const result = chat({ reply: 'You can correct that block in the Timeline.', correctionActivityRef: 'a1' }, ['That morning block was not Project X.']);
    expect(result.chat!.correction).toEqual({ activityId: 'ai-12-0', title: 'Implement Project X sync engine', start: iso(12, '09:00'), end: iso(12, '10:20') });
    expect(chat({ correctionActivityRef: 'a77' }).chat!.correction).toBeNull();
  });

  it('a proposal follows the record; a commitment the user makes is theirs to make', () => {
    const blockedCtx = { ...context({ actions: [notDone(9), notDone(10)] }) };
    const run = (committed: boolean) => {
      const contextNumbers = new Set<string>();
      return validateChat({
        raw: modelChat({ proposedAction: { ...modelAction({ metricKeys: [] }), committed } }),
        context: blockedCtx,
        actionRefs: new Map(),
        activityRefs: new Map(),
        contextNumbers,
        userTexts: ['I will do a 45 minute Project X session tomorrow morning.'],
      });
    };
    expect(run(false).errors[0]).toContain('has not worked out 2 times');
    expect(run(false).chat!.action).toBeNull();
    expect(run(true).chat!.action).toMatchObject({ committed: true, strategyKey: 'focus_session|morning|medium' });
  });

  it('never proposes what the user already has', () => {
    const result = chat({ proposedAction: { ...modelAction({ metricKeys: [] }), committed: true } }, ['I will do a 45 minute Project X session tomorrow morning.']);
    expect(result.errors[0]).toContain('the user already has this');
    expect(result.chat!.action).toBeNull();
  });

  it('survives garbage', () => {
    for (const raw of [null, 'text', { reply: 5 }]) {
      const result = validateChat({ raw, context: ctx, actionRefs: new Map(), activityRefs: new Map(), contextNumbers: new Set(), userTexts: [] });
      expect(result).toMatchObject({ ok: false, chat: null });
    }
  });
});
