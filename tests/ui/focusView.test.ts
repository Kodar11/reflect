import { describe, it, expect } from 'vitest';
import {
  blockingDetail,
  blockingSummary,
  blockingView,
  cleanIpcError,
  endDialogCopy,
  formatClock,
  formatDurationLabel,
  formatMinutes,
  phraseMatches,
  pickDefaultProfile,
  profileSummary,
  recentTasks,
  startProblem,
  stateLabel,
  summaryView,
  timerView,
} from '../../src/ui/Focus/focusView';
import { MIN, T0, active, challenge, iso, profile, session, stopwatch } from './focusFixtures';

describe('clock formatting', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [61_000, '1:01'],
    [52 * MIN + 14_000, '52:14'],
    [60 * MIN, '1:00:00'],
    [2 * 60 * MIN + 5 * MIN + 9000, '2:05:09'],
    [-5000, '0:00'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });

  it('formats minutes and durations', () => {
    expect(formatMinutes(54 * MIN)).toBe('54 min');
    expect(formatMinutes(20_000)).toBe('under 1 min');
    expect(formatDurationLabel(25)).toBe('25 min');
    expect(formatDurationLabel(60)).toBe('1 hr');
    expect(formatDurationLabel(90)).toBe('1 hr 30 min');
    expect(formatDurationLabel(120)).toBe('2 hr');
  });
});

describe('timer', () => {
  it('a countdown shows the time remaining in the commitment', () => {
    expect(timerView(active(), T0)).toMatchObject({ clock: '1:00:00', label: 'remaining' });
    expect(timerView(active(), T0 + 7 * MIN + 46_000)).toMatchObject({ clock: '52:14', label: 'remaining' });
  });

  it('a countdown reads 0:00 only once the commitment is over, never negative', () => {
    expect(timerView(active(), T0 + 60 * MIN - 400).clock).toBe('0:01');
    expect(timerView(active(), T0 + 60 * MIN).clock).toBe('0:00');
    expect(timerView(active(), T0 + 90 * MIN).clock).toBe('0:00');
  });

  it('a paused countdown is frozen at the time that was left', () => {
    const paused = active(
      { isRunning: false, pauseKind: 'manual', plannedEndsAt: null, remainingMs: 50 * MIN },
      { state: 'paused', pausedAt: iso(T0 + 10 * MIN), elapsedMs: 10 * MIN },
    );
    expect(timerView(paused, T0 + 15 * MIN).clock).toBe('50:00');
    expect(timerView(paused, T0 + 3 * 60 * MIN).clock).toBe('50:00');
  });

  it('a resumed countdown continues from where it was paused', () => {
    // 10 min worked, 5 min paused → the end moved from +60 to +65.
    const resumed = active({ plannedEndsAt: iso(T0 + 65 * MIN) }, { totalPauseMs: 5 * MIN, elapsedMs: 10 * MIN });
    expect(timerView(resumed, T0 + 15 * MIN).clock).toBe('50:00');
    expect(timerView(resumed, T0 + 16 * MIN).clock).toBe('49:00');
  });

  it('a stopwatch shows active time and excludes pauses', () => {
    const running = stopwatch({}, { totalPauseMs: 5 * MIN });
    expect(timerView(running, T0 + 57 * MIN + 14_000)).toMatchObject({ clock: '52:14', label: 'elapsed' });
  });

  it('a paused stopwatch is frozen at the active time so far', () => {
    const paused = stopwatch({ isRunning: false, pauseKind: 'manual' }, { state: 'paused', elapsedMs: 12 * MIN + 30_000 });
    expect(timerView(paused, T0 + 20 * MIN).clock).toBe('12:30');
    expect(timerView(paused, T0 + 50 * MIN).clock).toBe('12:30');
  });

  it('does not drift: the value depends only on timestamps and the clock', () => {
    const dto = active();
    const a = timerView(dto, T0 + 123_456);
    const b = timerView(structuredClone(dto), T0 + 123_456);
    expect(a).toEqual(b);
  });
});

