import { describe, it, expect } from 'vitest';
import {
  INSIGHT_TYPE_LABELS,
  PERIOD_TABS,
  anchorForOffset,
  deriveScreen,
  formatGeneratedAt,
  generateResultNotice,
  navigationState,
  nextFeedback,
  refreshHint,
  refreshLabel,
  shortMetricLabel,
  staleMessage,
  timelineTargetFor,
  resolveTimelineTarget,
  evidenceWhere,
  carryStatusLine,
} from '../../src/ui/Reflection/reflectionView';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { REFLECTION_INSIGHT_TYPES } from '../../src/reflection/ReflectionModels';
import { makeView, report, week42 } from './reflectionFixtures';

const local = (day: number, h = 0, m = 0) => new Date(2026, 9, day, h, m);

describe('Reflection tab — period switching and historical navigation', () => {
  it('offers Today / Week / Month / Year', () => {
    expect(PERIOD_TABS.map((t) => [t.type, t.label])).toEqual([
      ['day', 'Today'],
      ['week', 'Week'],
      ['month', 'Month'],
      ['year', 'Year'],
    ]);
  });

  it('steps to the previous and next period', () => {
    const previous = anchorForOffset(week42, -1);
    expect(periodContaining('week', previous).key).toBe('2026-W41');
    expect(periodContaining('week', anchorForOffset(week42, 1)).key).toBe('2026-W43');
    const october = periodContaining('month', local(15));
    expect(periodContaining('month', anchorForOffset(october, -1)).key).toBe('2026-09');
    expect(periodContaining('year', anchorForOffset(periodContaining('year', local(15)), -1)).key).toBe('2025');
  });

  it('never navigates into the future or before tracking began', () => {
    expect(navigationState(null)).toEqual({ canGoPrevious: false, canGoNext: false, isCurrent: true });
    const current = makeView({ period: { isCurrent: true, isClosed: false, hasNext: false, hasPrevious: true } });
    expect(navigationState(current)).toEqual({ canGoPrevious: true, canGoNext: false, isCurrent: true });
    const first = makeView({ period: { hasPrevious: false, hasNext: true } });
    expect(navigationState(first)).toMatchObject({ canGoPrevious: false, canGoNext: true });
  });
});

describe('Reflection tab — which screen to show', () => {
  it('loading, then error when nothing could be loaded', () => {
    expect(deriveScreen({ view: null, loading: true, error: null })).toBe('loading');
    expect(deriveScreen({ view: null, loading: false, error: 'boom' })).toBe('error');
  });

  it('a report always wins — even when a later refresh failed or it went stale', () => {
    expect(deriveScreen({ view: makeView(), loading: false, error: null })).toBe('report');
    const failedRefresh = makeView({ generation: { state: 'failed', errorCategory: 'network', message: 'x', at: null } });
    expect(deriveScreen({ view: failedRefresh, loading: false, error: null })).toBe('report');
    expect(deriveScreen({ view: makeView({ report: report({ status: 'stale' }) }), loading: true, error: null })).toBe('report');
  });

  it('empty states: generating, insufficient data, failed, unconfigured, pending', () => {
    const none = (overrides: Parameters<typeof makeView>[0]) => deriveScreen({ view: makeView({ report: null, ...overrides }), loading: false, error: null });
    expect(none({ generation: { state: 'generating', errorCategory: null, message: null, at: null } })).toBe('generating');
    expect(none({ sufficiency: { enough: false, message: 'Not enough activity yet to generate a meaningful reflection.' } })).toBe('insufficient');
    expect(none({ generation: { state: 'insufficient_data', errorCategory: null, message: null, at: null } })).toBe('insufficient');
    expect(none({ generation: { state: 'failed', errorCategory: 'validation', message: 'x', at: null } })).toBe('failed');
    expect(none({ configured: false })).toBe('unconfigured');
    expect(none({})).toBe('pending');
  });
});

