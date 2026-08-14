import { describe, it, expect, vi } from 'vitest';
import { CategorizationService } from '../../src/categorization/CategorizationService.js';
import type { ActivityRuleRepository, Activity, TrackingRule } from '../../src/database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../../src/database/CategorizationRepository.js';
import type { IEventRepository } from '../../src/database/EventRepository.js';
import type { IFocusRepository } from '../../src/database/FocusRepository.js';
import type { FocusSession, FocusProfile } from '../../src/focus/FocusModels.js';
import type { VerifiedSession } from '../../src/timeline/TimelineModels.js';
import type { DimensionEntry, EventClassification } from '../../src/categorization/Classification.js';
import type { Event } from '../../src/models/Event.js';

function makeRepo(): {
  activityRuleRepo: ActivityRuleRepository;
  categorizationRepo: CategorizationRepository;
  eventRepo: IEventRepository;
  focusRepo: IFocusRepository;
  rules: TrackingRule[];
  activities: Activity[];
  overrides: any[];
  eventClassifications: EventClassification[];
  events: Event[];
  dimensions: DimensionEntry[];
} {
  const activities: Activity[] = [
    { id: 'coding', name: 'Coding', color: 'blue' },
    { id: 'music', name: 'Music Listening', color: 'green' },
  ];
  const rules: TrackingRule[] = [];
  const overrides: any[] = [];
  const eventClassifications: EventClassification[] = [];
  const events: Event[] = [];
  const dimensions: DimensionEntry[] = [
    { id: 'area_work', dimension: 'area', name: 'Work', sortOrder: 0 },
    { id: 'area_personal', dimension: 'area', name: 'Personal', sortOrder: 1 },
    { id: 'area_learning', dimension: 'area', name: 'Learning', sortOrder: 2 },
    { id: 'area_leisure', dimension: 'area', name: 'Leisure', sortOrder: 3 },
    { id: 'intent_create', dimension: 'intent', name: 'Create', sortOrder: 0 },
    { id: 'intent_learn', dimension: 'intent', name: 'Learn', sortOrder: 1 },
    { id: 'intent_consume', dimension: 'intent', name: 'Consume', sortOrder: 2 },
    { id: 'quality_deep', dimension: 'quality', name: 'Deep', sortOrder: 0 },
    { id: 'quality_focused', dimension: 'quality', name: 'Focused', sortOrder: 1 },
    { id: 'quality_distracting', dimension: 'quality', name: 'Distracting', sortOrder: 2 },
  ];

  const activityRuleRepo = {
    listActivities: vi.fn(() => activities),
    listRules: vi.fn(() => rules),
    saveRule: vi.fn((r: TrackingRule) => {
      const idx = rules.findIndex((x) => x.id === r.id);
      if (idx >= 0) rules[idx] = r;
      else rules.push(r);
    }),
    saveActivity: vi.fn(),
    deleteActivity: vi.fn(),
    deleteRule: vi.fn((id: string) => {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx >= 0) rules.splice(idx, 1);
    }),
    getActivity: vi.fn(),
  } as unknown as ActivityRuleRepository;

  const categorizationRepo = {
    listDimensions: vi.fn(() => dimensions),
    listDimensionsByType: vi.fn((type: string) => dimensions.filter((d) => d.dimension === type)),
    listOverrides: vi.fn(() => overrides),
    saveOverride: vi.fn((o: any) => overrides.push(o)),
    deleteOverride: vi.fn(),
    saveEventClassification: vi.fn((c: EventClassification) => {
      const idx = eventClassifications.findIndex((x) => x.eventId === c.eventId);
      if (idx >= 0) eventClassifications[idx] = { ...c };
      else eventClassifications.push({ ...c });
    }),
    getEventClassification: vi.fn((eventId: number) =>
      eventClassifications.find((c) => c.eventId === eventId) ?? null,
    ),
    getEventClassifications: vi.fn((eventIds: number[]) =>
      eventClassifications.filter((c) => eventIds.includes(c.eventId)),
    ),
    deleteEventClassification: vi.fn((eventId: number) => {
      const idx = eventClassifications.findIndex((c) => c.eventId === eventId);
      if (idx >= 0) eventClassifications.splice(idx, 1);
    }),
  } as unknown as CategorizationRepository;

  const eventRepo = {
    getByIds: vi.fn((ids: number[]) => events.filter((e) => ids.includes(e.id))),
  } as unknown as IEventRepository;

  const focusRepo = {
    getSessionsByRange: vi.fn(() => [] as FocusSession[]),
    getProfiles: vi.fn(() => [] as FocusProfile[]),
  } as unknown as IFocusRepository;

  return { activityRuleRepo, categorizationRepo, eventRepo, focusRepo, rules, activities, overrides, eventClassifications, events, dimensions };
}

