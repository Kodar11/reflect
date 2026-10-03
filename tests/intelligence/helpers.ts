import { vi } from 'vitest';
import type { Event } from '../../src/models/Event';
import type { IEventRepository } from '../../src/database/EventRepository';
import type { TrackingRule } from '../../src/database/ActivityRuleRepository';
import type { FocusSession } from '../../src/focus/FocusModels';
import type { GeminiJsonRequest, IGeminiClient } from '../../src/intelligence/GeminiClient';
import { IntelligenceService, type IntelligenceServiceDeps } from '../../src/intelligence/IntelligenceService';
import { UserProfileContextProvider } from '../../src/intelligence/IntelligenceContext';
import type { IUserProfileRepository } from '../../src/database/UserProfileRepository';
import {
  emptyProfile,
  normalizeProfileInput,
  type OnboardingStatus,
  type UserProfile,
  type UserProfileInput,
} from '../../src/profile/UserProfile';
import { FakeIntelligenceRepository } from './FakeIntelligenceRepository';

/** UTC timestamp on a fixed day: `t('09:20')` → 2026-03-02T09:20:00.000Z. */
export function t(hhmm: string, day = '2026-03-02'): string {
  return `${day}T${hhmm}:00.000Z`;
}

export function makeEvent(
  id: number,
  start: string,
  end: string,
  fields: Partial<Pick<Event, 'app' | 'browser' | 'title' | 'url' | 'watcher' | 'payload'>> = {},
): Event {
  return {
    id,
    watcher: fields.watcher ?? 'window',
    startedAt: start,
    endedAt: end,
    app: fields.app ?? null,
    browser: fields.browser ?? null,
    title: fields.title ?? null,
    url: fields.url ?? null,
    payload: fields.payload ?? null,
    createdAt: null,
  };
}

/** Read-only event store honouring the real range/overlap semantics. */
export class InMemoryEvents implements IEventRepository {
  constructor(public events: Event[] = []) {}
  insert(): number { throw new Error('read-only'); }
  updateEndedAt(): void { throw new Error('read-only'); }
  getToday(): Event[] { return [...this.events]; }
  getAll(): Event[] { return [...this.events]; }
  getByRange(from: string, to: string): Event[] {
    return this.events.filter((e) => e.startedAt >= from && e.startedAt < to);
  }
  getOverlapping(from: string, to: string): Event[] {
    return this.events
      .filter((e) => e.startedAt < to && e.endedAt > from)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id - b.id));
  }
  getByIds(ids: number[]): Event[] {
    return this.events.filter((e) => ids.includes(e.id));
  }
  byId(id: number): Event | undefined {
    return this.events.find((e) => e.id === id);
  }
}

export const TAXONOMY = {
  activities: [
    { id: 'coding', name: 'Coding', color: 'blue' },
    { id: 'learning', name: 'Learning', color: 'green' },
  ],
  dimensions: [
    { id: 'area_work', dimension: 'area' as const, name: 'Work', sortOrder: 0 },
    { id: 'area_leisure', dimension: 'area' as const, name: 'Leisure', sortOrder: 2 },
    { id: 'intent_create', dimension: 'intent' as const, name: 'Create', sortOrder: 0 },
    { id: 'intent_consume', dimension: 'intent' as const, name: 'Consume', sortOrder: 6 },
    { id: 'quality_focused', dimension: 'quality' as const, name: 'Focused', sortOrder: 1 },
    { id: 'quality_distracting', dimension: 'quality' as const, name: 'Distracting', sortOrder: 3 },
  ],
};

/** A model activity with sensible defaults; override what the test cares about. */
export function modelActivity(overrides: Record<string, unknown> & { eventIds: number[] }) {
  return {
    temporaryId: 'a1',
    continuationOfActivityId: null,
    startedAt: t('09:00'),
    endedAt: t('09:30'),
    title: 'Implement Reflect Gemini integration',
    summary: 'Worked on the intelligence pipeline.',
    contextId: 'coding',
    areaId: 'area_work',
    intentId: 'intent_create',
    qualityId: 'quality_focused',
    confidence: 0.9,
    uncertainty: [],
    ...overrides,
  };
}

