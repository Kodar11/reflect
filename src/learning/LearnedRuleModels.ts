import type { RuleCondition, RuleConditionType } from '../categorization/Classification.js';

/**
 * Learned patterns — domain types and tunables.
 *
 * Reflect learns the reusable pattern behind a manual correction:
 *
 *   correction → candidate → repeated evidence → suggestion
 *     → user confirms → tracking_rule (source = 'learned')
 *
 * A candidate is NOT a rule. It is a pattern Reflect is considering, expressed
 * with the same deterministic conditions the rule engine already matches. It
 * only becomes a row in `tracking_rules` when the user says so.
 *
 * Layers (all under `src/learning/`):
 *   PURE (no SQLite / Electron / network / Date.now / Math.random):
 *     - LearnedRuleModels.ts       this file — types + thresholds
 *     - LearnedPattern.ts          normalisation, hashing, descriptions
 *     - LearnedRuleEligibility.ts  evidence, eligibility, suggestion choice
 *     - LearnedPatternPrompt.ts    extraction prompt + response schema
 *     - LearnedPatternValidator.ts runtime validation of Gemini's proposal
 *   IMPURE:
 *     - LearnedRuleService.ts      orchestration
 *     - learnedRulesIpc.ts         renderer bridge
 */

/** Version of the pattern-extraction output contract. */
export const LEARNED_PATTERN_SCHEMA_VERSION = 1;

/** The condition types the deterministic matcher supports. Nothing else may
 * ever appear in a candidate. */
export const SUPPORTED_CONDITION_TYPES: readonly RuleConditionType[] = [
  'app_equals',
  'browser_equals',
  'title_contains',
  'url_contains',
  'url_starts_with',
  'domain_equals',
];

// ── Tunables ────────────────────────────────────────────────────────────────

export interface LearnedRuleConfig {
  /** Path A: a correction plus this many matching activities … */
  minOccurrencesWithCorrection: number;
  /** Path B: without relying on corrections, this many matching activities … */
  minOccurrences: number;
  /** … spread over at least this many calendar days (both paths). */
  minDistinctDays: number;
  /** A candidate not seen for longer than this is kept but never suggested. */
  recencyWindowDays: number;
  /** "Not now", and the gap before the same candidate may be shown again. */
  resuggestAfterDays: number;
  /** Minimum gap between any two interrupting suggestions. */
  globalCooldownMinutes: number;
  /** Local hour from which the end-of-day suggestion may appear. */
  endOfDayHour: number;
  /** "Current activity" = the latest activity that ended within this window. */
  contextualWindowMinutes: number;
  /** Shorter matches are noise, not an occurrence. */
  minOccurrenceDurationMs: number;
  /** How far back occurrence tracking re-scans activities. */
  trackingLookbackHours: number;
  /** Upper bound on conditions in one pattern. */
  maxConditions: number;
  maxConditionValueLength: number;
  /** Proposals below this confidence are discarded. */
  minProposalConfidence: number;
  /** Cost guard for pattern extraction. */
  maxExtractionsPerHour: number;
  /** Priority given to a rule created from a confirmed candidate. */
  learnedRulePriority: number;
}

export const LEARNED_RULE_MIN_OCCURRENCES_WITH_CORRECTION = 2;
export const LEARNED_RULE_MIN_OCCURRENCES = 3;
export const LEARNED_RULE_MIN_DISTINCT_DAYS = 2;
export const LEARNED_RULE_RECENCY_WINDOW_DAYS = 30;
export const LEARNED_RULE_RESUGGEST_AFTER_DAYS = 7;
export const LEARNED_RULE_GLOBAL_COOLDOWN_MINUTES = 240;
export const LEARNED_RULE_END_OF_DAY_HOUR = 18;

