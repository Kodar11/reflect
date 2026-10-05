import { describe, it, expect } from 'vitest';
import {
  describeReasons,
  effectivenessLines,
  findEscalations,
  isBlocked,
  learnedStatements,
  signalOf,
  summarizeEffectiveness,
  verdictOf,
} from '../../src/coach/CoachEffectiveness';
import { DEFAULT_COACH_CONFIG as CONFIG, type CoachObservation } from '../../src/coach/CoachModels';
import { iso } from '../reflection/helpers';
import { accepted, coachAction, notDone, worked } from './helpers';

const NOW = iso(20, '22:00');
const label = (key: string | null) => (key === 't:project-x' ? 'Project X' : key);
const notObserved: CoachObservation = {
  kind: 'not_observed',
  observedAt: iso(13, '12:30'),
  window: { start: iso(13, '05:00'), end: iso(13, '12:00') },
  final: true,
  focusSessionIds: [],
  activityIds: [],
  focusMinutes: 0,
  matchedMinutes: 0,
  plannedMinutes: 45,
  interruptions: 0,
  facts: [],
};

describe('how one action counts toward learning', () => {
  it('separates success, failure, and "says nothing yet"', () => {
    expect(signalOf(worked(12))).toBe('success');
    expect(signalOf(worked(12, { outcome: 'partly_worked' }))).toBe('partial_success');
    expect(signalOf(worked(12, { outcome: 'did_not_work' }))).toBe('failure'); // done, and still a bad recommendation
    expect(signalOf(worked(12, { outcome: 'not_applicable' }))).toBe('failure');
    expect(signalOf(notDone(12))).toBe('failure');
    expect(signalOf(coachAction())).toBe('pending');
    expect(signalOf(accepted())).toBe('pending');
  });

  it('a window that passed unseen and unanswered counts — an unrated completion does not', () => {
    expect(signalOf(accepted({ status: 'review', observation: notObserved }))).toBe('failure');
    expect(signalOf(accepted({ status: 'closed', observation: notObserved }))).toBe('failure');
    expect(signalOf(accepted({ status: 'review', execution: 'done', executionSource: 'observed' }))).toBe('pending');
    expect(signalOf(accepted({ status: 'closed', execution: 'done', executionSource: 'observed' }))).toBe('neutral');
  });

  it('"already doing it" is not a failure; never-decided and replaced suggestions are not either', () => {
    expect(signalOf(coachAction({ status: 'rejected', reasonCode: 'already_doing' }))).toBe('neutral');
    expect(signalOf(coachAction({ status: 'rejected', reasonCode: 'bad_timing' }))).toBe('failure');
    expect(signalOf(coachAction({ status: 'rejected', reasonCode: null }))).toBe('failure');
    expect(signalOf(coachAction({ status: 'expired' }))).toBe('neutral');
    expect(signalOf(coachAction({ status: 'withdrawn' }))).toBe('neutral');
    // "Not now" twice is an answer about timing.
    expect(signalOf(coachAction({ status: 'expired', reasonCode: 'bad_timing' }))).toBe('failure');
  });
});

