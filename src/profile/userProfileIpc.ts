import type { IUserProfileRepository } from '../database/UserProfileRepository.js';
import {
  isOnboardingStatus,
  type OnboardingStatus,
  type UserProfileInput,
} from './UserProfile.js';

const ANSWER_KEYS = [
  'roles',
  'description',
  'currentWork',
  'priorities',
  'interests',
  'additionalContext',
] as const satisfies readonly (keyof UserProfileInput)[];

/** Copy only known answer keys from an untrusted renderer payload. The
 * repository normalizes values (trim, dedupe, clamp) on write. */
function pickAnswers(payload: unknown): Partial<UserProfileInput> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const key of ANSWER_KEYS) {
    if (key in payload) out[key] = (payload as Record<string, unknown>)[key];
  }
  return out as Partial<UserProfileInput>;
}

function pickStatus(value: unknown): OnboardingStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isOnboardingStatus(value)) throw new Error(`Invalid onboarding status: ${String(value)}`);
  return value;
}

/**
 * Renderer bridge for the user profile / onboarding context. Follows the
 * existing registrar pattern: thin handlers, DTOs only, frame-validated by
 * `ipcMainHandle`. The renderer never touches SQLite.
 */
export function registerUserProfileIpc(
  repo: IUserProfileRepository,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
) {
  ipcMainHandle('userProfile:get', () => repo.getProfile());
  ipcMainHandle('userProfile:getOnboardingStatus', () => repo.getOnboardingStatus());
  ipcMainHandle('userProfile:save', (p: { profile: unknown; status?: unknown }) => {
    const answers = pickAnswers(p?.profile);
    return repo.saveProfile(
      {
        roles: answers.roles ?? [],
        description: answers.description ?? null,
        currentWork: answers.currentWork ?? [],
        priorities: answers.priorities ?? [],
        interests: answers.interests ?? [],
        additionalContext: answers.additionalContext ?? null,
      },
      pickStatus(p?.status),
    );
  });
  ipcMainHandle('userProfile:update', (p: { patch: unknown }) => {
    const status = pickStatus((p?.patch as { onboardingStatus?: unknown } | undefined)?.onboardingStatus);
    return repo.updateProfile({ ...pickAnswers(p?.patch), ...(status ? { onboardingStatus: status } : {}) });
  });
}
