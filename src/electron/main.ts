// Belt-and-suspenders for the elevation flow: UAC doesn't reliably forward
// env vars, so the relaunched admin instance won't have NODE_ENV set even
// though it was launched from a dev session. We pass --dev as an argv flag
// from elevation.ts; mirror that into NODE_ENV here so any third-party code
// that reads process.env.NODE_ENV (rather than our isDev()) also sees dev.
// Done before any other imports so it lands before module init code runs.
if (process.argv.includes('--dev') && process.env.NODE_ENV !== 'development') {
  process.env.NODE_ENV = 'development';
}

import { app, BrowserWindow } from 'electron';
import { isDev } from './util.js';
import { getPreloadPath, getUIPath } from './pathResolver.js';
import { Logger } from '../service/logger.js';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(logger: Logger) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f5',
    title: 'Productivity Coach',
  });

  if (isDev()) {
    mainWindow.loadURL('http://localhost:5123');
  } else {
    mainWindow.loadFile(getUIPath());
  }

  logger.info('[APP] Window ready.');
  return mainWindow;
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const logger = new Logger({ dir: userData, source: 'app' });
  logger.info('[APP] Starting Productivity Coach starter.');
  createMainWindow(logger);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const logger = new Logger({ dir: app.getPath('userData'), source: 'app' });
    createMainWindow(logger);
  }
});