describe('state and blocking labels', () => {
  it('names the session state', () => {
    expect(stateLabel(active())).toBe('Focusing');
    expect(stateLabel(active({ isRunning: false, pauseKind: 'manual' }))).toBe('Paused');
    expect(stateLabel(active({ isRunning: false, pauseKind: 'idle' }))).toBe('Paused — no activity');
  });

  it('only says "Blocking active" when it is', () => {
    expect(blockingView({ status: 'active', ruleCount: 5, message: null })).toMatchObject({ text: 'Blocking active', tone: 'ok', canRestore: false });
    for (const status of ['off', 'recovering', 'degraded', 'unavailable'] as const) {
      expect(blockingView({ status, ruleCount: 5, message: null }).text).not.toBe('Blocking active');
    }
    expect(blockingView({ status: 'degraded', ruleCount: 5, message: 'The blocker stopped responding.' })).toMatchObject({
      text: 'Blocking stopped',
      tone: 'warn',
      detail: 'The blocker stopped responding.',
      canRestore: true,
    });
    expect(blockingView({ status: 'recovering', ruleCount: 5, message: null })).toMatchObject({ tone: 'warn', canRestore: false });
  });

  it('summarizes a profile as a preset', () => {
    expect(blockingSummary(profile())).toBe('Blocking: 5 rules');
    expect(blockingSummary(profile({ blocking: { enabled: true, ruleCount: 1, siteCount: 3, appCount: 0 } }))).toBe('Blocking: 1 rule');
    expect(blockingSummary(profile({ blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } }))).toBe('Blocking off');
    expect(blockingDetail(profile())).toBe('38 sites · 4 apps');
    expect(blockingDetail(profile({ blocking: { enabled: true, ruleCount: 1, siteCount: 1, appCount: 0 } }))).toBe('1 site');
    expect(blockingDetail(profile({ blocking: { enabled: false, ruleCount: 0, siteCount: 0, appCount: 0 } }))).toBe('');
    expect(profileSummary(profile())).toBe('1 hr · Blocking: 5 rules');
    expect(profileSummary(profile({ mode: 'stopwatch', defaultDurationMinutes: null }))).toBe('No time limit · Blocking: 5 rules');
  });
});

describe('default profile', () => {
  const a = profile({ id: 'a', isDefault: false });
  const b = profile({ id: 'b', isDefault: true });
  const c = profile({ id: 'c', isDefault: false });

  it('prefers the remembered profile, then the flagged default, then the first', () => {
    expect(pickDefaultProfile([a, b, c], 'c')?.id).toBe('c');
    expect(pickDefaultProfile([a, b, c], null)?.id).toBe('b');
    expect(pickDefaultProfile([a, b, c], 'deleted')?.id).toBe('b');
    expect(pickDefaultProfile([a, c], null)?.id).toBe('a');
    expect(pickDefaultProfile([], 'a')).toBeNull();
  });
});

describe('start validation', () => {
  const draft = { task: 'Finish authentication', mode: 'countdown' as const, durationMinutes: 60, profileId: 'profile-1' };

  it('accepts a task, a profile and a sane duration', () => {
    expect(startProblem(draft)).toBeNull();
    expect(startProblem({ ...draft, mode: 'stopwatch', durationMinutes: NaN })).toBeNull();
  });

  it.each([
    [{ task: '   ' }, /focusing on/],
    [{ task: 'x'.repeat(201) }, /under 200/],
    [{ durationMinutes: 0 }, /duration/],
    [{ durationMinutes: 721 }, /duration/],
    [{ durationMinutes: NaN }, /duration/],
    [{ durationMinutes: 12.5 }, /duration/],
    [{ profileId: null }, /profile/],
  ])('rejects %j', (patch, message) => {
    expect(startProblem({ ...draft, ...patch })).toMatch(message);
  });
});