function makeVerifiedSession(overrides: Partial<VerifiedSession> = {}): VerifiedSession {
  return {
    id: 's-1',
    startedAt: new Date('2024-01-01T09:00:00Z'),
    endedAt: new Date('2024-01-01T09:30:00Z'),
    duration: 1800000,
    activeDuration: 1800000,
    eventCount: 1,
    primaryApp: 'Visual Studio Code',
    primaryBrowser: null,
    primaryTitle: 'main.ts',
    primaryUrl: null,
    appsUsed: ['Visual Studio Code'],
    browserTabs: [],
    source: 'generated',
    events: [{ id: 1, watcher: 'test', startedAt: new Date(), endedAt: new Date(), app: 'Visual Studio Code', title: 'main.ts', url: null, browser: null, payload: null, createdAt: new Date() }],
    ...overrides,
  } as VerifiedSession;
}

describe('CategorizationService', () => {
  it('classifies a VS Code session using an existing rule', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_1',
      activityId: 'coding',
      conditions: JSON.stringify([{ type: 'app_equals', value: 'VS Code' }]),
      enabled: 1,
      priority: 0,
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });

    const sessions = [makeVerifiedSession()];
    service.classifySessions(sessions);

    expect(sessions[0].classification?.source).toBe('user_rule');
    expect(sessions[0].classification?.context?.name).toBe('Coding');
    expect(sessions[0].classification?.area?.name).toBe('Work');
  });

  it('"Remember for future" creates a rule that classifies future sessions', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, rules } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    const first = makeVerifiedSession({ events: [{ id: 1, watcher: 'test', startedAt: new Date(), endedAt: new Date(), app: 'Visual Studio Code', title: 'Planmay spec', url: null, browser: null, payload: null, createdAt: new Date() }] });
    service.saveOverride(
      [1],
      { contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_deep' },
      true,
      { primaryApp: 'Visual Studio Code', primaryTitle: 'Planmay spec' },
    );

    expect(rules.length).toBe(1);
    const rememberedRule = rules[0];
    expect(rememberedRule.priority).toBe(10);
    expect(rememberedRule.activityId).toBe('coding');
    expect(rememberedRule.areaId).toBe('area_work');

    const second = makeVerifiedSession({
      id: 's-2',
      events: [{ id: 2, watcher: 'test', startedAt: new Date(), endedAt: new Date(), app: 'Visual Studio Code', title: 'Planmay spec', url: null, browser: null, payload: null, createdAt: new Date() }],
    });
    service.classifySessions([second]);

    expect(second.classification?.source).toBe('user_rule');
    expect(second.classification?.context?.name).toBe('Coding');
    expect(second.classification?.matchedRuleId).toBe(rememberedRule.id);
  });

  it('override wins over rules and survives with anchor event id', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, overrides } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_1',
      activityId: 'coding',
      conditions: JSON.stringify([{ type: 'app_equals', value: 'VS Code' }]),
      enabled: 1,
      priority: 0,
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });

    service.saveOverride(
      [1],
      { contextId: 'coding', areaId: 'area_personal', intentId: 'intent_learn', qualityId: 'quality_focused' },
      false,
    );

    expect(overrides[0].anchorEventId).toBe(1);

    const session = makeVerifiedSession({
      events: [{ id: 1, watcher: 'test', startedAt: new Date(), endedAt: new Date(), app: 'Visual Studio Code', title: 'main.ts', url: null, browser: null, payload: null, createdAt: new Date() }],
    });
    service.classifySessions([session]);

    expect(session.classification?.source).toBe('user_override');
    expect(session.classification?.area?.name).toBe('Personal');
  });

  it('rememberEventAsRule creates a domain_equals rule from a URL', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, rules } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    const result = service.rememberEventAsRule(
      123,
      { contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused' },
      { app: 'Brave Browser', title: 'Reflect - ChatGPT', url: 'chatgpt.com' },
    );

    expect(result.ruleId).toBeDefined();
    expect(result.activityId).toBe('coding');
    expect(rules).toHaveLength(1);

    const rule = rules[0];
    expect(rule.activityId).toBe('coding');
    expect(rule.areaId).toBe('area_work');
    expect(rule.intentId).toBe('intent_create');
    expect(rule.qualityId).toBe('quality_focused');
    expect(rule.priority).toBe(10);

    const conditions = JSON.parse(rule.conditions);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].type).toBe('domain_equals');
    expect(conditions[0].value).toBe('chatgpt.com');
  });

  it('rememberEventAsRule falls back to app_equals when no URL', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, rules } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    service.rememberEventAsRule(
      124,
      { contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused' },
      { app: 'Visual Studio Code', title: 'main.ts' },
    );

    const conditions = JSON.parse(rules[0].conditions);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].type).toBe('app_equals');
    expect(conditions[0].value).toBe('Visual Studio Code');
  });

  it('rememberEventAsRule throws without a context', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    expect(() =>
      service.rememberEventAsRule(
        125,
        { contextId: null, areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused' },
        { app: 'VS Code' },
      ),
    ).toThrow(/Cannot remember a rule without a Context/);
  });
});

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    watcher: 'window',
    startedAt: '2024-01-01T09:00:00.000Z',
    endedAt: '2024-01-01T09:05:00.000Z',
    app: null,
    browser: null,
    title: null,
    url: null,
    payload: null,
    createdAt: null,
    ...overrides,
  };
}

