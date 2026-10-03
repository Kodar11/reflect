import { describe, it, expect } from 'vitest';
import { validatePatternProposal } from '../../src/learning/LearnedPatternValidator';
import {
  buildPatternPrompt,
  buildPatternResponseJsonSchema,
  buildPatternRetryFeedback,
  buildPatternSystemInstruction,
} from '../../src/learning/LearnedPatternPrompt';
import {
  DEFAULT_LEARNED_RULE_CONFIG,
  SUPPORTED_CONDITION_TYPES,
  type PatternPromptInput,
} from '../../src/learning/LearnedRuleModels';
import { activity, at, GAME_THEORY_PATTERN, proposal } from './helpers';

const corrected = activity(at(0, 10), [1]);
const ctx = { activity: corrected, config: DEFAULT_LEARNED_RULE_CONFIG };

function errorsOf(raw: unknown): string[] {
  const result = validatePatternProposal(raw, ctx);
  if (result.ok) throw new Error('expected the proposal to be rejected');
  return result.errors;
}

describe('validatePatternProposal', () => {
  it('accepts a supported, observable pattern and returns it normalised', () => {
    const result = validatePatternProposal(
      proposal([
        { type: 'title_contains', value: ' GameTheory ' },
        { type: 'app_equals', value: 'VS Code' },
        { type: 'title_contains', value: 'gametheory' },
      ]),
      ctx,
    );
    expect(result).toEqual({ ok: true, pattern: GAME_THEORY_PATTERN, confidence: 0.9 });
  });

  it('an empty conditions array means "no pattern", not an error', () => {
    expect(validatePatternProposal(proposal([]), ctx)).toEqual({ ok: true, pattern: null, reason: 'no_pattern' });
  });

  it('a low-confidence proposal produces no pattern', () => {
    expect(validatePatternProposal(proposal(GAME_THEORY_PATTERN, 0.3), ctx)).toEqual({
      ok: true,
      pattern: null,
      reason: 'low_confidence',
    });
  });

  it('rejects an invalid schema', () => {
    expect(errorsOf(null)[0]).toMatch(/^schema:/);
    expect(errorsOf({ conditions: GAME_THEORY_PATTERN })[0]).toMatch(/^schema:/);
    expect(errorsOf({ ...proposal(GAME_THEORY_PATTERN), schemaVersion: 2 })[0]).toMatch(/schemaVersion/);
    expect(errorsOf({ ...proposal(GAME_THEORY_PATTERN), conditions: 'VS Code in GameTheory' })[0]).toMatch(/conditions/);
    expect(errorsOf({ ...proposal(GAME_THEORY_PATTERN), conditions: [{ type: 'app_equals' }] })[0]).toMatch(/value/);
  });

  it('rejects confidence outside 0..1', () => {
    expect(errorsOf(proposal(GAME_THEORY_PATTERN, 1.4))[0]).toMatch(/confidence/);
    expect(errorsOf(proposal(GAME_THEORY_PATTERN, -0.1))[0]).toMatch(/confidence/);
  });

  it('rejects condition types the matcher does not support', () => {
    expect(errorsOf(proposal([{ type: 'intent_is', value: 'personal project' }]))).toEqual([
      'unsupported condition type "intent_is"',
    ]);
    // Legacy aliases are tolerated on stored rules, never from Gemini.
    expect(errorsOf(proposal([{ type: 'app', value: 'VS Code' }]))).toEqual(['unsupported condition type "app"']);
  });

  it('rejects empty and oversized values', () => {
    expect(errorsOf(proposal([{ type: 'app_equals', value: '   ' }]))).toEqual(['app_equals: value must not be empty']);
    expect(errorsOf(proposal([{ type: 'title_contains', value: 'x'.repeat(200) }]))[0]).toMatch(/too long/);
  });

  it('rejects more conditions than the configured maximum', () => {
    const many = Array.from({ length: 12 }, () => ({ type: 'app_equals', value: 'VS Code' }));
    expect(errorsOf(proposal(many))[0]).toMatch(/too many conditions/);
  });

  it('rejects a condition that is not observable in the corrected activity', () => {
    expect(
      errorsOf(
        proposal([
          { type: 'app_equals', value: 'VS Code' },
          { type: 'url_contains', value: '/GameTheory/' },
        ]),
      ),
    ).toEqual(['url_contains "/GameTheory/" is not present in the corrected activity']);
    expect(errorsOf(proposal([{ type: 'title_contains', value: 'Thesis' }]))[0]).toMatch(/not present/);
  });

  it('rejects a browser on its own as too broad', () => {
    const browsing = activity(at(0, 10), [1], {
      primaryApp: 'Google Chrome',
      primaryBrowser: 'Chrome',
      primaryTitle: 'YouTube',
      primaryUrl: 'youtube.com',
      appsUsed: ['Google Chrome'],
      browserTabs: ['youtube.com'],
    });
    const result = validatePatternProposal(proposal([{ type: 'browser_equals', value: 'Chrome' }]), {
      activity: browsing,
      config: DEFAULT_LEARNED_RULE_CONFIG,
    });
    expect(result).toEqual({ ok: false, errors: ['a browser on its own is too broad to be a pattern'] });
    // The same browser with a domain is a real pattern.
    expect(
      validatePatternProposal(
        proposal([
          { type: 'browser_equals', value: 'Chrome' },
          { type: 'domain_equals', value: 'www.youtube.com' },
        ]),
        { activity: browsing, config: DEFAULT_LEARNED_RULE_CONFIG },
      ),
    ).toMatchObject({ ok: true, pattern: [{ type: 'browser_equals', value: 'Chrome' }, { type: 'domain_equals', value: 'youtube.com' }] });
  });
});

