import type { ReflectionEvidence } from '../reflection/ReflectionModels.js';

/**
 * Coach layer — domain types and configuration.
 *
 *   TIMELINE   observes.
 *   REFLECTION understands.
 *   COACH      decides what is worth trying next, remembers what was decided,
 *              watches whether it happened, asks whether it helped, and adapts.
 *
 * The Coach is not a second intelligence system: its daily output is produced
 * by the SAME Gemini request that writes the day's reflection, and committed
 * in the same transaction. Everything it knows about the user is structured:
 *
 *   coach_actions        a recommendation as a trackable entity
 *   coach_action_events  the audit trail of its lifecycle
 *   coach_memory         durable things the user said / that were concluded
 *   coach_messages       the conversation
 *
 * Layers (all under `src/coach/`):
 *   PURE (no SQLite / Electron / network / Date.now / Math.random):
 *     - CoachModels.ts        this file — types + config
 *     - CoachLifecycle.ts     the action state machine
 *     - CoachMatching.ts      similarity, strategy identity, execution detection
 *     - CoachEffectiveness.ts what has worked / failed for this user
 *     - CoachContext.ts       structured history → compact model input
 *     - CoachPrompt.ts        prompt text + response schemas
 *     - CoachValidator.ts     runtime validation of model output
 *   IMPURE:
 *     - CoachService.ts       daily hook, user decisions, observation, conversation
 *     - coachIpc.ts           renderer bridge
 */

// ── Action taxonomy ─────────────────────────────────────────────────────────

export const COACH_ACTION_TYPES = [
  'continue_behavior',
  'focus_session',
  'change_timing',
  'protect_priority',
  'reduce_fragmentation',
  'close_open_loop',
  'avoid_pattern',
  'experiment',
  'change_approach',
  'rest',
  'clarify_priority',
  'drop',
] as const;

export type CoachActionType = (typeof COACH_ACTION_TYPES)[number];

export const COACH_DAYPARTS = ['morning', 'afternoon', 'evening', 'night', 'any'] as const;
export type CoachDaypart = (typeof COACH_DAYPARTS)[number];

export const COACH_WHEN = ['today', 'tomorrow', 'this_week'] as const;
export type CoachWhen = (typeof COACH_WHEN)[number];

/**
 * Where an action is in its life. `execution` (did it happen) and `outcome`
 * (did it help) are separate fields — a completed action can still have been a
 * bad recommendation.
 *
 *   suggested  waiting for the user's decision
 *   snoozed    "Not now" — offered once more the next day
 *   accepted   a commitment; Reflect is watching for it
 *   review     its window passed (or it was observed); waiting for the user's
 *              word on whether it happened and/or whether it helped
 *   closed     lifecycle complete
 *   rejected   the user declined it (terminal)
 *   withdrawn  its report was regenerated before the user decided (terminal)
 *   expired    never decided (terminal)
 */
export type CoachActionStatus =
  | 'suggested'
  | 'snoozed'
  | 'accepted'
  | 'review'
  | 'closed'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export const COACH_OPEN_STATUSES: readonly CoachActionStatus[] = ['suggested', 'snoozed', 'accepted', 'review'];

export type CoachExecution = 'done' | 'partial' | 'not_done';
export const COACH_EXECUTIONS: readonly CoachExecution[] = ['done', 'partial', 'not_done'];
export type CoachExecutionSource = 'observed' | 'user';

export type CoachOutcome = 'worked' | 'partly_worked' | 'did_not_work' | 'not_applicable';
export const COACH_OUTCOMES: readonly CoachOutcome[] = ['worked', 'partly_worked', 'did_not_work', 'not_applicable'];

export type CoachReasonCode =
  | 'not_relevant'
  | 'bad_timing'
  | 'too_difficult'
  | 'different_priority'
  | 'already_doing'
  | 'external_constraint'
  | 'not_applicable'
  | 'other';

export const COACH_REASON_CODES: readonly CoachReasonCode[] = [
  'not_relevant',
  'bad_timing',
  'too_difficult',
  'different_priority',
  'already_doing',
  'external_constraint',
  'not_applicable',
  'other',
];

export type CoachActionSource = 'daily' | 'conversation';

