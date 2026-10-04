/**
 * Data model for Focus Mode.
 *
 * A Focus Session is a planned period of intentional work. While active,
 * automatic activity tracking continues and tracked sessions are tagged with
 * the focus session id so they can be analyzed together.
 */

export type FocusMode = 'stopwatch' | 'countdown';
export type FocusSessionState = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * Why a session ended. `state` alone cannot tell a fulfilled commitment from
 * a deliberate early exit, and Reflection needs that distinction.
 *
 *   completed   — a countdown ran for its whole planned duration   (state: completed)
 *   finished    — a stopwatch was deliberately ended by the user   (state: completed)
 *   ended-early — a countdown was ended before its planned end     (state: cancelled)
 *   abandoned   — the app went away and the session was not resumable (state: cancelled)
 */
export type FocusEndReason = 'completed' | 'finished' | 'ended-early' | 'abandoned';

/**
 * What the enforcement layer is actually doing right now. The UI shows this
 * verbatim — it must never claim "active" unless the blocker confirmed it.
 *
 *   active      — a lease is held and the blocker confirmed it
 *   off         — this session blocks nothing (profile has blocking disabled / no rules)
 *   recovering  — the lease was lost and is being re-acquired
 *   degraded    — the lease was lost and could not be re-acquired
 *   unavailable — this platform has no enforcement implementation
 */
export type FocusBlockingStatus = 'active' | 'off' | 'recovering' | 'degraded' | 'unavailable';

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

/**
 * The blocking a session actually enforces, compiled from its profile's rules
 * when the session starts and frozen for the session's lifetime. Editing the
 * profile afterwards only affects future sessions.
 */
export interface EffectiveBlockingConfig {
  /** False when the session enforces nothing. */
  enabled: boolean;
  /** Exact hostnames to block, sorted, already expanded (www./m. siblings etc.). */
  domains: string[];
  /** Process image names to terminate, lowercase, sorted (e.g. "discord.exe"). */
  apps: string[];
  /** The rules this was compiled from, for later explanation. */
  rules: Array<Pick<FocusProfileRule, 'type' | 'target' | 'action'>>;
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
  /** Accumulated active work time in milliseconds (pause and idle excluded). */
  elapsedMs: number;
  /** The blocking lease id from the blocking manager. */
  blockingLeaseId: string | null;
  /** Why the session ended; null while it is still open. */
  endReason: FocusEndReason | null;
  /** Optional short reason the user gave for ending early. */
  endNote: string | null;
  /** Snapshot of what this session enforces; null on rows older than v14. */
  blockingConfig: EffectiveBlockingConfig | null;
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
  /** Live active work time in ms. */
  liveElapsedMs: number;
  /** True if the active-work timer is running. */
  isRunning: boolean;
  /**
   * Remaining time in ms for countdown mode; null for stopwatch. Frozen
   * while paused.
   */
  remainingMs: number | null;
  /** When a running countdown ends; null for a stopwatch and while paused. */
  plannedEndsAt: string | null;
  /** Why the session is paused, when it is. */
  pauseKind: 'manual' | 'idle' | null;
  blocking: {
    status: FocusBlockingStatus;
    /** Number of block rules the session enforces. */
    ruleCount: number;
    /** Plain-language detail when blocking is not healthy. */
    message: string | null;
  };
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
  /**
   * Start with nothing enforced. Only offered after blocking could not be
   * turned on; the session then truthfully reports blocking as off.
   */
  withoutBlocking?: boolean;
}

/**
 * What the service requires before it will end the current session. Issued by
 * `requestEnd`; the renderer must echo `token` (and the phrase, when required)
 * back through `confirmEnd`. There is no other way to end a session early.
 */
export interface EndFocusChallenge {
  token: string;
  sessionId: string;
  /** True when ending now breaks a countdown commitment. */
  early: boolean;
  /** True when the user must type `phrase` to confirm. */
  requiresPhrase: boolean;
  phrase: string;
  /** Remaining commitment at the time of the request; null for stopwatch. */
  remainingMs: number | null;
  expiresAt: string;
}

export interface ConfirmEndRequest {
  token: string;
  phrase?: string | null;
  /** Optional short reason for ending early. */
  reason?: string | null;
}

/** Persistent Focus configuration. Owned by the main process. */
export interface FocusPreferences {
  defaultProfileId: string | null;
  idleAutoPause: boolean;
  idleThresholdSeconds: number;
  idleAutoResume: boolean;
  notifyStart: boolean;
  notifyIdle: boolean;
  notifyComplete: boolean;
  /** A quiet note the first time a blocked site or app is stopped. */
  notifyBlocked: boolean;
}

export const DEFAULT_FOCUS_PREFERENCES: FocusPreferences = {
  defaultProfileId: null,
  idleAutoPause: true,
  idleThresholdSeconds: 120,
  idleAutoResume: true,
  notifyStart: false,
  notifyIdle: true,
  notifyComplete: true,
  notifyBlocked: true,
};

export const MIN_IDLE_THRESHOLD_SECONDS = 30;
export const MAX_IDLE_THRESHOLD_SECONDS = 3600;

/** Coerce anything (stored JSON, an IPC payload) into valid preferences. */
export function normalizeFocusPreferences(raw: unknown): FocusPreferences {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (key: keyof FocusPreferences): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : (DEFAULT_FOCUS_PREFERENCES[key] as boolean);
  const threshold = Number(src.idleThresholdSeconds);
  return {
    defaultProfileId: typeof src.defaultProfileId === 'string' && src.defaultProfileId ? src.defaultProfileId : null,
    idleAutoPause: bool('idleAutoPause'),
    idleThresholdSeconds: Number.isFinite(threshold)
      ? Math.min(MAX_IDLE_THRESHOLD_SECONDS, Math.max(MIN_IDLE_THRESHOLD_SECONDS, Math.round(threshold)))
      : DEFAULT_FOCUS_PREFERENCES.idleThresholdSeconds,
    idleAutoResume: bool('idleAutoResume'),
    notifyStart: bool('notifyStart'),
    notifyIdle: bool('notifyIdle'),
    notifyComplete: bool('notifyComplete'),
    notifyBlocked: bool('notifyBlocked'),
  };
}

export const MAX_TASK_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_REASON_LENGTH = 120;
export const MAX_PLANNED_MINUTES = 12 * 60;

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
