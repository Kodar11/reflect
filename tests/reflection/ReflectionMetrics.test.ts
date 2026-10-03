import { describe, it, expect } from 'vitest';
import {
  assessSufficiency,
  buildComparisons,
  computeMetrics,
  findMeaningfulDifference,
  formatMinutes,
  selectSupportingMetrics,
} from '../../src/reflection/ReflectionMetrics';
import { clipActivities, mergeFragments } from '../../src/reflection/ReflectionActivities';
import { DEFAULT_REFLECTION_CONFIG, type MetricSet, type ReflectionActivity } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { TAXONOMY, activity, browsing, iso, local, priority, projectX, projectY, research, workday } from './helpers';

const p1 = priority('p1', 'Launch Project X');

/** Project X activities are what the user's stated priority is about. */
const linked = (activities: ReflectionActivity[]) =>
  activities.map((a) => (a.thread === 'Project X' ? { ...a, priorityId: 'p1' } : a));

function dayMetrics(activities: ReflectionActivity[], extra: Partial<Parameters<typeof computeMetrics>[0]> = {}) {
  return computeMetrics({
    period: periodContaining('day', local(6, '12:00')),
    activities,
    priorities: [p1],
    taxonomy: TAXONOMY,
    focus: [],
    ...extra,
  });
}

const value = (metrics: MetricSet, key: string) => metrics[key]?.value;
const display = (metrics: MetricSet, key: string) => metrics[key]?.display;

describe('formatMinutes', () => {
  it('formats durations the way a reflection quotes them', () => {
    expect([formatMinutes(0), formatMinutes(48), formatMinutes(60), formatMinutes(133), formatMinutes(74.4)]).toEqual([
      '0m', '48m', '1h', '2h 13m', '1h 14m',
    ]);
  });
});