/**
 * What Reflect's own data shows about an accepted action.
 *
 *   executed      it happened (a matching Focus session, or enough matching work)
 *   attempted     the target was worked on, but not the way it was suggested
 *   ambiguous     something related happened; not enough to call it either way
 *   not_observed  the window passed and nothing matching was seen — no judgment
 *   unobservable  this kind of action leaves no trace Reflect can see
 */
export type CoachObservationKind = 'executed' | 'attempted' | 'ambiguous' | 'not_observed' | 'unobservable';

export interface CoachObservation {
  kind: CoachObservationKind;
  observedAt: string;
  window: { start: string; end: string };
  /** Whether the window had ended when this was observed. */
  final: boolean;
  focusSessionIds: string[];
  activityIds: string[];
  /** Active minutes in matching Focus sessions. */
  focusMinutes: number;
  /** Tracked minutes of matching activity. */
  matchedMinutes: number;
  plannedMinutes: number | null;
  interruptions: number;
  /** Plain statements of what was seen — shown to the user and to the model. */
  facts: string[];
}

export interface CoachAction {
  id: string;
  source: CoachActionSource;
  /** The daily report that suggested it, when it came from one. */
  reportId: string | null;
  /** Local day (`2026-10-03`) it was suggested on. */
  originDayKey: string;
  /** The earlier action this one adapts after it did not work out. */
  parentActionId: string | null;

  title: string;
  description: string | null;
  rationale: string;
  actionType: CoachActionType;
  daypart: CoachDaypart;
  targetStart: string | null;
  targetEnd: string | null;
  /** When set, the action can be run as a Focus session of this length. */
  focusMinutes: number | null;
  focusTask: string | null;
  priorityId: string | null;
  thread: string | null;

  /** How the intervention is shaped — the unit effectiveness is learned on. */
  strategyKey: string;
  /** What it is aimed at (a priority or a thread); null when general. */
  targetKey: string | null;

  evidence: ReflectionEvidence[];
  sourceMetricKeys: string[];
  sourceActivityIds: string[];
  confidence: number;