describe('summary', () => {
  it('a completed countdown: planned and active time', () => {
    const view = summaryView(session({ state: 'completed', endReason: 'completed', endedAt: iso(T0 + 60 * MIN), elapsedMs: 54 * MIN }));
    expect(view).toEqual({ title: 'Focus complete', task: 'Finish authentication', lines: ['60 min planned', '54 min active'] });
  });

  it('an early end: active time and what was left', () => {
    const view = summaryView(session({ state: 'cancelled', endReason: 'ended-early', endedAt: iso(T0 + 17 * MIN), elapsedMs: 17 * MIN }));
    expect(view).toEqual({ title: 'Focus ended', task: 'Finish authentication', lines: ['17 min active', '43 min remaining'] });
  });

  it('a finished stopwatch: active time only', () => {
    const view = summaryView(
      session({ mode: 'stopwatch', plannedDurationMinutes: null, state: 'completed', endReason: 'finished', endedAt: iso(T0 + 60 * MIN), elapsedMs: 52 * MIN }),
    );
    expect(view).toEqual({ title: 'Focus complete', task: 'Finish authentication', lines: ['52 min active'] });
  });

  it('an abandoned session is stated plainly', () => {
    const view = summaryView(session({ state: 'cancelled', endReason: 'abandoned', endedAt: iso(T0 + 10 * MIN), elapsedMs: 10 * MIN }));
    expect(view).toEqual({ title: 'Focus ended', task: 'Finish authentication', lines: ['10 min active'] });
  });

  it('never calls an early end complete, and never judges', () => {
    const early = summaryView(session({ state: 'cancelled', endReason: 'ended-early', endedAt: iso(T0 + 2 * MIN), elapsedMs: 2 * MIN }));
    const text = [early.title, ...early.lines].join(' ').toLowerCase();
    expect(text).not.toContain('complete');
    for (const word of ['gave up', 'failed', 'quit', 'only', 'score', 'streak', 'should']) expect(text).not.toContain(word);
  });
});

describe('exit dialog', () => {
  it('an early end states what is left and labels the way out "End Anyway"', () => {
    expect(endDialogCopy(challenge())).toEqual({
      title: 'End Focus?',
      body: ['You still have 38 minutes remaining.', 'Your commitment is still active.'],
      confirmLabel: 'End Anyway',
    });
    expect(endDialogCopy(challenge({ remainingMs: 20_000 })).body[0]).toBe('You still have 1 minute remaining.');
  });

  it('a stopwatch needs only a plain confirmation', () => {
    const copy = endDialogCopy(challenge({ early: false, requiresPhrase: false, remainingMs: null }));
    expect(copy.confirmLabel).toBe('End Focus');
    expect(copy.body.join(' ')).not.toContain('remaining');
  });

  it('accepts the phrase regardless of case and padding, and nothing else', () => {
    const c = challenge();
    expect(phraseMatches('END', c)).toBe(true);
    expect(phraseMatches('  end ', c)).toBe(true);
    for (const typed of ['', 'EN', 'ENDD', 'stop', 'e n d']) expect(phraseMatches(typed, c)).toBe(false);
    expect(phraseMatches('', challenge({ requiresPhrase: false }))).toBe(true);
  });
});

describe('small helpers', () => {
  it('strips the IPC wrapper from errors', () => {
    expect(cleanIpcError(new Error("Error invoking remote method 'focus:start': FocusError: Administrator permission was declined. Focus was not started."))).toBe(
      'Administrator permission was declined. Focus was not started.',
    );
    expect(cleanIpcError(new Error('Plain message'))).toBe('Plain message');
    expect(cleanIpcError(new Error("Error invoking remote method 'focus:confirmEnd': Error: nope"))).toBe('nope');
  });

  it('offers distinct recent tasks, newest first', () => {
    const tasks = recentTasks([
      session({ task: 'Write proposal' }),
      session({ task: 'write proposal ' }),
      session({ task: 'Review PRs' }),
      session({ task: '  ' }),
      session({ task: 'Refactor auth' }),
      session({ task: 'Fourth' }),
    ]);
    expect(tasks).toEqual(['Write proposal', 'Review PRs', 'Refactor auth']);
  });
});
