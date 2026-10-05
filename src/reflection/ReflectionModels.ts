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
 *     - ReflectionLedger.ts      per-day structured facts + period aggregates
 *     - ReflectionLongitudinal.ts change across periods, trajectories, carried work
 *     - ReflectionIdentity.ts    what an insight is about + whether it is new
 *     - ReflectionPreprocessor.ts dataset → model input
 *     - ReflectionPrompt.ts      prompt + response schema
 *     - ReflectionValidator.ts   runtime validation of model output
 *   IMPURE:
 *     - ReflectionMetricsService.ts loads activities, computes datasets
 *     - ReflectionAnnotator.ts   thread / priority linking (Gemini, cached)
 *     - ReflectionService.ts     the generation pipeline + read model
 *     - ReflectionScheduler.ts   which closed periods to generate, and when
 *     - ReflectionHistory.ts     structured history: insights, trends, carried work
 *     - reflectionIpc.ts         renderer bridge
 */

/** Version of the dataset handed to the model. Bump when its shape changes. */
export const REFLECTION_INPUT_SCHEMA_VERSION = 3;
/** Version of the structured output contract. Bump when its shape changes. */
export const REFLECTION_OUTPUT_SCHEMA_VERSION = 3;

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
  /** Local time at which the day's reflection is written, unless the user set their own. */
  dailyReflectionHour: number;
  dailyReflectionMinute: number;
  /** The day's reflection may be written this long before that time… */
  earlyReflectionWindowMinutes: number;
  /** …once nothing has been tracked for this long (the day has wound down). */
  windDownInactivityMinutes: number;
  /** Earlier days whose numbers a day's reflection can cite. */
  recentDays: number;
  /** Upper bound per period. Fewer is always fine; zero is valid. */
  maxInsights: Record<ReflectionPeriodType, number>;
  /** Personal baseline: how many earlier periods to look at, and how many of
   * them must hold enough data before a baseline is stated at all. */
  baseline: Record<ReflectionPeriodType, { lookback: number; minPeriods: number }>;
  /** Below this a period is not reflected on. */
  sufficiency: Record<ReflectionPeriodType, { minTrackedMinutes: number; minActiveDays: number }>;
  /** How many closed periods the scheduler looks back for missing reports. */
  backlog: Record<ReflectionPeriodType, number>;
  /** Reports written per scheduling cycle at most — a long absence is caught up over several cycles. */
  maxScheduledPerCycle: number;
  /** A running week / month / year gets a "so far" report, rewritten once it is this many days old. 0 = never. */
  runningRefreshDays: Record<Exclude<ReflectionPeriodType, 'day'>, number>;
  /** A stale report inside the backlog window is rewritten by the scheduler, at most this often. */
  staleRegenerateCooldownMs: number;
  /** Same-weekday baseline of a day: how many earlier same weekdays, and how many must hold data. */
  weekdayBaseline: { lookback: number; minPeriods: number };
  /** Days of history a work trajectory looks at, per period type. */
  trajectoryDays: Record<ReflectionPeriodType, number>;
  /** Work untouched for this many TRACKED days (while other work happened) has stalled. */
  stalledAfterTrackedDays: number;
  /** Earlier reports (same period type) an insight's identity is compared with. */
  identityLookback: Record<ReflectionPeriodType, number>;
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
  earlyReflectionWindowMinutes: 120,
  windDownInactivityMinutes: 40,
  recentDays: 7,
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
  backlog: { day: 7, week: 8, month: 12, year: 3 },
  maxScheduledPerCycle: 6,
  runningRefreshDays: { week: 3, month: 10, year: 30 },
  staleRegenerateCooldownMs: 6 * 3_600_000,
  weekdayBaseline: { lookback: 6, minPeriods: 3 },
  trajectoryDays: { day: 10, week: 28, month: 62, year: 366 },
  stalledAfterTrackedDays: 2,
  identityLookback: { day: 7, week: 6, month: 6, year: 3 },
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
  /** A note the user wrote on this block in the Timeline. */
  note?: string | null;
  /**
   * The raw events this block is made of (capped sample, first and last
   * always included). Block ids are derived and change when grouping changes;
   * event ids never do — this is what evidence is anchored to.
   */
  eventIds?: number[];
  /** How the priority link was decided: the user's correction, the model, or the keyword fallback. */
  priorityLinkSource?: 'user' | 'model' | 'keyword' | null;
}

/** At most this many event ids are kept per activity / evidence item. */
export const MAX_EVIDENCE_EVENT_IDS = 40;

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
  /**
   * Every stretch during which the priority actually applied, oldest first.
   * A pause or a completion ends a stretch; reactivating starts a new one —
   * the gap in between is history, not something to be papered over. Absent
   * on rows that predate the event log: then [activeFrom, activeUntil) is it.
   */
  intervals?: { from: string; until: string | null }[];
  /** What happened to it, oldest first. */
  history?: PriorityEvent[];
}

export type PriorityEventType = 'stated' | 'paused' | 'completed' | 'reactivated' | 'renamed' | 'archived';

