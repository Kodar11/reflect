import { describe, it, expect } from 'vitest';
import { CoachTransitionError, applyTransition, canTransition, isTerminal, pendingInput } from '../../src/coach/CoachLifecycle';
import type { CoachObservation } from '../../src/coach/CoachModels';
import { iso } from '../reflection/helpers';
import { accepted, coachAction } from './helpers';

const NOW = iso(13, '21:00');

function observation(kind: CoachObservation['kind'], final = true): CoachObservation {
  return {
    kind,
    observedAt: NOW,
    window: { start: iso(13, '05:00'), end: iso(13, '12:00') },
    final,
    focusSessionIds: [],
    activityIds: [],
    focusMinutes: 0,
    matchedMinutes: 0,
    plannedMinutes: 45,
    interruptions: 0,
    facts: [],
  };
}

describe('coach action lifecycle — decisions', () => {
  it('accepting a suggestion makes it a commitment', () => {
    const next = applyTransition(coachAction(), { type: 'accept' }, NOW);
    expect(next).toMatchObject({ status: 'accepted', acceptedAt: NOW, updatedAt: NOW });
    expect(pendingInput(next)).toBeNull();
  });

  it('suggested → rejected is a complete lifecycle, with its reason', () => {
    const next = applyTransition(coachAction(), { type: 'reject', reasonCode: 'bad_timing', note: 'Mornings are classes' }, NOW);
    expect(next).toMatchObject({ status: 'rejected', rejectedAt: NOW, closedAt: NOW, reasonCode: 'bad_timing', note: 'Mornings are classes' });
    expect(isTerminal(next.status)).toBe(true);
    expect(() => applyTransition(next, { type: 'accept' }, NOW)).toThrow(CoachTransitionError);
  });

  it('"Not now" postpones once; a second "Not now" is an answer', () => {
    const snoozed = applyTransition(coachAction(), { type: 'snooze', until: iso(13) }, NOW);
    expect(snoozed).toMatchObject({ status: 'snoozed', snoozedUntil: iso(13), snoozeCount: 1 });

    const back = applyTransition(snoozed, { type: 'resurface', targetStart: iso(14, '05:00'), targetEnd: iso(14, '12:00') }, iso(13));
    expect(back).toMatchObject({ status: 'suggested', snoozedUntil: null, targetStart: iso(14, '05:00') });

    const again = applyTransition(back, { type: 'snooze', until: iso(14) }, iso(13, '09:00'));
    expect(again).toMatchObject({ status: 'expired', reasonCode: 'bad_timing' });
  });

  it('a suggestion can be accepted straight from "Not now"', () => {
    const snoozed = applyTransition(coachAction(), { type: 'snooze', until: iso(13) }, NOW);
    expect(applyTransition(snoozed, { type: 'accept' }, NOW)).toMatchObject({ status: 'accepted', snoozedUntil: null });
  });

  it('an undecided suggestion expires or is withdrawn; neither is a rejection', () => {
    expect(applyTransition(coachAction(), { type: 'expire' }, NOW)).toMatchObject({ status: 'expired', rejectedAt: null, reasonCode: null });
    expect(applyTransition(coachAction(), { type: 'withdraw' }, NOW)).toMatchObject({ status: 'withdrawn', rejectedAt: null });
    expect(canTransition('accepted', 'withdraw')).toBe(false); // what the user decided on is never withdrawn
    expect(canTransition('accepted', 'expire')).toBe(false);
  });

  it('editing keeps the state and remembers that the user changed it', () => {
    const next = applyTransition(coachAction(), { type: 'edit', patch: { title: 'A 25-minute block on Project X', focusMinutes: 25 } }, NOW);
    expect(next).toMatchObject({ status: 'suggested', title: 'A 25-minute block on Project X', focusMinutes: 25, userEdited: true });
    // An absent field is left alone.
    expect(next.daypart).toBe('morning');
    expect(() => applyTransition({ ...next, status: 'closed' }, { type: 'edit', patch: { title: 'x' } }, NOW)).toThrow(CoachTransitionError);
  });

  it('starting it as a Focus session is a commitment', () => {
    const next = applyTransition(coachAction(), { type: 'link_focus', sessionId: 'focus-1' }, NOW);
    expect(next).toMatchObject({ status: 'accepted', acceptedAt: NOW, linkedFocusSessionId: 'focus-1' });
    const already = applyTransition(accepted(), { type: 'link_focus', sessionId: 'focus-1' }, NOW);
    expect(already.acceptedAt).toBe(iso(12, '22:05'));
  });
});

