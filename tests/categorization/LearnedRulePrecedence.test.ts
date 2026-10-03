import { describe, it, expect, vi } from 'vitest';
import {
  CategorizationService,
  type ClassificationCorrection,
} from '../../src/categorization/CategorizationService';
import { ClassificationEngine } from '../../src/categorization/ClassificationEngine';
import { compareRules, sortRules } from '../../src/categorization/ClassificationRules';
import type { CategorizationRule, DimensionEntry, SessionLike } from '../../src/categorization/Classification';
import type { Activity, ActivityRuleRepository, TrackingRule } from '../../src/database/ActivityRuleRepository';
import type { CategorizationRepository } from '../../src/database/CategorizationRepository';
import type { IEventRepository } from '../../src/database/EventRepository';
import type { IFocusRepository } from '../../src/database/FocusRepository';
import type { VerifiedSession } from '../../src/timeline/TimelineModels';

/**
 * Where learned rules sit in the one deterministic rule system:
 *   user override > user rule > learned rule > AI > system default.
 */

const ACTIVITIES: Activity[] = [{ id: 'coding', name: 'Coding', color: 'blue' }];
const DIMENSIONS: DimensionEntry[] = [
  { id: 'area_work', dimension: 'area', name: 'Work', sortOrder: 0 },
  { id: 'area_personal', dimension: 'area', name: 'Personal', sortOrder: 1 },
  { id: 'area_leisure', dimension: 'area', name: 'Leisure', sortOrder: 2 },
  { id: 'intent_create', dimension: 'intent', name: 'Create', sortOrder: 0 },
  { id: 'quality_focused', dimension: 'quality', name: 'Focused', sortOrder: 1 },
];

const GAME_THEORY = [
  { type: 'app_equals', value: 'VS Code' },
  { type: 'title_contains', value: 'GameTheory' },
];