describe('Reflection tab — evidence links', () => {
  it('opens one activity on its day and selects it', () => {
    const target = timelineTargetFor(
      { activityId: 'ai-12-0', period: { start: local(12, 9).toISOString(), end: local(12, 10, 20).toISOString() } },
      week42,
    );
    expect(target).toMatchObject({ day: local(12, 9).toISOString(), view: 'day', activityId: 'ai-12-0' });
  });

  it('carries the raw events behind an activity, so the link survives a regrouped timeline', async () => {
    const period = { start: local(12, 9).toISOString(), end: local(12, 10, 20).toISOString() };
    const target = timelineTargetFor({ activityId: 's-101-4', eventIds: [101, 102, 103, 104], period }, week42);
    expect(target.evidence).toEqual({ activityId: 's-101-4', eventIds: [101, 102, 103, 104], period });

    // The block that holds those events today has another id: that one is opened.
    const resolved = await resolveTimelineTarget(target, async (evidence) => {
      expect(evidence.eventIds).toEqual([101, 102, 103, 104]);
      return { activityId: 'ai-new', start: local(12, 9, 5).toISOString(), end: local(12, 10).toISOString() };
    });
    expect(resolved).toMatchObject({ activityId: 'ai-new', day: local(12, 9, 5).toISOString(), view: 'day' });

    // The lookup failing (or finding nothing) falls back to the recorded window — never to nowhere.
    expect(await resolveTimelineTarget(target, async () => null)).toEqual(target);
    expect(
      await resolveTimelineTarget(target, async () => {
        throw new Error('offline');
      }),
    ).toEqual(target);
    // A metric over the whole period has nothing to resolve.
    expect(timelineTargetFor({}, week42).evidence).toBeUndefined();
  });

  it('says which days a piece of evidence is about — unless it is the whole period', () => {
    expect(evidenceWhere({ period: { start: local(13).toISOString(), end: local(14).toISOString() } }, week42)).toBe('Tue, Oct 13');
    expect(evidenceWhere({ period: { start: local(13).toISOString(), end: local(16).toISOString() } }, week42)).toBe('Oct 13 – Oct 15');
    expect(evidenceWhere({ period: { start: week42.start, end: week42.end } }, week42)).toBeNull();
    expect(evidenceWhere({}, week42)).toBeNull();
  });

  it('describes carried work without calling closed work open', () => {
    const lastWorked = { start: local(13).toISOString(), end: local(14).toISOString() };
    expect(carryStatusLine({ status: 'open', idleTrackedDays: 3, lastWorked })).toBe('Still open — no work on it for 3 tracked days, last worked Tue, Oct 13.');
    expect(carryStatusLine({ status: 'progressing', idleTrackedDays: 0, lastWorked })).toBe('Picked up again on Tue, Oct 13.');
    expect(carryStatusLine({ status: 'completed', idleTrackedDays: 4, lastWorked })).toBe('Closed — you marked it completed.');
    expect(carryStatusLine({ status: 'dropped', idleTrackedDays: 4, lastWorked: null })).toBe('Closed — you removed it from your priorities.');
  });

  it('opens a metric window in the smallest view that shows it', () => {
    const dayBucket = { period: { start: local(13).toISOString(), end: local(14).toISOString() } };
    expect(timelineTargetFor(dayBucket, week42)).toMatchObject({ view: 'day', activityId: null });
    const weekBucket = { period: { start: local(12).toISOString(), end: local(19).toISOString() } };
    expect(timelineTargetFor(weekBucket, week42).view).toBe('week');
    const month = periodContaining('month', local(15));
    expect(timelineTargetFor({ period: { start: month.start, end: month.end } }, week42).view).toBe('month');
  });

  it('falls back to the reflection\'s own period when the evidence has no window', () => {
    expect(timelineTargetFor({}, week42)).toEqual({ day: week42.start, view: 'week', activityId: null });
    expect(timelineTargetFor(null, periodContaining('day', local(13)))).toMatchObject({ view: 'day' });
    expect(timelineTargetFor(null, periodContaining('year', local(13))).view).toBe('year');
  });
});

describe('Reflection tab — feedback and labels', () => {
  it('toggles feedback: same choice clears, another replaces', () => {
    expect(nextFeedback(null, 'useful')).toBe('useful');
    expect(nextFeedback('useful', 'useful')).toBeNull();
    expect(nextFeedback('useful', 'inaccurate')).toBe('inaccurate');
  });

  it('labels every insight type', () => {
    for (const type of REFLECTION_INSIGHT_TYPES) expect(INSIGHT_TYPE_LABELS[type]).toBeTruthy();
    expect(INSIGHT_TYPE_LABELS.recurring_behavior).toBe('A pattern emerged');
    expect(INSIGHT_TYPE_LABELS.change_over_time).toBe('What changed');
  });

  it('says when a reflection was generated and why it is stale', () => {
    expect(formatGeneratedAt(local(19, 0, 5).toISOString())).toBe('Mon, Oct 19, 12:05 AM');
    expect(formatGeneratedAt(null)).toBeNull();
    expect(formatGeneratedAt('not a date')).toBeNull();
    expect(staleMessage('activity_changed')).toBe('The activity in this period changed after this reflection was written.');
    expect(staleMessage('priorities_changed')).toBe('Your priorities changed after this reflection was written.');
  });

  it('labels the refresh action for the situation', () => {
    expect(refreshLabel(makeView())).toBe('Refresh reflection');
    expect(refreshLabel(makeView({ report: null }))).toBe('Generate reflection');
    expect(refreshLabel(makeView({ report: null, period: { isCurrent: true, isClosed: false } }))).toBe('Reflect now');
  });

  it('explains a blocked refresh only when that helps', () => {
    const cooldown = makeView({ canRefresh: false, refreshBlockedReason: 'cooldown', refreshAvailableAt: local(20, 16, 15).toISOString() });
    expect(refreshHint(cooldown)).toBe('You can refresh again at 4:15 PM.');
    expect(refreshHint(makeView({ canRefresh: false, refreshBlockedReason: 'not_configured' }))).toMatch(/Gemini API key/);
    expect(refreshHint(makeView({ canRefresh: false, refreshBlockedReason: 'up_to_date' }))).toBeNull();
    expect(refreshHint(makeView())).toBeNull();
  });

  it('turns a refresh outcome into a calm notice', () => {
    expect(generateResultNotice({ status: 'succeeded', reportId: 'r', period: week42, attempts: 1, insightCount: 3 })).toBeNull();
    expect(generateResultNotice({ status: 'skipped', reason: 'throttled', period: week42 })).toBe('This reflection was refreshed a moment ago.');
    expect(
      generateResultNotice({ status: 'failed', category: 'network', error: 'x', reportId: null, period: week42, attempts: 3 }),
    ).toBe('Reflect could not reach Gemini, so nothing was changed.');
    expect(
      generateResultNotice({ status: 'failed', category: 'validation', error: 'x', reportId: 'r', period: week42, attempts: 3 }),
    ).toMatch(/evidence checks/);
  });

  it('shortens supporting-number labels', () => {
    expect(shortMetricLabel({ key: 'time.tracked_minutes', label: 'Total tracked time' })).toBe('Tracked');
    expect(shortMetricLabel({ key: 'priority.pr-1.minutes', label: 'Time linked to the priority “X”' })).toBe('Current priority');
    expect(shortMetricLabel({ key: 'something.else', label: 'Something else' })).toBe('Something else');
  });
});
