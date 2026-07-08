const electron = require('electron');

electron.contextBridge.exposeInMainWorld('app', {
  sendFrameAction: (payload: FrameWindowAction) => {
    electron.ipcRenderer.send('sendFrameAction', payload);
  },
} satisfies Window['app']);

// Tracker IPC surface (read-only queries for the dev event viewer).
// All methods return a Promise of plain DTOs from the EventRepository — the
// renderer never sees DB handles, SQL, or watcher internals.
electron.contextBridge.exposeInMainWorld('tracker', {
  getToday: (): Promise<TrackerEventDto[]> => electron.ipcRenderer.invoke('tracker:getToday'),
  getRange: (from: string, to: string): Promise<TrackerEventDto[]> =>
    electron.ipcRenderer.invoke('tracker:getRange', { from, to }),
  getAll: (limit?: number): Promise<TrackerEventDto[]> =>
    electron.ipcRenderer.invoke('tracker:getAll', { limit }),
} satisfies Window['tracker']);