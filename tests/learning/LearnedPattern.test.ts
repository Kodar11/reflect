import { describe, it, expect } from 'vitest';
import {
  activityFromEvents,
  activityKey,
  classificationHash,
  describeClassification,
  describeEvidence,
  describePattern,
  normalizeConditions,
  patternHash,
  patternMatches,
} from '../../src/learning/LearnedPattern';
import { activity, at, GAME_THEORY_PATTERN, PERSONAL, vsCodeEvent, WORK } from './helpers';
import { makeEvent } from '../intelligence/helpers';

describe('patternHash', () => {
  it('same conditions → same hash', () => {
    expect(patternHash(GAME_THEORY_PATTERN)).toBe(patternHash([...GAME_THEORY_PATTERN.map((c) => ({ ...c }))]));
  });

  it('different condition order → same hash', () => {
    expect(patternHash([...GAME_THEORY_PATTERN].reverse())).toBe(patternHash(GAME_THEORY_PATTERN));
  });

  it('different values → different hash', () => {
    expect(
      patternHash([
        { type: 'app_equals', value: 'VS Code' },
        { type: 'title_contains', value: 'Planmay' },
      ]),
    ).not.toBe(patternHash(GAME_THEORY_PATTERN));
  });

  it('a different condition type with the same value → different hash', () => {
    expect(patternHash([{ type: 'url_contains', value: 'coursera.org' }])).not.toBe(
      patternHash([{ type: 'domain_equals', value: 'coursera.org' }]),
    );
  });

  it('duplicates, whitespace and casing normalise away', () => {
    expect(
      patternHash([
        { type: 'title_contains', value: '  gametheory ' },
        { type: 'app_equals', value: 'VS Code' },
        { type: 'title_contains', value: 'GameTheory' },
        { type: 'app_equals', value: 'vs code' },
      ]),
    ).toBe(patternHash(GAME_THEORY_PATTERN));
  });

  it('follows the matcher: application aliases and www. are the same pattern', () => {
    expect(patternHash([{ type: 'app_equals', value: 'Visual Studio Code' }])).toBe(
      patternHash([{ type: 'app_equals', value: 'Code.exe'.replace('Code', 'vscode') }]),
    );
    expect(patternHash([{ type: 'domain_equals', value: 'https://www.Coursera.org/learn' }])).toBe(
      patternHash([{ type: 'domain_equals', value: 'coursera.org' }]),
    );
  });

  it('is a stable sha-256 of the conditions only', () => {
    const hash = patternHash(GAME_THEORY_PATTERN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(patternHash(GAME_THEORY_PATTERN)).toBe(hash);
  });
});

describe('normalizeConditions', () => {
  it('trims, deduplicates and orders deterministically', () => {
    expect(
      normalizeConditions([
        { type: 'title_contains', value: ' GameTheory ' },
        { type: 'app_equals', value: 'VS Code' },
        { type: 'title_contains', value: 'gametheory' },
      ]),
    ).toEqual([
      { type: 'app_equals', value: 'VS Code' },
      { type: 'title_contains', value: 'GameTheory' },
    ]);
  });

  it('drops empty values and unsupported condition types', () => {
    expect(
      normalizeConditions([
        { type: 'app_equals', value: '   ' },
        { type: 'mood_equals', value: 'focused' },
        { type: 'domain_equals', value: 'www.youtube.com' },
      ]),
    ).toEqual([{ type: 'domain_equals', value: 'youtube.com' }]);
  });
});

describe('classificationHash', () => {
  it('distinguishes classifications and treats missing ids as null', () => {
    expect(classificationHash(PERSONAL)).not.toBe(classificationHash(WORK));
    expect(classificationHash({ ...PERSONAL })).toBe(classificationHash(PERSONAL));
    expect(classificationHash({ areaId: 'area_personal' } as any)).toBe(
      classificationHash({ contextId: null, areaId: 'area_personal', intentId: null, qualityId: null }),
    );
  });
});

describe('descriptions', () => {
  it('describes a pattern from its conditions', () => {
    expect(describePattern(GAME_THEORY_PATTERN)).toBe('VS Code + “GameTheory”');
    expect(
      describePattern([
        { type: 'title_contains', value: 'Operating Systems' },
        { type: 'domain_equals', value: 'coursera.org' },
      ]),
    ).toBe('“Operating Systems” + coursera.org');
  });

  it('describes classification and evidence in observable terms', () => {
    expect(describeClassification({ context: null, area: 'Personal', intent: 'Create', quality: 'Focused' })).toBe(
      'Personal · Create · Focused',
    );
    expect(describeEvidence(8, 4)).toBe('Seen 8 times across 4 days');
    expect(describeEvidence(1, 1)).toBe('Seen once across 1 day');
  });
});

describe('matching', () => {
  it('uses the deterministic rule matcher', () => {
    const a = activity(at(0, 10), [1]);
    expect(patternMatches(a, GAME_THEORY_PATTERN)).toBe(true);
    expect(patternMatches(a, [{ type: 'title_contains', value: 'Planmay' }])).toBe(false);
    expect(patternMatches(a, [])).toBe(false);
  });

  it('keys an activity by its AI activity id, else by its first event', () => {
    expect(activityKey({ aiActivityId: 'ai-1', eventIds: [9, 4] })).toBe('ai:ai-1');
    expect(activityKey({ aiActivityId: null, eventIds: [9, 4] })).toBe('ev:4');
  });

  it('derives an activity from raw events with the timeline statistics', () => {
    const a = activityFromEvents(
      [
        makeEvent(2, at(0, 10, 25), at(0, 10, 30), { app: 'Google Chrome', browser: 'Chrome', url: 'stackoverflow.com', title: 'python - Stack Overflow' }),
        vsCodeEvent(1, at(0, 10)),
      ],
      null,
      PERSONAL,
      'user_override',
    )!;
    expect(a.eventIds).toEqual([1, 2]);
    expect(a.primaryApp).toBe('Visual Studio Code');
    expect(a.appsUsed).toEqual(['Google Chrome', 'Visual Studio Code']);
    expect(patternMatches(a, GAME_THEORY_PATTERN)).toBe(true);
    expect(activityFromEvents([], null, PERSONAL, null)).toBeNull();
  });
});
