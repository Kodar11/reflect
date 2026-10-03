/**
 * Reflection layer — domain types and configuration.
 *
 *   TRACKING tells me what happened.
 *   TIMELINE tells me what I did.
 *   CLASSIFICATION tells me what the activity represented.
 *   REFLECTION tells me what that means.
 *
 * Reflection is a derived overlay on the verified timeline. It never writes to
 * events, sessions, AI activities or classifications.
 *
 * Layers (all under `src/reflection/`):
 *   PURE (no SQLite / Electron / network / Date.now / Math.random):
 *     - ReflectionModels.ts      this file — types + config
 *     - ReflectionPeriods.ts     local-time period boundaries
 *     - ReflectionPriorities.ts  priority normalization + keyword matching
 *     - ReflectionActivities.ts  verified timeline → compact activities
 *     - ReflectionMetrics.ts     deterministic measurements + comparisons
 *     - ReflectionPreprocessor.ts dataset → model input
 *     - ReflectionPrompt.ts      prompt + response schema
 *     - ReflectionValidator.ts   runtime validation of model output
 *   IMPURE:
 *     - ReflectionMetricsService.ts loads activities, computes datasets
 *     - ReflectionAnnotator.ts   thread / priority linking (Gemini, cached)
 *     - ReflectionService.ts     the generation pipeline + read model
 *     - ReflectionScheduler.ts   which closed periods to generate, and when
 *     - ReflectionHistory.ts     structured queries for the future Coach
 *     - reflectionIpc.ts         renderer bridge
 */

/** Version of the dataset handed to the model. Bump when its shape changes. */
export const REFLECTION_INPUT_SCHEMA_VERSION = 1;
/** Version of the structured output contract. Bump when its shape changes. */
export const REFLECTION_OUTPUT_SCHEMA_VERSION = 1;

// ── Periods ─────────────────────────────────────────────────────────────────

export type ReflectionPeriodType = 'day' | 'week' | 'month' | 'year';

export const REFLECTION_PERIOD_TYPES: readonly ReflectionPeriodType[] = ['day', 'week', 'month', 'year'];

/**
 * One reflection period. `start`/`end` are ISO instants of the LOCAL calendar
 * boundaries (`end` exclusive); `key` is the local label and the period's
 * identity: `2026-10-03`, `2026-W40`, `2026-10`, `2026`.
 */
export interface ReflectionPeriod {
  type: ReflectionPeriodType;
  key: string;
  start: string;
  end: string;
}

// ── Insight taxonomy ────────────────────────────────────────────────────────

export type ReflectionInsightType =
  | 'progress'
  | 'priority_alignment'
  | 'time_attention_pattern'
  | 'fragmentation'
  | 'consistency_momentum'
  | 'recurring_behavior'
  | 'change_over_time'
  | 'open_loop'
  | 'unexpected';

export const REFLECTION_INSIGHT_TYPES: readonly ReflectionInsightType[] = [
  'progress',
  'priority_alignment',
  'time_attention_pattern',
  'fragmentation',
  'consistency_momentum',
  'recurring_behavior',
  'change_over_time',
  'open_loop',
  'unexpected',
];

/** Types describing a standing pattern. Repeating one needs new evidence. */
export const PATTERN_INSIGHT_TYPES: readonly ReflectionInsightType[] = [
  'time_attention_pattern',
  'fragmentation',
  'consistency_momentum',
  'recurring_behavior',
  'unexpected',
];

// ── Configuration ───────────────────────────────────────────────────────────

