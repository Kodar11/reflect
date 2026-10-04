import { strategyKeyOf, targetKeyOf, type FocusFact } from '../../src/coach/CoachMatching';
import type { CoachAction, CoachMemory, CoachMessage } from '../../src/coach/CoachModels';
import type { ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { priorityKey } from '../../src/reflection/ReflectionPriorities';
import { iso, local, modelInsight, modelReflection } from '../reflection/helpers';

let nextId = 1;

/**
 * A coach action with sensible defaults: "one 45-minute Focus session on
 * Project X tomorrow morning", suggested on the evening of Mon Oct 12 for the
 * morning of Tue Oct 13.
 */
export function coachAction(overrides: Partial<CoachAction> = {}): CoachAction {
  const base = {
    actionType: 'focus_session' as const,
    daypart: 'morning' as const,
    focusMinutes: 45 as number | null,
    priorityId: null as string | null,
    thread: 'Project X' as string | null,
    ...overrides,
  };
  return {
    id: `act-${nextId++}`,
    source: 'daily',
    reportId: 'report-12',
    originDayKey: '2026-10-12',
    parentActionId: null,
    title: 'Run one 45-minute Focus session on Project X before switching threads',
    description: null,
    rationale: 'Your longest blocks on Project X started before noon.',
    targetStart: iso(13, '05:00'),
    targetEnd: iso(13, '12:00'),
    focusTask: 'Project X',
    strategyKey: strategyKeyOf(base),
    targetKey: targetKeyOf(base),
    evidence: [],
    sourceMetricKeys: [],
    sourceActivityIds: [],
    confidence: 0.8,
    status: 'suggested',
    execution: null,
    executionSource: null,
    outcome: null,
    reasonCode: null,
    note: null,
    observation: null,
    linkedFocusSessionId: null,
    snoozedUntil: null,
    snoozeCount: 0,
    userEdited: false,
    createdAt: iso(12, '22:00'),
    acceptedAt: null,
    rejectedAt: null,
    executedAt: null,
    outcomeAt: null,
    closedAt: null,
    updatedAt: iso(12, '22:00'),
    ...base,
  };
}

/** The same action, accepted that evening. */
export const accepted = (overrides: Partial<CoachAction> = {}) =>
  coachAction({ status: 'accepted', acceptedAt: iso(12, '22:05'), updatedAt: iso(12, '22:05'), ...overrides });

/** An action that was accepted, then did not happen (the user said so). */
export const notDone = (day: number, overrides: Partial<CoachAction> = {}) =>
  coachAction({
    originDayKey: `2026-10-${String(day).padStart(2, '0')}`,
    createdAt: iso(day, '22:00'),
    acceptedAt: iso(day, '22:05'),
    targetStart: iso(day + 1, '05:00'),
    targetEnd: iso(day + 1, '12:00'),
    status: 'closed',
    execution: 'not_done',
    executionSource: 'user',
    reasonCode: 'bad_timing',
    closedAt: iso(day + 1, '21:00'),
    updatedAt: iso(day + 1, '21:00'),
    ...overrides,
  });

/** An action that was carried out and helped. */
export const worked = (day: number, overrides: Partial<CoachAction> = {}) =>
  coachAction({
    originDayKey: `2026-10-${String(day).padStart(2, '0')}`,
    createdAt: iso(day, '22:00'),
    acceptedAt: iso(day, '22:05'),
    targetStart: iso(day + 1, '05:00'),
    targetEnd: iso(day + 1, '12:00'),
    status: 'closed',
    execution: 'done',
    executionSource: 'observed',
    executedAt: iso(day + 1, '09:45'),
    outcome: 'worked',
    outcomeAt: iso(day + 1, '21:00'),
    closedAt: iso(day + 1, '21:00'),
    updatedAt: iso(day + 1, '21:00'),
    ...overrides,
  });

export function focusFact(day: number, hhmm: string, minutes: number, overrides: Partial<FocusFact> = {}): FocusFact {
  const start = local(day, hhmm);
  return {
    id: `focus-${day}-${hhmm}`,
    task: 'Project X',
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    elapsedMinutes: minutes,
    plannedMinutes: minutes,
    interruptionCount: 0,
    endReason: 'completed',
    endNote: null,
    ...overrides,
  };
}

export function memory(text: string, overrides: Partial<CoachMemory> = {}): CoachMemory {
  return {
    id: `mem-${nextId++}`,
    kind: 'constraint',
    text,
    normalizedKey: priorityKey(text),
    status: 'active',
    source: 'user',
    sourceRef: null,
    targetKey: null,
    createdAt: iso(10, '20:00'),
    updatedAt: iso(10, '20:00'),
    ...overrides,
  };
}

export function message(role: CoachMessage['role'], text: string, at: string, meta: CoachMessage['meta'] = null): CoachMessage {
  return { id: `msg-${nextId++}`, role, text, meta, createdAt: at };
}

// ── What the model returns ──────────────────────────────────────────────────

/** A coach action as the model writes it. */
export function modelAction(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Run one 45-minute Focus session on Project X before switching threads',
    description: null,
    rationale: 'Your longest block on Project X started in the morning, before the afternoon switching began.',
    actionType: 'focus_session',
    when: 'tomorrow',
    daypart: 'morning',
    focusMinutes: 45,
    focusTask: 'Project X',
    priorityId: null,
    thread: 'Project X',
    adaptsActionRef: null,
    metricKeys: ['thread.project-x.minutes'],
    activityRefs: [],
    actionRefs: [],
    confidence: 0.8,
    ...overrides,
  };
}

/** The `coach` part of a day's response. */
export function modelCoach(overrides: Record<string, unknown> = {}) {
  return {
    followups: [],
    actions: [modelAction()],
    noActionReason: null,
    question: null,
    uncertainty: [],
    memoryUpdates: [],
    ...overrides,
  };
}

/** A whole day's intelligence: reflection + coaching in one response. */
export function modelDay(period: ReflectionPeriod, coach: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return modelReflection(period, {
    headline: 'Project X took your morning; the afternoon moved between threads.',
    narrative: 'You started with a long stretch on Project X. After lunch the day broke into shorter pieces across Project Y, research and video.',
    insights: [
      modelInsight({
        title: 'Project X got the morning',
        observation: 'Project X received the largest share of your tracked time today.',
        interpretation: 'Most of your sustained attention went to one thread.',
      }),
    ],
    carryForward: null,
    coach: modelCoach(coach),
    ...overrides,
  });
}

/** A conversational reply as the model writes it. */
export function modelChat(overrides: Record<string, unknown> = {}) {
  return {
    reply: 'Project X is where most of your tracked time has gone.',
    proposedAction: null,
    actionUpdates: [],
    memoryUpdates: [],
    correctionActivityRef: null,
    ...overrides,
  };
}
