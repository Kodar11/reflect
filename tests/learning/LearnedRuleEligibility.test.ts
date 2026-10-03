import { describe, it, expect } from 'vitest';
import {
  eligibilityBlockers,
  inGlobalCooldown,
  inSuggestionCooldown,
  isConsistent,
  isCoveredByRule,
  isEligible,
  rankCandidates,
  summarizeEvidence,
  type EligibilityContext,
} from '../../src/learning/LearnedRuleEligibility';
import { DEFAULT_LEARNED_RULE_CONFIG, type LearnedRuleCandidate } from '../../src/learning/LearnedRuleModels';
import { at, candidate, GAME_THEORY_PATTERN, PERSONAL, WORK } from './helpers';

const NOW = Date.parse(at(1, 12));

function ctx(all: LearnedRuleCandidate[], overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return { nowMs: NOW, config: DEFAULT_LEARNED_RULE_CONFIG, all, rules: [], ...overrides };
}

/** Evidence shorthand: a candidate last seen on day 1. */
function withEvidence(occurrences: number, days: number, corrections: number, extra: Partial<LearnedRuleCandidate> = {}) {
  return candidate({
    occurrenceCount: occurrences,
    distinctDayCount: days,
    correctionCount: corrections,
    firstSeenAt: at(0, 10),
    lastSeenAt: at(1, 10),
    ...extra,
  });
}

describe('eligibility thresholds', () => {
  it('1 correction + 1 occurrence → not eligible', () => {
    const c = withEvidence(1, 1, 1);
    expect(eligibilityBlockers(c, ctx([c]))).toEqual(['insufficient_evidence']);
  });

  it('1 correction + 2 occurrences across 2 days → eligible', () => {
    const c = withEvidence(2, 2, 1);
    expect(isEligible(c, ctx([c]))).toBe(true);
  });

  it('1 correction + 2 occurrences on the same day → not eligible', () => {
    const c = withEvidence(2, 1, 1);
    expect(isEligible(c, ctx([c]))).toBe(false);
  });

  it('3 occurrences across 2 days → eligible without a correction', () => {
    const c = withEvidence(3, 2, 0);
    expect(isEligible(c, ctx([c]))).toBe(true);
  });

  it('2 occurrences across 2 days without a correction → not eligible', () => {
    const c = withEvidence(2, 2, 0);
    expect(isEligible(c, ctx([c]))).toBe(false);
  });

  it('3 occurrences all on 1 day → not eligible', () => {
    const c = withEvidence(3, 1, 0);
    expect(eligibilityBlockers(c, ctx([c]))).toEqual(['insufficient_evidence']);
  });

  it('thresholds come from configuration', () => {
    const c = withEvidence(2, 2, 1);
    const strict = { ...DEFAULT_LEARNED_RULE_CONFIG, minOccurrencesWithCorrection: 4, minOccurrences: 6 };
    expect(isEligible(c, ctx([c], { config: strict }))).toBe(false);
  });
});

describe('recency', () => {
  it('old candidate → not eligible', () => {
    const c = withEvidence(8, 4, 1, { lastSeenAt: at(-40, 10) });
    expect(eligibilityBlockers(c, ctx([c]))).toEqual(['not_recent']);
  });

  it('recent candidate → eligible', () => {
    const c = withEvidence(8, 4, 1, { lastSeenAt: at(-20, 10) });
    expect(isEligible(c, ctx([c]))).toBe(true);
  });
});

describe('status', () => {
  it('snoozed is blocked until snoozed_until passes', () => {
    const snoozed = withEvidence(4, 3, 1, { status: 'snoozed', snoozedUntil: at(5, 12) });
    expect(eligibilityBlockers(snoozed, ctx([snoozed]))).toEqual(['snoozed']);
    const expired = withEvidence(4, 3, 1, { status: 'snoozed', snoozedUntil: at(0, 12) });
    expect(isEligible(expired, ctx([expired]))).toBe(true);
  });

  it('dismissed and confirmed candidates are never eligible', () => {
    const dismissed = withEvidence(4, 3, 1, { status: 'dismissed' });
    const confirmed = withEvidence(4, 3, 1, { status: 'confirmed', confirmedRuleId: 'rule_x' });
    expect(eligibilityBlockers(dismissed, ctx([dismissed]))).toEqual(['dismissed']);
    expect(eligibilityBlockers(confirmed, ctx([confirmed]))).toEqual(['already_confirmed']);
  });
});

describe('classification consistency', () => {
  it('a matching activity the user classified differently suppresses the candidate', () => {
    const c = withEvidence(4, 3, 1, { conflictCount: 1 });
    expect(isConsistent(c, [c])).toBe(false);
    expect(eligibilityBlockers(c, ctx([c]))).toEqual(['inconsistent_classification']);
  });

  it('the same pattern with two classifications recommends neither', () => {
    const personal = withEvidence(4, 3, 1, { id: 'lrc_a', classification: PERSONAL });
    const work = withEvidence(4, 3, 1, { id: 'lrc_b', classification: WORK });
    const all = [personal, work];
    expect(personal.patternHash).toBe(work.patternHash);
    expect(personal.classificationHash).not.toBe(work.classificationHash);
    expect(isEligible(personal, ctx(all))).toBe(false);
    expect(isEligible(work, ctx(all))).toBe(false);
  });

  it('a dismissed sibling no longer conflicts', () => {
    const personal = withEvidence(4, 3, 1, { id: 'lrc_a', classification: PERSONAL });
    const work = withEvidence(4, 3, 1, { id: 'lrc_b', classification: WORK, status: 'dismissed' });
    expect(isEligible(personal, ctx([personal, work]))).toBe(true);
  });
});