export interface ReflectionConfig {
  /** Local time at which the day's reflection is written. */
  dailyReflectionHour: number;
  dailyReflectionMinute: number;
  /** Upper bound per period. Fewer is always fine; zero is valid. */
  maxInsights: Record<ReflectionPeriodType, number>;
  /** Personal baseline: how many earlier periods to look at, and how many of
   * them must hold enough data before a baseline is stated at all. */
  baseline: Record<ReflectionPeriodType, { lookback: number; minPeriods: number }>;
  /** Below this a period is not reflected on. */
  sufficiency: Record<ReflectionPeriodType, { minTrackedMinutes: number; minActiveDays: number }>;
  /** How many closed periods the scheduler looks back for missing reports. */
  backlog: Record<ReflectionPeriodType, number>;
  /** A day's evening report is rewritten once after midnight when at least
   * this much activity happened after it was generated. */
  finalizeMinNewMinutes: number;
  manualRefreshCooldownMs: number;
  failedRetryCooldownMs: number;
  /** A report whose output keeps being rejected is not retried forever. */
  maxRejectedAttemptsPerPeriod: number;
  /** A priority not reconfirmed for this long is flagged as possibly stale. */
  priorityStaleAfterDays: number;
  /** Staleness tolerance: a time bucket must move by more than both. */
  staleMinMinutes: number;
  staleMinRatio: number;
  /** Activities sent to the model, per period type. */
  maxPromptActivities: Record<ReflectionPeriodType, number>;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  dailyReflectionHour: 22,
  dailyReflectionMinute: 0,
  maxInsights: { day: 4, week: 5, month: 6, year: 8 },
  baseline: {
    day: { lookback: 14, minPeriods: 5 },
    week: { lookback: 6, minPeriods: 3 },
    month: { lookback: 6, minPeriods: 3 },
    year: { lookback: 2, minPeriods: 1 },
  },
  sufficiency: {
    day: { minTrackedMinutes: 30, minActiveDays: 1 },
    week: { minTrackedMinutes: 120, minActiveDays: 2 },
    month: { minTrackedMinutes: 480, minActiveDays: 5 },
    year: { minTrackedMinutes: 1800, minActiveDays: 20 },
  },
  backlog: { day: 3, week: 2, month: 2, year: 1 },
  finalizeMinNewMinutes: 15,
  manualRefreshCooldownMs: 15 * 60_000,
  failedRetryCooldownMs: 60_000,
  maxRejectedAttemptsPerPeriod: 3,
  priorityStaleAfterDays: 60,
  staleMinMinutes: 10,
  staleMinRatio: 0.1,
  maxPromptActivities: { day: 60, week: 60, month: 45, year: 45 },
};

// ── Measurement thresholds (shared by metrics + tests) ──────────────────────

/** Quality ids that count as "focused" time. Seeded by the v6 migration. */
export const FOCUSED_QUALITY_IDS: readonly string[] = ['quality_deep_work', 'quality_focused'];
/** Shorter blocks are noise for behaviour metrics (they still count as time). */
export const MIN_BEHAVIOR_ACTIVITY_MINUTES = 1;
/** An activity long enough to be called an activity in a reflection. */
export const MEANINGFUL_ACTIVITY_MINUTES = 5;
export const SHORT_ACTIVITY_MINUTES = 10;
export const SUSTAINED_ACTIVITY_MINUTES = 25;
/** Two activities further apart than this are not a "switch" — it is a break. */
export const SWITCH_MAX_GAP_MINUTES = 15;
/** Same work continuing across a gap this small is one uninterrupted block. */
export const BLOCK_MAX_GAP_MINUTES = 5;
export const ACTIVE_DAY_MIN_MINUTES = 10;
/** A stretch needs at least this many switches to be called fragmented. */
export const FRAGMENTED_MIN_SWITCHES = 4;
export const MAX_THREAD_METRICS = 6;
export const MAX_CONTEXT_METRICS = 6;
export const MAX_APP_METRICS = 5;

// ── Activities ──────────────────────────────────────────────────────────────

export type ReflectionActivitySource = 'ai' | 'deterministic' | 'user_override';

/**
 * A timeline block as Reflection sees it: derived meaning only, never raw
 * event payloads. `thread` and `priorityId` are Reflection's own overlay.
 */
export interface ReflectionActivity {
  /** Timeline block id (AI activity id, or deterministic session id). */
  id: string;
  startedAt: string;
  endedAt: string;
  /** Tracked (active) minutes inside the loaded range. */
  durationMinutes: number;
  title: string;
  summary: string | null;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: ReflectionActivitySource;
  app: string | null;
  domain: string | null;
  /** The project / theme this activity belongs to, when known. */
  thread: string | null;
  /** The stated priority this activity served, when linked. */
  priorityId: string | null;
}

// ── Priorities ──────────────────────────────────────────────────────────────

export type ReflectionPriorityStatus = 'active' | 'completed' | 'paused' | 'archived';

export const REFLECTION_PRIORITY_STATUSES: readonly ReflectionPriorityStatus[] = [
  'active',
  'completed',
  'paused',
  'archived',
];

