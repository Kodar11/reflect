import { describe, it, expect } from 'vitest';
import { matchConditions, specificity, compareRules, sortRules, summarizeConditions } from '../../src/categorization/ClassificationRules.js';
import type { CategorizationRule, SessionLike, RuleCondition } from '../../src/categorization/Classification.js';

function makeSession(overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    id: 's-1-1',
    startedAt: '2024-01-01T10:00:00Z',
    endedAt: '2024-01-01T10:30:00Z',
    primaryApp: 'VS Code',
    primaryBrowser: undefined,
    primaryTitle: 'main.ts - My Project',
    primaryUrl: undefined,
    appsUsed: ['VS Code'],
    browserTabs: [],
    events: [{ id: 1 }],
    ...overrides,
  };
}

function makeRule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: 'rule_1',
    conditions: [{ type: 'app_equals', value: 'VS Code' }],
    contextId: 'planmay',
    areaId: 'area_work',
    intentId: 'intent_create',
    qualityId: 'quality_deep',
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

describe('matchConditions', () => {
  it('matches app_equals', () => {
    const s = makeSession({ primaryApp: 'VS Code' });
    expect(matchConditions(s, [{ type: 'app_equals', value: 'VS Code' }])).toBe(true);
  });

  it('matches case-insensitively', () => {
    const s = makeSession({ primaryApp: 'vs code' });
    expect(matchConditions(s, [{ type: 'app_equals', value: 'VS CODE' }])).toBe(true);
  });

  it('matches against appsUsed', () => {
    const s = makeSession({ primaryApp: 'Chrome', appsUsed: ['Chrome', 'VS Code'] });
    expect(matchConditions(s, [{ type: 'app_equals', value: 'VS Code' }])).toBe(true);
  });

  it('matches canonical app aliases (VS Code ↔ Visual Studio Code)', () => {
    const s = makeSession({ primaryApp: 'Visual Studio Code' });
    expect(matchConditions(s, [{ type: 'app_equals', value: 'VS Code' }])).toBe(true);
    expect(matchConditions(s, [{ type: 'app_equals', value: 'vscode' }])).toBe(true);
  });

  it('matches title_contains', () => {
    const s = makeSession({ primaryTitle: 'React Tutorial - YouTube' });
    expect(matchConditions(s, [{ type: 'title_contains', value: 'React' }])).toBe(true);
  });

  it('matches url_contains', () => {
    const s = makeSession({ primaryUrl: 'github.com/pull/123' });
    expect(matchConditions(s, [{ type: 'url_contains', value: 'github' }])).toBe(true);
  });

  it('matches domain_equals', () => {
    const s = makeSession({ primaryUrl: 'youtube.com/watch?v=abc' });
    expect(matchConditions(s, [{ type: 'domain_equals', value: 'youtube.com' }])).toBe(true);
  });

  it('matches browser_equals', () => {
    const s = makeSession({ primaryBrowser: 'Brave' });
    expect(matchConditions(s, [{ type: 'browser_equals', value: 'brave' }])).toBe(true);
  });

  it('returns false for empty conditions', () => {
    expect(matchConditions(makeSession(), [])).toBe(false);
  });

  it('returns false for unknown condition type', () => {
    expect(matchConditions(makeSession(), [{ type: 'unknown', value: 'x' }])).toBe(false);
  });

  it('normalizes legacy condition types at runtime', () => {
    const s = makeSession({ primaryApp: 'Visual Studio Code' });
    expect(matchConditions(s, [{ type: 'application', value: 'VS Code' }])).toBe(true);
    expect(matchConditions(s, [{ type: 'app', value: 'VS Code' }])).toBe(true);
  });

  it('ANDs multiple conditions', () => {
    const s = makeSession({ primaryApp: 'Chrome', primaryUrl: 'github.com' });
    expect(matchConditions(s, [
      { type: 'app_equals', value: 'Chrome' },
      { type: 'domain_equals', value: 'github.com' },
    ])).toBe(true);
  });

  it('fails if one condition does not match', () => {
    const s = makeSession({ primaryApp: 'Chrome', primaryUrl: 'instagram.com' });
    expect(matchConditions(s, [
      { type: 'app_equals', value: 'Chrome' },
      { type: 'domain_equals', value: 'github.com' },
    ])).toBe(false);
  });
});

describe('specificity', () => {
  it('counts non-empty conditions', () => {
    expect(specificity(makeRule({ conditions: [{ type: 'app_equals', value: 'VS Code' }] }))).toBe(1);
    expect(specificity(makeRule({ conditions: [
      { type: 'app_equals', value: 'Chrome' },
      { type: 'domain_equals', value: 'github.com' },
    ] }))).toBe(2);
  });

  it('ignores empty-value conditions', () => {
    expect(specificity(makeRule({ conditions: [
      { type: 'app_equals', value: 'VS Code' },
      { type: 'title_contains', value: '' },
    ] }))).toBe(1);
  });
});

describe('compareRules', () => {
  it('orders by priority DESC first', () => {
    const a = makeRule({ id: 'a', priority: 0, conditions: [{ type: 'app_equals', value: 'X' }] });
    const b = makeRule({ id: 'b', priority: 1, conditions: [{ type: 'app_equals', value: 'Y' }] });
    expect(compareRules(a, b)).toBeGreaterThan(0);
  });

  it('orders by specificity DESC when priority is equal', () => {
    const a = makeRule({ id: 'a', priority: 0, conditions: [{ type: 'app_equals', value: 'X' }] });
    const b = makeRule({ id: 'b', priority: 0, conditions: [
      { type: 'app_equals', value: 'Y' },
      { type: 'domain_equals', value: 'z.com' },
    ] });
    expect(compareRules(a, b)).toBeGreaterThan(0);
  });

  it('orders by id ASC as stable tiebreak', () => {
    const a = makeRule({ id: 'aaa', priority: 0, conditions: [{ type: 'app_equals', value: 'X' }] });
    const b = makeRule({ id: 'bbb', priority: 0, conditions: [{ type: 'app_equals', value: 'Y' }] });
    expect(compareRules(a, b)).toBeLessThan(0);
  });
});

describe('sortRules', () => {
  it('produces a deterministic order', () => {
    const rules = [
      makeRule({ id: 'c', priority: 0, conditions: [{ type: 'app_equals', value: 'C' }] }),
      makeRule({ id: 'a', priority: 0, conditions: [{ type: 'app_equals', value: 'A' }] }),
      makeRule({ id: 'b', priority: 1, conditions: [{ type: 'app_equals', value: 'B' }] }),
    ];
    const sorted = sortRules(rules);
    expect(sorted[0].id).toBe('b');
    expect(sorted[1].id).toBe('a');
    expect(sorted[2].id).toBe('c');
  });
});

describe('summarizeConditions', () => {
  it('produces a readable summary', () => {
    const conds: RuleCondition[] = [
      { type: 'app_equals', value: 'VS Code' },
      { type: 'title_contains', value: 'Planmay' },
    ];
    expect(summarizeConditions(conds)).toBe('app=VS Code, title~=Planmay');
  });
});