export function modelOutput(activities: unknown[], unassignedEventIds: number[] = [], window = [t('09:00'), t('10:00')]) {
  return { schemaVersion: 1, windowStart: window[0], windowEnd: window[1], activities, unassignedEventIds };
}

/** Scripted Gemini: each call consumes the next response (object → JSON text, Error → thrown). */
export class ScriptedGemini implements IGeminiClient {
  readonly model = 'test-model';
  configured = true;
  requests: GeminiJsonRequest[] = [];
  private readonly script: unknown[];

  constructor(script: unknown[] = []) {
    this.script = [...script];
  }

  push(...responses: unknown[]): void {
    this.script.push(...responses);
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async generateJson(request: GeminiJsonRequest) {
    this.requests.push(request);
    if (this.script.length === 0) throw new Error('ScriptedGemini: no response scripted');
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : JSON.stringify(next), modelVersion: 'test-model-001' };
  }
}

/** In-memory profile store with the real repository's normalization and status semantics. */
export class FakeUserProfileRepository implements IUserProfileRepository {
  private stored: UserProfile | null = null;
  reads = 0;

  getProfile(): UserProfile {
    this.reads++;
    return this.stored ? structuredClone(this.stored) : emptyProfile();
  }

  saveProfile(input: UserProfileInput, status?: OnboardingStatus): UserProfile {
    this.stored = {
      ...normalizeProfileInput(input),
      onboardingStatus: status ?? this.stored?.onboardingStatus ?? 'not_started',
      createdAt: this.stored?.createdAt ?? t('08:00'),
      updatedAt: t('08:00'),
    };
    return this.getProfile();
  }

  updateProfile(patch: Partial<UserProfileInput> & { onboardingStatus?: OnboardingStatus }): UserProfile {
    const { onboardingStatus, ...answers } = patch;
    const current = this.stored ?? emptyProfile();
    return this.saveProfile({ ...current, ...answers }, onboardingStatus ?? current.onboardingStatus);
  }

  getOnboardingStatus(): OnboardingStatus {
    return this.getProfile().onboardingStatus;
  }

  clearProfile(): void {
    this.stored = null;
  }
}

export interface Harness {
  service: IntelligenceService;
  /** Backs the real `UserProfileContextProvider`; empty (not started) by default. */
  profiles: FakeUserProfileRepository;
  events: InMemoryEvents;
  repo: FakeIntelligenceRepository;
  gemini: ScriptedGemini;
  rules: TrackingRule[];
  focusSessions: FocusSession[];
  sleeps: number[];
  setNow(iso: string): void;
}

export function makeHarness(
  events: Event[],
  script: unknown[] = [],
  extra: Partial<IntelligenceServiceDeps> = {},
): Harness {
  const store = new InMemoryEvents(events);
  const repo = new FakeIntelligenceRepository((id) => store.byId(id));
  const gemini = new ScriptedGemini(script);
  const rules: TrackingRule[] = [];
  const focusSessions: FocusSession[] = [];
  const sleeps: number[] = [];
  const profiles = new FakeUserProfileRepository();
  let now = t('12:00');

  const service = new IntelligenceService({
    events: store,
    repo,
    gemini,
    activityRules: {
      listActivities: vi.fn(() => TAXONOMY.activities),
      listRules: vi.fn(() => rules),
    },
    categorization: {
      listDimensionsByType: vi.fn((type: string) => TAXONOMY.dimensions.filter((d) => d.dimension === type)),
    },
    focus: {
      getSessionsByRange: vi.fn(() => focusSessions),
      getProfiles: vi.fn(() => [{ id: 'default-deep-work', name: 'Deep Work' }] as any),
    },
    userContext: new UserProfileContextProvider(profiles),
    now: () => new Date(now),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });

  return { service, profiles, events: store, repo, gemini, rules, focusSessions, sleeps, setNow: (iso) => { now = iso; } };
}