export const DEFAULT_LEARNED_RULE_CONFIG: LearnedRuleConfig = {
  minOccurrencesWithCorrection: LEARNED_RULE_MIN_OCCURRENCES_WITH_CORRECTION,
  minOccurrences: LEARNED_RULE_MIN_OCCURRENCES,
  minDistinctDays: LEARNED_RULE_MIN_DISTINCT_DAYS,
  recencyWindowDays: LEARNED_RULE_RECENCY_WINDOW_DAYS,
  resuggestAfterDays: LEARNED_RULE_RESUGGEST_AFTER_DAYS,
  globalCooldownMinutes: LEARNED_RULE_GLOBAL_COOLDOWN_MINUTES,
  endOfDayHour: LEARNED_RULE_END_OF_DAY_HOUR,
  contextualWindowMinutes: 10,
  minOccurrenceDurationMs: 60_000,
  trackingLookbackHours: 48,
  maxConditions: 4,
  maxConditionValueLength: 120,
  minProposalConfidence: 0.5,
  maxExtractionsPerHour: 12,
  learnedRulePriority: 10,
};

// ── Classification ──────────────────────────────────────────────────────────

/** The four classification ids a candidate (and later its rule) assigns. */
export interface ClassificationIds {
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
}

/** Display names for the ids, resolved against the current taxonomy. */
export interface ClassificationNames {
  context: string | null;
  area: string | null;
  intent: string | null;
  quality: string | null;
}

// ── Candidates ──────────────────────────────────────────────────────────────

/**
 * pending   — may become eligible for a suggestion
 * snoozed   — "Not now"; hidden until `snoozedUntil`
 * confirmed — converted into a learned rule (`confirmedRuleId`)
 * dismissed — "Never suggest this"; only an explicit reactivation revives it
 */
export type CandidateStatus = 'pending' | 'snoozed' | 'confirmed' | 'dismissed';

export interface LearnedRuleCandidate {
  id: string;
  /** Hash of the normalised conditions — stable identity of the pattern. */
  patternHash: string;
  /** Hash of the classification; with `patternHash` it identifies the candidate. */
  classificationHash: string;
  /** Normalised, deduplicated, deterministically ordered. */
  conditions: RuleCondition[];
  classification: ClassificationIds;

  /** Distinct activities that matched the pattern. */
  occurrenceCount: number;
  /** Distinct calendar days those activities fell on. */
  distinctDayCount: number;
  /** Matching activities the user corrected to this classification. */
  correctionCount: number;
  /** Matching activities the user explicitly classified differently. */
  conflictCount: number;

  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastCorrectionAt: string | null;

  lastSuggestedAt: string | null;
  suggestionCount: number;