describe('the effectiveness record', () => {
  const history = [worked(5), worked(7), notDone(9), worked(12, { outcome: 'partly_worked' })];

  it('keeps acceptance, follow-through, usefulness and applicability apart — no single score', () => {
    const summary = summarizeEffectiveness([...history, coachAction({ status: 'rejected', reasonCode: 'not_relevant', rejectedAt: iso(14) })], NOW, CONFIG);
    expect(summary.byTarget).toHaveLength(1);
    expect(summary.byTarget[0]).toMatchObject({
      strategyKey: 'focus_session|morning|medium',
      targetKey: 't:project-x',
      suggested: 5,
      accepted: 4,
      rejected: 1,
      carriedOut: 3,
      notCarriedOut: 1,
      worked: 2,
      partlyWorked: 1,
      didNotWork: 0,
      successes: 3,
      failures: 2,
      reasons: { bad_timing: 1, not_relevant: 1 },
    });
    expect(summary.byTarget[0]).not.toHaveProperty('score');
  });

  it('groups by strategy + target, and also by strategy alone', () => {
    const summary = summarizeEffectiveness(
      [worked(5), worked(6, { thread: 'Project Y', targetKey: 't:project-y' }), notDone(7, { daypart: 'evening', strategyKey: 'focus_session|evening|medium' })],
      NOW,
      CONFIG,
    );
    expect(summary.byTarget.map((r) => `${r.strategyKey}→${r.targetKey}`).sort()).toEqual([
      'focus_session|evening|medium→t:project-x',
      'focus_session|morning|medium→t:project-x',
      'focus_session|morning|medium→t:project-y',
    ]);
    expect(summary.byStrategy.find((r) => r.strategyKey === 'focus_session|morning|medium')).toMatchObject({ suggested: 2, worked: 2 });
  });

  it('ignores replaced suggestions and anything older than the lookback', () => {
    const old = notDone(1, { createdAt: new Date(Date.parse(NOW) - 90 * 86_400_000).toISOString() });
    const summary = summarizeEffectiveness([old, coachAction({ status: 'withdrawn' })], NOW, CONFIG);
    expect(summary.byTarget).toEqual([]);
  });
});

describe('learning: repeated evidence, not one data point', () => {
  it('one failure is not a verdict', () => {
    const summary = summarizeEffectiveness([notDone(12)], NOW, CONFIG);
    expect(verdictOf(summary.byTarget[0], CONFIG)).toBe('unclear');
    expect(isBlocked(summary, { strategyKey: 'focus_session|morning|medium', targetKey: 't:project-x' }, CONFIG)).toBeNull();
  });

  it('repeated failure with no success blocks that strategy for that target — and only that one', () => {
    const summary = summarizeEffectiveness([notDone(12), notDone(13)], NOW, CONFIG);
    expect(verdictOf(summary.byTarget[0], CONFIG)).toBe('not_working');
    expect(isBlocked(summary, { strategyKey: 'focus_session|morning|medium', targetKey: 't:project-x' }, CONFIG)).toMatchObject({ failures: 2 });
    // A different time of day, a different size, or a different target is a different thing to try.
    expect(isBlocked(summary, { strategyKey: 'focus_session|evening|medium', targetKey: 't:project-x' }, CONFIG)).toBeNull();
    expect(isBlocked(summary, { strategyKey: 'focus_session|morning|short', targetKey: 't:project-x' }, CONFIG)).toBeNull();
    expect(isBlocked(summary, { strategyKey: 'focus_session|morning|medium', targetKey: 't:project-y' }, CONFIG)).toBeNull();
  });

  it('a success keeps a strategy available despite failures', () => {
    const summary = summarizeEffectiveness([worked(5), notDone(12), notDone(13)], NOW, CONFIG);
    expect(verdictOf(summary.byTarget[0], CONFIG)).toBe('unclear');
    expect(isBlocked(summary, { strategyKey: 'focus_session|morning|medium', targetKey: 't:project-x' }, CONFIG)).toBeNull();
  });

  it('repeated success makes a strategy reusable', () => {
    const summary = summarizeEffectiveness([worked(5), worked(7), worked(9), notDone(12)], NOW, CONFIG);
    expect(verdictOf(summary.byTarget[0], CONFIG)).toBe('working');
    expect(learnedStatements(summary, label, CONFIG)).toEqual([
      { kind: 'works', text: 'A Focus session (up to an hour) in the morning for “Project X” has helped 3 of 4 times.' },
    ]);
  });

  it('tells the user plainly what it will stop suggesting, and why', () => {
    const summary = summarizeEffectiveness([notDone(12), notDone(13)], NOW, CONFIG);
    expect(learnedStatements(summary, label, CONFIG)).toEqual([
      {
        kind: 'does_not_work',
        text: 'A Focus session (up to an hour) in the morning for “Project X” has not worked out 2 times (bad timing ×2), so Reflect will not suggest it that way again.',
      },
    ]);
  });

  it('renders the record for the model: counts, reasons and a verdict', () => {
    const working = summarizeEffectiveness([worked(5), worked(7)], NOW, CONFIG);
    expect(effectivenessLines(working, label, CONFIG)).toEqual([
      'a Focus session (up to an hour) in the morning → “Project X”: suggested 2, accepted 2, carried out 2, helped 2. WORKS for this user — a good candidate to reuse.',
    ]);
    const failing = summarizeEffectiveness([notDone(12), notDone(13, { reasonCode: 'too_difficult' })], NOW, CONFIG);
    expect(effectivenessLines(failing, label, CONFIG)[0]).toBe(
      'a Focus session (up to an hour) in the morning → “Project X”: suggested 2, accepted 2, carried out 0, helped 0, did not happen 2; ' +
        'reasons given: bad timing, too difficult. NOT WORKING — do not suggest it again in this form.',
    );
    // Something outside the user's control took the day: that is no evidence against the strategy.
    const interrupted = summarizeEffectiveness([notDone(12), notDone(13, { reasonCode: 'external_constraint' })], NOW, CONFIG);
    expect(signalOf(notDone(13, { reasonCode: 'external_constraint' }))).toBe('neutral');
    expect(interrupted.byTarget[0]).toMatchObject({ failures: 1, notCarriedOut: 2 });
    expect(isBlocked(interrupted, { strategyKey: interrupted.byTarget[0].strategyKey, targetKey: interrupted.byTarget[0].targetKey }, CONFIG)).toBeNull();
    // One outcome is already something to learn from — in words that say how much it is worth.
    expect(effectivenessLines(summarizeEffectiveness([worked(5)], NOW, CONFIG), label, CONFIG)[0]).toContain('HELPED when it was tried — reasonable to reuse when the situation is similar.');
    expect(effectivenessLines(summarizeEffectiveness([worked(5, { outcome: 'partly_worked' })], NOW, CONFIG), label, CONFIG)[0]).toContain('PARTLY HELPED — keep the idea and refine one thing');
    expect(effectivenessLines(summarizeEffectiveness([worked(5, { outcome: 'did_not_work' })], NOW, CONFIG), label, CONFIG)[0]).toContain('The user said it DID NOT HELP — do not offer it again unchanged');
    // Nothing decided yet → nothing to say.
    expect(effectivenessLines(summarizeEffectiveness([coachAction()], NOW, CONFIG), label, CONFIG)).toEqual([]);
    expect(describeReasons({ bad_timing: 2, other: 1 })).toBe('bad timing ×2, another reason');
  });
});

