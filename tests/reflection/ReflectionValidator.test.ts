import { describe, it, expect } from 'vitest';
import { buildComparisons, computeMetrics } from '../../src/reflection/ReflectionMetrics';
import type { MetricSet, ReflectionActivity } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import {
  claimSignature,
  extractNumbers,
  validateReflectionOutput,
  type ReflectionValidationContext,
} from '../../src/reflection/ReflectionValidator';
import { TAXONOMY, local, modelInsight, modelReflection, priority, workday } from './helpers';

const p1 = priority('p1', 'Launch Project X');
const period = periodContaining('week', local(14));
const linked = (list: ReflectionActivity[]) => list.map((a) => (a.thread === 'Project X' ? { ...a, priorityId: 'p1' } : a));

const activities = linked([12, 13, 14, 15, 16].flatMap(workday));
const core = computeMetrics({ period, activities, priorities: [p1], taxonomy: TAXONOMY, focus: [] });
const previous = computeMetrics({ period, activities: linked([5, 6, 7].flatMap(workday)), priorities: [p1], taxonomy: TAXONOMY, focus: [] });
const metrics: MetricSet = {
  ...core,
  ...buildComparisons({
    current: core,
    previous,
    previousName: 'previous week',
    baselines: [],
    baselineUnit: 'week',
    minBaselinePeriods: 3,
    mode: 'full',
  }),
};

function ctx(overrides: Partial<ReflectionValidationContext> = {}): ReflectionValidationContext {
  return {
    period,
    metrics,
    activityByRef: new Map([
      ['a1', activities[0]],
      ['a2', activities[1]],
    ]),
    priorities: [p1],
    maxInsights: 5,
    history: [],
    periodLabel: 'This week Oct 12 – Oct 18',
    ...overrides,
  };
}

/** A fully grounded weekly reflection, as a good model would return it. */
const good = () =>
  modelReflection(period, {
    headline: 'Project X received 14h 20m this week, and your afternoons were where the switching happened.',
    insights: [
      modelInsight({
        type: 'progress',
        title: 'Project X moved forward on all 5 days',
        observation: 'You spent 14h 20m on Project X across 5 days, in 20 sessions.',
        interpretation: 'This was your most consistently worked thread of the week.',
        metricKeys: ['thread.project-x.minutes', 'thread.project-x.active_days', 'thread.project-x.sessions'],
      }),
      modelInsight({
        type: 'priority_alignment',
        title: 'Your stated priority received most of your time',
        observation: '63% of your tracked time went toward the priority “Launch Project X”.',
        interpretation: 'What you said matters and where your time went lined up this week.',
        relevance: 'Launching Project X is the priority you stated.',
        metricKeys: ['priority.p1.share'],
        priorityIds: ['p1'],
      }),
      modelInsight({
        type: 'fragmentation',
        title: 'Switching was concentrated in the afternoon',
        observation: 'All 30 context switches happened in the afternoon; none in the morning.',
        interpretation: 'Your mornings held long blocks while afternoons moved between threads.',
        metricKeys: ['daypart.afternoon.switches', 'daypart.morning.switches'],
        activityRefs: ['a1'],
      }),
      modelInsight({
        type: 'change_over_time',
        title: 'More tracked time than the previous week',
        observation: 'Tracked time was 22h 40m, up from 13h 36m the previous week.',
        interpretation: 'You were active on two more days than the week before.',
        metricKeys: ['time.tracked_minutes', 'prev.time.tracked_minutes', 'delta.days.active'],
      }),
    ],
    carryForward: {
      text: 'Keep a morning block for Project X before switching threads.',
      sourceMetricKeys: ['pattern.longest_block_before_noon_days'],
      sourceActivityRefs: [],
    },
  });

const errorsOf = (raw: unknown, context = ctx()) => {
  const result = validateReflectionOutput(raw, context);
  return result.ok ? [] : result.errors;
};

