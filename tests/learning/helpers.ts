import type { TrackingRule } from '../../src/database/ActivityRuleRepository';
import type { Event } from '../../src/models/Event';
import { LearnedRuleService, type LearnedRuleServiceDeps } from '../../src/learning/LearnedRuleService';
import type {
  ClassificationIds,
  LearnedRuleCandidate,
  LearnedRuleConfig,
  LearningActivity,
} from '../../src/learning/LearnedRuleModels';
import { DEFAULT_LEARNED_RULE_CONFIG } from '../../src/learning/LearnedRuleModels';
import { classificationHash, patternHash, normalizeConditions } from '../../src/learning/LearnedPattern';
import type { RuleCondition } from '../../src/categorization/Classification';
import { InMemoryEvents, ScriptedGemini, makeEvent } from '../intelligence/helpers';
import { FakeLearnedRuleRepository } from './FakeLearnedRuleRepository';

/**
 * Local wall-clock instant relative to a fixed "day 0" (12 Sep 2026). Local
 * time is used on purpose: distinct-day counting is about calendar days as the
 * user experiences them, so the tests hold in any timezone.
 */
export function at(dayOffset: number, hour: number, minute = 0): string {
  return new Date(2026, 8, 12 + dayOffset, hour, minute, 0, 0).toISOString();
}

export const ACTIVITIES = [
  { id: 'coding', name: 'Coding', color: 'blue' },
  { id: 'gametheory', name: 'Game Theory', color: 'green' },
];

export const DIMENSIONS = [
  { id: 'area_work', dimension: 'area' as const, name: 'Work', sortOrder: 0 },
  { id: 'area_personal', dimension: 'area' as const, name: 'Personal', sortOrder: 1 },
  { id: 'area_leisure', dimension: 'area' as const, name: 'Leisure', sortOrder: 2 },
  { id: 'intent_create', dimension: 'intent' as const, name: 'Create', sortOrder: 0 },
  { id: 'intent_learn', dimension: 'intent' as const, name: 'Learn', sortOrder: 1 },
  { id: 'intent_consume', dimension: 'intent' as const, name: 'Consume', sortOrder: 6 },
  { id: 'quality_focused', dimension: 'quality' as const, name: 'Focused', sortOrder: 1 },
];

export const WORK: ClassificationIds = {
  contextId: null,
  areaId: 'area_work',
  intentId: 'intent_create',
  qualityId: 'quality_focused',
};

export const PERSONAL: ClassificationIds = {
  contextId: null,
  areaId: 'area_personal',
  intentId: 'intent_create',
  qualityId: 'quality_focused',
};

export const LEISURE: ClassificationIds = {
  contextId: null,
  areaId: 'area_leisure',
  intentId: 'intent_consume',
  qualityId: null,
};

export const GAME_THEORY_TITLE = 'strategy.py — GameTheory — Visual Studio Code';

export const GAME_THEORY_PATTERN: RuleCondition[] = [
  { type: 'app_equals', value: 'VS Code' },
  { type: 'title_contains', value: 'GameTheory' },
];

/** A Gemini pattern proposal. */
export function proposal(conditions: RuleCondition[], confidence = 0.9) {
  return { schemaVersion: 1, conditions, explanation: 'Application and project name in the window title.', confidence };
}

/** A timeline activity; defaults to 30 minutes of VS Code in the GameTheory project. */
export function activity(
  start: string,
  eventIds: number[],
  overrides: Partial<LearningActivity> = {},
): LearningActivity {
  return {
    aiActivityId: null,
    startedAt: start,
    endedAt: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    activeDurationMs: 30 * 60_000,
    primaryApp: 'Visual Studio Code',
    primaryTitle: GAME_THEORY_TITLE,
    appsUsed: ['Visual Studio Code'],
    browserTabs: [GAME_THEORY_TITLE],
    eventIds,
    classificationSource: 'ai',
    classification: WORK,
    ...overrides,
  };
}

/** The raw event behind `activity()`. */
export function vsCodeEvent(id: number, start: string, title = GAME_THEORY_TITLE): Event {
  return makeEvent(id, start, new Date(Date.parse(start) + 30 * 60_000).toISOString(), {
    app: 'Visual Studio Code',
    title,
  });
}

/** A stored candidate with explicit evidence, for pure eligibility tests. */
export function candidate(overrides: Partial<LearnedRuleCandidate> = {}): LearnedRuleCandidate {
  const conditions = normalizeConditions(overrides.conditions ?? GAME_THEORY_PATTERN);
  const classification = overrides.classification ?? PERSONAL;
  return {
    id: 'lrc_a',
    patternHash: patternHash(conditions),
    classificationHash: classificationHash(classification),
    occurrenceCount: 0,
    distinctDayCount: 0,
    correctionCount: 0,
    conflictCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    lastCorrectionAt: null,
    lastSuggestedAt: null,
    suggestionCount: 0,
    status: 'pending',
    snoozedUntil: null,
    confirmedRuleId: null,
    createdAt: at(0, 9),
    updatedAt: at(0, 9),
    ...overrides,
    conditions,
    classification,
  };
}

export interface LearningHarness {
  service: LearnedRuleService;
  repo: FakeLearnedRuleRepository;
  gemini: ScriptedGemini;
  events: InMemoryEvents;
  /** The verified timeline the service scans. */
  timeline: LearningActivity[];
  rules: TrackingRule[];
  rulesChanged: { count: number };
  setNow(iso: string): void;
}

export function makeLearningHarness(
  options: { config?: Partial<LearnedRuleConfig>; deps?: Partial<LearnedRuleServiceDeps> } = {},
): LearningHarness {
  const rules: TrackingRule[] = [];
  const repo = new FakeLearnedRuleRepository(rules);
  const gemini = new ScriptedGemini();
  const events = new InMemoryEvents();
  const timeline: LearningActivity[] = [];
  const rulesChanged = { count: 0 };
  let now = at(0, 12);
  let nextId = 0;

  const service = new LearnedRuleService({
    repo,
    gemini,
    events,
    activityRules: { listRules: () => rules, listActivities: () => ACTIVITIES },
    categorization: { listDimensions: () => DIMENSIONS },
    getActivities: (from, to) => timeline.filter((a) => a.endedAt >= from && a.startedAt <= to),
    onRulesChanged: () => {
      rulesChanged.count++;
    },
    now: () => new Date(now),
    newId: () => String(++nextId).padStart(4, '0'),
    config: { ...DEFAULT_LEARNED_RULE_CONFIG, ...options.config },
    ...options.deps,
  });

  return { service, repo, gemini, events, timeline, rules, rulesChanged, setNow: (iso) => { now = iso; } };
}

/** Add an activity (and its raw event) to the harness timeline. */
export function addActivity(
  h: LearningHarness,
  start: string,
  eventId: number,
  overrides: Partial<LearningActivity> = {},
): LearningActivity {
  const a = activity(start, [eventId], overrides);
  h.timeline.push(a);
  h.events.events.push(vsCodeEvent(eventId, start, a.primaryTitle ?? GAME_THEORY_TITLE));
  return a;
}
