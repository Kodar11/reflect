import { describe, it, expect } from 'vitest';
import {
  daypartWindow,
  describeStrategy,
  describeTarget,
  isObservable,
  isSameSuggestion,
  observeAction,
  resolveTarget,
  shiftWindowByDay,
  sizeBucket,
  strategyKeyOf,
  targetKeyOf,
  titleSimilarity,
  tokensOf,
} from '../../src/coach/CoachMatching';
import { DEFAULT_COACH_CONFIG, type CoachAction } from '../../src/coach/CoachModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { activity, browsing, iso, local, projectX, projectY } from '../reflection/helpers';
import { accepted, coachAction, focusFact } from './helpers';

const observe = (action: CoachAction, at: string, focus = [] as ReturnType<typeof focusFact>[], activities = [] as ReturnType<typeof activity>[], priorityText: string | null = null) =>
  observeAction({ action, nowIso: at, focus, activities, priorityText, config: DEFAULT_COACH_CONFIG });

describe('identity: what counts as the same recommendation', () => {
  it('a strategy is its type, its time of day and its size', () => {
    expect(strategyKeyOf({ actionType: 'focus_session', daypart: 'morning', focusMinutes: 45 })).toBe('focus_session|morning|medium');
    expect(strategyKeyOf({ actionType: 'focus_session', daypart: 'evening', focusMinutes: 45 })).toBe('focus_session|evening|medium');
    expect(strategyKeyOf({ actionType: 'focus_session', daypart: 'morning', focusMinutes: 25 })).toBe('focus_session|morning|short');
    expect(strategyKeyOf({ actionType: 'drop', daypart: 'any', focusMinutes: null })).toBe('drop|any|none');
    expect([sizeBucket(null), sizeBucket(30), sizeBucket(60), sizeBucket(61)]).toEqual(['none', 'short', 'medium', 'long']);
    expect(describeStrategy('focus_session|morning|short')).toBe('a Focus session (30 minutes or less) in the morning');
    expect(describeStrategy('rest|any|none')).toBe('deliberate rest');
  });

  it('a target is the priority it serves, else the thread', () => {
    expect(targetKeyOf({ priorityId: 'pr-1', thread: 'Project X' })).toBe('p:pr-1');
    expect(targetKeyOf({ priorityId: null, thread: 'Project  X' })).toBe('t:project-x');
    expect(targetKeyOf({ priorityId: null, thread: null })).toBeNull();
  });

  it('ignores filler words and numbers when comparing wording', () => {
    expect([...tokensOf('Run one 45-minute Focus session on Planmay tomorrow morning')]).toEqual(['planmay']);
    expect(titleSimilarity('Protect the first hour for Planmay onboarding', 'Keep an hour for the Planmay onboarding flow')).toBeGreaterThan(0.6);
    expect(titleSimilarity('Protect an hour for Planmay', 'Stop carrying the billing loop')).toBe(0);
  });

  it('two suggestions are one when strategy and target match, or the wording does', () => {
    const a = coachAction();
    expect(isSameSuggestion(a, coachAction({ title: 'Something phrased completely differently' }), 0.6)).toBe(true);
    expect(isSameSuggestion(a, coachAction({ daypart: 'evening', title: 'An evening block on billing' }), 0.6)).toBe(false);
    expect(isSameSuggestion(a, coachAction({ daypart: 'evening', title: a.title }), 0.6)).toBe(true);
  });
});

