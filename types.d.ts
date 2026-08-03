type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

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
  createdAt: string;
  updatedAt: string;
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
}

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
  createdAt: string;
  updatedAt: string;
}

interface ActiveFocusSessionDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  liveElapsedMs: number;
  isRunning: boolean;
  remainingMs: number | null;
}

interface StartFocusRequestDto {
  profileId: string;
  task: string;
  notes?: string | null;
  mode?: 'stopwatch' | 'countdown';
  plannedDurationMinutes?: number | null;
}

interface FocusSummaryDto {
  session: FocusSessionDto;
  profile: FocusProfileDto;
  trackedSessionIds: string[];
  interruptionCount: number;
  blockedAttemptCount: number;
  productiveMs: number;
}

interface Window {
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
    listRules: () => Promise<any[]>;
    saveRule: (p: { id: string; activityId: string; conditions: string; enabled: number; priority: number }) => Promise<{ ok: boolean }>;
    deleteRule: (p: { id: string }) => Promise<{ ok: boolean }>;
  };
  settings: {
    exportTimeline: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
    exportActivity: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
    exportSessions: (format: 'csv' | 'json') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
  };
  focusMode: {
    listProfiles: () => Promise<FocusProfileDto[]>;
    saveProfile: (profile: FocusProfileDto, ruleIds: string[]) => Promise<{ ok: boolean }>;
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
    stop: (state: 'completed' | 'cancelled') => Promise<FocusSessionDto | null>;
    onActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => void;
    offActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => void;
    onSummary: (callback: (dto: FocusSummaryDto) => void) => void;
    offSummary: (callback: (dto: FocusSummaryDto) => void) => void;
  };
}