describe('computeMetrics — one day', () => {
  // Tue Oct 6: two long Project X blocks in the morning, a fragmented afternoon.
  const metrics = dayMetrics(linked(workday(6)));

  it('aggregates total time and time by classification', () => {
    expect(display(metrics, 'time.tracked_minutes')).toBe('4h 32m');
    expect(value(metrics, 'time.area.area_work')).toBe(262);
    expect(value(metrics, 'time.area.area_leisure')).toBe(10);
    expect(display(metrics, 'time.area.area_work.share')).toBe('96%');
    expect(value(metrics, 'time.intent.intent_create')).toBe(227);
    expect(value(metrics, 'time.intent.intent_research')).toBe(35);
    expect(value(metrics, 'time.quality.quality_focused')).toBe(227);
    expect(value(metrics, 'time.quality.quality_distracting')).toBe(10);
    expect(value(metrics, 'time.context.coding')).toBe(227);
    expect(metrics['time.context.coding'].label).toBe('Time in context “Coding”');
  });

  it('derives focused time from the Quality dimension only', () => {
    expect(value(metrics, 'time.focused_minutes')).toBe(227);
    expect(display(metrics, 'time.focused_share')).toBe('83%');
  });

  it('measures session behaviour', () => {
    expect(value(metrics, 'behavior.activity_count')).toBe(9);
    expect(value(metrics, 'behavior.avg_activity_minutes')).toBe(30);
    expect(value(metrics, 'behavior.median_activity_minutes')).toBe(20);
    expect(value(metrics, 'behavior.longest_activity_minutes')).toBe(80);
    expect(value(metrics, 'behavior.sustained_activities')).toBe(4);
    expect(value(metrics, 'behavior.short_activities')).toBe(0);
  });

  it('counts context switches, but not returns to the same thing or long breaks', () => {
    // Morning: Project X → 10 min pause → Project X is not a switch. The 90
    // minute lunch gap is not a switch either. Afternoon: six real switches.
    expect(value(metrics, 'behavior.switches')).toBe(6);
    expect(display(metrics, 'behavior.switches_per_hour')).toBe('1.3 per hour');
    expect(value(metrics, 'daypart.afternoon.switches')).toBe(6);
    expect(value(metrics, 'daypart.morning.switches')).toBe(0);
  });

  it('locates the most fragmented stretch, with the window it points at', () => {
    const peak = metrics['fragmentation.peak_switches'];
    expect(peak.value).toBe(6);
    expect(peak.label).toBe('Most context switches in one stretch (the afternoon, 1:00 PM–3:28 PM)');
    expect(peak.range).toEqual({ start: iso(6, '13:00'), end: iso(6, '15:28') });
    expect(peak.activityIds!.length).toBe(7);
  });

  it('describes the time-of-day distribution', () => {
    expect(value(metrics, 'daypart.morning.minutes')).toBe(140);
    expect(value(metrics, 'daypart.afternoon.minutes')).toBe(132);
    expect(value(metrics, 'daypart.morning.focused_minutes')).toBe(140);
    expect(value(metrics, 'daypart.afternoon.focused_minutes')).toBe(87);
    expect(metrics['daypart.evening.minutes']).toBeUndefined();
    expect(display(metrics, 'attention.peak_hour')).toBe('9 AM–10 AM');
  });

  it('finds the longest uninterrupted block and when sustained work first began', () => {
    const longest = metrics['block.longest_minutes'];
    expect(longest.display).toBe('1h 20m');
    expect(longest.label).toBe('Longest uninterrupted block (Project X, started 9:00 AM)');
    expect(longest.range).toEqual({ start: iso(6, '09:00'), end: iso(6, '10:20') });
    expect(value(metrics, 'block.sustained_count')).toBe(4);
    expect(display(metrics, 'block.first_sustained_start')).toBe('9:00 AM');
  });

  it('merges back-to-back work on the same thread into one block', () => {
    const m = dayMetrics([projectX(6, '09:00', 40), projectX(6, '09:42', 50), projectY(6, '11:00', 20)]);
    expect(value(m, 'block.longest_minutes')).toBe(90);
    expect(m['block.longest_minutes'].activityIds).toHaveLength(2);
    expect(value(m, 'behavior.switches')).toBe(0);
  });

  it('reports time by thread (project / theme)', () => {
    expect(display(metrics, 'thread.project-x.minutes')).toBe('2h 52m');
    expect(display(metrics, 'thread.project-x.share')).toBe('63%');
    expect(value(metrics, 'thread.project-x.sessions')).toBe(4);
    expect(value(metrics, 'thread.project-y.minutes')).toBe(55);
    expect(value(metrics, 'thread.research.minutes')).toBe(35);
    expect(metrics['thread.project-x.active_days']).toBeUndefined(); // single day
  });

  it('measures priority alignment against the stated priority', () => {
    expect(metrics['priority.p1.minutes']).toMatchObject({
      value: 172,
      display: '2h 52m',
      label: 'Time linked to the priority “Launch Project X”',
      priorityId: 'p1',
    });
    expect(display(metrics, 'priority.p1.share')).toBe('63%');
    expect(value(metrics, 'priority.p1.sessions')).toBe(4);
    expect(value(metrics, 'priority.linked_minutes')).toBe(172);
    expect(value(metrics, 'priority.unlinked_minutes')).toBe(100);
  });

  it('states a real zero for an active priority that received no linked time', () => {
    const m = dayMetrics(workday(6)); // nothing linked
    expect(value(m, 'priority.p1.minutes')).toBe(0);
    expect(display(m, 'priority.p1.share')).toBe('0%');
  });

  it('omits priority metrics entirely when no priority applies', () => {
    const m = dayMetrics(workday(6), { priorities: [] });
    expect(Object.keys(m).filter((k) => k.startsWith('priority.'))).toEqual([]);
  });

  it('records the most recent thread as a possible carry-forward', () => {
    expect(metrics['continuity.last_thread']).toMatchObject({ value: 'Project X', thread: 'Project X' });
    expect(metrics['continuity.last_thread'].display).toBe('Project X (last worked Tue, Oct 6, 3:28 PM)');
    expect(value(metrics, 'continuity.last_thread_sessions')).toBe(4);
  });

  it('uses existing Focus sessions without a second analytics engine', () => {
    const m = dayMetrics(linked(workday(6)), {
      focus: [
        {
          id: 'f1',
          task: 'Sync engine',
          startedAt: iso(6, '09:00'),
          endedAt: iso(6, '09:50'),
          elapsedMinutes: 50,
          interruptionCount: 1,
          blockedAttemptCount: 0,
        },
      ],
    });
    expect(value(m, 'focus.session_count')).toBe(1);
    expect(value(m, 'focus.total_minutes')).toBe(50);
    expect(value(m, 'focus.interruption_count')).toBe(1);
    expect(value(m, 'focus.tracked_overlap_minutes')).toBe(50);
    expect(display(m, 'focus.top_thread')).toBe('Project X (50m)');
    expect(m['focus.blocked_attempt_count']).toBeUndefined();
    expect(Object.keys(metrics).some((k) => k.startsWith('focus.'))).toBe(false); // no sessions → no focus metrics
  });

  it('treats leisure as plain time, with no judgment attached', () => {
    const m = dayMetrics([browsing(6, '20:00', 80)]);
    expect(m['time.area.area_leisure']).toMatchObject({ value: 80, label: 'Time in the Leisure area' });
    const text = JSON.stringify(m).toLowerCase();
    for (const word of ['wasted', 'unproductive', 'productivity', 'score']) expect(text).not.toContain(word);
  });
});

