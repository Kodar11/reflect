import { periodContaining } from '../../src/reflection/ReflectionPeriods';

/** Fixtures for the Reflection UI tests: a persisted weekly reflection as the main process hands it over. */

const local = (day: number, h = 0, m = 0) => new Date(2026, 9, day, h, m);

export const week42 = periodContaining('week', local(14));

export function insight(overrides: Partial<ReflectionInsightDto> = {}): ReflectionInsightDto {
  return {
    id: 'i1',
    type: 'progress',
    title: 'Project X moved forward every working day',
    observation: 'You spent 14h 20m on Project X across 5 days.',
    interpretation: 'It was your most sustained thread of the week.',
    relevance: null,
    evidence: [
      { kind: 'metric', metricKey: 'thread.project-x.minutes', label: 'Time on “Project X”', value: '14h 20m' },
      {
        kind: 'activity',
        activityId: 'ai-12-0',
        label: 'Implement Project X sync engine',
        value: '1h 20m · Mon, Oct 12, 9:00 AM',
        period: { start: local(12, 9).toISOString(), end: local(12, 10, 20).toISOString() },
      },
    ],
    feedback: null,
    continuity: 'new',
    priority: null,
    thread: null,
    ...overrides,
  };
}

export function report(overrides: Partial<ReflectionReportDto> = {}): ReflectionReportDto {
  return {
    id: 'r1',
    status: 'fresh',
    headline: 'Project X received consistent attention this week, but your afternoons became more fragmented as you switched between projects.',
    narrative: null,
    coach: null,
    insights: [
      insight(),
      insight({
        id: 'i2',
        type: 'priority_alignment',
        title: 'Most of your time went toward your stated priority',
        observation: '63% of your tracked time was linked to launching Project X.',
        interpretation: 'What you said matters and where your time went lined up.',
        relevance: 'Launching Project X is the priority you told Reflect about.',
        evidence: [
          {
            kind: 'priority',
            metricKey: 'priority.pr-1.share',
            priorityId: 'pr-1',
            label: 'Share of tracked time linked to the priority “Launching Project X”',
            value: '63%',
          },
        ],
        feedback: 'useful',
      }),
    ],
    carryForward: {
      text: 'Protect a dedicated Project X block before switching projects.',
      evidence: [{ kind: 'metric', metricKey: 'daypart.afternoon.switches', label: 'Context switches — Afternoon (12 PM–5 PM)', value: '30' }],
    },
    generatedAt: local(19, 0, 5).toISOString(),
    coveredUntil: week42.end,
    isPartial: false,
    staleReason: null,
    carried: [],
    outdated: false,
    supportingMetrics: [
      { key: 'time.tracked_minutes', label: 'Total tracked time', display: '22h 40m' },
      { key: 'time.focused_minutes', label: 'Focused time (Deep Work + Focused)', display: '18h 55m' },
      { key: 'behavior.switches', label: 'Context switches', display: '30' },
    ],
    notes: ['Not enough history yet for a personal baseline.'],
    ...overrides,
  };
}

type ViewOverrides = Partial<Omit<ReflectionViewDto, 'period'>> & { period?: Partial<ReflectionViewDto['period']> };

export function makeView(overrides: ViewOverrides = {}): ReflectionViewDto {
  const { period, ...rest } = overrides;
  return {
    period: {
      ...week42,
      title: 'Last week',
      range: 'Oct 12 – Oct 18',
      isCurrent: false,
      isClosed: true,
      hasPrevious: true,
      hasNext: true,
      ...period,
    },
    configured: true,
    report: report(),
    generation: { state: 'idle', errorCategory: null, message: null, at: null },
    live: null,
    sufficiency: { enough: true, message: null },
    canRefresh: false,
    refreshBlockedReason: 'up_to_date',
    refreshAvailableAt: null,
    dailyReflectionAt: null,
    priorities: [
      {
        id: 'pr-1',
        text: 'Launching Project X',
        status: 'active',
        activeFrom: local(1).toISOString(),
        lastConfirmedAt: local(1).toISOString(),
        possiblyStale: false,
      },
    ],
    ...rest,
  };
}
