import { describe, it, expect, vi } from 'vitest';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { FakeReflectionRepository } from './FakeReflectionRepository';
import { TAXONOMY, local, workday } from './helpers';

/**
 * A tracking pause is missing data, not inactivity. The reflection layer is
 * told how long tracking was paused in the period it is about to describe, so
 * it never reads a deliberate pause as a break or an empty afternoon.
 */

function metricsWith(pausedMs: ((from: string, to: string) => number) | undefined, now = local(13, '09:00')) {
  const activities = [...workday(9), ...workday(12)];
  return new ReflectionMetricsService(
    {
      getActivities: (from, to) => activities.filter((a) => a.startedAt >= from && a.startedAt < to).map((a) => ({ ...a })),
      focus: { getSessionsByRange: () => [], getInterruptions: () => [], getBlockedAttempts: () => [] },
      taxonomy: () => TAXONOMY,
      firstEventAt: () => activities[0].startedAt,
      ...(pausedMs ? { trackingPausedMs: pausedMs } : {}),
    },
    new FakeReflectionRepository(),
    { config: DEFAULT_REFLECTION_CONFIG, now: () => now, yieldToEventLoop: async () => {} },
  );
}

const monday = periodContaining('day', local(12));
const pauseNote = (notes: string[]) => notes.find((n) => n.includes('paused tracking'));

describe('reflection data notes — tracking pauses', () => {
  it('tells the model how long tracking was paused, and that it is missing data', async () => {
    const paused = vi.fn(() => 80 * 60_000);
    const dataset = await metricsWith(paused).computeDataset(monday, monday.end, []);
    const note = pauseNote(dataset.notes);
    expect(note).toBe(
      'The user paused tracking for about 1 hour 20 minutes during this day. Nothing was recorded in that time: it is missing data, not inactivity or a break.',
    );
    expect(paused).toHaveBeenCalledWith(monday.start, monday.end);
  });

  it('says nothing when tracking was not paused, or only for a moment', async () => {
    expect(pauseNote((await metricsWith(() => 0).computeDataset(monday, monday.end, [])).notes)).toBeUndefined();
    expect(pauseNote((await metricsWith(() => 3 * 60_000).computeDataset(monday, monday.end, [])).notes)).toBeUndefined();
    expect(pauseNote((await metricsWith(undefined).computeDataset(monday, monday.end, [])).notes)).toBeUndefined();
  });

  it('for a day still in progress, only looks at the time that has passed', async () => {
    const paused = vi.fn(() => 30 * 60_000);
    const now = local(12, '15:00');
    const dataset = await metricsWith(paused, now).computeDataset(monday, now.toISOString(), []);
    expect(paused).toHaveBeenCalledWith(monday.start, now.toISOString());
    expect(pauseNote(dataset.notes)).toContain('about 30 minutes');
  });

  it('a failing pause source never breaks the reflection', async () => {
    const dataset = await metricsWith(() => {
      throw new Error('database is locked');
    }).computeDataset(monday, monday.end, []);
    expect(pauseNote(dataset.notes)).toBeUndefined();
    expect(dataset.notes.length).toBeGreaterThan(0);
  });
});
