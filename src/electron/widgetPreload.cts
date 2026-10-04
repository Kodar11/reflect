const electron = require('electron');

// The floating widget's entire bridge to the main process. It can read the
// background status, ask for its own window to expand / move, and request one
// of a fixed set of actions. It gets no database, timeline or Focus access —
// the main process refuses every other channel from the widget's page.
const statusListeners = new Set<(status: BackgroundStatusDto) => void>();
let statusSubscribed = false;

electron.contextBridge.exposeInMainWorld('widget', {
  getStatus: (): Promise<BackgroundStatusDto> => electron.ipcRenderer.invoke('widget:getStatus'),
  onStatus: (callback: (status: BackgroundStatusDto) => void) => {
    if (!statusSubscribed) {
      statusSubscribed = true;
      electron.ipcRenderer.on('widget:status', (_event: unknown, status: BackgroundStatusDto) =>
        statusListeners.forEach((cb) => cb(status)),
      );
    }
    statusListeners.add(callback);
  },
  setExpanded: (expanded: boolean): Promise<void> => electron.ipcRenderer.invoke('widget:setExpanded', expanded),
  drag: (phase: 'start' | 'move' | 'end') => {
    electron.ipcRenderer.send('widget:drag', phase);
  },
  act: (action: WidgetActionDto): Promise<void> => electron.ipcRenderer.invoke('widget:act', action),
} satisfies Window['widget']);
