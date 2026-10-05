const electron = require('electron');

electron.contextBridge.exposeInMainWorld('app', {
  sendFrameAction: (payload: FrameWindowAction) => {
    electron.ipcRenderer.send('sendFrameAction', payload);
  },
} satisfies Window['app']);

// Background runtime IPC surface. The main process owns tracking, the widget,
// the startup setting and notifications; the renderer shows their state and
// asks for changes. Nothing here keeps anything running.
//
// Subscriptions are identified by a number, not by the callback: a function
// that crosses the context bridge arrives as a new proxy each time, so the
// callback handed to "off" would never match the one handed to "on".
let nextSubscription = 1;
const backgroundStatusListeners = new Map<number, (status: BackgroundStatusDto) => void>();
let backgroundStatusSubscribed = false;
const navigationListeners = new Map<number, () => void>();
let navigationSubscribed = false;

electron.contextBridge.exposeInMainWorld('background', {
  getStatus: (): Promise<BackgroundStatusDto> => electron.ipcRenderer.invoke('background:getStatus'),
  getSettings: (): Promise<BackgroundSettingsDto> => electron.ipcRenderer.invoke('background:getSettings'),
  updateSettings: (patch: BackgroundSettingsPatchDto): Promise<BackgroundSettingsDto> =>
    electron.ipcRenderer.invoke('background:updateSettings', patch),
  pauseTracking: (duration: PauseDurationDto): Promise<BackgroundStatusDto> =>
    electron.ipcRenderer.invoke('background:pauseTracking', { duration }),
  resumeTracking: (): Promise<BackgroundStatusDto> => electron.ipcRenderer.invoke('background:resumeTracking'),
  takeNavigation: (): Promise<UiNavigationDto | null> => electron.ipcRenderer.invoke('background:takeNavigation'),
  onStatus: (callback: (status: BackgroundStatusDto) => void) => {
    if (!backgroundStatusSubscribed) {
      backgroundStatusSubscribed = true;
      electron.ipcRenderer.on('background:status', (_event: unknown, status: BackgroundStatusDto) =>
        backgroundStatusListeners.forEach((cb) => cb(status)),
      );
    }
    const subscription = nextSubscription++;
    backgroundStatusListeners.set(subscription, callback);
    return subscription;
  },
  offStatus: (subscription: number) => {
    backgroundStatusListeners.delete(subscription);
  },
  onNavigationRequested: (callback: () => void) => {
    if (!navigationSubscribed) {
      navigationSubscribed = true;
      electron.ipcRenderer.on('background:navigate', () => navigationListeners.forEach((cb) => cb()));
    }
    const subscription = nextSubscription++;
    navigationListeners.set(subscription, callback);
    return subscription;
  },
  offNavigationRequested: (subscription: number) => {
    navigationListeners.delete(subscription);
  },
} satisfies Window['background']);

// Tracker IPC surface (read-only queries for the raw event viewer).
electron.contextBridge.exposeInMainWorld('tracker', {
  getToday: (): Promise<TrackerEventDto[]> => electron.ipcRenderer.invoke('tracker:getToday'),
  getRange: (from: string, to: string): Promise<TrackerEventDto[]> =>
    electron.ipcRenderer.invoke('tracker:getRange', { from, to }),
  getAll: (limit?: number): Promise<TrackerEventDto[]> =>
    electron.ipcRenderer.invoke('tracker:getAll', { limit }),
} satisfies Window['tracker']);

// Session IPC surface (derived sessions — in-memory, never persisted).
// The renderer sees only DTOs; the engine / repository stay in main.
electron.contextBridge.exposeInMainWorld('session', {
  getToday: (): Promise<SessionDto[]> => electron.ipcRenderer.invoke('session:getToday'),
  getRange: (from: string, to: string): Promise<SessionDto[]> =>
    electron.ipcRenderer.invoke('session:getRange', { from, to }),
  getAll: (limit?: number): Promise<SessionDto[]> =>
    electron.ipcRenderer.invoke('session:getAll', { limit }),
} satisfies Window['session']);

