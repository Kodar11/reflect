import type { WatcherName } from '../models/Event.js';
import type { RuleCondition } from '../categorization/Classification.js';
import type { OnboardingStatus, UserIntelligenceContext } from '../profile/UserProfile.js';

/**
 * Intelligence layer — domain types.
 *
 * The intelligence layer reconstructs meaningful human activities from raw
 * events. It is a derived overlay: raw events are never modified and no AI
 * interpretation is ever written to the `events` table.
 *
 * Layers (all under `src/intelligence/`):
 *   PURE (no SQLite / Electron / network):
 *     - IntelligenceModels.ts        this file — types + versions
 *     - IntelligencePreprocessor.ts  Event[] → compact evidence
 *     - IntelligencePrompt.ts        prompt + response schema builders
 *     - IntelligenceValidator.ts     runtime validation of model output
 *     - IntelligenceReconciler.ts    validated output → incremental write plan
 *   IMPURE:
 *     - GeminiClient.ts              provider/API concerns only
 *     - IntelligenceService.ts       the analysis pipeline
 *     - IntelligenceScheduler.ts     hourly + backlog cadence
 *     - IntelligenceTimelineSource.ts timeline adapter
 *     - intelligenceIpc.ts           manual trigger for the renderer
 */

/** Version of the structured output contract. Bump when the shape changes. */
export const INTELLIGENCE_SCHEMA_VERSION = 1;

// ── User context ────────────────────────────────────────────────────────────

/** The single representation of user context, derived from the saved profile. */
export type { UserIntelligenceContext };

/**
 * Seam between the saved onboarding profile and the pipeline. Called once per
 * analysis, so implementations must reflect the current profile.
 */
export interface UserContextProvider {
  /** `null` when the user has provided no context (skipped / not started / empty). */
  getUserContext(): UserIntelligenceContext | null;
  getOnboardingStatus(): OnboardingStatus;
}

// ── Prompt input blocks ─────────────────────────────────────────────────────

export interface TaxonomyEntry {
  id: string;
  name: string;
}

/** The only classification ids the model may use. */
export interface AllowedTaxonomy {
  contexts: TaxonomyEntry[];
  areas: TaxonomyEntry[];
  intents: TaxonomyEntry[];
  qualities: TaxonomyEntry[];
}

/** A rule the USER explicitly created (never a seeded/system heuristic). */
export interface UserRuleInput {
  id: string;
  conditions: RuleCondition[];
  classification: {
    contextId: string | null;
    areaId: string | null;
    intentId: string | null;
    qualityId: string | null;
  };
}

/** A persisted AI activity offered to the model for continuity. */
export interface PreviousActivityInput {
  id: string;
  startedAt: string;
  endedAt: string;
  title: string;
  summary: string | null;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
}

export interface FocusContextInput {
  task: string;
  profileName: string;
  startedAt: string;
  /** null while the focus session is still running. */
  endedAt: string | null;
}

/** One piece of raw evidence exactly as the model sees it. */
export interface EvidenceEvent {
  id: number;
  watcher: WatcherName;
  startedAt: string;
  endedAt: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  /**
   * The recorded activity this evidence currently belongs to. Present only on
   * evidence an earlier analysis already assigned (the lookback context, or a
   * forced re-analysis); the model may keep or revise it.
   */
  activityId?: string;
}

/**
 * Evidence plus local traceability. `id` is the first raw event id of the
 * block; `sourceEventIds` lists every raw event the block stands for, so a
 * model reference to `id` always expands back to exact raw events.
 */
export interface EvidenceItem extends EvidenceEvent {
  sourceEventIds: number[];
}

export interface PreprocessResult {
  items: EvidenceItem[];
  /** Raw events in the window that were not sent (empty/noise). */
  droppedEventIds: number[];
}

export interface AnalysisPromptInput {
  /** Start of the evidence shown: the window plus the lookback context before it. */
  evidenceStart: string;
  windowStart: string;
  windowEnd: string;
  /** `null` → the prompt states that no user context was provided. */
  userContext: UserIntelligenceContext | null;
  userRules: UserRuleInput[];
  previousActivities: PreviousActivityInput[];
  focus: FocusContextInput[];
  taxonomy: AllowedTaxonomy;
  events: EvidenceEvent[];
}

// ── Model output ────────────────────────────────────────────────────────────

/** An activity after runtime validation, with evidence expanded to raw ids. */
export interface ValidatedActivity {
  temporaryId: string;
  continuationOfActivityId: string | null;
  startedAt: string;
  endedAt: string;
  title: string;
  summary: string | null;
  /** Raw event ids, chronological, no duplicates. */
  eventIds: number[];
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  confidence: number;
  uncertainty: string[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

export interface IntelligenceActivity {
  id: string;
  startedAt: string;
  endedAt: string;
  title: string;
  summary: string | null;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  confidence: number;
  uncertainty: string[];
  sourceRunId: string;
  userLocked: boolean;
  supersededAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type IntelligenceRunStatus = 'running' | 'succeeded' | 'failed' | 'superseded';

export type IntelligenceErrorCategory =
  | 'missing_api_key'
  | 'network'
  | 'api'
  | 'quota'
  | 'malformed_output'
  | 'validation'
  | 'persistence'
  | 'internal';

export interface IntelligenceRun {
  id: string;
  windowStart: string;
  windowEnd: string;
  status: IntelligenceRunStatus;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  attemptCount: number;
  error: string | null;
  errorCategory: IntelligenceErrorCategory | null;
  outputJson: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Fields the model may set on an activity. */
export interface ActivityInterpretation {
  title: string;
  summary: string | null;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  confidence: number;
  uncertainty: string[];
}

export interface PlannedActivity extends ActivityInterpretation {
  id: string;
  startedAt: string;
  endedAt: string;
  eventIds: number[];
}

export interface PlannedExtension extends ActivityInterpretation {
  activityId: string;
  addEventIds: number[];
}

/**
 * The incremental write a successful run performs. Applied in ONE transaction
 * by the repository; nothing outside the plan is touched.
 */
export interface ReconcilePlan {
  create: PlannedActivity[];
  extend: PlannedExtension[];
  /** Events moving away from an unlocked activity that the new analysis
   * legitimately re-assigned. An activity left with no events is superseded. */
  detach: { activityId: string; eventIds: number[] }[];
  /** Events the model assigned but that stay with the user (locked / edited). */
  userProtectedEventIds: number[];
}

// ── Results ─────────────────────────────────────────────────────────────────

export type AnalysisResult =
  | {
      status: 'succeeded';
      runId: string;
      windowStart: string;
      windowEnd: string;
      attempts: number;
      eventCount: number;
      activitiesCreated: number;
      activitiesExtended: number;
    }
  | {
      status: 'skipped';
      reason: 'already_analyzed' | 'no_events';
      windowStart: string;
      windowEnd: string;
    }
  | {
      status: 'failed';
      category: IntelligenceErrorCategory;
      error: string;
      runId: string | null;
      windowStart: string;
      windowEnd: string;
      attempts: number;
    };

export interface BacklogResult {
  status: 'completed' | 'stopped' | 'unavailable' | 'busy';
  /** Why the cycle stopped early, when it did. */
  reason?: string;
  windowsConsidered: number;
  results: AnalysisResult[];
}