/**
 * A priority the user stated, with the interval during which it applied.
 * Free-form onboarding text stays the source; this is the normalized,
 * time-aware view Reflection compares behaviour against.
 */
export interface ReflectionPriority {
  id: string;
  text: string;
  normalizedKey: string;
  status: ReflectionPriorityStatus;
  activeFrom: string;
  /** null while active. */
  activeUntil: string | null;
  /** Last time the user saved their profile with this priority present. */
  lastConfirmedAt: string;
}

/** Thread / priority decision cached per activity signature. */
export interface ActivityAnnotation {
  signature: string;
  thread: string | null;
  priorityId: string | null;
  /** Priorities this signature was evaluated against. */
  checkedPriorityIds: string[];
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export type MetricUnit = 'minutes' | 'count' | 'percent' | 'per_hour' | 'clock' | 'text';

export type MetricGroup =
  | 'time'
  | 'behavior'
  | 'attention'
  | 'thread'
  | 'priority'
  | 'focus'
  | 'continuity'
  | 'series'
  | 'comparison';

/**
 * One deterministic measurement. The model cites metrics by `key`; the
 * backend resolves the key back to this record, so every claim is traceable.
 */
export interface Metric {
  key: string;
  label: string;
  value: number | string;
  unit: MetricUnit;
  /** The value as it should be quoted, e.g. `2h 13m`, `31%`, `14`. */
  display: string;
  group: MetricGroup;
  /** Timeline window this measurement points at. */
  range?: { start: string; end: string };
  /** Supporting activities (capped). */
  activityIds?: string[];
  priorityId?: string;
  thread?: string;
}

export type MetricSet = Record<string, Metric>;

export interface TaxonomyNames {
  contexts: Record<string, string>;
  areas: Record<string, string>;
  intents: Record<string, string>;
  qualities: Record<string, string>;
}

/** What Reflection needs to know about one Focus session. */
export interface FocusSessionFacts {
  id: string;
  task: string;
  startedAt: string;
  endedAt: string;
  elapsedMinutes: number;
  interruptionCount: number;
  blockedAttemptCount: number;
}

export interface SufficiencyAssessment {
  enough: boolean;
  reason: 'no_activity' | 'too_little_activity' | null;
  message: string | null;
}

/** Everything deterministic about one period. */
export interface PeriodDataset {
  period: ReflectionPeriod;
  /** Data is included up to here (`period.end` once the period has closed). */
  coveredUntil: string;
  isPartial: boolean;
  activities: ReflectionActivity[];
  priorities: ReflectionPriority[];
  /** Core metrics plus comparisons, by key. */
  metrics: MetricSet;
  sufficiency: SufficiencyAssessment;
  /** Plain statements about what could not be computed (missing history…). */
  notes: string[];
  hasPreviousComparison: boolean;
  baselinePeriodCount: number;
}

// ── Evidence + insights ─────────────────────────────────────────────────────

export type ReflectionEvidenceKind = 'metric' | 'activity' | 'comparison' | 'priority';

/** Resolved, self-contained evidence stored with an insight. */
export interface ReflectionEvidence {
  kind: ReflectionEvidenceKind;
  metricKey?: string;
  activityId?: string;
  priorityId?: string;
  label: string;
  value?: number | string;
  /** Where to look on the Timeline. */
  period?: { start: string; end: string };
}

export interface ReflectionInsight {
  id: string;
  type: ReflectionInsightType;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  suggestedAction: string | null;
  confidence: number;
  evidence: ReflectionEvidence[];
  sourceActivityIds: string[];
  sourceMetricKeys: string[];
  /** Normalized claim identity, used to avoid repeating an insight. */
  claimSignature: string;
  createdAt: string;
}

export interface ReflectionCarryForward {
  text: string;
  sourceMetricKeys: string[];
  sourceActivityIds: string[];
  evidence: ReflectionEvidence[];
}

export type ReflectionFeedbackType = 'useful' | 'not_useful' | 'inaccurate';

export const REFLECTION_FEEDBACK_TYPES: readonly ReflectionFeedbackType[] = ['useful', 'not_useful', 'inaccurate'];

// ── Reports ─────────────────────────────────────────────────────────────────

export type ReflectionReportStatus =
  | 'generating'
  | 'fresh'
  | 'stale'
  | 'failed'
  | 'superseded'
  | 'insufficient_data';

export type ReflectionTrigger = 'scheduled' | 'manual';

export type ReflectionErrorCategory =
  | 'missing_api_key'
  | 'network'
  | 'api'
  | 'quota'
  | 'malformed_output'
  | 'validation'
  | 'persistence'
  | 'internal';

/** Compact, payload-free record of what a report was generated from. */
export interface ReflectionDataSnapshot {
  period: ReflectionPeriod;
  coveredUntil: string;
  isPartial: boolean;
  priorities: { id: string; text: string; activeFrom: string; possiblyStale: boolean }[];
  /** Priorities that were active at the moment of generation. */
  activePriorityIds: string[];
  activities: {
    id: string;
    startedAt: string;
    endedAt: string;
    minutes: number;
    title: string;
    thread: string | null;
    priorityId: string | null;
  }[];
  notes: string[];
  userContextIncluded: boolean;
  previousReportId: string | null;
}

export interface ReflectionReport {
  id: string;
  period: ReflectionPeriod;
  coveredUntil: string | null;
  status: ReflectionReportStatus;
  trigger: ReflectionTrigger;
  headline: string | null;
  carryForward: ReflectionCarryForward | null;
  insights: (ReflectionInsight & { feedback: ReflectionFeedbackType | null })[];
  inputSchemaVersion: number;
  outputSchemaVersion: number;
  promptVersion: string;
  model: string;
  attemptCount: number;
  dataSnapshot: ReflectionDataSnapshot | null;
  metricsSnapshot: MetricSet | null;
  error: string | null;
  errorCategory: ReflectionErrorCategory | null;
  staleReason: string | null;
  staleAt: string | null;
  /** Underlying data changed since this report was last checked. */
  needsVerification: boolean;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Model input ─────────────────────────────────────────────────────────────

/** An activity exactly as the model sees it. `ref` is a short local alias. */
export interface PromptActivity {
  ref: string;
  start: string;
  end: string;
  minutes: number;
  title: string;
  summary: string | null;
  context: string | null;
  area: string | null;
  intent: string | null;
  quality: string | null;
  thread: string | null;
  priorityId: string | null;
  source: ReflectionActivitySource;
}

export interface PromptPriority {
  id: string;
  text: string;
  statedOn: string;
  possiblyStale: boolean;
}

export interface PromptMetric {
  key: string;
  label: string;
  value: string;
}

/**
 * One comparable measurement with its reference values. The model cites the
 * part it uses as `prev.<key>`, `delta.<key>` or `baseline.<key>`.
 */
export interface PromptComparison {
  key: string;
  label: string;
  now: string;
  previous?: string;
  change?: string;
  baseline?: string;
}

export interface PreviousReflectionInput {
  periodLabel: string;
  headline: string;
  carryForward: string | null;
  insights: { type: ReflectionInsightType; title: string; observation: string }[];
}

/** The compact dataset handed to the model. No raw events, no payloads. */
export interface ReflectionInput {
  schemaVersion: number;
  period: {
    type: ReflectionPeriodType;
    start: string;
    end: string;
    label: string;
    isPartial: boolean;
    coveredUntil: string;
  };
  userContext: {
    roles: string[];
    description: string | null;
    currentWork: string[];
    priorities: string[];
    interests: string[];
    additionalContext: string | null;
  } | null;
  currentPriorities: PromptPriority[];
  activities: PromptActivity[];
  metrics: PromptMetric[];
  comparisons: PromptComparison[];
  notes: string[];
  learnedPatterns: string[];
  previousReflection: PreviousReflectionInput | null;
  /** Claims already surfaced recently, with how often. */
  previouslySurfaced: { type: ReflectionInsightType; title: string; signature: string; timesSurfaced: number }[];
  /** e.g. "recurring_behavior: 3 useful, 0 not useful". */
  feedbackHistory: string[];
  maxInsights: number;
}

// ── Results ─────────────────────────────────────────────────────────────────

export type GenerateResult =
  | { status: 'succeeded'; reportId: string; period: ReflectionPeriod; attempts: number; insightCount: number }
  | {
      status: 'skipped';
      reason: 'insufficient_data' | 'throttled' | 'up_to_date' | 'future_period' | 'no_data';
      period: ReflectionPeriod;
    }
  | {
      status: 'failed';
      category: ReflectionErrorCategory;
      error: string;
      reportId: string | null;
      period: ReflectionPeriod;
      attempts: number;
    };

export interface ReflectionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