describe('computeMetrics — missing data is absent, never zero', () => {
  it('does not report focused time when Quality was never determined', () => {
    const m = dayMetrics([activity(6, '09:00', 60, { qualityId: null }), activity(6, '10:10', 30, { qualityId: null })]);
    expect(m['time.focused_minutes']).toBeUndefined();
    expect(m['time.focused_share']).toBeUndefined();
    expect(m['daypart.morning.focused_minutes']).toBeUndefined();
    expect(value(m, 'time.tracked_minutes')).toBe(90);
  });

  it('reports unclassified time separately', () => {
    const m = dayMetrics([
      activity(6, '09:00', 60),
      activity(6, '10:10', 30, { contextId: null, areaId: null, intentId: null, qualityId: null, title: 'Chrome' }),
    ]);
    expect(value(m, 'time.unclassified_minutes')).toBe(30);
    expect(value(m, 'time.area.area_work')).toBe(60);
  });

  it('produces only the bare facts for an empty period', () => {
    const m = dayMetrics([]);
    expect(Object.keys(m).sort()).toEqual(['days.active', 'priority.linked_minutes', 'priority.p1.minutes', 'priority.p1.sessions', 'priority.unlinked_minutes', 'time.tracked_minutes']);
    expect(value(m, 'time.tracked_minutes')).toBe(0);
  });
});

describe('computeMetrics — a week', () => {
  // Mon Oct 5 – Fri Oct 9, the same shape every day.
  const activities = linked([5, 6, 7, 8, 9].flatMap(workday));
  const week = periodContaining('week', local(7));
  const metrics = computeMetrics({ period: week, activities, priorities: [p1], taxonomy: TAXONOMY, focus: [] });

  it('aggregates across days', () => {
    expect(value(metrics, 'time.tracked_minutes')).toBe(1360);
    expect(value(metrics, 'days.active')).toBe(5);
    expect(value(metrics, 'time.tracked_per_active_day')).toBe(272);
    expect(value(metrics, 'behavior.switches')).toBe(30);
  });

  it('measures consistency: on how many days each thread and priority was engaged', () => {
    expect(value(metrics, 'thread.project-x.active_days')).toBe(5);
    expect(value(metrics, 'priority.p1.active_days')).toBe(5);
    expect(value(metrics, 'continuity.multi_day_threads')).toBe(3);
  });

  it('detects the recurring morning pattern', () => {
    expect(value(metrics, 'pattern.sustained_days')).toBe(5);
    expect(metrics['pattern.longest_block_before_noon_days']).toMatchObject({ value: 5, display: '5 of 5 days' });
    expect(display(metrics, 'pattern.typical_first_sustained_start')).toBe('9:00 AM');
  });

  it('names the day of the most fragmented stretch', () => {
    expect(metrics['fragmentation.peak_switches'].label).toBe(
      'Most context switches in one stretch (afternoon of Mon, Oct 5, 1:00 PM–3:28 PM)',
    );
  });

  it('builds a per-day series', () => {
    expect(value(metrics, 'series.2026-10-05.tracked_minutes')).toBe(272);
    expect(value(metrics, 'series.2026-10-09.switches')).toBe(6);
    expect(display(metrics, 'series.2026-10-07.top_thread')).toBe('Project X (2h 52m)');
    expect(display(metrics, 'series.2026-10-07.top_intent')).toBe('Create (3h 47m)');
    expect(metrics['series.2026-10-10.tracked_minutes']).toBeUndefined(); // nothing tracked on Saturday
    expect(metrics['series.2026-10-06.tracked_minutes'].range).toEqual({ start: iso(6), end: iso(7) });
  });

  it('reports forced threads as a measured zero', () => {
    const m = computeMetrics({ period: week, activities, priorities: [], taxonomy: TAXONOMY, focus: [], forceThreads: ['Project Z'] });
    expect(value(m, 'thread.project-z.minutes')).toBe(0);
  });
});

