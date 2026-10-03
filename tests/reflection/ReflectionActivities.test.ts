import { describe, it, expect } from 'vitest';
import type { Event } from '../../src/models/Event';
import { activitySignature, threadSlug, toReflectionActivities } from '../../src/reflection/ReflectionActivities';
import type { VerifiedSession } from '../../src/timeline/TimelineModels';
import { iso, local } from './helpers';

const event = (id: number): Event => ({
  id,
  watcher: 'window',
  startedAt: iso(6, '09:00'),
  endedAt: iso(6, '10:00'),
  app: 'VS Code',
  browser: null,
  title: 'secret-plan.md — reflect — Visual Studio Code',
  url: null,
  payload: '{"bundleId":123}',
  createdAt: null,
});

function session(overrides: Partial<VerifiedSession> = {}): VerifiedSession {
  return {
    id: 's-1-1',
    startedAt: local(6, '09:00'),
    endedAt: local(6, '10:00'),
    duration: 60 * 60_000,
    activeDuration: 55 * 60_000,
    events: [event(1)],
    primaryApp: 'VS Code',
    primaryTitle: 'secret-plan.md — reflect — Visual Studio Code',
    appsUsed: ['VS Code'],
    browserTabs: [],
    eventCount: 1,
    source: 'generated',
    hidden: false,
    ...overrides,
  };
}

const ai = {
  activityId: 'ai-1',
  title: 'Implement Project X sync engine',
  summary: 'Worked on conflict resolution.',
  contextId: 'coding',
  areaId: 'area_work',
  intentId: 'intent_create',
  qualityId: 'quality_focused',
  confidence: 0.9,
  uncertainty: [],
  userLocked: false,
};

const classification = (source: 'ai' | 'user_override' | 'user_rule') => ({
  context: { id: 'coding', name: 'Coding' },
  area: { id: 'area_work', name: 'Work' },
  intent: { id: 'intent_create', name: 'Create' },
  quality: { id: 'quality_focused', name: 'Focused' },
  source,
  reason: '',
  matchedRuleId: null,
  matchedConditions: null,
  isOverride: source === 'user_override',
});

describe('toReflectionActivities (verified timeline → reflection)', () => {
  it('uses the AI activity as the semantic unit, with the resolved classification', () => {
    const [activity] = toReflectionActivities([session({ id: 'ai-1', ai, classification: classification('ai') })]);
    expect(activity).toEqual({
      id: 'ai-1',
      startedAt: iso(6, '09:00'),
      endedAt: iso(6, '10:00'),
      durationMinutes: 55, // tracked (active) time, not the envelope
      title: 'Implement Project X sync engine',
      summary: 'Worked on conflict resolution.',
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      source: 'ai',
      app: 'VS Code',
      domain: null,
      thread: null,
      priorityId: null,
    });
  });

  it('never carries raw window titles or event payloads for un-analysed sessions', () => {
    const [activity] = toReflectionActivities([session({ primaryUrl: 'github.com' })]);
    expect(activity.title).toBe('VS Code · github.com');
    expect(activity.source).toBe('deterministic');
    expect(JSON.stringify(activity)).not.toMatch(/secret-plan|bundleId|payload/);
    expect(toReflectionActivities([session({ primaryApp: undefined })])[0].title).toBe('Untitled activity');
  });

  it('a user correction wins and is marked as such', () => {
    const renamed = toReflectionActivities([session({ ai, customTitle: 'Pairing on Project X' })])[0];
    expect(renamed).toMatchObject({ title: 'Pairing on Project X', source: 'user_override' });

    const reclassified = toReflectionActivities([
      session({
        ai,
        classification: { ...classification('user_override'), area: { id: 'area_personal', name: 'Personal' } },
      }),
    ])[0];
    expect(reclassified).toMatchObject({ source: 'user_override', areaId: 'area_personal' });
  });

  it('skips deleted blocks and blocks without any time', () => {
    expect(toReflectionActivities([session({ hidden: true }), session({ duration: 0, activeDuration: 0 })])).toEqual([]);
  });

  it('counts a hand-added offline block by its stated range — and only inside the queried window', () => {
    const offline = session({
      id: 'u-7',
      startedAt: local(14, '18:00'),
      endedAt: local(14, '19:00'),
      duration: 60 * 60_000,
      activeDuration: 0,
      events: [],
      customTitle: 'Whiteboard session',
      primaryApp: undefined,
      primaryTitle: 'Whiteboard session',
      source: 'user',
    });
    // The timeline engine replays offline blocks into every query…
    const queriedOnItsDay = toReflectionActivities([offline], { start: iso(14), end: iso(15) });
    expect(queriedOnItsDay).toMatchObject([{ id: 'u-7', title: 'Whiteboard session', durationMinutes: 60, source: 'user_override' }]);
    // …so on any other day it must be dropped, or it would be counted once per day.
    expect(toReflectionActivities([offline], { start: iso(13), end: iso(14) })).toEqual([]);
    expect(toReflectionActivities([offline], { start: iso(15), end: iso(16) })).toEqual([]);
    // Blocks backed by events are already scoped by the query itself.
    expect(toReflectionActivities([session()], { start: iso(13), end: iso(14) })).toHaveLength(1);
  });

  it('derives stable signatures and thread slugs', () => {
    expect(activitySignature({ title: '  Implement Project-X  sync engine ', contextId: 'coding' })).toBe('implement project x sync engine|coding');
    expect(activitySignature({ title: 'Anything', contextId: null })).toBe('anything|');
    expect(threadSlug('Project  X')).toBe('project-x');
    expect(threadSlug('Game Theory')).toBe(threadSlug('game theory'));
  });
});
