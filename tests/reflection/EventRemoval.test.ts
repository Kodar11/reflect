import { describe, it, expect } from 'vitest';
import { citesRemovedEvents, planReportRedaction, type RemovedEvents } from '../../src/reflection/ReflectionChanges';
import { MAX_EVIDENCE_EVENT_IDS, type ReflectionEvidence, type ReflectionInsight } from '../../src/reflection/ReflectionModels';
import { iso } from './helpers';

/**
 * Which stored references rest on an event the user removed. Matching is by
 * event id, block id and — only when the reference cannot say which events it
 * stood on — by time. Titles and URLs are never part of it.
 */

const removed: RemovedEvents = {
  eventIds: [102],
  ranges: [{ start: iso(5, '09:20'), end: iso(5, '09:30') }],
  activityIds: ['ai-detour'],
};

const activityEvidence = (overrides: Partial<ReflectionEvidence> = {}): ReflectionEvidence => ({
  kind: 'activity',
  activityId: 'ai-other',
  eventIds: [201, 202],
  label: 'Something else',
  period: { start: iso(5, '09:00'), end: iso(5, '10:00') },
  ...overrides,
});

function insight(id: string, evidence: ReflectionEvidence[], sourceActivityIds: string[] = []): ReflectionInsight & { feedback: null } {
  return {
    id,
    type: 'progress',
    title: id,
    observation: id,
    interpretation: id,
    relevance: null,
    confidence: 0.8,
    evidence,
    sourceActivityIds,
    sourceMetricKeys: [],
    claimSignature: id,
    identityKey: id,
    subjectKey: null,
    thread: null,
    priorityId: null,
    continuity: 'new',
    magnitude: null,
    createdAt: iso(6),
    feedback: null,
  };
}

describe('citesRemovedEvents', () => {
  it('matches by event id', () => {
    expect(citesRemovedEvents(activityEvidence({ eventIds: [101, 102, 103] }), removed)).toBe(true);
  });

  it('matches by the id of the block that held the event', () => {
    expect(citesRemovedEvents(activityEvidence({ activityId: 'ai-detour' }), removed)).toBe(true);
  });

  it('a block that lists all its events and none of them was removed is not affected, even when it spans the same time', () => {
    expect(citesRemovedEvents(activityEvidence(), removed)).toBe(false);
  });

  it('falls back to time only when the reference cannot say which events it stood on', () => {
    // A reference from before event ids were recorded.
    expect(citesRemovedEvents(activityEvidence({ eventIds: undefined }), removed)).toBe(true);
    // A capped sample may simply have left the removed event out.
    const sampled = Array.from({ length: MAX_EVIDENCE_EVENT_IDS }, (_, i) => 1000 + i);
    expect(citesRemovedEvents(activityEvidence({ eventIds: sampled }), removed)).toBe(true);
    // …but not when it was somewhere else in time.
    expect(citesRemovedEvents(activityEvidence({ eventIds: undefined, period: { start: iso(5, '13:00'), end: iso(5, '14:00') } }), removed)).toBe(false);
  });

  it('a measurement is never matched by time: it is recomputed, not a citation of the event', () => {
    const metric: ReflectionEvidence = { kind: 'metric', metricKey: 'time.tracked_minutes', label: 'Tracked', period: { start: iso(5), end: iso(6) } };
    expect(citesRemovedEvents(metric, removed)).toBe(false);
  });
});

describe('planReportRedaction', () => {
  const snapshot = (activities: { id: string; eventIds?: number[] }[]) => ({
    period: { type: 'day' as const, key: '2026-10-05', start: iso(5), end: iso(6) },
    coveredUntil: iso(6),
    isPartial: false,
    priorities: [],
    activePriorityIds: [],
    activities: activities.map((a) => ({ ...a, startedAt: iso(5, '09:00'), endedAt: iso(5, '10:00'), minutes: 60, title: a.id, thread: null, priorityId: null })),
    notes: [],
    userContextIncluded: false,
    previousReportId: null,
  });

  it('finds the insights, the carry-forward and the recorded activities that rest on the event', () => {
    const plan = planReportRedaction(
      {
        insights: [
          insight('by-event', [activityEvidence({ eventIds: [102] })]),
          insight('by-source', [], ['ai-detour']),
          insight('unrelated', [activityEvidence()]),
        ],
        carryForward: { text: 'Tomorrow', sourceMetricKeys: [], sourceActivityIds: [], evidence: [activityEvidence({ activityId: 'ai-detour' })] },
        dataSnapshot: snapshot([{ id: 'ai-other', eventIds: [201] }, { id: 'ai-detour', eventIds: [101, 102] }]),
      },
      removed,
    );
    expect(plan).toEqual({ insightIds: ['by-event', 'by-source'], carryForward: true, snapshotActivities: [1] });
  });

  it('a report that never saw the event is left alone', () => {
    expect(
      planReportRedaction(
        { insights: [insight('unrelated', [activityEvidence()])], carryForward: null, dataSnapshot: snapshot([{ id: 'ai-other', eventIds: [201] }]) },
        removed,
      ),
    ).toBeNull();
    expect(planReportRedaction({ insights: [], carryForward: null, dataSnapshot: null }, removed)).toBeNull();
  });

  it('a report that was only shown the activity, without citing it, is still one written from it', () => {
    expect(planReportRedaction({ insights: [], carryForward: null, dataSnapshot: snapshot([{ id: 'ai-detour', eventIds: [102] }]) }, removed)).toEqual({
      insightIds: [],
      carryForward: false,
      snapshotActivities: [0],
    });
  });
});