function rule(id: string, source: CategorizationRule['source'], overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id,
    source,
    conditions: GAME_THEORY,
    contextId: null,
    areaId: 'area_personal',
    intentId: 'intent_create',
    qualityId: 'quality_focused',
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

const SESSION: SessionLike = {
  id: 's-1',
  startedAt: '2026-09-12T09:00:00.000Z',
  endedAt: '2026-09-12T09:30:00.000Z',
  primaryApp: 'Visual Studio Code',
  primaryTitle: 'strategy.py — GameTheory — Visual Studio Code',
  appsUsed: ['Visual Studio Code'],
  browserTabs: [],
  events: [{ id: 1 }],
};

describe('rule ordering with sources', () => {
  it('explicit user rules outrank learned rules, which outrank system defaults', () => {
    const system = rule('a_system', 'system', { priority: 100 });
    const learned = rule('b_learned', 'learned', { priority: 50 });
    const user = rule('c_user', 'user', { priority: 0, conditions: [GAME_THEORY[0]] });
    expect(sortRules([system, learned, user]).map((r) => r.id)).toEqual(['c_user', 'b_learned', 'a_system']);
  });

  it('a rule without a source is an explicit user rule', () => {
    const legacy = rule('legacy', undefined);
    expect(compareRules(legacy, rule('learned', 'learned', { priority: 99 }))).toBeLessThan(0);
    expect(compareRules(legacy, rule('user', 'user'))).toBeLessThan(0); // same tier → id
  });

  it('within one source the order stays priority → specificity → id', () => {
    const lowPriority = rule('a', 'learned', { priority: 1 });
    const highPriority = rule('z', 'learned', { priority: 9, conditions: [GAME_THEORY[0]] });
    const specific = rule('m', 'learned', { priority: 1, conditions: [...GAME_THEORY, { type: 'title_contains', value: 'strategy' }] });
    const twin = rule('b', 'learned', { priority: 1 });
    expect(sortRules([twin, lowPriority, specific, highPriority]).map((r) => r.id)).toEqual(['z', 'm', 'a', 'b']);
  });
});

describe('ClassificationEngine with learned rules', () => {
  const engine = new ClassificationEngine();
  const classify = (rules: CategorizationRule[]) =>
    engine.classify({ session: SESSION, rules, overrides: [], contexts: ACTIVITIES, dimensions: DIMENSIONS, focusSignals: [] });

  it('a learned rule classifies through the same deterministic matcher', () => {
    const result = classify([rule('rule_learned_1', 'learned')]);
    expect(result).toMatchObject({
      source: 'user_rule',
      matchedRuleId: 'rule_learned_1',
      area: { id: 'area_personal', name: 'Personal' },
      intent: { id: 'intent_create' },
      quality: { id: 'quality_focused' },
      isOverride: false,
    });
    expect(result.reason).toBe('Learned rule: app=VS Code, title~=GameTheory → Personal · Create · Focused');
  });

  it('a learned rule beats the broad system default it refines', () => {
    const systemDefault = rule('rule_coding', 'system', { conditions: [GAME_THEORY[0]], contextId: 'coding', areaId: 'area_work' });
    expect(classify([systemDefault, rule('rule_learned_1', 'learned')]).matchedRuleId).toBe('rule_learned_1');
  });

  it('an explicit user rule beats a learned rule for the same activity', () => {
    const user = rule('rule_user', 'user', { conditions: [GAME_THEORY[1]], areaId: 'area_leisure' });
    const result = classify([rule('rule_learned_1', 'learned', { priority: 10 }), user]);
    expect(result.matchedRuleId).toBe('rule_user');
    expect(result.reason).toMatch(/^Rule:/);
  });

  it('a manual override still beats every rule', () => {
    const result = engine.classify({
      session: SESSION,
      rules: [rule('rule_learned_1', 'learned'), rule('rule_user', 'user')],
      overrides: [{ id: 'ov', eventIds: [1], anchorEventId: 1, contextId: null, areaId: 'area_work', intentId: null, qualityId: null, source: 'user_override', ruleId: null }],
      contexts: ACTIVITIES,
      dimensions: DIMENSIONS,
      focusSignals: [],
    });
    expect(result).toMatchObject({ source: 'user_override', area: { id: 'area_work' } });
  });

  it('a disabled learned rule does not classify', () => {
    expect(classify([rule('rule_learned_1', 'learned', { enabled: false })]).source).toBe('unclassified');
  });
});

function makeService(observer?: { onCorrection(c: ClassificationCorrection): void }) {
  const rules: TrackingRule[] = [];
  const overrides: any[] = [];
  const activityRuleRepo = {
    listActivities: vi.fn(() => ACTIVITIES),
    listRules: vi.fn(() => rules),
    saveRule: vi.fn((r: TrackingRule) => rules.push(r)),
  } as unknown as ActivityRuleRepository;
  const categorizationRepo = {
    listDimensions: vi.fn(() => DIMENSIONS),
    listOverrides: vi.fn(() => overrides),
    saveOverride: vi.fn((o: any) => overrides.push(o)),
    saveEventClassification: vi.fn(),
  } as unknown as CategorizationRepository;
  const focusRepo = { getSessionsByRange: vi.fn(() => []), getProfiles: vi.fn(() => []) } as unknown as IFocusRepository;
  const eventRepo = { getByIds: vi.fn(() => []) } as unknown as IEventRepository;
  const service = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, eventRepo, undefined, observer);
  return { service, rules, overrides };
}

function trackingRule(id: string, source: TrackingRule['source'], overrides: Partial<TrackingRule> = {}): TrackingRule {
  return {
    id,
    activityId: '',
    conditions: JSON.stringify(GAME_THEORY),
    enabled: 1,
    priority: 10,
    areaId: 'area_personal',
    intentId: 'intent_create',
    qualityId: 'quality_focused',
    source,
    ...overrides,
  };
}

function aiSession(): VerifiedSession {
  return {
    id: 'ai-1',
    startedAt: new Date('2026-09-14T09:00:00Z'),
    endedAt: new Date('2026-09-14T09:30:00Z'),
    duration: 1_800_000,
    activeDuration: 1_800_000,
    eventCount: 1,
    primaryApp: 'Visual Studio Code',
    primaryTitle: 'payoff.py — GameTheory — Visual Studio Code',
    appsUsed: ['Visual Studio Code'],
    browserTabs: [],
    source: 'generated',
    hidden: false,
    events: [{ id: 1, watcher: 'window', startedAt: '2026-09-14T09:00:00.000Z', endedAt: '2026-09-14T09:30:00.000Z', app: 'Visual Studio Code', title: 'payoff.py — GameTheory — Visual Studio Code', url: null, browser: null, payload: null, createdAt: null }],
    // Gemini keeps rediscovering this as work.
    ai: { activityId: 'ai-1', title: 'Software development', summary: null, contextId: 'coding', areaId: 'area_work', intentId: 'intent_create', qualityId: 'quality_focused', confidence: 0.8, uncertainty: [], userLocked: false },
  };
}

