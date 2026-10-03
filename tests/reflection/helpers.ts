import type { FocusSession } from '../../src/focus/FocusModels';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import { ReflectionAnnotator } from '../../src/reflection/ReflectionAnnotator';
import { ReflectionMetricsService } from '../../src/reflection/ReflectionMetricsService';
import {
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionActivity,
  type ReflectionConfig,
  type ReflectionPeriod,
  type ReflectionPriority,
  type TaxonomyNames,
} from '../../src/reflection/ReflectionModels';
import { priorityKey } from '../../src/reflection/ReflectionPriorities';
import { ReflectionService } from '../../src/reflection/ReflectionService';
import { FakeUserProfileRepository, ScriptedGemini } from '../intelligence/helpers';
import { FakeReflectionRepository } from './FakeReflectionRepository';

/**
 * Local wall-clock instant in October 2026 (Oct 1 2026 is a Thursday, so
 * Mon Oct 5 – Sun Oct 11 is ISO week 41). Days beyond 31 roll into November,
 * days below 1 into September — handy for multi-week datasets.
 */
export function local(day: number, hhmm = '00:00'): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, day, h, m, 0, 0);
}

export const iso = (day: number, hhmm = '00:00') => local(day, hhmm).toISOString();

export const TAXONOMY: TaxonomyNames = {
  contexts: { coding: 'Coding', learning: 'Learning', browsing: 'Browsing' },
  areas: { area_work: 'Work', area_personal: 'Personal', area_leisure: 'Leisure' },
  intents: { intent_create: 'Create', intent_research: 'Research', intent_consume: 'Consume' },
  qualities: {
    quality_deep_work: 'Deep Work',
    quality_focused: 'Focused',
    quality_routine: 'Routine',
    quality_distracting: 'Distracting',
  },
};

let nextId = 1;

/** An activity starting at local `day hhmm` and running `minutes`. */
export function activity(
  day: number,
  hhmm: string,
  minutes: number,
  overrides: Partial<ReflectionActivity> = {},
): ReflectionActivity {
  const start = local(day, hhmm);
  return {
    id: `act-${nextId++}`,
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    durationMinutes: minutes,
    title: 'Implement Project X sync engine',
    summary: null,
    contextId: 'coding',
    areaId: 'area_work',
    intentId: 'intent_create',
    qualityId: 'quality_focused',
    source: 'ai',
    app: 'VS Code',
    domain: null,
    thread: null,
    priorityId: null,
    ...overrides,
  };
}

/** Project X implementation, focused. */
export const projectX = (day: number, hhmm: string, minutes: number, overrides: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, { title: 'Implement Project X sync engine', thread: 'Project X', ...overrides });

/** Project Y work, focused. */
export const projectY = (day: number, hhmm: string, minutes: number, overrides: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, { title: 'Fix Project Y billing bug', thread: 'Project Y', ...overrides });

export const research = (day: number, hhmm: string, minutes: number, overrides: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, {
    title: 'Research offline sync approaches',
    thread: 'Research',
    intentId: 'intent_research',
    contextId: 'learning',
    qualityId: 'quality_routine',
    app: 'Chrome',
    ...overrides,
  });

export const browsing = (day: number, hhmm: string, minutes: number, overrides: Partial<ReflectionActivity> = {}) =>
  activity(day, hhmm, minutes, {
    title: 'Watch videos',
    thread: null,
    contextId: 'browsing',
    areaId: 'area_leisure',
    intentId: 'intent_consume',
    qualityId: 'quality_distracting',
    app: 'Chrome',
    domain: 'youtube.com',
    ...overrides,
  });

export function priority(id: string, text: string, overrides: Partial<ReflectionPriority> = {}): ReflectionPriority {
  return {
    id,
    text,
    normalizedKey: priorityKey(text),
    status: 'active',
    activeFrom: iso(-60),
    activeUntil: null,
    lastConfirmedAt: iso(-10),
    ...overrides,
  };
}

/** A realistic working day: Project X in the morning, a fragmented afternoon. */
export function workday(day: number): ReflectionActivity[] {
  return [
    projectX(day, '09:00', 80),
    projectX(day, '10:30', 60),
    research(day, '13:00', 20),
    projectY(day, '13:22', 25),
    projectX(day, '13:50', 12),
    browsing(day, '14:05', 10),
    projectY(day, '14:17', 30),
    research(day, '14:50', 15),
    projectX(day, '15:08', 20),
  ];
}

export interface ReflectionHarness {
  service: ReflectionService;
  metrics: ReflectionMetricsService;
  repo: FakeReflectionRepository;
  gemini: ScriptedGemini;
  profiles: FakeUserProfileRepository;
  /** The verified timeline, as plain activities (mutable). */
  activities: ReflectionActivity[];
  focusSessions: FocusSession[];
  sleeps: number[];
  setNow(date: Date): void;
  /** How many times each local day was loaded from the timeline. */
  dayLoads: number[];
}