describe('coach action lifecycle — did it happen, and did it help', () => {
  it('observed execution opens the question "did it help?" — it does not answer it', () => {
    const next = applyTransition(
      accepted(),
      { type: 'observe', observation: observation('executed'), execution: 'done', executedAt: iso(13, '09:45') },
      NOW,
    );
    expect(next).toMatchObject({ status: 'review', execution: 'done', executionSource: 'observed', executedAt: iso(13, '09:45'), outcome: null });
    expect(pendingInput(next)).toBe('outcome');
  });

  it('"not observed" asks the user; it never records a failure on its own', () => {
    const next = applyTransition(accepted(), { type: 'observe', observation: observation('not_observed'), execution: null, executedAt: null }, NOW);
    expect(next).toMatchObject({ status: 'review', execution: null, executionSource: null, outcome: null });
    expect(pendingInput(next)).toBe('execution');
  });

  it('an inconclusive observation before the window ends changes nothing but what was seen', () => {
    const next = applyTransition(accepted(), { type: 'observe', observation: observation('ambiguous', false), execution: null, executedAt: null }, NOW);
    expect(next.status).toBe('accepted');
    expect(next.observation?.kind).toBe('ambiguous');
  });

  it('what the user said outranks what Reflect inferred', () => {
    const userSaid = applyTransition(accepted(), { type: 'execution', execution: 'done', reasonCode: null, note: null }, iso(13, '10:00'));
    expect(userSaid).toMatchObject({ status: 'review', execution: 'done', executionSource: 'user' });
    const observed = applyTransition(userSaid, { type: 'observe', observation: observation('not_observed'), execution: null, executedAt: null }, NOW);
    expect(observed).toMatchObject({ execution: 'done', executionSource: 'user' });
  });

  it('"I didn\'t do it" ends the lifecycle with a reason and no outcome', () => {
    const next = applyTransition(accepted(), { type: 'execution', execution: 'not_done', reasonCode: 'external_constraint', note: 'A deadline moved' }, NOW);
    expect(next).toMatchObject({
      status: 'closed',
      execution: 'not_done',
      executionSource: 'user',
      executedAt: null,
      outcome: null,
      reasonCode: 'external_constraint',
      note: 'A deadline moved',
      closedAt: NOW,
    });
  });

  it('a completed action can still be a bad recommendation', () => {
    const done = applyTransition(accepted(), { type: 'execution', execution: 'done', reasonCode: null, note: null }, NOW);
    const next = applyTransition(done, { type: 'outcome', outcome: 'did_not_work', reasonCode: 'too_difficult', note: null }, NOW);
    expect(next).toMatchObject({ status: 'closed', execution: 'done', outcome: 'did_not_work', reasonCode: 'too_difficult', outcomeAt: NOW });
  });

  it('rating an outcome implies it was tried; "not applicable" does not', () => {
    const rated = applyTransition(accepted(), { type: 'outcome', outcome: 'worked', reasonCode: null, note: null }, NOW);
    expect(rated).toMatchObject({ status: 'closed', outcome: 'worked', execution: 'done', executionSource: 'user' });

    const inapplicable = applyTransition(accepted(), { type: 'outcome', outcome: 'not_applicable', reasonCode: null, note: null }, NOW);
    expect(inapplicable).toMatchObject({ status: 'closed', outcome: 'not_applicable', execution: null, reasonCode: 'not_applicable' });
  });

  it('the user can correct a closed action: "I actually completed this"', () => {
    const closed = applyTransition(accepted(), { type: 'execution', execution: 'not_done', reasonCode: 'bad_timing', note: null }, NOW);
    const corrected = applyTransition(closed, { type: 'execution', execution: 'done', reasonCode: null, note: null }, iso(14, '08:00'));
    // It happened after all — so whether it helped is open again.
    expect(corrected).toMatchObject({ status: 'review', execution: 'done', executionSource: 'user', reasonCode: null, closedAt: null });
    const rated = applyTransition(corrected, { type: 'outcome', outcome: 'worked', reasonCode: null, note: null }, iso(14, '08:01'));
    expect(rated).toMatchObject({ status: 'closed', outcome: 'worked' });
    // And an outcome can be revised later.
    expect(applyTransition(rated, { type: 'outcome', outcome: 'partly_worked', reasonCode: null, note: null }, iso(15))).toMatchObject({
      status: 'closed',
      outcome: 'partly_worked',
    });
  });

  it('an unanswered review closes without inventing an outcome', () => {
    const review = applyTransition(accepted(), { type: 'observe', observation: observation('not_observed'), execution: null, executedAt: null }, NOW);
    const closed = applyTransition(review, { type: 'timeout' }, iso(19));
    expect(closed).toMatchObject({ status: 'closed', execution: null, outcome: null });
  });

  it('refuses transitions that make no sense', () => {
    expect(() => applyTransition(coachAction(), { type: 'outcome', outcome: 'worked', reasonCode: null, note: null }, NOW)).toThrow(/suggested/);
    expect(() => applyTransition(coachAction({ status: 'rejected' }), { type: 'execution', execution: 'done', reasonCode: null, note: null }, NOW)).toThrow();
    expect(() => applyTransition(coachAction({ status: 'withdrawn' }), { type: 'accept' }, NOW)).toThrow();
    expect(canTransition('review', 'timeout')).toBe(true);
    expect(canTransition('accepted', 'timeout')).toBe(false);
  });

  it('never mutates its input', () => {
    const before = accepted();
    const snapshot = structuredClone(before);
    applyTransition(before, { type: 'outcome', outcome: 'worked', reasonCode: null, note: 'x' }, NOW);
    expect(before).toEqual(snapshot);
  });
});
