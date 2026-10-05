type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

interface ClassificationDto {
  context: { id: string | null; name: string; color: string | null } | null;
  area: { id: string | null; name: string } | null;
  intent: { id: string | null; name: string } | null;
  quality: { id: string | null; name: string } | null;
  source: string;
  reason: string;
  matchedRuleId: string | null;
  matchedConditions: string | null;
  isOverride: boolean;
}

interface DimensionEntryDto {
  id: string;
  dimension: 'area' | 'intent' | 'quality';
  name: string;
  sortOrder: number;
}

interface EventClassificationDto {
  eventId: number;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: string;
  ruleId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Minimal DTO the renderer sees for each stored raw event. Mirrors `Event`
 * but kept separate so the DB layer's types never leak into renderer typings. */
interface TrackerEventDto {
  id: number;
  watcher: string;
  startedAt: string;
  endedAt: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  payload: string | null;
  createdAt: string | null;
}

/** Derived session DTO. Sessions exist only in memory and are re-derived from
 * raw events on each query; the renderer never imports the engine. */
interface SessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
}

/** Verified-session DTO for the timeline. Carries custom-title flag and
 * source so the UI can show generated vs user (offline) sessions identically
 * per spec, with only metadata differing. */
interface VerifiedSessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  activeDuration: number;
  eventCount: number;
  title: string;
  isCustomTitle: boolean;
  primaryApp: string | null;
  primaryBrowser: string | null;
  primaryTitle: string | null;
  primaryUrl: string | null;
  appsUsed: string[];
  browserTabs: string[];
  source: 'generated' | 'user';
  note?: string;
  eventIds: number[];
  activity?: {
    id: string;
    name: string;
    color: string;
  } | null;
  activityRuleId?: string | null;
  classification?: ClassificationDto | null;
  /** Present when the block is an AI-derived activity. */
  ai?: {
    activityId: string;
    title: string;
    summary: string | null;
    confidence: number;
    uncertainty: string[];
    userLocked: boolean;
  } | null;
}

/** Outcome of one intelligence analysis window (manual trigger / scheduler). */
type IntelligenceAnalysisResultDto =
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
  | { status: 'skipped'; reason: 'already_analyzed' | 'no_events'; windowStart: string; windowEnd: string }
  | {
      status: 'failed';
      category: string;
      error: string;
      runId: string | null;
      windowStart: string;
      windowEnd: string;
      attempts: number;
    };

interface IntelligenceBacklogResultDto {
  status: 'completed' | 'stopped' | 'unavailable' | 'busy';
  reason?: string;
  windowsConsidered: number;
  results: IntelligenceAnalysisResultDto[];
}

interface IntelligenceStatusDto {
  configured: boolean;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  /** Sanitized: whether user context is sent, never its contents. */
  hasUserContext: boolean;
  onboardingStatus: 'not_started' | 'in_progress' | 'completed' | 'skipped' | null;
  userRuleCount: number;
  recentRuns: {
    id: string;
    windowStart: string;
    windowEnd: string;
    status: string;
    model: string;
    promptVersion: string;
    schemaVersion: number;
    attemptCount: number;
    error: string | null;
    errorCategory: string | null;
    createdAt?: string;
    updatedAt?: string;
  }[];
}

type RuleSourceDto = 'system' | 'user' | 'learned';

/** A tracking rule as the renderer sees it. One rules table; `source` is provenance. */
interface TrackingRuleDto {
  id: string;
  /** Context id; '' when the rule sets no Context. */
  activityId: string;
  conditions: string;
  enabled: number;
  priority: number;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: RuleSourceDto;
  /** Present on learned rules only. */
  learned?: {
    candidateId: string | null;
    confirmedAt: string | null;
    userModifiedAt: string | null;
    correctionCount: number;
    matchCount: number;
    distinctDayCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  } | null;
}

interface RuleConditionDto {
  type: string;
  value: string;
}

interface ClassificationIdsDto {
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
}

