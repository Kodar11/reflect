const electron = require('electron');

electron.contextBridge.exposeInMainWorld('app', {
  sendFrameAction: (payload: FrameWindowAction) => {
    electron.ipcRenderer.send('sendFrameAction', payload);
  },
} satisfies Window['app']);

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
  saveProfile: (profile: FocusProfileDto, ruleIds: string[]) => electron.ipcRenderer.invoke('focus:saveProfile', { profile, ruleIds }),
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
  stop: (state: 'completed' | 'cancelled') => electron.ipcRenderer.invoke('focus:stop', { state }),
  onActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => { registerFocusListener('focus:activeSessionChanged', callback); },
  offActiveSessionChanged: (callback: (dto: ActiveFocusSessionDto | null) => void) => { focusListeners.get('focus:activeSessionChanged')?.delete(callback); },
  onSummary: (callback: (dto: FocusSummaryDto) => void) => { registerFocusListener('focus:summary', callback); },
  offSummary: (callback: (dto: FocusSummaryDto) => void) => { focusListeners.get('focus:summary')?.delete(callback); },
} satisfies Window['focusMode']);