describe('CategorizationService.getResolvedEventClassifications', () => {
  it('explicit event classification wins over a matching rule', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 1, url: 'https://youtube.com/watch' }));

    service.saveEventClassification({
      eventId: 1,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    });

    const result = service.getResolvedEventClassifications([1]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('coding');
    expect(result[0].source).toBe('user_override');
    expect(result[0].ruleId).toBeNull();
  });

  it('matching domain rule classifies an unclassified event', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 2, app: 'Brave Browser', url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([2]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('music');
    expect(result[0].areaId).toBe('area_leisure');
    expect(result[0].intentId).toBe('intent_consume');
    expect(result[0].qualityId).toBe('quality_distracting');
    expect(result[0].source).toBe('user_rule');
    expect(result[0].ruleId).toBe('rule_yt');
  });

  it('matching app rule classifies an unclassified event', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_code',
      activityId: 'coding',
      conditions: JSON.stringify([{ type: 'app_equals', value: 'Visual Studio Code' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });

    events.push(makeEvent({ id: 3, app: 'Visual Studio Code', title: 'main.ts' }));

    const result = service.getResolvedEventClassifications([3]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('coding');
    expect(result[0].source).toBe('user_rule');
    expect(result[0].ruleId).toBe('rule_code');
  });

  it('disabled rule does not match → falls back to default', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 0,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 4, url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([4]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('default');
    expect(result[0].areaId).toBe('area_leisure');
    expect(result[0].ruleId).toBeNull();
  });

  it('non-matching rule does not classify → falls back to default', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_gh',
      activityId: 'coding',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'github.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });

    events.push(makeEvent({ id: 5, url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([5]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('default');
    expect(result[0].areaId).toBe('area_leisure');
    expect(result[0].intentId).toBe('intent_consume');
    expect(result[0].ruleId).toBeNull();
  });

  it('multiple rules use priority and specificity ordering', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt_broad',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    activityRuleRepo.saveRule({
      id: 'rule_yt_specific',
      activityId: 'coding',
      conditions: JSON.stringify([
        { type: 'domain_equals', value: 'youtube.com' },
        { type: 'title_contains', value: 'specific' },
      ]),
      enabled: 1,
      priority: 10,
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
    });

    events.push(makeEvent({ id: 6, url: 'https://youtube.com/watch', title: 'specific video' }));

    const result = service.getResolvedEventClassifications([6]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('coding');
    expect(result[0].ruleId).toBe('rule_yt_specific');
  });

  it('no matching rule returns no classification', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    events.push(makeEvent({ id: 7, url: 'https://example.com/page' }));

    const result = service.getResolvedEventClassifications([7]);
    expect(result).toHaveLength(0);
  });

  it('manual classification remains authoritative after repeated resolution', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 8, url: 'https://youtube.com/watch' }));

    service.saveEventClassification({
      eventId: 8,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    });

    for (let i = 0; i < 3; i++) {
      const result = service.getResolvedEventClassifications([8]);
      expect(result).toHaveLength(1);
      expect(result[0].contextId).toBe('coding');
      expect(result[0].source).toBe('user_override');
    }
  });

  it('rememberEventAsRule creates a rule that classifies a new matching event', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    service.rememberEventAsRule(
      9,
      {
        contextId: 'music',
        areaId: 'area_leisure',
        intentId: 'intent_consume',
        qualityId: 'quality_distracting',
      },
      { app: 'Brave Browser', url: 'https://youtube.com/watch' },
    );

    events.push(makeEvent({ id: 10, app: 'Brave Browser', url: 'https://youtube.com/another' }));

    const result = service.getResolvedEventClassifications([10]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('music');
    expect(result[0].source).toBe('user_rule');
    expect(result[0].ruleId).toBeDefined();
  });

  it('does not persist rule-derived classifications into event_classifications', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events, eventClassifications } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 11, url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([11]);
    expect(result).toHaveLength(1);
    expect(eventClassifications).toHaveLength(0);
  });

  it('explicit classification wins over a matching rule and a default', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 12, app: 'Brave Browser', url: 'https://youtube.com/watch' }));
    service.saveEventClassification({
      eventId: 12,
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_deep',
      source: 'user_override',
      ruleId: null,
    });

    const result = service.getResolvedEventClassifications([12]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('coding');
    expect(result[0].areaId).toBe('area_work');
    expect(result[0].source).toBe('user_override');
    expect(result[0].ruleId).toBeNull();
  });

  it('matching rule wins over default classification', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    activityRuleRepo.saveRule({
      id: 'rule_yt',
      activityId: 'music',
      conditions: JSON.stringify([{ type: 'domain_equals', value: 'youtube.com' }]),
      enabled: 1,
      priority: 10,
      areaId: 'area_leisure',
      intentId: 'intent_consume',
      qualityId: 'quality_distracting',
    });

    events.push(makeEvent({ id: 13, app: 'Brave Browser', url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([13]);
    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('music');
    expect(result[0].areaId).toBe('area_leisure');
    expect(result[0].source).toBe('user_rule');
    expect(result[0].ruleId).toBe('rule_yt');
  });

  it('default classification wins when no explicit and no rule match', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    events.push(makeEvent({ id: 14, app: 'Brave Browser', url: 'https://chatgpt.com/c/abc' }));

    const result = service.getResolvedEventClassifications([14]);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe(14);
    expect(result[0].contextId).toBeNull();
    expect(result[0].areaId).toBe('area_work');
    expect(result[0].intentId).toBe('intent_learn');
    expect(result[0].qualityId).toBe('quality_focused');
    expect(result[0].source).toBe('default');
    expect(result[0].ruleId).toBeNull();
  });

  it('unknown event with no default remains unclassified', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    events.push(makeEvent({ id: 15, app: 'MysteryApp', url: 'https://unknown.example.com/' }));

    const result = service.getResolvedEventClassifications([15]);
    expect(result).toHaveLength(0);
  });

  it('does not persist default classifications into event_classifications', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events, eventClassifications } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    events.push(makeEvent({ id: 16, app: 'Brave Browser', url: 'https://youtube.com/watch' }));

    const result = service.getResolvedEventClassifications([16]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('default');
    expect(eventClassifications).toHaveLength(0);
  });

  it('repeated resolution produces the same default', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    events.push(makeEvent({ id: 17, app: 'Visual Studio Code', title: 'main.ts' }));

    for (let i = 0; i < 3; i++) {
      const result = service.getResolvedEventClassifications([17]);
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('default');
      expect(result[0].areaId).toBe('area_work');
      expect(result[0].intentId).toBe('intent_create');
      expect(result[0].qualityId).toBe('quality_focused');
    }
  });

  it('rememberEventAsRule creates a rule that beats the default', () => {
    const { activityRuleRepo, categorizationRepo, focusRepo, eventRepo, events, rules } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo);

    // Before the rule exists, ChatGPT resolves via the default layer.
    events.push(makeEvent({ id: 18, app: 'Brave Browser', url: 'https://chatgpt.com/c/abc' }));
    const before = service.getResolvedEventClassifications([18]);
    expect(before).toHaveLength(1);
    expect(before[0].source).toBe('default');

    // User explicitly remembers a rule for ChatGPT.
    const { ruleId } = service.rememberEventAsRule(
      18,
      { contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_deep' },
      { app: 'Brave Browser', url: 'https://chatgpt.com/c/abc' },
    );

    // A new matching event should now be classified by the rule, not the default.
    events.push(makeEvent({ id: 19, app: 'Brave Browser', url: 'https://chatgpt.com/another' }));
    const after = service.getResolvedEventClassifications([19]);
    expect(after).toHaveLength(1);
    expect(after[0].source).toBe('user_rule');
    expect(after[0].ruleId).toBe(ruleId);
    expect(after[0].contextId).toBe('coding');
  });
});
