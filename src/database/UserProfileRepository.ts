import type { Database } from './Database.js';
import {
  emptyProfile,
  isOnboardingStatus,
  normalizeProfileInput,
  type OnboardingStatus,
  type UserProfile,
  type UserProfileInput,
} from '../profile/UserProfile.js';

/**
 * Repository seam for the single-row `user_profile` table — the only module
 * that knows its SQL. Inputs are normalized on every write, so whatever the
 * renderer sends, only trimmed, de-duplicated, length-clamped data is stored.
 *
 * A missing row reads as an empty profile with status `not_started`.
 */
export interface IUserProfileRepository {
  getProfile(): UserProfile;
  /** Replace all answers (and optionally the status). */
  saveProfile(input: UserProfileInput, status?: OnboardingStatus): UserProfile;
  /** Merge a partial set of answers and/or a new status. */
  updateProfile(patch: Partial<UserProfileInput> & { onboardingStatus?: OnboardingStatus }): UserProfile;
  getOnboardingStatus(): OnboardingStatus;
  clearProfile(): void;
}

interface UserProfileRow {
  roles: string;
  description: string | null;
  current_work: string;
  priorities: string;
  interests: string;
  additional_context: string | null;
  onboarding_status: string;
  created_at: string;
  updated_at: string;
}

function parseList(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

export class UserProfileRepository implements IUserProfileRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly clearStmt;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.getStmt = db.prepare(`SELECT * FROM user_profile WHERE id = 1`);
    this.upsertStmt = db.prepare(`
      INSERT INTO user_profile (
        id, roles, description, current_work, priorities, interests,
        additional_context, onboarding_status, created_at, updated_at
      ) VALUES (1, @roles, @description, @currentWork, @priorities, @interests,
        @additionalContext, @status, @now, @now)
      ON CONFLICT (id) DO UPDATE SET
        roles              = excluded.roles,
        description        = excluded.description,
        current_work       = excluded.current_work,
        priorities         = excluded.priorities,
        interests          = excluded.interests,
        additional_context = excluded.additional_context,
        onboarding_status  = excluded.onboarding_status,
        updated_at         = excluded.updated_at
    `);
    this.clearStmt = db.prepare(`DELETE FROM user_profile WHERE id = 1`);
  }

  getProfile(): UserProfile {
    const row = this.getStmt.get() as UserProfileRow | undefined;
    if (!row) return emptyProfile();
    const input = normalizeProfileInput({
      roles: parseList(row.roles),
      description: row.description,
      currentWork: parseList(row.current_work),
      priorities: parseList(row.priorities),
      interests: parseList(row.interests),
      additionalContext: row.additional_context,
    });
    return {
      ...input,
      onboardingStatus: isOnboardingStatus(row.onboarding_status) ? row.onboarding_status : 'not_started',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveProfile(input: UserProfileInput, status?: OnboardingStatus): UserProfile {
    const nextStatus = status ?? this.getOnboardingStatus();
    this.write(normalizeProfileInput(input), nextStatus);
    return this.getProfile();
  }

  updateProfile(patch: Partial<UserProfileInput> & { onboardingStatus?: OnboardingStatus }): UserProfile {
    return this.db.transaction(() => {
      const current = this.getProfile();
      const { onboardingStatus, ...answers } = patch;
      const merged = normalizeProfileInput({ ...current, ...answers });
      this.write(merged, onboardingStatus ?? current.onboardingStatus);
      return this.getProfile();
    });
  }

  getOnboardingStatus(): OnboardingStatus {
    return this.getProfile().onboardingStatus;
  }

  clearProfile(): void {
    this.clearStmt.run();
  }

  private write(input: UserProfileInput, status: OnboardingStatus): void {
    if (!isOnboardingStatus(status)) {
      throw new Error(`Invalid onboarding status: ${String(status)}`);
    }
    this.upsertStmt.run({
      roles: JSON.stringify(input.roles),
      description: input.description,
      currentWork: JSON.stringify(input.currentWork),
      priorities: JSON.stringify(input.priorities),
      interests: JSON.stringify(input.interests),
      additionalContext: input.additionalContext,
      status,
      now: this.now().toISOString(),
    });
  }
}
