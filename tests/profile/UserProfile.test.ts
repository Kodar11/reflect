import { describe, it, expect } from 'vitest';
import {
  PROFILE_LIMITS,
  emptyProfile,
  formatIntelligenceContext,
  hasProfileContent,
  normalizeProfileInput,
  normalizeTags,
  shouldShowOnboarding,
  statusAfterEdit,
  statusAfterSkip,
  toIntelligenceContext,
  type UserProfile,
} from '../../src/profile/UserProfile';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return { ...emptyProfile(), ...overrides };
}

describe('UserProfile model', () => {
  it('accepts a fully populated profile unchanged', () => {
    const input = {
      roles: ['Student', 'Software Developer'],
      description: 'Final-year CS student.',
      currentWork: ['College studies', 'Reflect'],
      priorities: ['Finish my degree'],
      interests: ['Gaming', 'Reading'],
      additionalContext: 'My Game Theory project is a hobby, not college work.',
    };
    expect(normalizeProfileInput(input)).toEqual(input);
  });

  it('treats every field as optional', () => {
    expect(normalizeProfileInput({})).toEqual({
      roles: [],
      description: null,
      currentWork: [],
      priorities: [],
      interests: [],
      additionalContext: null,
    });
  });

  it('turns empty / whitespace-only values into empty', () => {
    const out = normalizeProfileInput({
      roles: ['', '   '],
      description: '   ',
      currentWork: ['\t'],
      additionalContext: '\n\n',
    });
    expect(out.roles).toEqual([]);
    expect(out.description).toBeNull();
    expect(out.currentWork).toEqual([]);
    expect(out.additionalContext).toBeNull();
    expect(hasProfileContent(out)).toBe(false);
  });

  it('trims whitespace in tags and text', () => {
    const out = normalizeProfileInput({
      roles: ['  Student  '],
      description: '  Building   things  ',
      interests: ['  board   games '],
      additionalContext: '  line one\nline two  ',
    });
    expect(out.roles).toEqual(['Student']);
    expect(out.description).toBe('Building things');
    expect(out.interests).toEqual(['board games']);
    expect(out.additionalContext).toBe('line one\nline two');
  });

  it('removes case-insensitive duplicate tags, keeping the first spelling', () => {
    expect(normalizeTags(['Reading', 'reading', ' READING '], 10, 60)).toEqual(['Reading']);
  });

  it('drops malformed values (non-arrays, non-strings)', () => {
    const out = normalizeProfileInput({
      roles: 'Student' as unknown,
      currentWork: [42, null, 'Reflect', { x: 1 }] as unknown,
      description: 123 as unknown,
    });
    expect(out.roles).toEqual([]);
    expect(out.currentWork).toEqual(['Reflect']);
    expect(out.description).toBeNull();
  });

  it('clamps lengths and item counts', () => {
    const out = normalizeProfileInput({
      description: 'x'.repeat(1000),
      additionalContext: 'y'.repeat(1000),
      priorities: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      interests: ['z'.repeat(200)],
    });
    expect(out.description).toHaveLength(PROFILE_LIMITS.description);
    expect(out.additionalContext).toHaveLength(PROFILE_LIMITS.additionalContext);
    expect(out.priorities).toHaveLength(PROFILE_LIMITS.priorities);
    expect(out.interests[0]).toHaveLength(PROFILE_LIMITS.tagLength);
  });
});

describe('onboarding status', () => {
  it('shows onboarding only when not started or in progress', () => {
    expect(shouldShowOnboarding('not_started')).toBe(true);
    expect(shouldShowOnboarding('in_progress')).toBe(true);
    expect(shouldShowOnboarding('completed')).toBe(false);
    expect(shouldShowOnboarding('skipped')).toBe(false);
  });

  it('editing moves to in_progress but never un-completes', () => {
    expect(statusAfterEdit('not_started')).toBe('in_progress');
    expect(statusAfterEdit('skipped')).toBe('in_progress');
    expect(statusAfterEdit('in_progress')).toBe('in_progress');
    expect(statusAfterEdit('completed')).toBe('completed');
  });

  it('skipping marks skipped but never downgrades a completed profile', () => {
    expect(statusAfterSkip('not_started')).toBe('skipped');
    expect(statusAfterSkip('in_progress')).toBe('skipped');
    expect(statusAfterSkip('skipped')).toBe('skipped');
    expect(statusAfterSkip('completed')).toBe('completed');
  });
});

describe('intelligence context', () => {
  const filled = profile({
    roles: ['Student', 'Software Developer'],
    description: 'Final-year CS student.',
    currentWork: ['College studies', 'Reflect'],
    priorities: ['Finish my degree'],
    interests: ['Gaming'],
    additionalContext: 'My Game Theory project is a hobby.',
    onboardingStatus: 'completed',
  });

  it('maps each answer to its intelligence field', () => {
    expect(toIntelligenceContext(filled)).toEqual({
      roles: ['Student', 'Software Developer'],
      description: 'Final-year CS student.',
      currentWork: ['College studies', 'Reflect'],
      priorities: ['Finish my degree'],
      interests: ['Gaming'],
      interpretationNotes: 'My Game Theory project is a hobby.',
    });
  });

  it('gives no context (not defaults) when skipped or not started', () => {
    expect(toIntelligenceContext({ ...filled, onboardingStatus: 'skipped' })).toBeNull();
    expect(toIntelligenceContext({ ...filled, onboardingStatus: 'not_started' })).toBeNull();
  });

  it('gives no context when the user finished without answering anything', () => {
    expect(toIntelligenceContext(profile({ onboardingStatus: 'completed' }))).toBeNull();
  });

  it('includes partial answers from an in-progress profile', () => {
    const ctx = toIntelligenceContext(profile({ onboardingStatus: 'in_progress', interests: ['Music'] }));
    expect(ctx).toEqual({
      roles: [],
      description: null,
      currentWork: [],
      priorities: [],
      interests: ['Music'],
      interpretationNotes: null,
    });
  });

  it('formats prompt text, omitting empty sections', () => {
    const text = formatIntelligenceContext(toIntelligenceContext(filled)!);
    expect(text).toContain('Who the user is: Student, Software Developer');
    expect(text).toContain('Currently working on: College studies, Reflect');
    expect(text).toContain('Interpretation notes: My Game Theory project is a hobby.');

    const sparse = formatIntelligenceContext(
      toIntelligenceContext(profile({ onboardingStatus: 'completed', interests: ['Music'] }))!,
    );
    expect(sparse).toBe('Outside work or study: Music');
  });
});