  status: CandidateStatus;
  snoozedUntil: string | null;
  confirmedRuleId: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface NewLearnedRuleCandidate {
  id: string;
  patternHash: string;
  classificationHash: string;
  conditions: RuleCondition[];
  classification: ClassificationIds;
  nowIso: string;
}

/**
 * One activity that matched a candidate. The ledger makes counting idempotent:
 * an activity contributes at most one row however often it is processed.
 */
export interface CandidateOccurrence {
  candidateId: string;
  /** `ai:<activity id>` or `ev:<first event id>`. */
  occurrenceKey: string;
  /** First raw event of the activity; a second idempotency handle that
   * survives the activity being regrouped under a different key. */
  anchorEventId: number | null;
  /** Local calendar day, `YYYY-MM-DD`. */
  localDay: string;
  occurredAt: string;
  isCorrection: boolean;
  isConflict: boolean;
}

/** Counters derived from a candidate's occurrence ledger. */
export interface CandidateEvidence {
  occurrenceCount: number;
  distinctDayCount: number;
  correctionCount: number;
  conflictCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastCorrectionAt: string | null;
}

// ── Activities as the learning layer sees them ──────────────────────────────

/**
 * A timeline activity (AI activity or deterministic session) reduced to what
 * matching needs. Built by the composition root from the verified timeline, so
 * the learning layer uses exactly the boundaries the user sees.
 */
export interface LearningActivity {
  /** Persisted AI activity id, when the block is AI-derived. */
  aiActivityId: string | null;
  startedAt: string;
  endedAt: string;
  activeDurationMs: number;
  primaryApp?: string;
  primaryBrowser?: string;
  primaryTitle?: string;
  primaryUrl?: string;
  appsUsed: string[];
  browserTabs: string[];
  eventIds: number[];
  /** Where the activity's current classification came from. */
  classificationSource: string | null;
  classification: ClassificationIds;
}

// ── Gemini proposal ─────────────────────────────────────────────────────────

/** What Gemini is asked to return. A proposal, never an authorisation. */
export interface LearnedPatternProposal {
  schemaVersion: 1;
  /** Empty when no reliable reusable pattern exists. */
  conditions: RuleCondition[];
  explanation: string;
  confidence: number;
}

/** One distinct observation inside the corrected activity. */
export interface PatternEvidenceEvent {
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  /** Total time spent on this exact combination, in seconds. */
  seconds: number;
}

export interface PatternPromptInput {
  correctedAt: string;
  activity: {
    startedAt: string;
    endedAt: string;
    /** The activity's dominant values — what `title_contains` etc. are matched against. */
    primaryApp: string | null;
    primaryBrowser: string | null;
    primaryTitle: string | null;
    primaryUrl: string | null;
  };
  /** The AI interpretation the user corrected, when there was one. */
  original: { title: string | null; summary: string | null; classification: ClassificationNames } | null;
  corrected: ClassificationNames;
  events: PatternEvidenceEvent[];
  /** Other recent activities, so the pattern can be told apart from them. */
  otherActivities: { app: string | null; title: string | null; url: string | null; classification: ClassificationNames }[];
  /** User context text, or null when not provided. */
  userContext: string | null;
  existingRules: { conditions: RuleCondition[]; classification: ClassificationNames }[];
  maxConditions: number;
}

// ── Results / DTOs ──────────────────────────────────────────────────────────

export type ObservationResult =
  | { status: 'candidate'; candidateId: string; created: boolean; usedGemini: boolean }
  | {
      status: 'skipped';
      reason:
        | 'no_classification'
        | 'invalid_classification'
        | 'no_events'
        | 'gemini_unavailable'
        | 'rate_limited'
        | 'no_pattern'
        | 'rejected'
        | 'error';
      detail?: string;
    };

export type SuggestionTrigger = 'contextual' | 'daily' | 'list';

/** Everything the renderer needs to show a suggestion — and nothing it has to
 * decide for itself. */
export interface LearnedRuleSuggestion {
  candidateId: string;
  trigger: SuggestionTrigger;
  conditions: RuleCondition[];
  /** e.g. `VS Code + “GameTheory”`. */
  patternLabel: string;
  classification: ClassificationIds;
  /** e.g. `Personal · Create · Focused`. */
  classificationLabel: string;
  /** e.g. `Seen 8 times across 4 days`. */
  evidenceLabel: string;
  occurrenceCount: number;
  distinctDayCount: number;
  correctionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/** Candidate plus derived state, for the Rules page and for diagnostics. */
export interface LearnedRuleCandidateView extends LearnedRuleCandidate {
  patternLabel: string;
  classificationLabel: string;
  /** False when the same pattern has been classified in conflicting ways. */
  consistent: boolean;
  /** An enabled rule already produces this behaviour. */
  coveredByRule: boolean;
  /** Passes every evidence/recency/consistency gate right now. */
  eligible: boolean;
  /** Why it is not eligible, for testing. Empty when eligible. */
  blockedBy: string[];
}

export interface ConfirmResult {
  ruleId: string;
  /** False when the candidate had already been confirmed (idempotent). */
  created: boolean;
}

export interface TrackResult {
  activitiesScanned: number;
  occurrencesRecorded: number;
}