describe('determinism', () => {
  it('the same activities always produce identical metrics, in any input order', () => {
    const activities = linked([5, 6, 7].flatMap(workday));
    const input = { period: periodContaining('week', local(7)), priorities: [p1], taxonomy: TAXONOMY, focus: [] };
    const first = computeMetrics({ ...input, activities });
    const second = computeMetrics({ ...input, activities: [...activities].reverse() });
    expect(second).toEqual(first);
    expect(JSON.stringify(computeMetrics({ ...input, activities }))).toBe(JSON.stringify(first));
  });
});

describe('activity fragments and clipping', () => {
  it('reunites a block that was loaded as two day-fragments', () => {
    const merged = mergeFragments([
      projectX(6, '23:30', 30, { id: 'ai-1' }),
      { ...projectX(7, '00:00', 45, { id: 'ai-1' }) },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startedAt: iso(6, '23:30'), endedAt: iso(7, '00:45'), durationMinutes: 75 });
  });

  it('clips an activity to a range and scales its time', () => {
    const [clipped] = clipActivities([projectX(6, '09:00', 60)], iso(6, '09:30'), iso(6, '12:00'));
    expect(clipped).toMatchObject({ startedAt: iso(6, '09:30'), durationMinutes: 30 });
    expect(clipActivities([projectX(6, '09:00', 60)], iso(6, '10:00'), iso(6, '12:00'))).toEqual([]);
  });
});

describe('data sufficiency', () => {
  const config = DEFAULT_REFLECTION_CONFIG;

  it('refuses to reflect on too little activity', () => {
    expect(assessSufficiency(dayMetrics([]), 'day', config)).toEqual({
      enough: false,
      reason: 'no_activity',
      message: 'Not enough activity yet to generate a meaningful reflection.',
    });
    expect(assessSufficiency(dayMetrics([projectX(6, '09:00', 12)]), 'day', config).reason).toBe('too_little_activity');
    expect(assessSufficiency(dayMetrics(workday(6)), 'day', config).enough).toBe(true);
  });

  it('a week needs activity on more than one day', () => {
    const week = periodContaining('week', local(7));
    const oneDay = computeMetrics({ period: week, activities: workday(6), priorities: [], taxonomy: TAXONOMY, focus: [] });
    expect(assessSufficiency(oneDay, 'week', config).enough).toBe(false);
    const twoDays = computeMetrics({ period: week, activities: [...workday(6), ...workday(7)], priorities: [], taxonomy: TAXONOMY, focus: [] });
    expect(assessSufficiency(twoDays, 'week', config).enough).toBe(true);
  });
});