/** A learned-pattern suggestion, fully described by the main process. */
interface LearnedRuleSuggestionDto {
  candidateId: string;
  trigger: 'contextual' | 'daily' | 'list';
  conditions: RuleConditionDto[];
  patternLabel: string;
  classification: ClassificationIdsDto;
  classificationLabel: string;
  evidenceLabel: string;
  occurrenceCount: number;
  distinctDayCount: number;
  correctionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/** A pattern Reflect is considering. Not a rule until the user confirms it. */
interface LearnedRuleCandidateDto {
  id: string;
  patternHash: string;
  classificationHash: string;
  conditions: RuleConditionDto[];
  classification: ClassificationIdsDto;
  occurrenceCount: number;
  distinctDayCount: number;
  correctionCount: number;
  conflictCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastCorrectionAt: string | null;
  lastSuggestedAt: string | null;
  suggestionCount: number;
  status: 'pending' | 'snoozed' | 'confirmed' | 'dismissed';
  snoozedUntil: string | null;
  confirmedRuleId: string | null;
  createdAt: string;
  updatedAt: string;
  patternLabel: string;
  classificationLabel: string;
  consistent: boolean;
  coveredByRule: boolean;
  eligible: boolean;
  blockedBy: string[];
}

interface TimelineStatus {
  activeEdits: number;
}

interface FocusRuleDto {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: boolean;
  /** Human name: "Discord", "Social media", "youtube.com". */
  label: string;
  createdAt: string;
  updatedAt: string;
}

interface FocusBlockingOptionsDto {
  categories: Array<{ id: string; label: string; siteCount: number; appCount: number }>;
  /** Apps with an open window right now, most recently used first. */
  openApps: Array<{ name: string; process: string }>;
  /** Sites visited recently, most recent first. */
  recentSites: string[];
}

interface FocusProfileRuleDto {
  id: string;
  profileId: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  createdAt: string;
  updatedAt: string;
}

interface FocusProfileDto {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  mode: 'stopwatch' | 'countdown';
  defaultDurationMinutes: number | null;
  blocksDistractions: boolean;
  soundCue: string | null;
  createdAt: string;
  updatedAt: string;
  rules: FocusProfileRuleDto[];
  /** Every rule attached to the profile, including currently disabled ones. */
  ruleIds: string[];
  /** What a session started from this profile would actually enforce. */
  blocking: { enabled: boolean; ruleCount: number; siteCount: number; appCount: number };
}

type FocusEndReasonDto = 'completed' | 'finished' | 'ended-early' | 'abandoned';
type FocusBlockingStatusDto = 'active' | 'off' | 'recovering' | 'degraded' | 'unavailable';

interface FocusSessionDto {
  id: string;
  profileId: string;
  task: string;
  notes: string | null;
  mode: 'stopwatch' | 'countdown';
  plannedDurationMinutes: number | null;
  state: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  totalPauseMs: number;
  elapsedMs: number;
  blockingLeaseId: string | null;
  endReason: FocusEndReasonDto | null;
  endNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActiveFocusSessionDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  liveElapsedMs: number;
  isRunning: boolean;
  /** Remaining time; frozen while paused. Null for a stopwatch. */
  remainingMs: number | null;
  plannedEndsAt: string | null;
  pauseKind: 'manual' | 'idle' | null;
  blocking: { status: FocusBlockingStatusDto; ruleCount: number; message: string | null };
}

/** What the service requires before it will end the current session. */
interface EndFocusChallengeDto {
  token: string;
  sessionId: string;
  early: boolean;
  requiresPhrase: boolean;
  phrase: string;
  remainingMs: number | null;
  expiresAt: string;
}

interface FocusPreferencesDto {
  defaultProfileId: string | null;
  idleAutoPause: boolean;
  idleThresholdSeconds: number;
  idleAutoResume: boolean;
  notifyStart: boolean;
  notifyIdle: boolean;
  notifyComplete: boolean;
  notifyBlocked: boolean;
}

type FocusIntentDto = 'open' | 'pause' | 'end';

interface StartFocusRequestDto {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: 'stopwatch' | 'countdown';
  plannedDurationMinutes?: number | null;
  withoutBlocking?: boolean;
}

interface FocusSummaryDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  trackedSessionIds: string[];
  interruptionCount: number;
  blockedAttemptCount: number;
  productiveMs: number;
}

type OnboardingStatusDto = 'not_started' | 'in_progress' | 'completed' | 'skipped';

/** Personal context collected by onboarding. Mirrors `UserProfile` in
 * src/profile/UserProfile.ts. */
interface UserProfileInputDto {
  roles: string[];
  description: string | null;
  currentWork: string[];
  priorities: string[];
  interests: string[];
  additionalContext: string | null;
}

