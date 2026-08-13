import { describe, it, expect } from 'vitest';
import { aggregateByDimension } from '../../src/categorization/ClassificationStatistics.js';
import type { Classification, SessionLike } from '../../src/categorization/Classification.js';

function makeSession(id: string, startMin: number, endMin: number, overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    id,
    startedAt: `2024-01-01T${String(10 + Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00Z`,
    endedAt: `2024-01-01T${String(10 + Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00Z`,
    primaryApp: 'Test',
    appsUsed: ['Test'],
    browserTabs: [],
    events: [{ id: parseInt(id.split('-')[2] ?? '1') }],
    ...overrides,
  };
}

describe('aggregateByDimension', () => {
  it('aggregates time by area', () => {
    const sessions: SessionLike[] = [
      makeSession('s-1-1', 0, 30),
      makeSession('s-2-2', 30, 60),
    ];
    const classifications = new Map<string, Classification>([
      ['s-1-1', {
        context: null, area: { id: 'area_work', name: 'Work' },
        intent: { id: 'intent_create', name: 'Create' },
        quality: { id: 'quality_deep', name: 'Deep' },
        source: 'user_rule', reason: '', matchedRuleId: null,
        matchedConditions: null, isOverride: false,
      }],
      ['s-2-2', {
        context: null, area: { id: 'area_learning', name: 'Learning' },
        intent: null, quality: null,
        source: 'unclassified', reason: '', matchedRuleId: null,
        matchedConditions: null, isOverride: false,
      }],
    ]);
    const breakdown = aggregateByDimension(classifications, sessions);
    expect(breakdown.totalMs).toBe(3600000); // 60 min total
    expect(breakdown.classifiedMs).toBe(1800000); // 30 min classified
    expect(breakdown.unclassifiedMs).toBe(1800000); // 30 min unclassified
    expect(breakdown.byArea['Work']).toBe(1800000);
    expect(breakdown.byArea['Learning']).toBeUndefined(); // unclassified doesn't add to byArea
  });

  it('handles empty input', () => {
    const breakdown = aggregateByDimension(new Map(), []);
    expect(breakdown.totalMs).toBe(0);
    expect(breakdown.classifiedMs).toBe(0);
  });

  it('counts by source', () => {
    const sessions: SessionLike[] = [makeSession('s-1-1', 0, 30)];
    const classifications = new Map<string, Classification>([
      ['s-1-1', {
        context: null, area: null, intent: null, quality: null,
        source: 'unclassified', reason: '', matchedRuleId: null,
        matchedConditions: null, isOverride: false,
      }],
    ]);
    const breakdown = aggregateByDimension(classifications, sessions);
    expect(breakdown.bySource['unclassified']).toBe(1800000);
  });
});