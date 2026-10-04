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
}

interface ReflectionReportDto {
  id: string;
  status: 'fresh' | 'stale';
  headline: string;
  insights: ReflectionInsightDto[];
  carryForward: { text: string; evidence: ReflectionEvidenceDto[] } | null;
  generatedAt: string | null;
  coveredUntil: string | null;
  isPartial: boolean;
  staleReason: string | null;
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
}

type ReflectionGenerateResultDto =
  | { status: 'succeeded'; reportId: string; period: ReflectionPeriodDto; attempts: number; insightCount: number }
  | {
      status: 'skipped';
      reason: 'insufficient_data' | 'throttled' | 'up_to_date' | 'future_period' | 'no_data';
      period: ReflectionPeriodDto;
    }
  | { status: 'failed'; category: string; error: string; reportId: string | null; period: ReflectionPeriodDto; attempts: number };

interface Window {
  /** Reflections: persisted, evidence-backed readings of a day / week / month / year. */
  reflection: {
    /** The period's view. Never triggers a Gemini call. */
    getReport: (period: ReflectionPeriodRequestDto) => Promise<ReflectionViewDto>;
    getAvailablePeriods: () => Promise<{ periods: ReflectionPeriodDto[]; hasHistory: boolean }>;
    /** Manual "Refresh reflection" (throttled in the main process). */
    generate: (period: ReflectionPeriodRequestDto) => Promise<ReflectionGenerateResultDto>;
    /** `null` clears the feedback. */
    submitFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) => Promise<{ ok: boolean }>;
    getPriorities: () => Promise<ReflectionPriorityDto[]>;
    setPriorityStatus: (id: string, status: ReflectionPriorityDto['status']) => Promise<ReflectionPriorityDto[]>;
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