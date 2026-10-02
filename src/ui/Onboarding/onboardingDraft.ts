import {
  PRESET_ROLES,
  PROFILE_LIMITS,
  cleanText,
  hasTag,
  isPresetRole,
  normalizeProfileInput,
  type UserProfileInput,
} from '../../profile/UserProfile';

/**
 * In-form state for the onboarding / personal-context editor. Pure functions
 * only, so form behaviour (role toggling, tag add/remove, step navigation) is
 * unit-testable without a DOM.
 */
export interface OnboardingDraft {
  /** Selected preset roles. */
  roles: string[];
  otherSelected: boolean;
  otherRole: string;
  description: string;
  currentWork: string[];
  priorities: string[];
  interests: string[];
  additionalContext: string;
}

export type TagField = 'currentWork' | 'priorities' | 'interests';

export const TAG_LIMITS: Record<TagField, number> = {
  currentWork: PROFILE_LIMITS.currentWork,
  priorities: PROFILE_LIMITS.priorities,
  interests: PROFILE_LIMITS.interests,
};

export function emptyDraft(): OnboardingDraft {
  return {
    roles: [],
    otherSelected: false,
    otherRole: '',
    description: '',
    currentWork: [],
    priorities: [],
    interests: [],
    additionalContext: '',
  };
}

/** Load a stored profile into the form. Non-preset roles become "Other". */
export function draftFromProfile(profile: UserProfileInput): OnboardingDraft {
  const custom = profile.roles.filter((r) => !isPresetRole(r));
  return {
    roles: profile.roles.filter(isPresetRole),
    otherSelected: custom.length > 0,
    otherRole: custom.join(', '),
    description: profile.description ?? '',
    currentWork: [...profile.currentWork],
    priorities: [...profile.priorities],
    interests: [...profile.interests],
    additionalContext: profile.additionalContext ?? '',
  };
}

/** Convert the form into a normalized profile input ready to persist. */
export function draftToInput(draft: OnboardingDraft): UserProfileInput {
  const presets = PRESET_ROLES.filter((r) => draft.roles.includes(r));
  const custom = draft.otherSelected ? draft.otherRole.split(',') : [];
  return normalizeProfileInput({
    roles: [...presets, ...custom],
    description: draft.description,
    currentWork: draft.currentWork,
    priorities: draft.priorities,
    interests: draft.interests,
    additionalContext: draft.additionalContext,
  });
}

export function toggleRole(draft: OnboardingDraft, role: string): OnboardingDraft {
  const roles = draft.roles.includes(role)
    ? draft.roles.filter((r) => r !== role)
    : [...draft.roles, role];
  return { ...draft, roles };
}

export function toggleOther(draft: OnboardingDraft): OnboardingDraft {
  return { ...draft, otherSelected: !draft.otherSelected };
}

export type AddTagResult = 'added' | 'empty' | 'duplicate' | 'full';

/** Add a tag (trimmed); rejects empties, case-insensitive duplicates, and
 * additions past `max`. Returns the list unchanged on rejection. */
export function addTag(
  tags: readonly string[],
  value: string,
  max: number,
): { tags: string[]; result: AddTagResult } {
  const tag = cleanText(value).slice(0, PROFILE_LIMITS.tagLength).trim();
  if (!tag) return { tags: [...tags], result: 'empty' };
  if (hasTag(tags, tag)) return { tags: [...tags], result: 'duplicate' };
  if (tags.length >= max) return { tags: [...tags], result: 'full' };
  return { tags: [...tags, tag], result: 'added' };
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  return tags.filter((t) => t !== tag);
}

// ─── Steps ─────────────────────────────────────────────────────────────────

export type OnboardingStep = 'welcome' | 'about' | 'life' | 'context' | 'done';

/** The three question screens, in order. */
export const QUESTION_STEPS = ['about', 'life', 'context'] as const;

export function stepNumber(step: OnboardingStep): number | null {
  const i = (QUESTION_STEPS as readonly string[]).indexOf(step);
  return i === -1 ? null : i + 1;
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  switch (step) {
    case 'welcome': return 'about';
    case 'about': return 'life';
    case 'life': return 'context';
    case 'context': return 'done';
    case 'done': return 'done';
  }
}

export function previousStep(step: OnboardingStep): OnboardingStep {
  switch (step) {
    case 'welcome': return 'welcome';
    case 'about': return 'welcome';
    case 'life': return 'about';
    case 'context': return 'life';
    case 'done': return 'context';
  }
}