export interface PriorityEvent {
  priorityId: string;
  at: string;
  type: PriorityEventType;
  /** The wording after this event. */
  text: string;
  /** The wording before a rename. */
  previousText: string | null;
}

/** Thread / priority decision cached per activity signature. */
export interface ActivityAnnotation {
  signature: string;
  thread: string | null;
  priorityId: string | null;
  /** Priorities this signature was evaluated against. */
  checkedPriorityIds: string[];
  /** 'user' = corrected by the user; the model never overwrites it. */
  source?: 'model' | 'user';
}

// ── Day ledger (structured history) ─────────────────────────────────────────

export type DayFactKind = 'measure' | 'thread' | 'priority' | 'area' | 'intent' | 'quality' | 'context' | 'daypart' | 'signature';

/**
 * One fact about one closed local day. The ledger is a cache of derived
 * data — always recomputable from the verified timeline — that lets months
 * and years be reasoned about without re-deriving every day from raw events.
 */
export interface DayFactRow {
  dayKey: string;
  dayStart: string;
  dayEnd: string;
  kind: DayFactKind;
  key: string;
  label: string | null;
  /** Minutes; for kind 'measure' the measure's value. */
  minutes: number;
  sessions: number;
  /** For a thread: the priority most of its time that day was linked to. */
  priorityId: string | null;
}

export interface DayFacts {
  key: string;
  start: string;
  end: string;
  rows: DayFactRow[];
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export type MetricUnit = 'minutes' | 'count' | 'percent' | 'per_hour' | 'clock' | 'text';

export type MetricGroup =
  | 'history'
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
  /** What the user committed to; null for a stopwatch session. */
  plannedMinutes?: number | null;
  /** How it ended: completed, finished, ended-early, abandoned; null while running. */
  endReason?: string | null;
  /** The user's own words: why they stopped early, or their session notes. */
  note?: string | null;
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
  /** How each tracked body of work moved across the recent days. */
  trajectories?: WorkTrajectory[];
  /** Work that is still unresolved from earlier periods (and what closed). */
  carried?: CarryItem[];
  /** What meaningfully appeared, disappeared or shifted versus history. */
  changes?: EntityChange[];
  /** The period's natural sub-periods, summarized (week → days, month → weeks, year → months). */
  subPeriods?: SubPeriodSummary[];
  /** What happened to stated priorities in or shortly before the period. */
  priorityEvents?: PriorityEvent[];
  /** Fingerprint of everything the dataset was computed from. */
  basis?: ReflectionBasis;
}

// ── Longitudinal structure ──────────────────────────────────────────────────

export type TrajectoryStatus = 'new' | 'ongoing' | 'resumed' | 'stalled' | 'completed' | 'paused' | 'dropped';

/** One body of work (a stated priority, or a thread outside any priority) across tracked days. */
export interface WorkTrajectory {
  /** `p:<priorityId>` or `t:<threadSlug>` — backend-owned. */
  key: string;
  kind: 'priority' | 'thread';
  priorityId: string | null;
  thread: string | null;
  label: string;
  status: TrajectoryStatus;
  firstDay: string;
  lastDay: string;
  /** Tracked days with work on it / tracked days since it first appeared. */
  activeDays: number;
  trackedDays: number;
  /** Tracked days since it was last worked on (0 = worked on the latest tracked day). */
  idleTrackedDays: number;
  minutes: number;
  /** Day by day since it first appeared; unobserved days are left out. */
  days: { key: string; start: string; end: string; minutes: number }[];
}

export type CarryStatus = 'open' | 'progressing' | 'completed' | 'paused' | 'dropped';

/**
 * Something that persisted across periods. Derived from the trajectory and
 * from what earlier reports raised — never a stored task of its own.
 */
export interface CarryItem {
  key: string;
  title: string;
  priorityId: string | null;
  thread: string | null;
  status: CarryStatus;
  /** Local day it first became unresolved (last worked, or first raised). */
  since: string;
  /** Consecutive tracked days without work on it. */
  idleTrackedDays: number;
  /** Earlier reports (same period type) that raised it. */
  timesRaised: number;
  lastWorked: { start: string; end: string } | null;
}

export type EntityChangeKind = 'vanished' | 'appeared' | 'returned' | 'decreased' | 'increased';

/** A change versus history that passed the deterministic "is this meaningful?" test. */
export interface EntityChange {
  entity: 'thread' | 'priority' | 'area' | 'intent';
  key: string;
  label: string;
  change: EntityChangeKind;
  nowMinutes: number;
  previousMinutes: number;
  /** Earlier comparable periods it was present in / that held enough data. */
  presentIn: number;
  outOf: number;
  /** Why a disappearance is not a concern: the user completed, paused or dropped it. */
  explained: 'completed' | 'paused' | 'dropped' | null;
  priorityId: string | null;
  thread: string | null;
}

export interface SubPeriodSummary {
  key: string;
  label: string;
  start: string;
  end: string;
  /** null = nothing was observed in it (missing, not zero). */
  trackedMinutes: number | null;
  focusedMinutes: number | null;
  activeDays: number;
  top: { label: string; minutes: number }[];
  /** Headline of that sub-period's own reflection, when one exists. */
  headline: string | null;
}

