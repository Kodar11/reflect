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