describe('timing: "tomorrow morning" becomes a window', () => {
  const day12 = periodContaining('day', local(12));

  it('resolves dayparts inside the target day', () => {
    expect(daypartWindow(periodContaining('day', local(13)), 'morning')).toEqual({ start: iso(13, '05:00'), end: iso(13, '12:00') });
    expect(daypartWindow(periodContaining('day', local(13)), 'any')).toEqual({ start: iso(13), end: iso(14) });
    // "Night" runs past midnight; it is clipped to the day it belongs to.
    expect(daypartWindow(periodContaining('day', local(13)), 'night')).toEqual({ start: iso(13, '22:00'), end: iso(14) });
  });

  it('"tomorrow" is the day after the report\'s day', () => {
    expect(resolveTarget('tomorrow', 'morning', day12, local(12, '22:05'))).toEqual({ start: iso(13, '05:00'), end: iso(13, '12:00') });
  });

  it('"today" only exists while the day is running and the window has not passed', () => {
    expect(resolveTarget('today', 'evening', day12, local(12, '15:00'))).toEqual({ start: iso(12, '17:00'), end: iso(12, '22:00') });
    // The morning is over: it becomes tomorrow morning.
    expect(resolveTarget('today', 'morning', day12, local(12, '15:00'))).toEqual({ start: iso(13, '05:00'), end: iso(13, '12:00') });
    // The day is over.
    expect(resolveTarget('today', 'any', day12, local(13, '00:10'))).toEqual({ start: iso(13), end: iso(14) });
  });

  it('a report written long after its day speaks about the day now running', () => {
    expect(resolveTarget('tomorrow', 'any', day12, local(15, '09:00'))).toEqual({ start: iso(15), end: iso(16) });
  });

  it('"this week" is the seven days after the report\'s day', () => {
    expect(resolveTarget('this_week', 'any', day12, local(12, '22:00'))).toEqual({ start: iso(13), end: iso(20) });
  });

  it('labels a target relative to now, and shifts a postponed one by a day', () => {
    const action = coachAction();
    expect(describeTarget(action, local(12, '22:00'))).toBe('Tomorrow · morning');
    expect(describeTarget(action, local(13, '08:00'))).toBe('Today · morning');
    expect(describeTarget(action, local(14, '08:00'))).toBe('Yesterday · morning');
    expect(describeTarget(action, local(20, '08:00'))).toBe('Tue, Oct 13 · morning');
    expect(describeTarget(coachAction({ targetStart: iso(13), targetEnd: iso(20), daypart: 'any' }), local(12, '22:00'))).toBe('This week');
    expect(shiftWindowByDay(iso(13, '05:00'), iso(13, '12:00'))).toEqual({ start: iso(14, '05:00'), end: iso(14, '12:00') });
  });
});