/**
 * What a report depended on beyond its own period's measurements (those are
 * compared through the metric snapshot, with tolerance). A report is stale
 * when one of these moved.
 */
export interface ReflectionBasis {
  /** The priorities that applied during the period: ids, wording, state. */
  priorities: string;
  /** Carried work and how each item stood. */
  carried: string;
  /** Tracked minutes of the previous period — the reference it was compared with (null: none). */
  previousTrackedMinutes: number | null;
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
  /** Raw events behind an activity — the stable reference. `activityId` is the block id AS OF generation. */
  eventIds?: number[];
  thread?: string;
}

/** Whether a claim is new, and how it relates to what was said before. Backend-computed. */
export type InsightContinuity = 'new' | 'continuing' | 'strengthening' | 'weakening' | 'resolved' | 'recurred';

export const INSIGHT_CONTINUITY_STATES: readonly InsightContinuity[] = ['new', 'continuing', 'strengthening', 'weakening', 'resolved', 'recurred'];

export interface ReflectionInsight {
  id: string;
  type: ReflectionInsightType;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  confidence: number;
  evidence: ReflectionEvidence[];
  sourceActivityIds: string[];
  sourceMetricKeys: string[];
  /** Legacy identity (type + measures). Kept for reports written before identities existed. */
  claimSignature: string;
  /** What the claim is about + which way it points: `<subject>|<pattern>`. */
  identityKey: string;
  /** `p:<priorityId>`, `t:<threadSlug>`, or null when it is about the period as a whole. */
  subjectKey: string | null;
  thread: string | null;
  priorityId: string | null;
  continuity: InsightContinuity;
  /** The subject's size when this was said (minutes, or idle days) — what "stronger" is measured against. */
  magnitude: number | null;
  createdAt: string;
}

export interface ReflectionCarryForward {
  text: string;
  subjectKey?: string | null;
  sourceMetricKeys: string[];
  sourceActivityIds: string[];
  evidence: ReflectionEvidence[];
}

/**
 * The coaching half of a day's intelligence, as stored with the report. The
 * recommendations themselves are first-class `coach_actions` rows; this block
 * holds what the Coach said about earlier ones and what it is unsure of.
 */
export interface ReportCoachBlock {
  /** Recommendations this report created (canonical action ids). */
  actionIds: string[];
  /** What happened to earlier commitments, and what was learned. */
  followups: { actionId: string; title: string; note: string; learned: string | null }[];
  /** Where the evidence was too thin to say more. */
  uncertainty: string[];
  /** Why nothing was recommended, when nothing was. */
  noActionReason: string | null;
  /** A question the Coach needs answered before advising further. */
  question: { text: string; actionId: string | null; targetKey: string | null } | null;
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
    eventIds?: number[];
  }[];
  notes: string[];
  userContextIncluded: boolean;
  previousReportId: string | null;
  /** Carried work as it stood when the report was written. */
  carried?: CarryItem[];
  trajectories?: Pick<WorkTrajectory, 'key' | 'label' | 'status' | 'idleTrackedDays' | 'activeDays' | 'trackedDays'>[];
  changes?: EntityChange[];
  basis?: ReflectionBasis;
}

export interface ReflectionReport {
  id: string;
  period: ReflectionPeriod;
  coveredUntil: string | null;
  status: ReflectionReportStatus;
  trigger: ReflectionTrigger;
  headline: string | null;
  /** "What happened", in a few sentences. Days only. */
  narrative: string | null;
  carryForward: ReflectionCarryForward | null;
  /** Present on a day's report written together with the Coach. */
  coach: ReportCoachBlock | null;
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
  note?: string;
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
  /** Average over earlier same weekdays; cited as `weekday.<key>`. */
  sameWeekday?: string;
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
  /** What meaningfully appeared, disappeared or shifted versus history (`change.*`). */
  changes: PromptMetric[];
  /** How each body of work moved across the tracked days (`trajectory.*`). */
  trajectories: PromptMetric[];
  /** Work still open from earlier periods, what closed, and what was observed at all (`carry.*`, `coverage.*`). */
  carried: PromptMetric[];
  notes: string[];
  learnedPatterns: string[];
  /** Rules the user wrote themselves — the strongest classification knowledge. */
  explicitRules: string[];
  /** The latest reflection of the next larger period (a day sees its week). */
  longerTerm: { periodLabel: string; headline: string; insights: string[] } | null;
  previousReflection: PreviousReflectionInput | null;
  /** Claims already surfaced recently, with how often. */
  previouslySurfaced: { type: ReflectionInsightType; title: string; signature: string; timesSurfaced: number }[];
  /** Claims the user marked "not accurate" or "not useful". */
  disputed: { title: string; about: string | null; verdict: 'inaccurate' | 'not_useful' }[];
  /** Sub-periods of a week / month / year, in order. */
  subPeriods: { label: string; tracked: string; focused: string | null; activeDays: number; main: string[]; reflection: string | null }[];
  /** What happened to stated priorities (paused, completed, renamed, dropped…). */
  priorityHistory: string[];
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
