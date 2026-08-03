/**
 * Data model for Focus Mode.
 *
 * A Focus Session is a planned period of intentional work. While active,
 * automatic activity tracking continues and tracked sessions are tagged with
 * the focus session id so they can be analyzed together.
 */

export type FocusMode = 'stopwatch' | 'countdown';
export type FocusSessionState = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';

/** A global blocking/allowing rule that can be referenced by any profile. */
export interface FocusRule {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A rule inside a focus profile that describes what to block/allow.
 *  Derived from the global rule pool for the active profile. */
export interface FocusProfileRule {
  id: string;
  profileId: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  createdAt: string;
  updatedAt: string;
}

/** A reusable focus configuration (e.g. "Deep Work", "Writing", "Meeting"). */
export interface FocusProfile {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  mode: FocusMode;
  /** Default duration in minutes for countdown mode. Ignored for stopwatch. */
  defaultDurationMinutes: number | null;
  /** Whether the profile blocks distractions. */
  blocksDistractions: boolean;
  /** Optional ambient sound / playlist cue (stored as URL or identifier). */
  soundCue: string | null;
  createdAt: string;
  updatedAt: string;
  rules: FocusProfileRule[];
}

/** A single focus session. */
export interface FocusSession {
  id: string;
  profileId: string;
  task: string;
  notes: string | null;
  mode: FocusMode;
  /** Planned duration in minutes for countdown mode; null for stopwatch. */
  plannedDurationMinutes: number | null;
  state: FocusSessionState;
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  /** Cumulative pause time in milliseconds. */
  totalPauseMs: number;
  /** Current accumulated working time in milliseconds (updated on heartbeat). */
  elapsedMs: number;
  /** The blocking lease id from the external blocking manager. */
  blockingLeaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Records a pause or resume event. */
export interface FocusInterruption {
  id: string;
  sessionId: string;
  type: 'pause' | 'resume' | 'idle' | 'user';
  reason: string | null;
  occurredAt: string;
  /** Idle time in ms before this interruption was recorded. */
  idleMs: number | null;
  createdAt: string;
}

/** Records an attempt to access a blocked resource while focus is active. */
export interface BlockedAttempt {
  id: string;
  sessionId: string;
  type: 'app' | 'website' | 'category';
  target: string;
  /** Time when the attempt was observed by the blocking manager. */
  attemptedAt: string;
  createdAt: string;
}

/** DTO exposed to the renderer for the active session. */
export interface ActiveFocusSessionDto {
  session: FocusSession;
  profile: FocusProfile;
  /** Live elapsed working time in ms. */
  liveElapsedMs: number;
  /** True if the timer is running. */
  isRunning: boolean;
  /** Remaining time in ms for countdown mode; null for stopwatch. */
  remainingMs: number | null;
}

/** DTO for the post-session summary. */
export interface FocusSummaryDto {
  session: FocusSession;
  profile: FocusProfile;
  /** Tracked sessions that occurred during this focus session. */
  trackedSessionIds: string[];
  interruptionCount: number;
  blockedAttemptCount: number;
  /** Total time spent in tracked sessions during focus. */
  productiveMs: number;
}

/** Request to start a focus session. */
export interface StartFocusRequest {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: FocusMode;
  plannedDurationMinutes?: number | null;
}

/** Default profile factory. */
export function createDefaultProfile(now = new Date().toISOString()): FocusProfile {
  return {
    id: 'default-deep-work',
    name: 'Deep Work',
    description: 'Block distractions and focus on one task.',
    isDefault: true,
    mode: 'countdown',
    defaultDurationMinutes: 25,
    blocksDistractions: true,
    soundCue: null,
    createdAt: now,
    updatedAt: now,
    rules: [
      {
        id: 'rule-default-1',
        profileId: 'default-deep-work',
        type: 'category',
        target: 'social-media',
        action: 'block',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rule-default-2',
        profileId: 'default-deep-work',
        type: 'category',
        target: 'entertainment',
        action: 'block',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
