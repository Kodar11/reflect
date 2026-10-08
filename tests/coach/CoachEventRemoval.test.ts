import { describe, it, expect } from 'vitest';
import type { RemovedEvents } from '../../src/reflection/ReflectionChanges';
import type { ReflectionEvidence } from '../../src/reflection/ReflectionModels';
import { browsing, iso, local, makeReflectionHarness, projectY, workday } from '../reflection/helpers';
import { accepted, coachAction } from './helpers';

/**
 * The user hid or deleted an event. The Coach must not keep a suggestion that
 * was made from it, nor keep pointing at it from one the user already took on.
 * "Now" is Tue Oct 13.
 */
function harness() {
  return makeReflectionHarness({
    activities: [...[5, 6, 7, 8, 9, 12].flatMap(workday), projectY(13, '09:00', 60), browsing(13, '10:30', 30)],
    now: local(13, '08:00'),
    priorities: ['Launching Project X'],
    coach: true,
  });
}

const removed: RemovedEvents = {
  eventIds: [502],
  ranges: [{ start: iso(12, '21:10'), end: iso(12, '21:40') }],
  activityIds: ['ai-private'],
};

const privateEvidence: ReflectionEvidence = {
  kind: 'activity',
  activityId: 'ai-private',
  eventIds: [501, 502],
  label: 'Late browsing',
  period: { start: iso(12, '21:00'), end: iso(12, '21:45') },
};
const otherEvidence: ReflectionEvidence = {
  kind: 'activity',
  activityId: 'ai-project-x',
  eventIds: [601],
  label: 'Project X',
  period: { start: iso(12, '09:00'), end: iso(12, '10:00') },
};

describe('CoachService — an event the suggestion rested on was removed', () => {
  it('withdraws an undecided suggestion and records why, without naming the event', () => {
    const h = harness();
    const suggested = coachAction({ evidence: [privateEvidence], sourceActivityIds: ['ai-private'] });
    const snoozed = coachAction({ status: 'snoozed', evidence: [], sourceActivityIds: ['ai-private'] });
    h.coachRepo.actions.push(suggested, snoozed);

    expect(h.coach.onEventsRemoved(removed)).toBe(2);

    expect(h.coachRepo.getAction(suggested.id)).toMatchObject({ status: 'withdrawn' });
    expect(h.coachRepo.getAction(snoozed.id)).toMatchObject({ status: 'withdrawn' });
    expect(h.coachRepo.events.map((e) => [e.type, e.toStatus, e.detail])).toEqual([
      ['withdraw', 'withdrawn', { by: 'events_removed' }],
      ['withdraw', 'withdrawn', { by: 'events_removed' }],
    ]);
    expect(h.coachChanges.count).toBeGreaterThanOrEqual(1);
    // A withdrawn action is not part of what the Coach is told again.
    expect(h.coach.getState().commitments.map((a) => a.id)).not.toContain(suggested.id);
  });

  it('keeps a commitment the user already made, minus the citation', () => {
    const h = harness();
    const commitment = accepted({
      evidence: [privateEvidence, otherEvidence],
      sourceActivityIds: ['ai-private', 'ai-project-x'],
      observation: {
        kind: 'matched',
        observedAt: iso(13, '07:00'),
        window: { start: iso(13, '05:00'), end: iso(13, '12:00') },
        final: false,
        focusSessionIds: [],
        activityIds: ['ai-private', 'ai-project-x'],
        focusMinutes: 0,
        matchedMinutes: 30,
        plannedMinutes: 45,
        interruptions: 0,
        notes: [],
      } as never,
    });
    h.coachRepo.actions.push(commitment);

    expect(h.coach.onEventsRemoved(removed)).toBe(1);

    const after = h.coachRepo.getAction(commitment.id)!;
    expect(after.status).toBe('accepted');
    expect(after.title).toBe(commitment.title);
    expect(after.evidence).toEqual([otherEvidence]);
    expect(after.sourceActivityIds).toEqual(['ai-project-x']);
    expect(after.observation!.activityIds).toEqual(['ai-project-x']);
    expect(h.coachRepo.events).toEqual([]); // not a lifecycle step
  });

  it('permanent deletion: a suggestion the user never took on is removed, not kept as a withdrawn record', () => {
    const h = harness();
    const suggested = coachAction({ title: 'Stay off the late browsing', evidence: [privateEvidence], sourceActivityIds: ['ai-private'] });
    // Withdrawn earlier, when the event was only hidden.
    const withdrawn = coachAction({ status: 'withdrawn', title: 'Skip the late browsing', evidence: [privateEvidence] });
    const commitment = accepted({ evidence: [privateEvidence, otherEvidence], sourceActivityIds: ['ai-private'] });
    const unrelated = coachAction({ evidence: [otherEvidence] });
    h.coachRepo.actions.push(suggested, withdrawn, commitment, unrelated);
    h.coachRepo.events.push({ id: 'ev-1', actionId: withdrawn.id, type: 'withdraw', fromStatus: 'suggested', toStatus: 'withdrawn', detail: { by: 'events_removed' }, createdAt: iso(12, '23:00') });

    expect(h.coach.onEventsRemoved(removed, { purge: true })).toBe(3);

    expect(h.coachRepo.actions.map((a) => a.id)).toEqual([commitment.id, unrelated.id]);
    expect(h.coachRepo.events).toEqual([]);
    expect(JSON.stringify(h.coachRepo.actions)).not.toContain('late browsing');
    // What the user committed to is still theirs, without the citation.
    expect(h.coachRepo.getAction(commitment.id)).toMatchObject({ status: 'accepted', evidence: [otherEvidence], sourceActivityIds: [] });
    expect(h.coachRepo.getAction(unrelated.id)).toEqual(unrelated);
  });

  it('hide, undo, hide again, then delete: the withdrawn suggestion is still found and removed', () => {
    const h = harness();
    const suggested = coachAction({ title: 'Stay off the late browsing', evidence: [privateEvidence], sourceActivityIds: ['ai-private'] });
    h.coachRepo.actions.push(suggested);

    expect(h.coach.onEventsRemoved(removed)).toBe(1); // hidden → withdrawn
    expect(h.coach.onEventsRemoved(removed)).toBe(0); // hidden again → nothing left to do
    // The withdrawn record keeps its link to the event, so deletion can find it.
    expect(h.coachRepo.getAction(suggested.id)).toMatchObject({ status: 'withdrawn', evidence: [privateEvidence] });

    expect(h.coach.onEventsRemoved(removed, { purge: true })).toBe(1);
    expect(h.coachRepo.actions).toEqual([]);
    expect(h.coachRepo.events).toEqual([]);
  });

  it('leaves every other action exactly as it was', () => {
    const h = harness();
    const unrelated = coachAction({ evidence: [otherEvidence], sourceActivityIds: ['ai-project-x'] });
    const noEvidence = coachAction();
    h.coachRepo.actions.push(unrelated, noEvidence);
    const before = structuredClone(h.coachRepo.actions);
    const changesBefore = h.coachChanges.count;

    expect(h.coach.onEventsRemoved(removed)).toBe(0);

    expect(h.coachRepo.actions).toEqual(before);
    expect(h.coachChanges.count).toBe(changesBefore);
  });
});