describe('CategorizationService — rules vs. the AI interpretation', () => {
  it('a confirmed learned rule decides the classification of an AI activity', () => {
    const { service, rules } = makeService();
    rules.push(trackingRule('rule_learned_1', 'learned'));
    const session = aiSession();

    service.classifySessions([session]);

    expect(session.classification).toMatchObject({ source: 'user_rule', matchedRuleId: 'rule_learned_1', area: { id: 'area_personal' } });
  });

  it('an explicit user rule decides it too', () => {
    const { service, rules } = makeService();
    rules.push(trackingRule('rule_user', 'user', { areaId: 'area_leisure' }));
    const session = aiSession();

    service.classifySessions([session]);

    expect(session.classification).toMatchObject({ source: 'user_rule', matchedRuleId: 'rule_user', area: { id: 'area_leisure' } });
  });

  it('a system default does not outrank the AI interpretation', () => {
    const { service, rules } = makeService();
    rules.push(trackingRule('rule_coding', 'system', { areaId: 'area_leisure' }));
    const session = aiSession();

    service.classifySessions([session]);

    expect(session.classification).toMatchObject({ source: 'ai', area: { id: 'area_work' } });
  });

  it('without a matching rule the AI interpretation is kept', () => {
    const { service, rules } = makeService();
    rules.push(trackingRule('rule_learned_1', 'learned', { conditions: JSON.stringify([{ type: 'title_contains', value: 'Thesis' }]) }));
    const session = aiSession();

    service.classifySessions([session]);

    expect(session.classification?.source).toBe('ai');
  });

  it('a manual override still wins over a learned rule', () => {
    const { service, rules, overrides } = makeService();
    rules.push(trackingRule('rule_learned_1', 'learned'));
    overrides.push({ id: 'ov', eventIds: [1], anchorEventId: 1, contextId: null, areaId: 'area_leisure', intentId: null, qualityId: null, source: 'user_override', ruleId: null });
    const session = aiSession();

    service.classifySessions([session]);

    expect(session.classification).toMatchObject({ source: 'user_override', area: { id: 'area_leisure' } });
  });
});

describe('CategorizationService — corrections as learning evidence', () => {
  const personal = { contextId: null, areaId: 'area_personal', intentId: 'intent_create', qualityId: 'quality_focused' };

  it('a correction without "Remember for future" is handed to the learning layer', () => {
    const onCorrection = vi.fn();
    const { service, rules, overrides } = makeService({ onCorrection });

    const result = service.saveOverride([1, 2], personal, false);

    expect(result.ruleId).toBeNull();
    expect(overrides).toHaveLength(1); // the override itself is saved as before
    expect(rules).toEqual([]); // and no rule is created
    expect(onCorrection).toHaveBeenCalledTimes(1);
    expect(onCorrection).toHaveBeenCalledWith({ eventIds: [1, 2], ...personal });
  });

  it('"Remember for future" still creates an explicit user rule and is not re-learned', () => {
    const onCorrection = vi.fn();
    const { service, rules } = makeService({ onCorrection });

    const result = service.saveOverride([1], { ...personal, contextId: 'coding' }, true, { primaryApp: 'Visual Studio Code' });

    expect(result.ruleId).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: result.ruleId, source: 'user', activityId: 'coding' });
    expect(onCorrection).not.toHaveBeenCalled();
  });

  it('a failing learning layer never breaks the correction', () => {
    const { service, overrides } = makeService({
      onCorrection: () => {
        throw new Error('learning is down');
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => service.saveOverride([1], personal, false)).not.toThrow();
    expect(overrides).toHaveLength(1);
    errors.mockRestore();
  });

  it('an event-level manual classification is learning evidence as well', () => {
    const onCorrection = vi.fn();
    const { service } = makeService({ onCorrection });

    service.saveEventClassification({ eventId: 7, ...personal, source: 'user_override', ruleId: null });

    expect(onCorrection).toHaveBeenCalledWith({ eventIds: [7], ...personal });
  });
});