  status: CoachActionStatus;
  execution: CoachExecution | null;
  executionSource: CoachExecutionSource | null;
  outcome: CoachOutcome | null;
  /** Why it was rejected / not done / did not work. */
  reasonCode: CoachReasonCode | null;
  /** The user's own words, when they added any. */
  note: string | null;
  observation: CoachObservation | null;
  linkedFocusSessionId: string | null;
  snoozedUntil: string | null;
  snoozeCount: number;
  userEdited: boolean;

  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  /** When it was tried (observed or stated). */
  executedAt: string | null;
  outcomeAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface CoachActionEvent {
  id: string;
  actionId: string;
  type: string;
  fromStatus: CoachActionStatus | null;
  toStatus: CoachActionStatus;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

// ── Memory ──────────────────────────────────────────────────────────────────

/**
 * Durable coaching memory. What worked / failed is NOT stored here — it is
 * derived from the actions themselves, so there is one source of truth.
 *
 *   preference     how the user likes to work (stated by the user)
 *   constraint     something that limits what is realistic (stated by the user)
 *   decision       something the user decided
 *   priority_note  what the user said about a priority
 *   open_loop      a thread that is waiting on something (evidence-backed)
 *   conclusion     something the Coach concluded from outcomes (evidence-backed)
 */
export type CoachMemoryKind = 'preference' | 'constraint' | 'decision' | 'priority_note' | 'open_loop' | 'conclusion';

export const COACH_MEMORY_KINDS: readonly CoachMemoryKind[] = [
  'preference',
  'constraint',
  'decision',
  'priority_note',
  'open_loop',
  'conclusion',
];

/** Kinds the daily pass may write: only what evidence can support. */
export const DAILY_MEMORY_KINDS: readonly CoachMemoryKind[] = ['open_loop', 'conclusion'];
/** Kinds a conversation may write: what the user said, in their own words. */
export const CHAT_MEMORY_KINDS: readonly CoachMemoryKind[] = ['preference', 'constraint', 'decision', 'priority_note', 'open_loop'];

export type CoachMemoryStatus = 'active' | 'resolved' | 'removed';

export interface CoachMemory {
  id: string;
  kind: CoachMemoryKind;
  text: string;
  normalizedKey: string;
  status: CoachMemoryStatus;
  source: 'user' | 'coach';
  /** Report or message it came from. */
  sourceRef: string | null;
  targetKey: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Conversation ────────────────────────────────────────────────────────────

export interface CoachMessageMeta {
  kind?: 'question' | 'reply' | 'error';
  /** Actions this message created or changed, with what happened. */
  actions?: { actionId: string; change: string }[];
  memoryIds?: string[];
  /** The activity the user said was wrong — a way into the correction flow. */
  correction?: { activityId: string; title: string; start: string; end: string } | null;
  /** The action a coach question is about. */
  aboutActionId?: string | null;
  /** The target (priority / thread) a coach question is about. */
  targetKey?: string | null;
  reportId?: string | null;
}

export interface CoachMessage {
  id: string;
  role: 'user' | 'coach';
  text: string;
  meta: CoachMessageMeta | null;
  createdAt: string;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface CoachSettings {
  /** Minutes after local midnight at which the day's reflection is written. */
  reflectionMinutes: number;
  /** Minutes after local midnight at which the user's day begins (0–360). */
  dayStartMinutes: number;
  notifyDailyReflection: boolean;
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = {
  reflectionMinutes: 22 * 60,
  dayStartMinutes: 0,
  notifyDailyReflection: true,
};

export const MAX_DAY_START_MINUTES = 6 * 60;

/** Coerce anything (stored JSON, an IPC payload) into valid settings. */
export function normalizeCoachSettings(raw: unknown): CoachSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const minutes = (value: unknown, fallback: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback;
  };
  return {
    reflectionMinutes: minutes(src.reflectionMinutes, DEFAULT_COACH_SETTINGS.reflectionMinutes, 1439),
    dayStartMinutes: minutes(src.dayStartMinutes, DEFAULT_COACH_SETTINGS.dayStartMinutes, MAX_DAY_START_MINUTES),
    notifyDailyReflection:
      typeof src.notifyDailyReflection === 'boolean' ? src.notifyDailyReflection : DEFAULT_COACH_SETTINGS.notifyDailyReflection,
  };
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface CoachConfig {
  /** Upper bound on new recommendations per daily report. */
  maxActionsPerDay: number;
  /** The daily pass adds coaching only this long after the day closed. */
  dailyEligibilityMs: number;
  /** An accepted action without a window is watched this long. */
  defaultWindowMs: number;
  /** Matching work needed to call a target "worked on" when no length was planned. */
  minAttemptMinutes: number;
  /** Below this, matching work is noise. */
  minSignalMinutes: number;
  /** Share of the planned Focus time that counts as done / as partly done. */
  doneRatio: number;
  partialRatio: number;
  /** A review nobody answered is closed after this long. */
  reviewTimeoutMs: number;
  /** How far back outcomes inform recommendations. */
  effectivenessLookbackMs: number;
  /** Failures (with no success) after which a strategy is not suggested again for a target. */
  blockAfterFailures: number;
  /** Failures (with no success) on one target after which the Coach asks instead of advising. */
  escalateAfterFailures: number;
  /** A rejected suggestion is not repeated for this long. */
  rejectionMemoryMs: number;
  duplicateTitleOverlap: number;
  maxFollowups: number;
  maxMemoryUpdates: number;
  maxActiveMemories: number;
  minConfidence: number;
  chatHistoryMessages: number;
  maxStoredMessages: number;
}

const DAY_MS = 86_400_000;

export const DEFAULT_COACH_CONFIG: CoachConfig = {
  maxActionsPerDay: 2,
  dailyEligibilityMs: 12 * 3_600_000,
  defaultWindowMs: 2 * DAY_MS,
  minAttemptMinutes: 20,
  minSignalMinutes: 5,
  doneRatio: 0.8,
  partialRatio: 0.25,
  reviewTimeoutMs: 5 * DAY_MS,
  effectivenessLookbackMs: 60 * DAY_MS,
  blockAfterFailures: 2,
  escalateAfterFailures: 3,
  rejectionMemoryMs: 30 * DAY_MS,
  duplicateTitleOverlap: 0.6,
  maxFollowups: 6,
  maxMemoryUpdates: 3,
  maxActiveMemories: 40,
  minConfidence: 0.4,
  chatHistoryMessages: 8,
  maxStoredMessages: 200,
};

export const COACH_LIMITS = { title: 120, description: 300, rationale: 320, note: 400, memory: 200, question: 240, reply: 1400, followup: 280 };

/** Bounds of a Focus block the Coach may suggest. */
export const MIN_FOCUS_MINUTES = 10;
export const MAX_FOCUS_MINUTES = 180;

export interface CoachLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