export interface HarnessOptions {
  activities?: ReflectionActivity[];
  script?: unknown[];
  now?: Date;
  config?: Partial<ReflectionConfig>;
  /** Stated priorities; saved through the real profile semantics. */
  priorities?: string[];
  /** Use the real annotator (consumes one scripted response when it runs). */
  realAnnotator?: boolean;
}

export function makeReflectionHarness(options: HarnessOptions = {}): ReflectionHarness {
  const activities = options.activities ?? [];
  const repo = new FakeReflectionRepository();
  const gemini = new ScriptedGemini(options.script ?? []);
  const profiles = new FakeUserProfileRepository();
  const focusSessions: FocusSession[] = [];
  const sleeps: number[] = [];
  const dayLoads: number[] = [];
  const config = { ...DEFAULT_REFLECTION_CONFIG, ...options.config };
  let now = options.now ?? local(12, '09:00');
  let idCounter = 0;

  if (options.priorities) {
    profiles.saveProfile(
      {
        roles: ['Software Developer'],
        description: 'I build Project X.',
        currentWork: ['Project X'],
        priorities: options.priorities,
        interests: ['Gaming'],
        additionalContext: null,
      },
      'completed',
    );
  }

  // The shared profile fake stamps a fixed date; here the profile was created
  // and last saved on Oct 1.
  const datedProfiles = {
    getProfile: () => {
      const profile = profiles.getProfile();
      return profile.createdAt ? { ...profile, createdAt: iso(1), updatedAt: iso(1) } : profile;
    },
  };

  const metrics = new ReflectionMetricsService(
    {
      getActivities: (from, to) => {
        dayLoads.push(Date.parse(from));
        // Threads are attached by annotations in production; the harness keeps
        // whatever the test put on the activity by seeding matching annotations.
        return activities.filter((a) => a.startedAt >= from && a.startedAt < to).map((a) => ({ ...a }));
      },
      focus: {
        getSessionsByRange: (from, to) =>
          focusSessions.filter((s) => s.startedAt !== null && s.startedAt >= from && s.startedAt < to),
        getInterruptions: () => [],
        getBlockedAttempts: () => [],
      },
      taxonomy: () => TAXONOMY,
      firstEventAt: () =>
        activities.length === 0 ? null : activities.reduce((min, a) => (a.startedAt < min ? a.startedAt : min), activities[0].startedAt),
    },
    repo,
    { config, now: () => now, yieldToEventLoop: async () => {} },
  );

  const service = new ReflectionService({
    repo,
    gemini,
    metrics,
    annotator: options.realAnnotator ? new ReflectionAnnotator({ gemini, repo, now: () => now }) : { annotate: async () => 0 },
    userContext: new UserProfileContextProvider(datedProfiles),
    profiles: datedProfiles,
    taxonomy: () => TAXONOMY,
    learnedPatterns: () => [],
    config,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    newId: () => `id-${String(++idCounter).padStart(4, '0')}`,
  });

  return {
    service,
    metrics,
    repo,
    gemini,
    profiles,
    activities,
    focusSessions,
    sleeps,
    dayLoads,
    setNow: (date) => {
      now = date;
    },
  };
}

/**
 * Seed thread annotations so activities keep the `thread` the test gave them
 * after passing through the real annotate-on-load path.
 */
export function seedThreads(repo: FakeReflectionRepository, activities: ReflectionActivity[], priorityByThread: Record<string, string> = {}): void {
  const seen = new Map<string, { thread: string | null; contextId: string | null; title: string }>();
  for (const a of activities) seen.set(`${priorityKey(a.title)}|${a.contextId ?? ''}`, a);
  repo.upsertAnnotations(
    [...seen.entries()].map(([signature, a]) => ({
      signature,
      thread: a.thread,
      priorityId: a.thread ? priorityByThread[a.thread] ?? null : null,
      checkedPriorityIds: Object.values(priorityByThread),
    })),
    iso(1),
  );
}

/** A model reflection with sensible defaults for `period`. */
export function modelReflection(period: ReflectionPeriod, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    periodType: period.type,
    periodStart: period.start,
    periodEnd: period.end,
    headline: 'Project X received most of your tracked time this period.',
    insights: [modelInsight()],
    carryForward: null,
    ...overrides,
  };
}

export function modelInsight(overrides: Record<string, unknown> = {}) {
  return {
    type: 'progress',
    title: 'Project X moved forward',
    observation: 'Project X received the largest share of your tracked time.',
    interpretation: 'Most of your attention this period went to one thread.',
    relevance: null,
    suggestedAction: null,
    metricKeys: ['thread.project-x.minutes'],
    activityRefs: [],
    priorityIds: [],
    confidence: 0.85,
    ...overrides,
  };
}