describe('validateReflectionOutput — acceptance', () => {
  it('accepts a grounded reflection and resolves its evidence', () => {
    const result = validateReflectionOutput(good(), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { reflection } = result;
    expect(reflection.insights.map((i) => i.type)).toEqual(['progress', 'priority_alignment', 'fragmentation', 'change_over_time']);

    // Evidence is self-contained and typed.
    expect(reflection.insights[0].evidence[0]).toEqual({
      kind: 'metric',
      metricKey: 'thread.project-x.minutes',
      label: 'Time on “Project X”',
      value: '14h 20m',
      // Which project and priority it belongs to, and where on the Timeline
      // the work actually lies — the stretch it was done in, not the whole week.
      thread: 'Project X',
      priorityId: 'p1',
      period: { start: activities[0].startedAt, end: expect.any(String) },
    });
    expect(Date.parse(reflection.insights[0].evidence[0].period!.end)).toBeLessThan(Date.parse(period.end));
    // What each insight is about is decided by the backend, from that evidence.
    expect(reflection.insights[0]).toMatchObject({ subjectKey: 'p:p1', priorityId: 'p1', thread: 'Project X', identityKey: 'p:p1|advancing', continuity: 'new' });
    expect(reflection.insights[1].evidence[0]).toMatchObject({ kind: 'priority', priorityId: 'p1', value: '63%' });
    expect(reflection.insights[2].evidence.find((e) => e.kind === 'activity')).toMatchObject({
      activityId: activities[0].id,
      period: { start: activities[0].startedAt, end: activities[0].endedAt },
    });
    expect(reflection.insights[3].evidence.map((e) => e.kind)).toEqual(['metric', 'comparison', 'comparison']);
    expect(reflection.insights[2].sourceActivityIds).toEqual([activities[0].id]);

    // Backend-owned: ids are not part of the model output, signatures are derived.
    expect(reflection.insights[0].claimSignature).toBe(
      'progress|thread.project-x.active_days,thread.project-x.minutes,thread.project-x.sessions',
    );
    expect(reflection.carryForward).toMatchObject({
      text: 'Keep a morning block for Project X before switching threads.',
      sourceMetricKeys: ['pattern.longest_block_before_noon_days'],
    });
  });

  it('accepts "nothing unusual" with no insights', () => {
    const result = validateReflectionOutput(
      modelReflection(period, { headline: 'Nothing unusual stood out this week.', insights: [] }),
      ctx(),
    );
    expect(result).toEqual({
      ok: true,
      reflection: { headline: 'Nothing unusual stood out this week.', narrative: null, insights: [], carryForward: null },
    });
  });
});

describe('validateReflectionOutput — rejection', () => {
  it('rejects an invalid schema', () => {
    expect(errorsOf({ headline: 'x' })[0]).toMatch(/^schema:/);
    expect(errorsOf({ ...good(), schemaVersion: 1 })[0]).toMatch(/schemaVersion/);
    expect(errorsOf({ ...good(), insights: [{ type: 'progress' }] }).join(' ')).toMatch(/insights\.0/);
    const result = validateReflectionOutput('not an object', ctx());
    expect(result.ok === false && result.salvaged).toBeNull();
  });

  it('rejects a reflection for the wrong period', () => {
    const other = periodContaining('week', local(5));
    const result = validateReflectionOutput({ ...good(), periodStart: other.start, periodEnd: other.end }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^period: expected week/);
    expect(result.salvaged).toBeNull();
    expect(errorsOf({ ...good(), periodType: 'month' })[0]).toMatch(/^period:/);
  });

  it('rejects a nonexistent metric', () => {
    const raw = modelReflection(period, { insights: [modelInsight({ metricKeys: ['time.invented_minutes'] })] });
    expect(errorsOf(raw)).toContain('insight 1: metric "time.invented_minutes" does not exist');
  });

  it('rejects a nonexistent activity and a nonexistent priority', () => {
    const raw = modelReflection(period, {
      insights: [modelInsight({ activityRefs: ['a99'], priorityIds: ['p-unknown'] })],
    });
    expect(errorsOf(raw)).toEqual(
      expect.arrayContaining(['insight 1: activity "a99" does not exist', 'insight 1: priority "p-unknown" does not exist']),
    );
  });

  it('rejects an insight with no evidence at all', () => {
    const raw = modelReflection(period, { insights: [modelInsight({ metricKeys: [], activityRefs: [] })] });
    expect(errorsOf(raw).join(' ')).toMatch(/cites no evidence/);
  });

  it('rejects an unsupported insight type', () => {
    const raw = modelReflection(period, { insights: [modelInsight({ type: 'personality_profile' })] });
    expect(errorsOf(raw)).toContain('insight 1: unsupported insight type "personality_profile"');
  });

  it('rejects numbers that are not in the cited evidence', () => {
    const invented = modelReflection(period, {
      insights: [modelInsight({ observation: 'You spent 19h 5m on Project X this week.' })],
    });
    expect(errorsOf(invented)).toContain('insight 1: number(s) "19", "5" not found in its cited evidence');

    // A real number — but from a metric this insight does not cite.
    const uncited = modelReflection(period, {
      insights: [modelInsight({ observation: 'You switched contexts 30 times while working on Project X.' })],
    });
    expect(errorsOf(uncited)).toContain('insight 1: number(s) "30" not found in its cited evidence');
  });

  it('rejects an unsupported number in the headline', () => {
    const raw = { ...good(), headline: 'Your productivity improved by 82 points this week.' };
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok === false && result.errors.join(' ')).toMatch(/headline: number\(s\) "82"/);
    // Still rejected (a retry is asked for) — but if none comes, the day is not lost over it:
    // what is kept carries the title of its strongest validated insight, never the bad number.
    const salvaged = result.ok === false ? result.salvaged : null;
    expect(salvaged).not.toBeNull();
    expect(salvaged!.headline).toBe(salvaged!.insights[0].title);
    expect(salvaged!.headline).not.toContain('82');
    // With no validated insight to fall back on, there is nothing to keep.
    const empty = validateReflectionOutput({ ...good(), headline: 'Your productivity improved by 82 points this week.', insights: [] }, ctx());
    expect(empty.ok === false && empty.salvaged).toBeNull();
  });

  it('rejects causal language', () => {
    for (const interpretation of [
      'Slack caused your focus to decline during the afternoon.',
      'The switching happened because you moved between projects.',
      'This fragmentation was due to frequent project changes.',
    ]) {
      const raw = modelReflection(period, { insights: [modelInsight({ interpretation })] });
      expect(errorsOf(raw).join(' ')).toMatch(/uses causal language/);
    }
    // Describing co-occurrence is fine.
    const fine = modelReflection(period, {
      insights: [modelInsight({ interpretation: 'The switching coincided with moving between projects.' })],
    });
    expect(validateReflectionOutput(fine, ctx()).ok).toBe(true);
  });

  it('rejects psychological, health and motivation claims', () => {
    for (const interpretation of [
      'You were tired by the afternoon.',
      'You seemed unmotivated after lunch.',
      'You were probably stressed about the deadline.',
      'You were distracted for most of the afternoon.',
    ]) {
      const raw = modelReflection(period, { insights: [modelInsight({ interpretation })] });
      expect(errorsOf(raw).join(' ')).toMatch(/Reflect has no evidence for it/);
    }
  });

  it('rejects judgment and productivity scoring', () => {
    for (const interpretation of [
      'You wasted your afternoon on other projects.',
      'You were procrastinating instead of working on Project X.',
      'You became more productive this week.',
      'Your productivity score went up.',
    ]) {
      const raw = modelReflection(period, { insights: [modelInsight({ interpretation })] });
      expect(errorsOf(raw).join(' ')).toMatch(/describe, do not judge/);
    }
  });

  it('rejects a comparison made without comparison evidence', () => {
    const raw = modelReflection(period, {
      insights: [modelInsight({ observation: 'Your time on Project X increased compared with the week before.' })],
    });
    expect(errorsOf(raw)).toContain('insight 1: states a comparison without citing a comparison metric');

    const change = modelReflection(period, {
      insights: [modelInsight({ type: 'change_over_time', metricKeys: ['time.tracked_minutes'] })],
    });
    expect(errorsOf(change).join(' ')).toMatch(/change_over_time insight must cite a comparison/);
  });

  it('rejects a priority-alignment insight that cites no priority', () => {
    const raw = modelReflection(period, { insights: [modelInsight({ type: 'priority_alignment' })] });
    expect(errorsOf(raw).join(' ')).toMatch(/must cite a priority metric/);
  });

  it('rejects empty or meaningless content', () => {
    expect(errorsOf(modelReflection(period, { headline: '  ' })).join(' ')).toMatch(/headline: empty/);
    const raw = modelReflection(period, { insights: [modelInsight({ observation: 'Yes.', interpretation: '' })] });
    expect(errorsOf(raw)).toEqual(
      expect.arrayContaining([
        'insight 1: observation is empty or meaningless',
        'insight 1: interpretation is empty or meaningless',
      ]),
    );
  });

  it('rejects an excessive insight count and offers the complementary subset', () => {
    const many = modelReflection(period, {
      insights: [
        modelInsight({ title: 'Project X time', confidence: 0.9 }),
        modelInsight({ type: 'time_attention_pattern', title: 'Mornings held the long blocks', metricKeys: ['daypart.morning.minutes'], confidence: 0.6 }),
        modelInsight({ type: 'fragmentation', title: 'Afternoons were switch heavy', metricKeys: ['daypart.afternoon.switches'], confidence: 0.7 }),
        modelInsight({ type: 'progress', title: 'Billing bug work continued', metricKeys: ['thread.project-y.minutes'], confidence: 0.8 }),
      ],
    });
    const result = validateReflectionOutput(many, ctx({ maxInsights: 3 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('too many insights: 4 returned, at most 3 allowed — keep only the most meaningful');
    // One of each type first (diversity), in the original narrative order.
    expect(result.salvaged!.insights.map((i) => i.title)).toEqual([
      'Project X time',
      'Mornings held the long blocks',
      'Afternoons were switch heavy',
    ]);
  });

  it('removes duplicate insights, keeping the stronger one', () => {
    const raw = modelReflection(period, {
      insights: [
        modelInsight({ title: 'You switched contexts often', type: 'fragmentation', metricKeys: ['behavior.switches'], confidence: 0.6 }),
        modelInsight({
          title: 'Frequent switching between threads',
          type: 'fragmentation',
          metricKeys: ['behavior.switches'],
          confidence: 0.9,
        }),
        modelInsight(),
      ],
    });
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection.insights.map((i) => i.title)).toEqual(['Frequent switching between threads', 'Project X moved forward']);
  });

  it('quietly leaves out weakly supported insights', () => {
    const raw = modelReflection(period, { insights: [modelInsight(), modelInsight({ title: 'A guess', metricKeys: ['behavior.switches'], confidence: 0.2 })] });
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok && result.reflection.insights).toHaveLength(1);
  });

  it('does not repeat an already-surfaced pattern without new evidence', () => {
    const fragmentation = (metricKeys: string[]) =>
      modelReflection(period, {
        insights: [modelInsight({ type: 'fragmentation', title: 'Afternoons were switch heavy', metricKeys })],
      });
    /** The same identity, said in each of the three previous weeks. */
    const saidBefore = (identityKey: string, subjectKey: string | null = null) =>
      [1, 2, 3].map((periodsBack) => ({
        periodsBack,
        periodKey: `w-${periodsBack}`,
        identityKey,
        subjectKey,
        magnitude: null,
        title: 'Said before',
        type: 'fragmentation' as const,
        feedback: null,
      }));
    const recent = saidBefore('period|fragmentation|daypart.afternoon.switches');

    expect(errorsOf(fragmentation(['daypart.afternoon.switches']), ctx({ history: recent })).join(' ')).toMatch(
      /already surfaced in 3 recent reports/,
    );
    // The same claim WITH a comparison that shows what changed is allowed.
    expect(
      validateReflectionOutput(
        fragmentation(['daypart.afternoon.switches', 'delta.daypart.afternoon.switches']),
        ctx({ history: recent }),
      ).ok,
    ).toBe(true);
    // Progress may recur: new progress on the same priority is still news — and is labelled as continuing.
    const again = validateReflectionOutput(modelReflection(period), ctx({ history: saidBefore('p:p1|advancing', 'p:p1') }));
    expect(again.ok && again.reflection.insights[0].continuity).toBe('continuing');
  });
});

describe('validateReflectionOutput — one grounded action', () => {
  it('rejects a carry-forward that cites nothing or gives generic advice', () => {
    const ungrounded = { ...good(), carryForward: { text: 'Protect a morning block tomorrow.', sourceMetricKeys: [], sourceActivityRefs: [] } };
    expect(errorsOf(ungrounded)).toContain('carryForward: must cite the metrics or activities it is grounded in');

    for (const text of ['Try the Pomodoro technique next week.', 'Drink more water and take regular breaks.', 'Wake up earlier to get more done.']) {
      const generic = { ...good(), carryForward: { text, sourceMetricKeys: ['behavior.switches'], sourceActivityRefs: [] } };
      expect(errorsOf(generic).join(' ')).toMatch(/carryForward: contains/);
    }
  });

  it('salvage drops an invalid carry-forward but keeps the valid insights', () => {
    const raw = { ...good(), carryForward: { text: 'Take regular breaks.', sourceMetricKeys: ['behavior.switches'], sourceActivityRefs: [] } };
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.salvaged!.carryForward).toBeNull();
    expect(result.salvaged!.insights).toHaveLength(4);
  });

  it('an insight carries no action of its own: the carry-forward is the one place for one', () => {
    // An action written inside an insight (as an older contract allowed) is
    // not part of the output: it is neither stored nor promoted.
    const raw = modelReflection(period, {
      insights: [{ ...modelInsight(), suggestedAction: 'Continue Project X before opening a new thread.' }],
    });
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection.carryForward).toBeNull();
    expect(JSON.stringify(result.reflection)).not.toContain('suggestedAction');
  });

  it('says which priority or project a carry-forward is about', () => {
    const raw = { ...good(), carryForward: { text: 'Keep a morning block for Project X.', sourceMetricKeys: ['thread.project-x.minutes'], sourceActivityRefs: [] } };
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok && result.reflection.carryForward).toMatchObject({ subjectKey: 'p:p1' });
  });
});

