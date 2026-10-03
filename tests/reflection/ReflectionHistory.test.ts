import { describe, it, expect } from 'vitest';
import { ReflectionHistory } from '../../src/reflection/ReflectionHistory';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { iso, local, makeReflectionHarness, modelInsight, modelReflection, seedThreads, workday } from './helpers';

/**
 * The structured read surface the future Coach will use. Everything is
 * answered from persisted insights and metric snapshots — no prose scraping.
 */
describe('ReflectionHistory (Coach-facing queries)', () => {
  const week41 = periodContaining('week', local(7));
  const week42 = periodContaining('week', local(14));

  async function setup() {
    const h = makeReflectionHarness({
      activities: [5, 6, 7, 8, 9, 12, 13, 14].flatMap(workday),
      now: local(19, '09:00'),
      priorities: ['Launching Project X'],
    });
    const priorityId = h.service.syncPriorities()[0].id;
    seedThreads(h.repo, h.activities, { 'Project X': priorityId });
    const reflection = (period: typeof week41, withComparison: boolean) =>
      modelReflection(period, {
        insights: [
          modelInsight(),
          modelInsight({
            type: 'fragmentation',
            title: 'Afternoons were switch heavy',
            observation: 'Context switches were concentrated in your afternoons.',
            metricKeys: withComparison ? ['daypart.afternoon.switches', 'delta.daypart.afternoon.switches'] : ['daypart.afternoon.switches'],
          }),
        ],
        carryForward: {
          text: `Protect a morning block (${period === week41 ? 'first' : 'second'} week).`,
          sourceMetricKeys: ['behavior.switches'],
          sourceActivityRefs: [],
        },
      });
    h.gemini.push(reflection(week41, false), reflection(week42, true));
    await h.service.generate(week41, { trigger: 'scheduled' });
    await h.service.generate(week42, { trigger: 'scheduled' });
    return { ...h, priorityId, history: new ReflectionHistory(h.repo) };
  }

  it('returns a period\'s reflection and the insight history by type', async () => {
    const { history } = await setup();
    expect(history.getReflection('week', week42.key)!.insights).toHaveLength(2);
    expect(history.getReflection('week', '2026-W01')).toBeNull();

    const fragmentation = history.getInsightHistory('fragmentation');
    expect(fragmentation.map((e) => e.period.key)).toEqual(['2026-W42', '2026-W41']);
    expect(fragmentation[0].insight.evidence[0].metricKey).toBe('daypart.afternoon.switches');
    expect(history.getInsightHistory()).toHaveLength(4);
  });

  it('finds recurring patterns by claim signature, not by wording', async () => {
    const { history } = await setup();
    expect(history.getRecurringPatterns('week')).toEqual([
      {
        signature: 'progress|thread.project-x.minutes',
        type: 'progress',
        title: 'Project X moved forward',
        occurrences: 2,
        firstSeen: week41,
        lastSeen: week42,
      },
      {
        signature: 'fragmentation|daypart.afternoon.switches',
        type: 'fragmentation',
        title: 'Afternoons were switch heavy',
        occurrences: 2,
        firstSeen: week41,
        lastSeen: week42,
      },
    ]);
  });

  it('exposes behaviour trends and priority alignment over time, oldest first', async () => {
    const { history, priorityId } = await setup();
    expect(history.getBehaviorTrends('week', 'time.tracked_minutes').map((p) => [p.period.key, p.display])).toEqual([
      ['2026-W41', '22h 40m'],
      ['2026-W42', '13h 36m'],
    ]);
    expect(history.getPriorityAlignmentHistory('week')).toEqual([
      { period: week41, priorityId, priorityText: 'Launching Project X', minutes: 860, sharePercent: 63 },
      { period: week42, priorityId, priorityText: 'Launching Project X', minutes: 516, sharePercent: 63 },
    ]);
  });

  it('returns carry-forwards and user feedback', async () => {
    const { history, service, repo } = await setup();
    expect(history.getCarryForwardHistory('week').map((c) => c.carryForward.text)).toEqual([
      'Protect a morning block (second week).',
      'Protect a morning block (first week).',
    ]);
    const insight = repo.getCurrentReport('week', week42.key)!.insights[1];
    service.submitFeedback(insight.id, 'not_useful');
    expect(history.getUserFeedback(iso(1))).toEqual([
      { insightId: insight.id, insightType: 'fragmentation', feedbackType: 'not_useful', createdAt: iso(19, '09:00') },
    ]);
  });
});