interface UserProfileDto extends UserProfileInputDto {
  onboardingStatus: OnboardingStatusDto;
  createdAt: string | null;
  updatedAt: string | null;
}

// ── Reflection ───────────────────────────────────────────────────────────────

type ReflectionPeriodTypeDto = 'day' | 'week' | 'month' | 'year';
type ReflectionFeedbackDto = 'useful' | 'not_useful' | 'inaccurate';

type ReflectionInsightTypeDto =
  | 'progress'
  | 'priority_alignment'
  | 'time_attention_pattern'
  | 'fragmentation'
  | 'consistency_momentum'
  | 'recurring_behavior'
  | 'change_over_time'
  | 'open_loop'
  | 'unexpected';

interface ReflectionPeriodRequestDto {
  type: ReflectionPeriodTypeDto;
  /** Any ISO instant inside the period; omitted = the current period. */
  anchor?: string | null;
}

interface ReflectionPeriodDto {
  type: ReflectionPeriodTypeDto;
  /** `2026-10-03`, `2026-W40`, `2026-10`, `2026`. */
  key: string;
  start: string;
  end: string;
}

/** One piece of evidence behind an insight, traceable to the Timeline. */
interface ReflectionEvidenceDto {
  kind: 'metric' | 'activity' | 'comparison' | 'priority';
  metricKey?: string;
  activityId?: string;
  priorityId?: string;
  label: string;
  value?: number | string;
  period?: { start: string; end: string };
  /** The raw events behind an activity — what the reference rests on. `activityId` is the block as it was when written. */
  eventIds?: number[];
  thread?: string;
}

/** What it takes to find a piece of evidence on the Timeline again. */
interface ReflectionEvidenceRefDto {
  eventIds?: number[];
  activityId?: string;
  period?: { start: string; end: string };
}

interface ReflectionLinkCorrectionDto {
  evidence: ReflectionEvidenceRefDto;
  /** `null` = not work on any stated priority; omitted = unchanged. */
  priorityId?: string | null;
  /** `null` = no project; omitted = unchanged. */
  thread?: string | null;
}

/** How one activity behind an insight is linked right now. */
interface ReflectionInsightBasisDto {
  evidenceIndex: number;
  title: string;
  start: string;
  end: string;
  thread: string | null;
  priority: { id: string; text: string } | null;
  linkedBy: 'user' | 'model' | 'keyword' | null;
}

type ReflectionContinuityDto = 'new' | 'continuing' | 'strengthening' | 'weakening' | 'resolved' | 'recurred';

/** Something that persisted across periods — or closed. */
interface ReflectionCarryItemDto {
  key: string;
  title: string;
  priorityId: string | null;
  thread: string | null;
  status: 'open' | 'progressing' | 'completed' | 'paused' | 'dropped';
  since: string;
  idleTrackedDays: number;
  timesRaised: number;
  lastWorked: { start: string; end: string } | null;
}

interface ReflectionAvailablePeriodDto {
  period: ReflectionPeriodDto;
  status: 'reported' | 'available' | 'thin' | 'unobserved';
  trackedMinutes: number;
}

interface ReflectionMetricDto {
  key: string;
  label: string;
  display: string;
}

interface ReflectionInsightDto {
  id: string;
  type: ReflectionInsightTypeDto;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  evidence: ReflectionEvidenceDto[];
  feedback: ReflectionFeedbackDto | null;
  /** Whether this is new or was said before — decided by Reflect, not by the model. */
  continuity: ReflectionContinuityDto;
  priority: { id: string; text: string } | null;
  thread: string | null;
}

/** The coaching written with a day's reflection. Its actions are read through `window.coach`. */
interface ReflectionCoachBlockDto {
  actionIds: string[];
  followups: { actionId: string; title: string; note: string; learned: string | null }[];
  uncertainty: string[];
  noActionReason: string | null;
  question: { text: string; actionId: string | null; targetKey: string | null } | null;
}