// Timeline IPC surface (Stage 3). Read paths return verified DTOs; mutation
// paths append an edit and return; renderer never imports the timeline engine.
electron.contextBridge.exposeInMainWorld('timeline', {
  getToday: (): Promise<any[]> => electron.ipcRenderer.invoke('timeline:getToday'),
  getRange: (from: string, to: string): Promise<any[]> =>
    electron.ipcRenderer.invoke('timeline:getRange', { from, to }),
  getAll: (limit?: number): Promise<any[]> =>
    electron.ipcRenderer.invoke('timeline:getAll', { limit }),
  apply: (p: { operation: string; payload: unknown }) =>
    electron.ipcRenderer.invoke('timeline:apply', p),
  undo: (): Promise<{ ok: boolean }> => electron.ipcRenderer.invoke('timeline:undo'),
  redo: (): Promise<{ ok: boolean }> => electron.ipcRenderer.invoke('timeline:redo'),
  status: (): Promise<{ activeEdits: number }> =>
    electron.ipcRenderer.invoke('timeline:status'),
  listActivities: () => electron.ipcRenderer.invoke('activities:list'),
  saveActivity: (p) => electron.ipcRenderer.invoke('activities:save', p),
  deleteActivity: (p) => electron.ipcRenderer.invoke('activities:delete', p),
  listRules: () => electron.ipcRenderer.invoke('rules:list'),
  saveRule: (p) => electron.ipcRenderer.invoke('rules:save', p),
  deleteRule: (p) => electron.ipcRenderer.invoke('rules:delete', p),
} satisfies Window['timeline']);

// Categorization IPC surface.
electron.contextBridge.exposeInMainWorld('categorization', {
  getDimensions: () => electron.ipcRenderer.invoke('categorization:getDimensions'),
  getContexts: () => electron.ipcRenderer.invoke('categorization:getContexts'),
  listOverrides: () => electron.ipcRenderer.invoke('categorization:listOverrides'),
  deleteOverride: (p) => electron.ipcRenderer.invoke('categorization:deleteOverride', p),
  saveOverride: (p) => electron.ipcRenderer.invoke('categorization:saveOverride', p),
  getEventClassification: (p) => electron.ipcRenderer.invoke('categorization:getEventClassification', p),
  getEventClassifications: (p) => electron.ipcRenderer.invoke('categorization:getEventClassifications', p),
  getResolvedEventClassifications: (p) => electron.ipcRenderer.invoke('categorization:getResolvedEventClassifications', p),
  saveEventClassification: (p) => electron.ipcRenderer.invoke('categorization:saveEventClassification', p),
  deleteEventClassification: (p) => electron.ipcRenderer.invoke('categorization:deleteEventClassification', p),
  rememberEventAsRule: (p) => electron.ipcRenderer.invoke('categorization:rememberEventAsRule', p),
} satisfies Window['categorization']);

// Intelligence IPC surface — manual prototype/testing trigger only, e.g. from
// DevTools: `await window.intelligence.analyzeRecent()`. No API key or prompt
// content ever crosses this bridge.
electron.contextBridge.exposeInMainWorld('intelligence', {
  analyzeRecent: (p) => electron.ipcRenderer.invoke('intelligence:analyzeRecent', p),
  analyzeWindow: (p) => electron.ipcRenderer.invoke('intelligence:analyzeWindow', p),
  processBacklog: () => electron.ipcRenderer.invoke('intelligence:processBacklog'),
  status: () => electron.ipcRenderer.invoke('intelligence:status'),
} satisfies Window['intelligence']);

// Learned patterns IPC surface. The main process decides what is eligible;
// the renderer only shows a suggestion and reports the user's answer.
electron.contextBridge.exposeInMainWorld('learnedRules', {
  listCandidates: () => electron.ipcRenderer.invoke('learnedRules:listCandidates'),
  getCandidate: (candidateId: string) => electron.ipcRenderer.invoke('learnedRules:getCandidate', { candidateId }),
  listSuggestions: () => electron.ipcRenderer.invoke('learnedRules:listSuggestions'),
  nextSuggestion: () => electron.ipcRenderer.invoke('learnedRules:nextSuggestion'),
  confirmCandidate: (candidateId: string) => electron.ipcRenderer.invoke('learnedRules:confirmCandidate', { candidateId }),
  snoozeCandidate: (candidateId: string) => electron.ipcRenderer.invoke('learnedRules:snoozeCandidate', { candidateId }),
  dismissCandidate: (candidateId: string) => electron.ipcRenderer.invoke('learnedRules:dismissCandidate', { candidateId }),
  reactivateCandidate: (candidateId: string) => electron.ipcRenderer.invoke('learnedRules:reactivateCandidate', { candidateId }),
} satisfies Window['learnedRules']);

// Reflection IPC surface. The main process owns reflection state; the
// renderer reads a period's view, may request a refresh and reports feedback.
const reflectionListeners = new Set<() => void>();
let reflectionSubscribed = false;
const reflectionOpenListeners = new Set<() => void>();
let reflectionOpenSubscribed = false;

