import { describe, it, expect, vi } from 'vitest';
import { CategorizationService } from '../../src/categorization/CategorizationService.js';
import type { ActivityRuleRepository, Activity, TrackingRule } from '../../src/database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../../src/database/CategorizationRepository.js';
import type { IFocusRepository } from '../../src/database/FocusRepository.js';
import type { FocusSession, FocusProfile } from '../../src/focus/FocusModels.js';
import type { VerifiedSession } from '../../src/timeline/TimelineModels.js';
import type { DimensionEntry } from '../../src/categorization/Classification.js';

function makeRepo(): {
  activityRuleRepo: ActivityRuleRepository;
  categorizationRepo: CategorizationRepository;
  focusRepo: IFocusRepository;
  rules: TrackingRule[];
  activities: Activity[];
  overrides: any[];
  dimensions: DimensionEntry[];
} {
  const activities: Activity[] = [
    { id: 'coding', name: 'Coding', color: 'blue' },
  ];
  const rules: TrackingRule[] = [];
  const overrides: any[] = [];
  const dimensions: DimensionEntry[] = [
    { id: 'area_work', dimension: 'area', name: 'Work', sortOrder: 0 },
    { id: 'area_personal', dimension: 'area', name: 'Personal', sortOrder: 1 },
    { id: 'area_learning', dimension: 'area', name: 'Learning', sortOrder: 2 },
    { id: 'intent_create', dimension: 'intent', name: 'Create', sortOrder: 0 },
    { id: 'intent_learn', dimension: 'intent', name: 'Learn', sortOrder: 1 },
    { id: 'quality_deep', dimension: 'quality', name: 'Deep', sortOrder: 0 },
    { id: 'quality_focused', dimension: 'quality', name: 'Focused', sortOrder: 1 },
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
  } as unknown as CategorizationRepository;

  const focusRepo = {
    getSessionsByRange: vi.fn(() => [] as FocusSession[]),
    getProfiles: vi.fn(() => [] as FocusProfile[]),
  } as unknown as IFocusRepository;

  return { activityRuleRepo, categorizationRepo, focusRepo, rules, activities, overrides, dimensions };
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
    const { activityRuleRepo, categorizationRepo, focusRepo } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo);

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
    const { activityRuleRepo, categorizationRepo, focusRepo, rules } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo);

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
    const { activityRuleRepo, categorizationRepo, focusRepo, overrides } = makeRepo();
    const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo);

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
});