interface ReflectionReportDto {
  id: string;
  status: 'fresh' | 'stale';
  headline: string;
  /** "What happened", in a few sentences. Days only. */
  narrative: string | null;
  coach: ReflectionCoachBlockDto | null;
  insights: ReflectionInsightDto[];
  carryForward: { text: string; evidence: ReflectionEvidenceDto[] } | null;
  /** Work still unresolved from earlier periods, and what closed. */
  carried: ReflectionCarryItemDto[];
  generatedAt: string | null;
  coveredUntil: string | null;
  isPartial: boolean;
  staleReason: string | null;
  /** Written by an earlier version of Reflect's reasoning. */
  outdated: boolean;
  supportingMetrics: ReflectionMetricDto[];
  notes: string[];
}

interface ReflectionPriorityDto {
  id: string;
  text: string;
  status: 'active' | 'completed' | 'paused' | 'archived';
  activeFrom: string;
  lastConfirmedAt: string;
  possiblyStale: boolean;
}

type ReflectionRefreshBlockedDto =
  | 'not_configured'
  | 'generating'
  | 'future_period'
  | 'up_to_date'
  | 'cooldown'
  | 'insufficient_data';

/** Everything the Reflection page shows for one period. */
interface ReflectionViewDto {
  period: ReflectionPeriodDto & {
    title: string;
    range: string;
    isCurrent: boolean;
    isClosed: boolean;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  /** Whether Gemini is available to write reflections. */
  configured: boolean;
  report: ReflectionReportDto | null;
  generation: {
    state: 'idle' | 'generating' | 'failed' | 'insufficient_data';
    errorCategory: string | null;
    message: string | null;
    at: string | null;
  };
  /** Deterministic numbers for a running period, or one without a report. */
  live: { asOf: string; metrics: ReflectionMetricDto[] } | null;
  sufficiency: { enough: boolean; message: string | null };
  canRefresh: boolean;
  refreshBlockedReason: ReflectionRefreshBlockedDto | null;
  refreshAvailableAt: string | null;
  priorities: ReflectionPriorityDto[];
  /** When today's reflection is written (only for the day that is running). */
  dailyReflectionAt: string | null;
}

// ── Coach ────────────────────────────────────────────────────────────────────

type CoachActionTypeDto =
  | 'continue_behavior'
  | 'focus_session'
  | 'change_timing'
  | 'protect_priority'
  | 'reduce_fragmentation'
  | 'close_open_loop'
  | 'avoid_pattern'
  | 'experiment'
  | 'change_approach'
  | 'rest'
  | 'clarify_priority'
  | 'drop';

type CoachActionStatusDto = 'suggested' | 'snoozed' | 'accepted' | 'review' | 'closed' | 'rejected' | 'withdrawn' | 'expired';
type CoachDecisionDto = 'accept' | 'not_now' | 'reject';
type CoachExecutionDto = 'done' | 'partial' | 'not_done';
type CoachOutcomeDto = 'worked' | 'partly_worked' | 'did_not_work' | 'not_applicable';
type CoachDaypartDto = 'morning' | 'afternoon' | 'evening' | 'night' | 'any';
type CoachReasonCodeDto =
  | 'not_relevant'
  | 'bad_timing'
  | 'too_difficult'
  | 'different_priority'
  | 'already_doing'
  | 'external_constraint'
  | 'not_applicable'
  | 'other';

interface CoachReasonInputDto {
  reasonCode?: CoachReasonCodeDto | null;
  note?: string | null;
}

interface CoachEditDto {
  title?: string;
  description?: string | null;
  focusMinutes?: number | null;
  focusTask?: string | null;
  when?: 'today' | 'tomorrow' | 'this_week';
  daypart?: CoachDaypartDto;
}

/** A recommendation as a tracked entity. Every label is decided in the main process. */
interface CoachActionDto {
  id: string;
  source: 'daily' | 'conversation';
  reportId: string | null;
  title: string;
  description: string | null;
  rationale: string;
  actionType: CoachActionTypeDto;
  status: CoachActionStatusDto;
  /** Did it happen? */
  execution: CoachExecutionDto | null;
  executionSource: 'observed' | 'user' | null;
  /** Did it help? */
  outcome: CoachOutcomeDto | null;
  reasonCode: CoachReasonCodeDto | null;
  note: string | null;
  targetLabel: string | null;
  focusMinutes: number | null;
  focusTask: string | null;
  daypart: CoachDaypartDto;
  evidence: ReflectionEvidenceDto[];
  /** What Reflect's own data showed. */
  observation: { kind: 'executed' | 'attempted' | 'ambiguous' | 'not_observed' | 'unobservable'; facts: string[] } | null;
  /** What the user is being asked about it, if anything. */
  pending: 'decision' | 'execution' | 'outcome' | null;
  statusLine: string;
  canStartFocus: boolean;
  adaptedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CoachMemoryDto {
  id: string;
  kind: 'preference' | 'constraint' | 'decision' | 'priority_note' | 'open_loop' | 'conclusion';
  text: string;
  source: 'user' | 'coach';
  createdAt: string;
}

interface CoachMessageDto {
  id: string;
  role: 'user' | 'coach';
  text: string;
  meta: {
    kind?: 'question' | 'reply' | 'error';
    actions?: { actionId: string; change: string }[];
    memoryIds?: string[];
    correction?: { activityId: string; title: string; start: string; end: string } | null;
    aboutActionId?: string | null;
  } | null;
  createdAt: string;
}

interface CoachSettingsDto {
  /** Minutes after local midnight at which the day's reflection is written. */
  reflectionMinutes: number;
  /** Minutes after local midnight at which the user's day begins. */
  dayStartMinutes: number;
  notifyDailyReflection: boolean;
}

interface CoachStateDto {
  configured: boolean;
  settings: CoachSettingsDto;
  /** Suggestions waiting for a decision. */
  next: CoachActionDto[];
  /** Accepted, or waiting for the user's word on what happened. */
  commitments: CoachActionDto[];
  recent: CoachActionDto[];
  /** The actions of the report that was asked for. */
  reportActions: CoachActionDto[];
  learned: { kind: 'works' | 'does_not_work'; text: string }[];
  memory: CoachMemoryDto[];
  question: { messageId: string; text: string; actionId: string | null } | null;
  messages: CoachMessageDto[];
}

type CoachActionResultDto = { ok: true; action: CoachActionDto; noteDropped?: boolean } | { ok: false; error: string };

type CoachChatResultDto = { ok: true; messages: CoachMessageDto[] } | { ok: false; category: string; message: string };

type ReflectionGenerateResultDto =
  | { status: 'succeeded'; reportId: string; period: ReflectionPeriodDto; attempts: number; insightCount: number }
  | {
      status: 'skipped';
      reason: 'insufficient_data' | 'throttled' | 'up_to_date' | 'future_period' | 'no_data';
      period: ReflectionPeriodDto;
    }
  | { status: 'failed'; category: string; error: string; reportId: string | null; period: ReflectionPeriodDto; attempts: number };

// ── Background runtime ───────────────────────────────────────────────────────

type PauseDurationDto = '15m' | '1h' | 'tomorrow' | 'manual';

/** What the background runtime is doing. Owned by the main process; mirrors `BackgroundStatus`. */
interface BackgroundStatusDto {
  tracking: 'running' | 'paused';
  pausedSince: string | null;
  /** Null while running, and for a pause that waits for the user. */
  pausedUntil: string | null;
  todayTrackedMs: number;
  currentActivity: { label: string; since: string } | null;
  focus: {
    sessionId: string;
    task: string;
    profileName: string;
    isRunning: boolean;
    pauseKind: 'manual' | 'idle' | null;
    remainingMs: number | null;
    elapsedMs: number;
    blocking: FocusBlockingStatusDto;
  } | null;
  widgetVisible: boolean;
  reflectionPending: boolean;
  asOf: string;
}

interface BackgroundSettingsDto {
  startWithWindows: boolean;
  widgetEnabled: boolean;
  notificationsEnabled: boolean;
  /** False in a development build: the login item is never registered there. */
  startupAvailable: boolean;
  /** Registered, but switched off in Windows' own startup settings. */
  startupDisabledBySystem: boolean;
}

type BackgroundSettingsPatchDto = Partial<Pick<BackgroundSettingsDto, 'startWithWindows' | 'widgetEnabled' | 'notificationsEnabled'>>;

/** Where the main window was asked to go from outside (tray, widget, notification). */
type UiNavigationDto =
  | { route: 'settings' }
  | { route: 'focus'; intent: FocusIntentDto }
  | { route: 'reflection'; anchor: string | null };

type WidgetActionDto =
  | { type: 'open-main' }
  | { type: 'open-focus' }
  | { type: 'open-reflection' }
  | { type: 'pause-tracking'; duration: PauseDurationDto }
  | { type: 'resume-tracking' }
  | { type: 'hide' };

interface Window {
  /** The background runtime: tracking on/off, startup, widget, notifications. */
  background: {
    getStatus: () => Promise<BackgroundStatusDto>;
    getSettings: () => Promise<BackgroundSettingsDto>;
    updateSettings: (patch: BackgroundSettingsPatchDto) => Promise<BackgroundSettingsDto>;
    pauseTracking: (duration: PauseDurationDto) => Promise<BackgroundStatusDto>;
    resumeTracking: () => Promise<BackgroundStatusDto>;
    /** A navigation request parked for this window, if any (cleared by reading it). */
    takeNavigation: () => Promise<UiNavigationDto | null>;
    /** Returns the subscription to pass to `offStatus`. */
    onStatus: (callback: (status: BackgroundStatusDto) => void) => number;
    offStatus: (subscription: number) => void;
    /** A navigation request is waiting — call `takeNavigation`. Returns the subscription for `offNavigationRequested`. */
    onNavigationRequested: (callback: () => void) => number;
    offNavigationRequested: (subscription: number) => void;
  };
  /** The floating widget's own bridge. Present only in the widget's page. */
  widget: {
    getStatus: () => Promise<BackgroundStatusDto>;
    onStatus: (callback: (status: BackgroundStatusDto) => void) => void;
    /** Ask for the hover card (true) or the pill (false). */
    setExpanded: (expanded: boolean) => Promise<void>;
    /** The window follows the OS cursor between 'start' and 'end'. */
    drag: (phase: 'start' | 'move' | 'end') => void;
    act: (action: WidgetActionDto) => Promise<void>;
  };
  /** Reflections: persisted, evidence-backed readings of a day / week / month / year. */
  reflection: {
    /** The period's view. Never triggers a Gemini call. */
    getReport: (period: ReflectionPeriodRequestDto) => Promise<ReflectionViewDto>;
    /** With a type: every period of that type since tracking began, and what was observed in it. */
    getAvailablePeriods: (type?: ReflectionPeriodTypeDto | null) => Promise<{ periods: ReflectionPeriodDto[]; hasHistory: boolean; available: ReflectionAvailablePeriodDto[] }>;
    /** Where the evidence is on the Timeline now; `null` when it cannot be placed. */
    resolveEvidence: (evidence: ReflectionEvidenceRefDto) => Promise<{ activityId: string | null; start: string; end: string } | null>;
    getInsightBasis: (reportId: string, insightId: string) => Promise<ReflectionInsightBasisDto[]>;
    correctLink: (correction: ReflectionLinkCorrectionDto) => Promise<{ ok: boolean }>;
    /** Which day to open on: `null` = today, else an instant inside the latest day with a reflection. */
    getLanding: () => Promise<{ anchor: string | null }>;
    /** Manual "Refresh reflection" (throttled in the main process). */
    generate: (period: ReflectionPeriodRequestDto) => Promise<ReflectionGenerateResultDto>;
    /** `null` clears the feedback. */
    submitFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) => Promise<{ ok: boolean }>;
    getPriorities: () => Promise<ReflectionPriorityDto[]>;
    setPriorityStatus: (id: string, status: ReflectionPriorityDto['status']) => Promise<ReflectionPriorityDto[]>;
    onChanged: (callback: () => void) => void;
    offChanged: (callback: () => void) => void;
    /** The end-of-day notification was clicked. */
    onOpenRequested: (callback: () => void) => void;
    offOpenRequested: (callback: () => void) => void;
  };
  /** The Coach: tracked recommendations, their outcomes, memory and conversation. */
  coach: {
    /** Never triggers a Gemini call. `reportId` also returns that report's actions. */
    getState: (reportId?: string | null) => Promise<CoachStateDto>;
    decide: (actionId: string, decision: CoachDecisionDto, reason?: CoachReasonInputDto) => Promise<CoachActionResultDto>;
    edit: (actionId: string, patch: CoachEditDto) => Promise<CoachActionResultDto>;
    /** Whether it happened — not whether it helped. */
    reportExecution: (actionId: string, execution: CoachExecutionDto, reason?: CoachReasonInputDto) => Promise<CoachActionResultDto>;
    /** Whether it helped. */
    reportOutcome: (actionId: string, outcome: CoachOutcomeDto, reason?: CoachReasonInputDto) => Promise<CoachActionResultDto>;
    /** The Focus session now running was started for this action. */
    linkFocus: (actionId: string) => Promise<CoachActionResultDto>;
    chat: (text: string) => Promise<CoachChatResultDto>;
    removeMemory: (id: string) => Promise<{ ok: boolean }>;
    getSettings: () => Promise<CoachSettingsDto>;
    saveSettings: (settings: Partial<CoachSettingsDto>) => Promise<CoachSettingsDto>;
    onChanged: (callback: () => void) => void;
    offChanged: (callback: () => void) => void;
  };
  app: {
    sendFrameAction: (payload: FrameWindowAction) => void;
  };
  tracker: {
    getToday: () => Promise<TrackerEventDto[]>;
    getRange: (from: string, to: string) => Promise<TrackerEventDto[]>;
    getAll: (limit?: number) => Promise<TrackerEventDto[]>;
  };
  session: {
    getToday: () => Promise<SessionDto[]>;
    getRange: (from: string, to: string) => Promise<SessionDto[]>;
    getAll: (limit?: number) => Promise<SessionDto[]>;
  };
  timeline: {
    getToday: () => Promise<VerifiedSessionDto[]>;
    getRange: (from: string, to: string) => Promise<VerifiedSessionDto[]>;
    getAll: (limit?: number) => Promise<VerifiedSessionDto[]>;
    apply: (p: { operation: string; payload: unknown }) => Promise<{ ok: boolean }>;
    undo: () => Promise<{ ok: boolean }>;
    redo: () => Promise<{ ok: boolean }>;
    status: () => Promise<TimelineStatus>;
    listActivities: () => Promise<any[]>;
    saveActivity: (p: { id: string; name: string; color: string }) => Promise<{ ok: boolean }>;
    deleteActivity: (p: { id: string }) => Promise<{ ok: boolean }>;
    listRules: () => Promise<TrackingRuleDto[]>;
    saveRule: (p: { id: string; activityId: string; conditions: string; enabled: number; priority: number; areaId?: string | null; intentId?: string | null; qualityId?: string | null }) => Promise<{ ok: boolean }>;
    deleteRule: (p: { id: string }) => Promise<{ ok: boolean }>;
  };
  /** Manual prototype/testing path for the Gemini intelligence layer. */
  intelligence: {
    /** Analyze the last `minutes` (default 60). */
    analyzeRecent: (p?: { minutes?: number; force?: boolean }) => Promise<IntelligenceAnalysisResultDto>;
    analyzeWindow: (p: { from: string; to: string; force?: boolean }) => Promise<IntelligenceAnalysisResultDto>;
    processBacklog: () => Promise<IntelligenceBacklogResultDto>;
    status: () => Promise<IntelligenceStatusDto>;
  };
  /** Learned patterns: candidates, suggestions and the user's decisions. */
  learnedRules: {
    listCandidates: () => Promise<LearnedRuleCandidateDto[]>;
    getCandidate: (candidateId: string) => Promise<LearnedRuleCandidateDto | null>;
    /** Every currently eligible candidate (does not mark anything as shown). */
    listSuggestions: () => Promise<LearnedRuleSuggestionDto[]>;
    /** The one suggestion to surface now, or null. Marks it as shown. */
    nextSuggestion: () => Promise<LearnedRuleSuggestionDto | null>;
    /** "Remember" → creates a tracking rule with source 'learned'. */
    confirmCandidate: (candidateId: string) => Promise<{ ok: boolean; ruleId: string; created: boolean }>;
    /** "Not now". */
    snoozeCandidate: (candidateId: string) => Promise<{ ok: boolean }>;
    /** "Never suggest this". */
    dismissCandidate: (candidateId: string) => Promise<{ ok: boolean }>;
    reactivateCandidate: (candidateId: string) => Promise<{ ok: boolean }>;
  };
  settings: {
    exportTimeline: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
    exportActivity: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
    exportSessions: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
  };
  userProfile: {
    get: () => Promise<UserProfileDto>;
    getOnboardingStatus: () => Promise<OnboardingStatusDto>;
    save: (profile: UserProfileInputDto, status?: OnboardingStatusDto) => Promise<UserProfileDto>;
    update: (patch: Partial<UserProfileInputDto> & { onboardingStatus?: OnboardingStatusDto }) => Promise<UserProfileDto>;
  };
  focusMode: {
    listProfiles: () => Promise<FocusProfileDto[]>;
    /** `ruleIds: null` keeps the profile's current rules. */
    saveProfile: (profile: FocusProfileDto, ruleIds: string[] | null) => Promise<{ ok: boolean }>;
    deleteProfile: (id: string) => Promise<{ ok: boolean }>;
    listRules: () => Promise<FocusRuleDto[]>;
    saveRule: (rule: FocusRuleDto) => Promise<{ ok: boolean }>;
    deleteRule: (id: string) => Promise<{ ok: boolean }>;
    getActiveSession: () => Promise<ActiveFocusSessionDto | null>;
    getSessionsByRange: (from: string, to: string) => Promise<FocusSessionDto[]>;
    getSessionsForDay: (isoDate: string) => Promise<FocusSessionDto[]>;
    getHistory: (limit?: number) => Promise<FocusSessionDto[]>;
    getSessionSummary: (sessionId: string) => Promise<FocusSummaryDto | null>;
    start: (request: StartFocusRequestDto) => Promise<ActiveFocusSessionDto>;
    pause: (reason?: string | null) => Promise<ActiveFocusSessionDto | null>;
    resume: () => Promise<ActiveFocusSessionDto | null>;
    getBlockingOptions: () => Promise<FocusBlockingOptionsDto>;
    /** Normalizes, reuses an existing block, and turns it on for the preset. */
    addBlock: (block: { profileId?: string | null; type: FocusRuleDto['type']; target: string; action?: FocusRuleDto['action'] }) => Promise<{ ruleId: string; created: boolean }>;
    setProfileBlock: (profileId: string, ruleId: string, on: boolean) => Promise<{ ok: boolean }>;
    /** Ask to end the session; nothing ends until `confirmEnd`. */
    requestEnd: () => Promise<EndFocusChallengeDto | null>;
    confirmEnd: (request: { token: string; phrase?: string | null; reason?: string | null }) => Promise<FocusSessionDto>;
    restoreBlocking: () => Promise<ActiveFocusSessionDto | null>;
    getPreferences: () => Promise<FocusPreferencesDto>;
    savePreferences: (preferences: FocusPreferencesDto) => Promise<FocusPreferencesDto>;
    getBlockingResidue: () => Promise<boolean>;
    /** Resolves to whether leftover blocking is still present afterwards. */
    clearBlockingResidue: () => Promise<boolean>;
    onIntent: (callback: (intent: FocusIntentDto) => void) => void;
    offIntent: (callback: (intent: FocusIntentDto) => void) => void;
    onActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => void;
    offActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => void;
    onSummary: (callback: (dto: FocusSummaryDto) => void) => void;
    offSummary: (callback: (dto: FocusSummaryDto) => void) => void;
  };
  categorization: {
    getDimensions: () => Promise<{ areas: DimensionEntryDto[]; intents: DimensionEntryDto[]; qualities: DimensionEntryDto[] }>;
    getContexts: () => Promise<{ id: string; name: string; color: string }[]>;
    listOverrides: () => Promise<any[]>;
    deleteOverride: (p: { id: string }) => Promise<{ ok: boolean }>;
    saveOverride: (p: {
      eventIds: number[];
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
      remember: boolean;
      sessionHint?: {
        primaryApp?: string;
        primaryUrl?: string;
        primaryTitle?: string;
      };
    }) => Promise<{ ok: boolean; overrideId: string; ruleId: string | null }>;
    getEventClassification: (p: { eventId: number }) => Promise<EventClassificationDto | null>;
    getEventClassifications: (p: { eventIds: number[] }) => Promise<EventClassificationDto[]>;
    getResolvedEventClassifications: (p: { eventIds: number[] }) => Promise<EventClassificationDto[]>;
    saveEventClassification: (p: {
      eventId: number;
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
      source?: string;
      ruleId?: string | null;
    }) => Promise<{ ok: boolean }>;
    deleteEventClassification: (p: { eventId: number }) => Promise<{ ok: boolean }>;
    rememberEventAsRule: (p: {
      eventId: number;
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
      app?: string | null;
      title?: string | null;
      url?: string | null;
    }) => Promise<{ ok: boolean; ruleId: string; activityId: string }>;
  };
}