/**
 * User profile / personal context collected by onboarding.
 *
 * Pure domain module: no Electron, SQLite or React imports, so it is shared by
 * the main process (repository + IPC validation), the renderer (onboarding
 * form) and, later, the intelligence layer.
 *
 * Every field is optional by design. The only invalid input is malformed data,
 * which `normalizeProfileInput` repairs (trim, drop empties, dedupe, clamp
 * lengths) rather than rejecting.
 */

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

export const ONBOARDING_STATUSES: readonly OnboardingStatus[] = [
  'not_started',
  'in_progress',
  'completed',
  'skipped',
];

/** Suggested roles shown as chips. Custom roles (via "Other") are stored as
 * free text alongside these. */
export const PRESET_ROLES = [
  'Student',
  'Software Developer',
  'Designer',
  'Freelancer',
  'Founder',
  'Researcher',
  'Creator',
] as const;

export type PresetRole = (typeof PRESET_ROLES)[number];

export interface UserProfile {
  roles: string[];
  description: string | null;
  currentWork: string[];
  priorities: string[];
  interests: string[];
  additionalContext: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The user-editable part of the profile (what the form writes). */
export type UserProfileInput = Pick<
  UserProfile,
  'roles' | 'description' | 'currentWork' | 'priorities' | 'interests' | 'additionalContext'
>;

export const PROFILE_LIMITS = {
  roles: 10,
  roleLength: 40,
  description: 280,
  currentWork: 6,
  priorities: 5,
  interests: 8,
  tagLength: 60,
  additionalContext: 500,
} as const;

export function emptyProfile(): UserProfile {
  return {
    roles: [],
    description: null,
    currentWork: [],
    priorities: [],
    interests: [],
    additionalContext: null,
    onboardingStatus: 'not_started',
    createdAt: null,
    updatedAt: null,
  };
}

export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return typeof value === 'string' && (ONBOARDING_STATUSES as readonly string[]).includes(value);
}

export function isPresetRole(role: string): role is PresetRole {
  return (PRESET_ROLES as readonly string[]).includes(role);
}

/** Collapse internal whitespace runs and trim. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Trim multi-line text (keeps line breaks) and clamp; empty → null. */
export function normalizeFreeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength).trim();
}

/**
 * Normalize a tag list: non-strings dropped, whitespace trimmed, empties
 * removed, case-insensitive duplicates removed (first spelling wins), each tag
 * clamped to `maxLength`, list clamped to `maxItems`.
 */
export function normalizeTags(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = cleanText(raw).slice(0, maxLength).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** True when `tag` (after cleaning) already exists in `tags`, ignoring case. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const key = cleanText(tag).toLowerCase();
  return tags.some((t) => t.toLowerCase() === key);
}

/** Repair arbitrary (possibly renderer-supplied) input into a valid profile input. */
export function normalizeProfileInput(input: Partial<Record<keyof UserProfileInput, unknown>>): UserProfileInput {
  return {
    roles: normalizeTags(input.roles, PROFILE_LIMITS.roles, PROFILE_LIMITS.roleLength),
    description: normalizeFreeText(input.description, PROFILE_LIMITS.description),
    currentWork: normalizeTags(input.currentWork, PROFILE_LIMITS.currentWork, PROFILE_LIMITS.tagLength),
    priorities: normalizeTags(input.priorities, PROFILE_LIMITS.priorities, PROFILE_LIMITS.tagLength),
    interests: normalizeTags(input.interests, PROFILE_LIMITS.interests, PROFILE_LIMITS.tagLength),
    additionalContext: normalizeFreeText(input.additionalContext, PROFILE_LIMITS.additionalContext),
  };
}

/** Whether the profile carries any user-provided context at all. */
export function hasProfileContent(profile: UserProfileInput): boolean {
  return (
    profile.roles.length > 0 ||
    profile.description !== null ||
    profile.currentWork.length > 0 ||
    profile.priorities.length > 0 ||
    profile.interests.length > 0 ||
    profile.additionalContext !== null
  );
}

// ─── Onboarding status transitions ─────────────────────────────────────────

/** Status after the user edits any answer. A finished profile stays finished. */
export function statusAfterEdit(current: OnboardingStatus): OnboardingStatus {
  return current === 'completed' ? 'completed' : 'in_progress';
}

/** Status after "Set up later" / closing the editor. Never downgrades a
 * completed profile, so revisiting from Settings can't erase it. */
export function statusAfterSkip(current: OnboardingStatus): OnboardingStatus {
  return current === 'completed' ? 'completed' : 'skipped';
}

/** Whether the app should present onboarding on launch. Skipped and completed
 * users are never interrupted again; they can revisit from Settings. */
export function shouldShowOnboarding(status: OnboardingStatus): boolean {
  return status === 'not_started' || status === 'in_progress';
}

// ─── Intelligence layer compatibility ──────────────────────────────────────

/**
 * Shape consumed by the intelligence layer (IntelligenceService → Gemini
 * prompt). Field names describe what each answer means rather than how it
 * was collected.
 */
export interface UserIntelligenceContext {
  /** Who the user is (roles). */
  roles: string[];
  /** What they do, in their own words. */
  description: string | null;
  /** What they are actively working on right now. */
  currentWork: string[];
  /** What matters most to them right now. */
  priorities: string[];
  /** What they do outside work or study. */
  interests: string[];
  /** Special interpretation rules / exceptions the user asked Reflect to know. */
  interpretationNotes: string | null;
}

/**
 * Convert a stored profile into intelligence context. Returns `null` — no
 * context at all, never defaults — when the user skipped or hasn't started
 * onboarding, or when nothing was actually provided.
 */
export function toIntelligenceContext(profile: UserProfile): UserIntelligenceContext | null {
  if (profile.onboardingStatus === 'skipped' || profile.onboardingStatus === 'not_started') {
    return null;
  }
  const clean = normalizeProfileInput(profile);
  if (!hasProfileContent(clean)) return null;
  return {
    roles: clean.roles,
    description: clean.description,
    currentWork: clean.currentWork,
    priorities: clean.priorities,
    interests: clean.interests,
    interpretationNotes: clean.additionalContext,
  };
}

/** Render the context as compact prompt text, omitting empty sections. */
export function formatIntelligenceContext(context: UserIntelligenceContext): string {
  const lines: string[] = [];
  if (context.roles.length) lines.push(`Who the user is: ${context.roles.join(', ')}`);
  if (context.description) lines.push(`In their words: ${context.description}`);
  if (context.currentWork.length) lines.push(`Currently working on: ${context.currentWork.join(', ')}`);
  if (context.priorities.length) lines.push(`What matters most right now: ${context.priorities.join(', ')}`);
  if (context.interests.length) lines.push(`Outside work or study: ${context.interests.join(', ')}`);
  if (context.interpretationNotes) lines.push(`Interpretation notes: ${context.interpretationNotes}`);
  return lines.join('\n');
}
