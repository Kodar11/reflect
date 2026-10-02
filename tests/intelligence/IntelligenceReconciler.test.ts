import { describe, it, expect } from 'vitest';
import { planReconciliation, type ReconcileInput } from '../../src/intelligence/IntelligenceReconciler';
import type { ValidatedActivity } from '../../src/intelligence/IntelligenceModels';
import { t } from './helpers';

const windowEvents = [
  { id: 1, startedAt: t('09:00'), endedAt: t('09:10') },
  { id: 2, startedAt: t('09:10'), endedAt: t('09:20') },
  { id: 3, startedAt: t('09:20'), endedAt: t('09:30') },
  { id: 4, startedAt: t('09:30'), endedAt: t('09:40') },
  { id: 5, startedAt: t('09:40'), endedAt: t('09:50') },
];

function activity(eventIds: number[], overrides: Partial<ValidatedActivity> = {}): ValidatedActivity {
  return {
    temporaryId: 'a1',
    continuationOfActivityId: null,
    startedAt: t('09:00'),
    endedAt: t('09:50'),
    title: 'Work',
    summary: null,
    eventIds,
    contextId: null,
    areaId: null,
    intentId: null,
    qualityId: null,
    confidence: 0.8,
    uncertainty: [],
    ...overrides,
  };
}

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  let n = 0;
  return {
    windowEvents,
    activities: [],
    droppedEventIds: [],
    memberships: new Map(),
    previous: new Map(),
    protectedEventIds: new Set(),
    maxContinuationGapMs: 30 * 60_000,
    newId: () => `new-${++n}`,
    ...overrides,
  };
}

describe('IntelligenceReconciler', () => {
  it('creates a new activity with an envelope derived from its raw events', () => {
    const plan = planReconciliation(input({ activities: [activity([2, 3])] }));

    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({ id: 'new-1', eventIds: [2, 3], startedAt: t('09:10'), endedAt: t('09:30') });
    expect(plan.extend).toEqual([]);
    expect(plan.detach).toEqual([]);
  });

  it('extends the continued activity instead of creating a duplicate', () => {
    const plan = planReconciliation(
      input({
        activities: [activity([1, 2], { continuationOfActivityId: 'ai-prev' })],
        previous: new Map([['ai-prev', { userLocked: false, endedAt: t('08:58') }]]),
      }),
    );

    expect(plan.create).toEqual([]);
    expect(plan.extend).toMatchObject([{ activityId: 'ai-prev', addEventIds: [1, 2] }]);
  });

  it('absorbs withheld noise events that sit inside one activity', () => {
    const plan = planReconciliation(
      input({
        activities: [activity([1, 3], { temporaryId: 'a1' }), activity([5], { temporaryId: 'a2' })],
        droppedEventIds: [2, 4],
      }),
    );

    // 2 sits between two events of a1 → absorbed. 4 sits between a1 and a2 → left alone.
    expect(plan.create.map((a) => a.eventIds)).toEqual([[1, 2, 3], [5]]);
  });

  it('moves re-assigned events away from an unlocked owner only', () => {
    const plan = planReconciliation(
      input({
        activities: [activity([1, 2, 3])],
        memberships: new Map([
          [1, { activityId: 'ai-old', userLocked: false }],
          [2, { activityId: 'ai-old', userLocked: false }],
          [3, { activityId: 'ai-locked', userLocked: true }],
        ]),
      }),
    );

    expect(plan.create[0].eventIds).toEqual([1, 2]);
    expect(plan.detach).toEqual([{ activityId: 'ai-old', eventIds: [1, 2] }]);
    expect(plan.userProtectedEventIds).toEqual([3]);
  });

  it('never draws an AI block across user-owned events', () => {
    const plan = planReconciliation(
      input({
        activities: [activity([1, 2, 3, 4, 5], { continuationOfActivityId: 'ai-prev' })],
        previous: new Map([['ai-prev', { userLocked: false, endedAt: t('08:59') }]]),
        protectedEventIds: new Set([3]),
      }),
    );

    // The first part continues; the part after the user's block is a new activity.
    expect(plan.extend).toMatchObject([{ activityId: 'ai-prev', addEventIds: [1, 2] }]);
    expect(plan.create.map((a) => a.eventIds)).toEqual([[4, 5]]);
    expect(plan.userProtectedEventIds).toEqual([3]);
  });

  it('produces an empty plan when everything is user-owned', () => {
    const plan = planReconciliation(
      input({ activities: [activity([1, 2])], protectedEventIds: new Set([1, 2]) }),
    );
    expect(plan).toMatchObject({ create: [], extend: [], detach: [] });
  });
});
