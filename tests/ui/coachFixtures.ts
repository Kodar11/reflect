import { vi } from 'vitest';
import type { CoachController } from '../../src/ui/Reflection/CoachPanel';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { insight, makeView, report } from './reflectionFixtures';

/** Fixtures for the Coach UI tests: a day's briefing as the main process hands it over. */

const local = (day: number, h = 0, m = 0) => new Date(2026, 9, day, h, m);

export const day12 = periodContaining('day', local(12));

export function coachAction(overrides: Partial<CoachActionDto> = {}): CoachActionDto {
  return {
    id: 'act-1',
    source: 'daily',
    reportId: 'r-day',
    title: 'Run one 45-minute Focus session on Project X before switching threads',
    description: null,
    rationale: 'Your longest block on Project X started in the morning, before the afternoon switching began.',
    actionType: 'focus_session',
    status: 'suggested',
    execution: null,
    executionSource: null,
    outcome: null,
    reasonCode: null,
    note: null,
    targetLabel: 'Tomorrow · morning',
    focusMinutes: 45,
    focusTask: 'Project X',
    daypart: 'morning',
    evidence: [{ kind: 'metric', metricKey: 'thread.project-x.minutes', label: 'Time on “Project X”', value: '2h 52m' }],
    observation: null,
    pending: 'decision',
    statusLine: 'Tomorrow · morning',
    canStartFocus: true,
    adaptedFrom: null,
    createdAt: local(12, 22, 5).toISOString(),
    updatedAt: local(12, 22, 5).toISOString(),
    ...overrides,
  };
}

export const acceptedAction = (overrides: Partial<CoachActionDto> = {}) =>
  coachAction({ id: 'act-accepted', status: 'accepted', pending: null, statusLine: 'Accepted · Tomorrow · morning', ...overrides });

export const observedAction = (overrides: Partial<CoachActionDto> = {}) =>
  coachAction({
    id: 'act-observed',
    status: 'review',
    execution: 'done',
    executionSource: 'observed',
    pending: 'outcome',
    canStartFocus: false,
    statusLine: 'Carried out (observed) — did it help?',
    observation: { kind: 'executed', facts: ['Focus session “Project X” ran 42m of 45m planned, 1 interruption.'] },
    ...overrides,
  });

export const unobservedAction = (overrides: Partial<CoachActionDto> = {}) =>
  coachAction({
    id: 'act-unobserved',
    status: 'review',
    pending: 'execution',
    canStartFocus: false,
    statusLine: 'Not observed — did it happen?',
    observation: { kind: 'not_observed', facts: ['Nothing matching was observed between Tue, Oct 13, 5:00 AM and 12:00 PM.'] },
    ...overrides,
  });

export const settledAction = (overrides: Partial<CoachActionDto> = {}) =>
  coachAction({
    id: 'act-settled',
    status: 'closed',
    execution: 'done',
    executionSource: 'observed',
    outcome: 'worked',
    pending: null,
    canStartFocus: false,
    statusLine: 'Carried out · it worked',
    ...overrides,
  });

export function coachState(overrides: Partial<CoachStateDto> = {}): CoachStateDto {
  return {
    configured: true,
    settings: { reflectionMinutes: 22 * 60, dayStartMinutes: 0, notifyDailyReflection: true },
    next: [],
    commitments: [],
    recent: [],
    reportActions: [],
    learned: [],
    memory: [],
    question: null,
    messages: [],
    ...overrides,
  };
}

export function controller(overrides: Partial<CoachController> = {}): CoachController {
  return {
    state: coachState(),
    live: true,
    busyActionId: null,
    chatBusy: false,
    chatError: null,
    notice: null,
    onDecide: vi.fn(),
    onEdit: vi.fn(),
    onExecution: vi.fn(),
    onOutcome: vi.fn(),
    onStartFocus: vi.fn(),
    onSend: vi.fn(),
    onRemoveMemory: vi.fn(),
    onSaveSettings: vi.fn(),
    ...overrides,
  };
}

/** A day's intelligence: reflection + coach block, as `reflection:getReport` returns it. */
export function dailyReport(overrides: Partial<ReflectionReportDto> = {}): ReflectionReportDto {
  return report({
    id: 'r-day',
    headline: 'Project X took your morning; the afternoon moved between threads.',
    narrative: 'You started with a long stretch on Project X. After lunch the day broke into shorter pieces.',
    insights: [
      insight({ id: 'i-progress', type: 'progress', title: 'Project X got the morning' }),
      insight({ id: 'i-change', type: 'change_over_time', title: 'More switching than your usual afternoon' }),
      insight({ id: 'i-priority', type: 'priority_alignment', title: 'Most of your time went toward launching Project X' }),
    ],
    carryForward: null,
    coach: {
      actionIds: ['act-1'],
      followups: [
        {
          actionId: 'act-old',
          title: 'Protect the first hour for Project X',
          note: 'The Focus session ran 42m of the 45m planned.',
          learned: 'A morning block on Project X is realistic for you.',
        },
      ],
      uncertainty: ['I am not sure whether the afternoon research belonged to Project X.'],
      noActionReason: null,
      question: null,
    },
    generatedAt: local(12, 22, 6).toISOString(),
    coveredUntil: local(12, 22, 5).toISOString(),
    isPartial: true,
    notes: [],
    ...overrides,
  });
}

export function dailyView(overrides: Parameters<typeof makeView>[0] = {}) {
  const { period, ...rest } = overrides;
  return makeView({
    period: { ...day12, title: 'Today', range: 'Mon, Oct 12', isCurrent: true, isClosed: false, hasPrevious: true, hasNext: false, ...period },
    report: dailyReport(),
    live: null,
    canRefresh: false,
    refreshBlockedReason: 'cooldown',
    dailyReflectionAt: local(12, 22).toISOString(),
    ...rest,
  });
}