describe('pattern extraction prompt', () => {
  const input: PatternPromptInput = {
    correctedAt: at(0, 11),
    activity: {
      startedAt: at(0, 10),
      endedAt: at(0, 10, 30),
      primaryApp: 'Visual Studio Code',
      primaryBrowser: null,
      primaryTitle: 'strategy.py — GameTheory — Visual Studio Code',
      primaryUrl: null,
    },
    original: {
      title: 'Software development',
      summary: 'Edited Python files.',
      classification: { context: 'Coding', area: 'Work', intent: 'Create', quality: 'Focused' },
    },
    corrected: { context: null, area: 'Personal', intent: 'Create', quality: 'Focused' },
    events: [{ app: 'Visual Studio Code', browser: null, title: 'strategy.py — GameTheory — Visual Studio Code', url: null, seconds: 1800 }],
    otherActivities: [
      { app: 'Visual Studio Code', title: 'main.ts — reflect — Visual Studio Code', url: null, classification: { context: 'Coding', area: 'Work', intent: 'Create', quality: null } },
    ],
    userContext: 'Who the user is: Student',
    existingRules: [
      { conditions: [{ type: 'domain_equals', value: 'coursera.org' }], classification: { context: null, area: 'Personal', intent: 'Learn', quality: null } },
    ],
    maxConditions: 4,
  };

  it('is a dedicated instruction that forbids invention and allows "no pattern"', () => {
    const system = buildPatternSystemInstruction();
    expect(system).toContain('learn reusable activity patterns from a user correction');
    expect(system).toContain('smallest stable, observable set');
    expect(system).toContain('Use only evidence present');
    expect(system).toContain('Do not infer psychology, motivation');
    expect(system).toContain('empty conditions array');
    for (const type of SUPPORTED_CONDITION_TYPES) expect(system).toContain(type);
  });

  it('sends the correction, the evidence and contrast — and nothing unnecessary', () => {
    const prompt = buildPatternPrompt(input);
    const order = ['CORRECTED ACTIVITY', 'ORIGINAL INTERPRETATION', 'USER CORRECTION', 'EVENTS', 'OTHER RECENT ACTIVITIES', 'EXISTING RULES', 'USER CONTEXT', 'LIMITS'];
    const positions = order.map((heading) => prompt.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('"area":"Personal"');
    expect(prompt).toContain('GameTheory');
    expect(prompt).toContain('At most 4 conditions');
    expect(prompt).not.toContain('payload');
  });

  it('states absence explicitly instead of omitting sections', () => {
    const prompt = buildPatternPrompt({ ...input, original: null, otherActivities: [], existingRules: [], userContext: null });
    expect(prompt).toContain('ORIGINAL INTERPRETATION\nNone recorded.');
    expect(prompt).toContain('OTHER RECENT ACTIVITIES\nNone available.');
    expect(prompt).toContain('EXISTING RULES\nNone.');
    expect(prompt).toContain('USER CONTEXT\nNot provided.');
  });

  it('constrains condition types in the response schema', () => {
    const schema = buildPatternResponseJsonSchema(4) as any;
    expect(schema.required).toEqual(['schemaVersion', 'conditions', 'explanation', 'confidence']);
    expect(schema.properties.conditions.maxItems).toBe(4);
    expect(schema.properties.conditions.items.properties.type.enum).toEqual([...SUPPORTED_CONDITION_TYPES]);
    expect(schema.properties.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it('feeds validation errors back on retry', () => {
    const feedback = buildPatternRetryFeedback(['unsupported condition type "intent_is"']);
    expect(feedback).toContain('YOUR PREVIOUS PROPOSAL WAS REJECTED');
    expect(feedback).toContain('- unsupported condition type "intent_is"');
  });
});