describe('existing rules', () => {
  const c = withEvidence(4, 3, 1);

  it('a rule with the same conditions suppresses the candidate', () => {
    const rules = [{ enabled: true, conditions: [...GAME_THEORY_PATTERN].reverse(), classification: WORK }];
    expect(isCoveredByRule(c, rules)).toBe(true);
    expect(eligibilityBlockers(c, ctx([c], { rules }))).toEqual(['covered_by_rule']);
  });

  it('a broader rule suppresses only when it already gives this classification', () => {
    const broader = [{ type: 'app_equals', value: 'VS Code' }];
    expect(isCoveredByRule(c, [{ enabled: true, conditions: broader, classification: PERSONAL }])).toBe(true);
    expect(isCoveredByRule(c, [{ enabled: true, conditions: broader, classification: WORK }])).toBe(false);
  });

  it('disabled, unrelated and narrower rules do not suppress', () => {
    expect(isCoveredByRule(c, [{ enabled: false, conditions: GAME_THEORY_PATTERN, classification: PERSONAL }])).toBe(false);
    expect(
      isCoveredByRule(c, [{ enabled: true, conditions: [{ type: 'domain_equals', value: 'youtube.com' }], classification: PERSONAL }]),
    ).toBe(false);
    expect(
      isCoveredByRule(c, [
        {
          enabled: true,
          conditions: [...GAME_THEORY_PATTERN, { type: 'title_contains', value: 'strategy.py' }],
          classification: PERSONAL,
        },
      ]),
    ).toBe(false);
  });
});

describe('cooldowns', () => {
  it('the same candidate is not shown again within the re-suggest window', () => {
    const c = withEvidence(4, 3, 1, { lastSuggestedAt: at(-2, 12), suggestionCount: 1 });
    expect(inSuggestionCooldown(c, NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(true);
    const older = withEvidence(4, 3, 1, { lastSuggestedAt: at(-10, 12), suggestionCount: 1 });
    expect(inSuggestionCooldown(older, NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(false);
    expect(inSuggestionCooldown(withEvidence(4, 3, 1), NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(false);
  });

  it('no second suggestion within the global cooldown', () => {
    expect(inGlobalCooldown(at(1, 11), NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(true);
    expect(inGlobalCooldown(at(0, 12), NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(false);
    expect(inGlobalCooldown(null, NOW, DEFAULT_LEARNED_RULE_CONFIG)).toBe(false);
  });
});

describe('ranking', () => {
  it('prefers more corrections, then wider spread, then volume', () => {
    const corrected = withEvidence(2, 2, 2, { id: 'lrc_c' });
    const spread = withEvidence(6, 5, 0, { id: 'lrc_b' });
    const volume = withEvidence(6, 2, 0, { id: 'lrc_a' });
    expect(rankCandidates([volume, spread, corrected], NOW).map((c) => c.id)).toEqual(['lrc_c', 'lrc_b', 'lrc_a']);
  });

  it('is deterministic: equal evidence is ordered by candidate id, whatever the input order', () => {
    const a = withEvidence(3, 2, 1, { id: 'lrc_a' });
    const b = withEvidence(3, 2, 1, { id: 'lrc_b' });
    expect(rankCandidates([b, a], NOW).map((c) => c.id)).toEqual(['lrc_a', 'lrc_b']);
    expect(rankCandidates([a, b], NOW).map((c) => c.id)).toEqual(['lrc_a', 'lrc_b']);
  });

  it('a candidate already shown yields to an equally strong one that was not', () => {
    const shown = withEvidence(3, 2, 1, { id: 'lrc_a', suggestionCount: 2 });
    const fresh = withEvidence(3, 2, 1, { id: 'lrc_b' });
    expect(rankCandidates([shown, fresh], NOW)[0].id).toBe('lrc_b');
  });
});

describe('summarizeEvidence', () => {
  const row = (key: string, day: string, occurredAt: string, flags: { correction?: boolean; conflict?: boolean } = {}) => ({
    candidateId: 'lrc_a',
    occurrenceKey: key,
    anchorEventId: null,
    localDay: day,
    occurredAt,
    isCorrection: flags.correction ?? false,
    isConflict: flags.conflict ?? false,
  });

  it('counts activities, distinct days and corrections', () => {
    expect(
      summarizeEvidence([
        row('ev:1', '2026-09-12', at(0, 10), { correction: true }),
        row('ev:2', '2026-09-12', at(0, 15)),
        row('ev:3', '2026-09-13', at(1, 9)),
      ]),
    ).toEqual({
      occurrenceCount: 3,
      distinctDayCount: 2,
      correctionCount: 1,
      conflictCount: 0,
      firstSeenAt: at(0, 10),
      lastSeenAt: at(1, 9),
      lastCorrectionAt: at(0, 10),
    });
  });

  it('a conflicting activity is counted against the candidate, not as an occurrence', () => {
    const evidence = summarizeEvidence([
      row('ev:1', '2026-09-12', at(0, 10), { correction: true }),
      row('ev:2', '2026-09-13', at(1, 9), { conflict: true }),
    ]);
    expect(evidence.occurrenceCount).toBe(1);
    expect(evidence.distinctDayCount).toBe(1);
    expect(evidence.conflictCount).toBe(1);
    expect(evidence.lastSeenAt).toBe(at(0, 10));
  });

  it('no occurrences → empty evidence', () => {
    expect(summarizeEvidence([])).toEqual({
      occurrenceCount: 0,
      distinctDayCount: 0,
      correctionCount: 0,
      conflictCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastCorrectionAt: null,
    });
  });
});