describe('escalation: when advice keeps not working, ask', () => {
  const evening = { daypart: 'evening' as const, strategyKey: 'focus_session|evening|medium' };
  const three = [notDone(12), notDone(13), notDone(14, evening)];

  it('escalates a target after enough failures across strategies, with no success', () => {
    expect(findEscalations([notDone(12), notDone(13)], NOW, CONFIG)).toEqual([]);
    const [escalation] = findEscalations(three, NOW, CONFIG);
    expect(escalation).toMatchObject({ targetKey: 't:project-x', failures: 3, reasons: { bad_timing: 3 } });
    expect(escalation.actionIds).toEqual(three.map((a) => a.id));
  });

  it('does not escalate when something worked, or when there is no target', () => {
    expect(findEscalations([...three, worked(15)], NOW, CONFIG)).toEqual([]);
    const untargeted = { thread: null, targetKey: null };
    expect(findEscalations([notDone(12, untargeted), notDone(13, untargeted), notDone(14, untargeted)], NOW, CONFIG)).toEqual([]);
  });

  it('starts over once the user has explained what was getting in the way', () => {
    const resets = new Map([['t:project-x', iso(16, '09:00')]]);
    expect(findEscalations(three, NOW, CONFIG, resets)).toEqual([]);
    // Failures after the explanation count again.
    const later = [...three, notDone(16), notDone(17), notDone(18)];
    expect(findEscalations(later, NOW, CONFIG, resets)).toMatchObject([{ targetKey: 't:project-x', failures: 3 }]);
  });
});