describe('validateReflectionOutput — salvage', () => {
  it('removes only the unsupported insight', () => {
    const raw = good();
    (raw.insights as Record<string, unknown>[])[2].interpretation = 'You were tired in the afternoon.';
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.salvaged!.insights.map((i) => i.type)).toEqual(['progress', 'priority_alignment', 'change_over_time']);
  });

  it('offers nothing when every proposed insight fell', () => {
    const raw = modelReflection(period, { insights: [modelInsight({ metricKeys: ['nope'] })] });
    const result = validateReflectionOutput(raw, ctx());
    expect(result.ok === false && result.salvaged).toBeNull();
  });
});

describe('number extraction + claim identity', () => {
  it('extracts and normalizes numbers', () => {
    expect(extractNumbers('2h 13m, 31%, 09:05 AM, 1,200 and 18.30')).toEqual(['2', '13', '31', '9:05', '1200', '18.30']);
    expect(extractNumbers('no digits here')).toEqual([]);
  });

  it('identifies a claim independent of wording, sub-bucket and comparison side', () => {
    expect(claimSignature('fragmentation', ['delta.behavior.switches', 'behavior.switches'])).toBe('fragmentation|behavior.switches');
    expect(claimSignature('progress', ['series.2026-10-05.tracked_minutes'])).toBe(
      claimSignature('progress', ['series.2026-10-12.tracked_minutes']),
    );
    expect(claimSignature('open_loop', [])).toBe('open_loop|activities');
  });
});
