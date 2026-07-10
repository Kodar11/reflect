// Belt-and-suspenders for the elevation flow: UAC doesn't reliably forward
// env vars, so the relaunched admin instance won't have NODE_ENV set even
// though it was launched from a dev session. We pass --dev as an argv flag
// from elevation.ts; mirror that into NODE_ENV here so any third-party code
// that reads process.env.NODE_ENV (rather than our isDev()) also sees dev.
// Done before any other imports so it lands before module init code runs.
if (process.argv.includes('--dev') && process.env.NODE_ENV !== 'development') {
  process.env.NODE_ENV = 'development';
}

import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import activeWin from 'active-win';
import { isDev, ipcMainHandle, ipcMainOn } from './util.js';
import { getPreloadPath, getUIPath } from './pathResolver.js';
import { Logger } from '../service/logger.js';
import { Database } from '../database/Database.js';
import { EventRepository } from '../database/EventRepository.js';
import { HeartbeatEngine } from '../tracker/HeartbeatEngine.js';
import { WindowWatcher } from '../tracker/watcher/WindowWatcher.js';
import { TrackingService } from '../tracker/TrackingService.js';
import { registerTrackerIpc } from '../tracker/trackerIpc.js';
import { SessionService } from '../session/SessionService.js';
import { registerSessionIpc } from '../session/sessionIpc.js';
import { EditRepository } from '../database/EditRepository.js';
import { TimelineService } from '../timeline/TimelineService.js';
import { registerTimelineIpc } from '../timeline/timelineIpc.js';
import { ExportService } from '../service/ExportService.js';
import { registerExportIpc } from './exportIpc.js';
import { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import type { ActivitySample } from '../models/Event.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let database: Database | null = null;
let trackingService: TrackingService | null = null;
let quitting = false;

function createMainWindow(logger: Logger): BrowserWindow {
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

/**
 * Bridges `active-win` (which returns platform-native fields) to our
 * watcher-consumable `ActivitySample`. Kept here rather than in the watcher so
 * the watcher stays fully unit-testable with no `activeWin` import surface.
 */
async function pollActiveWin(): Promise<ActivitySample | null> {
  const w = await activeWin();
  if (!w) return null;
  return {
    watcher: 'window',
    app: w.owner?.name ?? undefined,
    title: w.title || undefined,
    payload: {
      bundleId: w.owner?.processId,
      platform: w.platform,
      id: w.id,
    },
  };
}

function createTray(logger: Logger): Tray {
  // 16x16 transparent-ish icon; real icon swapped in later. nativeImage.fromBuffer
  // needs bytes — a 1x1 PNG is the cheapest viable placeholder.
  const icon = nativeImage.createFromBuffer(Buffer.from(BASE64_TRAY_ICON, 'base64'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Productivity Coach');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp(logger) },
  ]));
  tray.on('click', () => mainWindow?.show());
  return tray;
}

async function quitApp(logger: Logger) {
  logger.info('[APP] Quit requested — flushing tracker.');
  try {
    await trackingService?.stop();
  } catch (e) {
    logger.error(`[APP] tracking stop error: ${(e as Error)?.message ?? e}`);
  }
  try {
    database?.close();
  } catch (e) {
    logger.error(`[APP] db close error: ${(e as Error)?.message ?? e}`);
  }
  tray?.destroy();
  app.quit();
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const logger = new Logger({ dir: userData, source: 'app' });
  logger.info('[APP] Starting Productivity Coach — Stage 1 tracker.');

  // --- Construct the tracking stack via DI ---
  database = new Database(Database.filePathFor(userData));
  const repo = new EventRepository(database);
  const engine = new HeartbeatEngine(repo);

  const windowWatcher = new WindowWatcher(pollActiveWin, engine, 1000, {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  });

  trackingService = new TrackingService([windowWatcher], engine, {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  });

  registerTrackerIpc(repo, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );

  // --- Construct the session layer (read-side transform over raw events) ---
  // Sessions are derived on demand from the same raw repo; never persisted.
  const sessionService = new SessionService(repo);
  registerSessionIpc(sessionService, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
  logger.info('[APP] Session service ready.');

  // --- Construct the timeline layer (Stage 3) ---
  // User edits overlay the generated sessions; the timeline is rederived on
  // demand. Edit log lives in timeline_edits (append-only + undone_at).
  const editRepo = new EditRepository(database, (msg) => logger.warn(msg));
  const activityRuleRepo = new ActivityRuleRepository(database);
  const timelineService = new TimelineService(sessionService, editRepo, activityRuleRepo);
  registerTimelineIpc(timelineService, activityRuleRepo, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
  logger.info('[APP] Timeline service ready.');

  // --- Construct the export layer (Stage 3.8) ---
  const exportService = new ExportService(timelineService, repo, sessionService);
  registerExportIpc(exportService, ipcMainHandle);
  logger.info('[APP] Export service ready.');

  createMainWindow(logger);
  createTray(logger);

  // Window frame controls (minimize / maximize / close-to-tray).
  ipcMainOn('sendFrameAction', (action) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return;
    switch (action) {
      case 'MINIMIZE':
        win.minimize();
        break;
      case 'MAXIMIZE':
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case 'CLOSE':
        win.hide();
        break;
    }
  });

  // Tracker starts automatically with the app, independent of the window.
  // Closing the window hides to tray; tracking keeps running.
  await trackingService.start();
  logger.info('[APP] Tracking started.');
});

app.on('window-all-closed', () => {
  // Stage 1 keeps tracking alive when the window is closed: hide to tray
  // instead of quitting. Real quit comes from the tray "Quit" menu only.
  if (process.platform === 'darwin') return;
  BrowserWindow.getAllWindows().forEach((w) => w.hide());
});

app.on('before-quit', async (e) => {
  // If the renderer/Electron itself initiates quit (Alt+F4 on a visible
  // window, OS shutdown), give the tracker a chance to flush before exit.
  // Guard against re-entry: `quitApp` calls `app.quit()` which would fire
  // this handler again.
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  await quitApp(new Logger({ dir: app.getPath('userData'), source: 'app' }));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const logger = new Logger({ dir: app.getPath('userData'), source: 'app' });
    createMainWindow(logger);
  }
});

// 16x16 1x1 transparent PNG (minimal placeholder tray icon).
const BASE64_TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAA3XAAAN1wFCKJt4AAAA' +
  'DklEQVR42mNk+M9QDwADhwH/xpYk2gAAAABJRU5ErkJggg==';
