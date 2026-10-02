import { describe, it, expect, beforeEach } from 'vitest';
import { registerUserProfileIpc } from '../../src/profile/userProfileIpc';
import {
  emptyProfile,
  normalizeProfileInput,
  shouldShowOnboarding,
  type OnboardingStatus,
  type UserProfile,
  type UserProfileInput,
} from '../../src/profile/UserProfile';
import type { IUserProfileRepository } from '../../src/database/UserProfileRepository';

/** In-memory repository mirroring UserProfileRepository semantics. */
class FakeUserProfileRepository implements IUserProfileRepository {
  profile: UserProfile = emptyProfile();
  getProfile() {
    return { ...this.profile };
  }
  saveProfile(input: UserProfileInput, status?: OnboardingStatus) {
    this.profile = { ...this.profile, ...normalizeProfileInput(input), onboardingStatus: status ?? this.profile.onboardingStatus };
    return this.getProfile();
  }
  updateProfile(patch: Partial<UserProfileInput> & { onboardingStatus?: OnboardingStatus }) {
    const { onboardingStatus, ...answers } = patch;
    this.profile = {
      ...this.profile,
      ...normalizeProfileInput({ ...this.profile, ...answers }),
      onboardingStatus: onboardingStatus ?? this.profile.onboardingStatus,
    };
    return this.getProfile();
  }
  getOnboardingStatus() {
    return this.profile.onboardingStatus;
  }
  clearProfile() {
    this.profile = emptyProfile();
  }
}

describe('userProfile IPC', () => {
  let repo: FakeUserProfileRepository;
  let handlers: Map<string, (payload?: any) => any>;

  beforeEach(() => {
    repo = new FakeUserProfileRepository();
    handlers = new Map();
    registerUserProfileIpc(repo, (key, handler) => handlers.set(key, handler));
  });

  it('registers the profile channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'userProfile:get',
      'userProfile:getOnboardingStatus',
      'userProfile:save',
      'userProfile:update',
    ]);
  });

  it('saves a full profile with status', () => {
    const out = handlers.get('userProfile:save')!({
      profile: { roles: ['Student'], description: null, currentWork: [], priorities: [], interests: [], additionalContext: null },
      status: 'completed',
    });
    expect(out.roles).toEqual(['Student']);
    expect(out.onboardingStatus).toBe('completed');
  });

  it('ignores unknown keys from the renderer', () => {
    handlers.get('userProfile:update')!({ patch: { roles: ['Founder'], age: 30, name: 'x' } });
    const p = handlers.get('userProfile:get')!();
    expect(p.roles).toEqual(['Founder']);
    expect(p).not.toHaveProperty('age');
    expect(p).not.toHaveProperty('name');
  });

  it('rejects an invalid status', () => {
    expect(() => handlers.get('userProfile:update')!({ patch: { onboardingStatus: 'done' } })).toThrow();
    expect(() => handlers.get('userProfile:save')!({ profile: {}, status: 42 })).toThrow();
  });

  it('skipping persists and stops onboarding from showing again', () => {
    handlers.get('userProfile:update')!({ patch: { onboardingStatus: 'skipped' } });
    const status = handlers.get('userProfile:getOnboardingStatus')!();
    expect(status).toBe('skipped');
    expect(shouldShowOnboarding(status)).toBe(false);
  });

  it('tolerates a missing payload', () => {
    expect(() => handlers.get('userProfile:update')!(undefined)).not.toThrow();
    expect(handlers.get('userProfile:get')!().onboardingStatus).toBe('not_started');
  });
});