describe('execution detection: did it actually happen?', () => {
  it('a matching Focus session of the planned length is execution, observed', () => {
    const result = observe(accepted(), iso(13, '12:30'), [focusFact(13, '09:00', 42, { plannedMinutes: 45, interruptionCount: 1 })]);
    expect(result).toMatchObject({ execution: 'done', executedAt: iso(13, '09:42') });
    expect(result.observation).toMatchObject({ kind: 'executed', final: true, focusMinutes: 42, plannedMinutes: 45, interruptions: 1 });
    expect(result.observation.facts[0]).toBe('Focus session “Project X” ran 42m of 45m planned, 1 interruption.');
  });

  it('is settled as soon as the session ends — it does not wait for the window to close', () => {
    const result = observe(accepted(), iso(13, '09:50'), [focusFact(13, '09:00', 45)]);
    expect(result.observation).toMatchObject({ kind: 'executed', final: false });
    expect(result.execution).toBe('done');
  });

  it('a Focus session that was ended early is partial execution, with the user\'s reason', () => {
    const result = observe(accepted(), iso(13, '12:30'), [
      focusFact(13, '09:00', 15, { plannedMinutes: 45, endReason: 'ended-early', endNote: 'call came in' }),
    ]);
    expect(result.execution).toBe('partial');
    expect(result.observation.facts[0]).toBe('Focus session “Project X” ran 15m of 45m planned, ended early (“call came in”).');
  });

  it('the session started for the action counts whatever it was called', () => {
    const action = accepted({ linkedFocusSessionId: 'focus-13-09:00' });
    const result = observe(action, iso(13, '12:30'), [focusFact(13, '09:00', 45, { task: 'deep work' })]);
    expect(result.execution).toBe('done');
    expect(result.observation.focusSessionIds).toEqual(['focus-13-09:00']);
  });

  it('work on the target outside Focus is an attempt — not full execution of a Focus suggestion', () => {
    const result = observe(accepted(), iso(13, '12:30'), [], [projectX(13, '09:00', 50)]);
    expect(result.observation).toMatchObject({ kind: 'attempted', matchedMinutes: 50 });
    expect(result.execution).toBe('partial');
    expect(result.observation.facts).toContain('The work happened, but not as a Focus session.');
  });

  it('nothing matching in the window is "not observed" — stated, never judged', () => {
    const result = observe(accepted(), iso(13, '12:30'), [], [browsing(13, '09:00', 40), projectY(13, '10:00', 30)]);
    expect(result).toMatchObject({ execution: null, executedAt: null });
    expect(result.observation).toMatchObject({ kind: 'not_observed', final: true, matchedMinutes: 0 });
    expect(result.observation.facts).toEqual(['Nothing matching was observed between Tue, Oct 13, 5:00 AM and 12:00 PM.']);
  });

  it('before the window has ended, "nothing yet" is not a conclusion', () => {
    const result = observe(accepted(), iso(13, '08:00'));
    expect(result.observation).toMatchObject({ kind: 'not_observed', final: false });
  });

  it('weak or conflicting evidence is ambiguous: the user is asked', () => {
    // A little matching work — not enough to call it either way.
    const little = observe(accepted(), iso(13, '12:30'), [], [projectX(13, '09:00', 12)]);
    expect(little).toMatchObject({ execution: null });
    expect(little.observation.kind).toBe('ambiguous');

    // A Focus session ran in the window, but on something else.
    const other = observe(accepted(), iso(13, '12:30'), [focusFact(13, '09:00', 45, { task: 'Fix billing bug' })]);
    expect(other.observation.kind).toBe('ambiguous');
    expect(other.observation.facts).toContain('A Focus session on something else ran in that window (“Fix billing bug”).');
  });

  it('a session still running settles nothing', () => {
    const result = observe(accepted(), iso(13, '12:30'), [focusFact(13, '11:50', 40, { endedAt: null })]);
    expect(result.execution).toBeNull();
    expect(result.observation).toMatchObject({ kind: 'ambiguous', final: false });
  });

  it('without a planned length, enough work on the target counts as carried out', () => {
    const action = accepted({ actionType: 'protect_priority', focusMinutes: null, focusTask: null, priorityId: 'pr-1', thread: null });
    const linked = projectX(13, '09:00', 35, { priorityId: 'pr-1' });
    expect(observe(action, iso(13, '12:30'), [], [linked], 'Launching Project X')).toMatchObject({ execution: 'done' });
    expect(observe(action, iso(13, '12:30'), [], [projectX(13, '09:00', 8, { priorityId: 'pr-1' })]).observation.kind).toBe('ambiguous');
    expect(observe(action, iso(13, '12:30'), [], [projectY(13, '09:00', 60)]).observation.kind).toBe('not_observed');
  });

  it('only counts the part of an activity inside the window', () => {
    const action = accepted({ actionType: 'protect_priority', focusMinutes: null, focusTask: null });
    // 11:30–12:30: half of it is inside the morning.
    const result = observe(action, iso(13, '13:00'), [], [projectX(13, '11:30', 60)]);
    expect(result.observation.matchedMinutes).toBe(30);
    expect(result.execution).toBe('done');
  });

  it('some actions leave no trace: Reflect says so and asks', () => {
    for (const actionType of ['rest', 'drop', 'clarify_priority', 'avoid_pattern'] as const) {
      const action = accepted({ actionType, focusMinutes: null, focusTask: null });
      expect(isObservable(action)).toBe(false);
      const result = observe(action, iso(13, '12:30'), [], [projectX(13, '09:00', 60)]);
      expect(result).toMatchObject({ execution: null });
      expect(result.observation.kind).toBe('unobservable');
    }
  });

  it('an action with no window is watched from the moment it was accepted', () => {
    const action = accepted({ targetStart: null, targetEnd: null });
    expect(observe(action, iso(13, '10:00'), [focusFact(13, '09:00', 45)]).execution).toBe('done');
    // Two days later with nothing seen, the watch is over.
    expect(observe(action, iso(15, '09:00')).observation).toMatchObject({ kind: 'not_observed', final: true });
  });
});