describe('buildComparisons', () => {
  const week = periodContaining('week', local(14));
  const weekOf = (days: number[]) =>
    computeMetrics({ period: week, activities: linked(days.flatMap(workday)), priorities: [p1], taxonomy: TAXONOMY, focus: [] });
  const current = weekOf([12, 13, 14, 15, 16]);
  const previous = weekOf([5, 6, 7]);
  const base = { current, previousName: 'previous week', baselineUnit: 'week', minBaselinePeriods: 3 };

  it('compares with the previous period', () => {
    const c = buildComparisons({ ...base, previous, baselines: [], mode: 'full' });
    expect(c['prev.time.tracked_minutes']).toMatchObject({ value: 816, display: '13h 36m', group: 'comparison' });
    expect(c['prev.time.tracked_minutes'].label).toBe('Total tracked time — previous week');
    expect(c['delta.time.tracked_minutes']).toMatchObject({ value: 544, display: '+9h 4m (+67%)' });
    expect(c['delta.days.active'].display).toBe('+2');
    expect(c['delta.priority.p1.minutes'].priorityId).toBe('p1');
    // Unchanged rates still compare (as "no change").
    expect(c['delta.time.focused_share'].display).toBe('0 pts');
  });

  it('uses a generic label where the current label names a specific instance', () => {
    const c = buildComparisons({ ...base, previous, baselines: [], mode: 'full' });
    expect(c['prev.block.longest_minutes'].label).toBe('Longest uninterrupted block — previous week');
  });

  it('builds a personal baseline only from enough earlier periods', () => {
    const tooFew = buildComparisons({ ...base, previous: null, baselines: [previous, previous], mode: 'full' });
    expect(Object.keys(tooFew)).toEqual([]);

    const enough = buildComparisons({ ...base, previous: null, baselines: [previous, previous, weekOf([5, 6, 7, 8, 9])], mode: 'full' });
    expect(enough['baseline.time.tracked_minutes']).toMatchObject({
      value: 997, // mean of 816, 816, 1360
      label: 'Total tracked time — your average over the previous 3 weeks',
    });
    expect(enough['prev.time.tracked_minutes']).toBeUndefined();
  });

  it('never compares totals of an unfinished period with a finished one', () => {
    const c = buildComparisons({ ...base, previous, baselines: [], mode: 'partial' });
    expect(c['prev.time.tracked_minutes']).toBeUndefined();
    expect(c['prev.behavior.switches']).toBeUndefined();
    expect(c['prev.days.active']).toBeUndefined();
    // Rates and averages remain comparable.
    expect(c['prev.behavior.switches_per_hour']).toBeDefined();
    expect(c['prev.time.focused_share']).toBeDefined();
    expect(c['prev.block.longest_minutes']).toBeDefined();
    expect(c['prev.time.tracked_per_active_day']).toBeDefined();
  });

  it('omits a comparison that cannot be made instead of treating missing data as zero', () => {
    // The previous week has no Quality information at all.
    const unclassified = computeMetrics({
      period: week,
      activities: [5, 6, 7].flatMap(workday).map((a) => ({ ...a, qualityId: null })),
      priorities: [],
      taxonomy: TAXONOMY,
      focus: [],
    });
    const c = buildComparisons({ ...base, previous: unclassified, baselines: [], mode: 'full' });
    expect(c['prev.time.focused_minutes']).toBeUndefined();
    expect(c['prev.time.quality.quality_focused']).toBeUndefined();
    expect(c['prev.daypart.morning.focused_minutes']).toBeUndefined();
    expect(c['prev.priority.p1.minutes']).toBeUndefined(); // the priority did not apply then
    expect(c['prev.time.tracked_minutes']).toBeDefined();
  });

  it('states a real zero when the dimension was observed but the bucket was empty', () => {
    const withLeisure = computeMetrics({
      period: week,
      activities: [...[12, 13].flatMap(workday), browsing(12, '20:00', 60)],
      priorities: [],
      taxonomy: TAXONOMY,
      focus: [],
    });
    const noEvening = weekOf([5, 6]);
    const c = buildComparisons({ ...base, current: withLeisure, previous: noEvening, baselines: [], mode: 'full' });
    expect(c['prev.daypart.evening.minutes']).toMatchObject({ value: 0, display: '0m' });
    expect(c['delta.daypart.evening.minutes'].display).toBe('+1h');
  });
});

describe('staleness + supporting numbers', () => {
  const before = dayMetrics(linked(workday(6)));

  it('ignores small re-groupings', () => {
    const after = dayMetrics(linked([...workday(6), research(6, '16:00', 6)]));
    expect(findMeaningfulDifference(before, after, DEFAULT_REFLECTION_CONFIG)).toBeNull();
  });

  it('detects a meaningful change in tracked or classified time', () => {
    const more = dayMetrics(linked([...workday(6), projectY(6, '17:00', 45)]));
    expect(findMeaningfulDifference(before, more, DEFAULT_REFLECTION_CONFIG)).toBe('time.area.area_work');

    const reclassified = dayMetrics(linked(workday(6)).map((a) => (a.thread === 'Project Y' ? { ...a, areaId: 'area_personal' } : a)));
    expect(findMeaningfulDifference(before, reclassified, DEFAULT_REFLECTION_CONFIG)).toBe('time.area.area_personal');
  });

  it('selects a small set of supporting numbers', () => {
    expect(selectSupportingMetrics(before, 'day').map((m) => m.key)).toEqual([
      'time.tracked_minutes',
      'time.focused_minutes',
      'priority.p1.minutes',
      'block.longest_minutes',
      'behavior.switches',
    ]);
    const week = computeMetrics({ period: periodContaining('week', local(7)), activities: workday(6), priorities: [], taxonomy: TAXONOMY, focus: [] });
    expect(selectSupportingMetrics(week, 'week').map((m) => m.key)).toContain('days.active');
  });
});
