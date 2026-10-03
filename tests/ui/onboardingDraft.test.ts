import { describe, it, expect } from 'vitest';
import {
  addTag,
  draftFromProfile,
  draftToInput,
  emptyDraft,
  isQuestionStep,
  nextStep,
  QUESTION_STEPS,
  previousStep,
  removeTag,
  stepNumber,
  toggleOther,
  toggleRole,
  type OnboardingStep,
} from '../../src/ui/Onboarding/onboardingDraft';

describe('onboarding draft — roles', () => {
  it('supports selecting multiple roles', () => {
    let d = emptyDraft();
    d = toggleRole(d, 'Student');
    d = toggleRole(d, 'Software Developer');
    expect(draftToInput(d).roles).toEqual(['Student', 'Software Developer']);
  });

  it('toggles a role off again', () => {
    const d = toggleRole(toggleRole(emptyDraft(), 'Founder'), 'Founder');
    expect(draftToInput(d).roles).toEqual([]);
  });

  it('stores roles in a stable (preset) order', () => {
    const d = toggleRole(toggleRole(emptyDraft(), 'Researcher'), 'Student');
    expect(draftToInput(d).roles).toEqual(['Student', 'Researcher']);
  });

  it('includes the custom "Other" role only while Other is selected', () => {
    let d = toggleOther(emptyDraft());
    d = { ...d, otherRole: ' Product manager, teacher ' };
    expect(draftToInput(d).roles).toEqual(['Product manager', 'teacher']);
    expect(draftToInput(toggleOther(d)).roles).toEqual([]);
  });

  it('ignores "Other" with no text', () => {
    expect(draftToInput(toggleOther(emptyDraft())).roles).toEqual([]);
  });

  it('round-trips custom roles through a stored profile', () => {
    const d = draftFromProfile({
      roles: ['Student', 'Musician'],
      description: null,
      currentWork: [],
      priorities: [],
      interests: [],
      additionalContext: null,
    });
    expect(d.roles).toEqual(['Student']);
    expect(d.otherSelected).toBe(true);
    expect(d.otherRole).toBe('Musician');
    expect(draftToInput(d).roles).toEqual(['Student', 'Musician']);
  });
});

describe('onboarding draft — tags', () => {
  it('adds trimmed tags', () => {
    expect(addTag([], '  Reflect  ', 5)).toEqual({ tags: ['Reflect'], result: 'added' });
  });

  it('ignores empty tags', () => {
    expect(addTag(['A'], '   ', 5)).toEqual({ tags: ['A'], result: 'empty' });
  });

  it('prevents duplicates regardless of case', () => {
    expect(addTag(['Reading'], 'reading', 5)).toEqual({ tags: ['Reading'], result: 'duplicate' });
  });

  it('stops at the maximum', () => {
    expect(addTag(['a', 'b'], 'c', 2)).toEqual({ tags: ['a', 'b'], result: 'full' });
  });

  it('removes a tag', () => {
    expect(removeTag(['Gaming', 'Music'], 'Gaming')).toEqual(['Music']);
  });

  it('turns empty text fields into null', () => {
    const input = draftToInput({ ...emptyDraft(), description: '   ', additionalContext: '' });
    expect(input.description).toBeNull();
    expect(input.additionalContext).toBeNull();
  });
});

describe('onboarding draft — navigation', () => {
  it('walks welcome → tour → one question per screen → done', () => {
    const seen: OnboardingStep[] = [];
    let s: OnboardingStep = 'welcome';
    for (let i = 0; i < 8; i++) {
      seen.push(s);
      s = nextStep(s);
    }
    expect(seen).toEqual(['welcome', 'tour', 'about', 'work', 'priorities', 'interests', 'context', 'done']);
    expect(QUESTION_STEPS.map((x) => stepNumber(x))).toEqual([1, 2, 3, 4, 5]);
    expect(stepNumber('welcome')).toBeNull();
    expect(stepNumber('tour')).toBeNull();
    expect(isQuestionStep('work')).toBe(true);
    expect(isQuestionStep('tour')).toBe(false);
  });

  it('stops at both ends', () => {
    expect(nextStep('done')).toBe('done');
    expect(previousStep('welcome')).toBe('welcome');
    expect(previousStep('done')).toBe('context');
  });

  it('navigating backward keeps the draft (state is independent of step)', () => {
    let d = toggleRole(emptyDraft(), 'Student');
    d = { ...d, currentWork: addTag(d.currentWork, 'Reflect', 6).tags };
    let step: OnboardingStep = nextStep(nextStep('tour')); // work
    step = previousStep(step);
    expect(step).toBe('about');
    expect(d.roles).toEqual(['Student']);
    expect(d.currentWork).toEqual(['Reflect']);
  });

  it('restores previously saved answers into the form', () => {
    const stored = {
      roles: ['Founder'],
      description: 'Building a startup.',
      currentWork: ['Startup'],
      priorities: ['Build my startup'],
      interests: ['Football'],
      additionalContext: 'Late-night coding is usually the startup.',
    };
    expect(draftToInput(draftFromProfile(stored))).toEqual(stored);
  });
});