electron.contextBridge.exposeInMainWorld('reflection', {
  getReport: (period: ReflectionPeriodRequestDto) => electron.ipcRenderer.invoke('reflection:getReport', period),
  getAvailablePeriods: (type?: ReflectionPeriodTypeDto | null) => electron.ipcRenderer.invoke('reflection:getAvailablePeriods', { type: type ?? null }),
  resolveEvidence: (evidence: ReflectionEvidenceRefDto) => electron.ipcRenderer.invoke('reflection:resolveEvidence', evidence),
  getInsightBasis: (reportId: string, insightId: string) => electron.ipcRenderer.invoke('reflection:getInsightBasis', { reportId, insightId }),
  correctLink: (correction: ReflectionLinkCorrectionDto) => electron.ipcRenderer.invoke('reflection:correctLink', correction),
  getLanding: () => electron.ipcRenderer.invoke('reflection:getLanding'),
  generate: (period: ReflectionPeriodRequestDto) => electron.ipcRenderer.invoke('reflection:generate', period),
  submitFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) =>
    electron.ipcRenderer.invoke('reflection:submitFeedback', { insightId, feedback }),
  getPriorities: () => electron.ipcRenderer.invoke('reflection:getPriorities'),
  setPriorityStatus: (id: string, status: ReflectionPriorityDto['status']) =>
    electron.ipcRenderer.invoke('reflection:setPriorityStatus', { id, status }),
  onChanged: (callback: () => void) => {
    if (!reflectionSubscribed) {
      reflectionSubscribed = true;
      electron.ipcRenderer.on('reflection:changed', () => reflectionListeners.forEach((cb) => cb()));
    }
    reflectionListeners.add(callback);
  },
  offChanged: (callback: () => void) => {
    reflectionListeners.delete(callback);
  },
  onOpenRequested: (callback: () => void) => {
    if (!reflectionOpenSubscribed) {
      reflectionOpenSubscribed = true;
      electron.ipcRenderer.on('reflection:open', () => reflectionOpenListeners.forEach((cb) => cb()));
    }
    reflectionOpenListeners.add(callback);
  },
  offOpenRequested: (callback: () => void) => {
    reflectionOpenListeners.delete(callback);
  },
} satisfies Window['reflection']);

// Coach IPC surface. The main process owns every action, memory and message;
// the renderer shows them and reports what the user chose.
const coachListeners = new Set<() => void>();
let coachSubscribed = false;

electron.contextBridge.exposeInMainWorld('coach', {
  getState: (reportId?: string | null) => electron.ipcRenderer.invoke('coach:getState', { reportId: reportId ?? null }),
  decide: (actionId: string, decision: CoachDecisionDto, reason?: CoachReasonInputDto) =>
    electron.ipcRenderer.invoke('coach:decide', { actionId, decision, ...reason }),
  edit: (actionId: string, patch: CoachEditDto) => electron.ipcRenderer.invoke('coach:edit', { actionId, patch }),
  reportExecution: (actionId: string, execution: CoachExecutionDto, reason?: CoachReasonInputDto) =>
    electron.ipcRenderer.invoke('coach:reportExecution', { actionId, execution, ...reason }),
  reportOutcome: (actionId: string, outcome: CoachOutcomeDto, reason?: CoachReasonInputDto) =>
    electron.ipcRenderer.invoke('coach:reportOutcome', { actionId, outcome, ...reason }),
  linkFocus: (actionId: string) => electron.ipcRenderer.invoke('coach:linkFocus', { actionId }),
  chat: (text: string) => electron.ipcRenderer.invoke('coach:chat', { text }),
  removeMemory: (id: string) => electron.ipcRenderer.invoke('coach:removeMemory', { id }),
  getSettings: () => electron.ipcRenderer.invoke('coach:getSettings'),
  saveSettings: (settings: Partial<CoachSettingsDto>) => electron.ipcRenderer.invoke('coach:saveSettings', settings),
  onChanged: (callback: () => void) => {
    if (!coachSubscribed) {
      coachSubscribed = true;
      electron.ipcRenderer.on('coach:changed', () => coachListeners.forEach((cb) => cb()));
    }
    coachListeners.add(callback);
  },
  offChanged: (callback: () => void) => {
    coachListeners.delete(callback);
  },
} satisfies Window['coach']);

electron.contextBridge.exposeInMainWorld('settings', {
  exportTimeline: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:timeline', { format }),
  exportActivity: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:activity', { format }),
  exportSessions: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:sessions', { format }),
} satisfies Window['settings']);

