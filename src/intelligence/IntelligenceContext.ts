import type { IUserProfileRepository } from '../database/UserProfileRepository.js';
import { toIntelligenceContext, type OnboardingStatus } from '../profile/UserProfile.js';
import type { UserContextProvider, UserIntelligenceContext } from './IntelligenceModels.js';

/**
 * The user's context for the intelligence layer, read from the saved
 * onboarding profile — the only source of truth. Nothing is cached: the
 * profile is read on every call, so an edit in Settings is used by the very
 * next analysis without a restart.
 *
 * Returns `null` (never defaults) unless onboarding was completed and the
 * user actually provided something.
 */
export class UserProfileContextProvider implements UserContextProvider {
  constructor(private readonly profiles: Pick<IUserProfileRepository, 'getProfile'>) {}

  getUserContext(): UserIntelligenceContext | null {
    const profile = this.profiles.getProfile();
    if (profile.onboardingStatus !== 'completed') return null;
    return toIntelligenceContext(profile);
  }

  getOnboardingStatus(): OnboardingStatus {
    return this.profiles.getProfile().onboardingStatus;
  }
}
