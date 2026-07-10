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
} satisfies Window['timeline']);

electron.contextBridge.exposeInMainWorld('settings', {
  exportTimeline: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:timeline', { format }),
  exportActivity: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:activity', { format }),
  exportSessions: (format: 'csv' | 'json') =>
    electron.ipcRenderer.invoke('export:sessions', { format }),
} satisfies Window['settings']);