// User profile IPC surface (personal context collected by onboarding).
electron.contextBridge.exposeInMainWorld('userProfile', {
  get: () => electron.ipcRenderer.invoke('userProfile:get'),
  getOnboardingStatus: () => electron.ipcRenderer.invoke('userProfile:getOnboardingStatus'),
  save: (profile: UserProfileInputDto, status?: OnboardingStatusDto) =>
    electron.ipcRenderer.invoke('userProfile:save', { profile, status }),
  update: (patch: Partial<UserProfileInputDto> & { onboardingStatus?: OnboardingStatusDto }) =>
    electron.ipcRenderer.invoke('userProfile:update', { patch }),
} satisfies Window['userProfile']);

const focusListeners = new Map<string, Set<(event: any) => void>>();

function registerFocusListener(channel: string, callback: (event: any) => void): () => void {
  if (!focusListeners.has(channel)) {
    focusListeners.set(channel, new Set());
    electron.ipcRenderer.on(channel, (_event, payload) => {
      focusListeners.get(channel)?.forEach((cb) => cb(payload));
    });
  }
  focusListeners.get(channel)?.add(callback);
  return () => {
    focusListeners.get(channel)?.delete(callback);
  };
}

electron.contextBridge.exposeInMainWorld('focusMode', {
  listProfiles: () => electron.ipcRenderer.invoke('focus:listProfiles'),
  saveProfile: (profile: FocusProfileDto, ruleIds: string[] | null) => electron.ipcRenderer.invoke('focus:saveProfile', { profile, ruleIds }),
  deleteProfile: (id: string) => electron.ipcRenderer.invoke('focus:deleteProfile', { id }),
  listRules: () => electron.ipcRenderer.invoke('focus:listRules'),
  saveRule: (rule: FocusRuleDto) => electron.ipcRenderer.invoke('focus:saveRule', rule),
  deleteRule: (id: string) => electron.ipcRenderer.invoke('focus:deleteRule', { id }),
  getActiveSession: () => electron.ipcRenderer.invoke('focus:getActiveSession'),
  getSessionsByRange: (from: string, to: string) => electron.ipcRenderer.invoke('focus:getSessionsByRange', { from, to }),
  getSessionsForDay: (isoDate: string) => electron.ipcRenderer.invoke('focus:getSessionsForDay', { isoDate }),
  getHistory: (limit?: number) => electron.ipcRenderer.invoke('focus:getHistory', { limit }),
  getSessionSummary: (sessionId: string) => electron.ipcRenderer.invoke('focus:getSessionSummary', { sessionId }),
  start: (request: StartFocusRequestDto) => electron.ipcRenderer.invoke('focus:start', request),
  pause: (reason?: string | null) => electron.ipcRenderer.invoke('focus:pause', { reason }),
  resume: () => electron.ipcRenderer.invoke('focus:resume'),
  getBlockingOptions: () => electron.ipcRenderer.invoke('focus:getBlockingOptions'),
  addBlock: (block: { profileId?: string | null; type: FocusRuleDto['type']; target: string; action?: FocusRuleDto['action'] }) =>
    electron.ipcRenderer.invoke('focus:addBlock', block),
  setProfileBlock: (profileId: string, ruleId: string, on: boolean) =>
    electron.ipcRenderer.invoke('focus:setProfileBlock', { profileId, ruleId, on }),
  requestEnd: () => electron.ipcRenderer.invoke('focus:requestEnd'),
  confirmEnd: (request: { token: string; phrase?: string | null; reason?: string | null }) =>
    electron.ipcRenderer.invoke('focus:confirmEnd', request),
  restoreBlocking: () => electron.ipcRenderer.invoke('focus:restoreBlocking'),
  getPreferences: () => electron.ipcRenderer.invoke('focus:getPreferences'),
  savePreferences: (preferences: FocusPreferencesDto) => electron.ipcRenderer.invoke('focus:savePreferences', preferences),
  getBlockingResidue: () => electron.ipcRenderer.invoke('focus:getBlockingResidue'),
  clearBlockingResidue: () => electron.ipcRenderer.invoke('focus:clearBlockingResidue'),
  onIntent: (callback: (intent: FocusIntentDto) => void) => { registerFocusListener('focus:intent', callback); },
  offIntent: (callback: (intent: FocusIntentDto) => void) => { focusListeners.get('focus:intent')?.delete(callback); },
  onActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => { registerFocusListener('focus:activeSessionChanged', callback); },
  offActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => { focusListeners.get('focus:activeSessionChanged')?.delete(callback); },
  onSummary: (callback: (dto: FocusSummaryDto) => void) => { registerFocusListener('focus:summary', callback); },
  offSummary: (callback: (dto: FocusSummaryDto) => void) => { focusListeners.get('focus:summary')?.delete(callback); },
} satisfies Window['focusMode']);