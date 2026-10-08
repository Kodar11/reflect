// Belt-and-suspenders for the elevation flow: UAC doesn't reliably forward
// env vars, so the relaunched admin instance won't have NODE_ENV set even
// though it was launched from a dev session. We pass --dev as an argv flag
// from elevation.ts; mirror that into NODE_ENV here so any third-party code
// that reads process.env.NODE_ENV (rather than our isDev()) also sees dev.
// Done before any other imports so it lands before module init code runs.
if (process.argv.includes('--dev') && process.env.NODE_ENV !== 'development') {
  process.env.NODE_ENV = 'development';
}

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  powerMonitor,
  screen,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import path from 'node:path';
import activeWin from 'active-win';
import { isDev, ipcMainHandle, ipcMainOn, widgetIpcHandle, widgetIpcOn } from './util.js';
import { getPreloadPath, getUIPath, getWidgetPreloadPath, getWidgetUIPath } from './pathResolver.js';
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
import { EventVisibilityService } from '../service/EventVisibilityService.js';
import { registerEventVisibilityIpc } from './eventVisibilityIpc.js';
import { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import { FocusRepository } from '../database/FocusRepository.js';
import { FocusService } from '../focus/FocusService.js';
import { NoopBlockingManager, type IBlockingManager } from '../focus/BlockingManager.js';
import { HelperBlockingManager } from '../focus/blocker/HelperBlockingManager.js';
import { createElevatedLauncher } from '../focus/blocker/elevatedLauncher.js';
import { isBlockerHelperInvocation, runBlockerHelperProcess } from '../focus/blocker/blockerHelper.js';
import { FocusNotifier } from '../focus/FocusNotifier.js';
import { registerFocusIpc, type FocusIntent } from '../focus/focusIpc.js';
import { CategorizationRepository } from '../database/CategorizationRepository.js';
import { CategorizationService } from '../categorization/CategorizationService.js';
import { registerCategorizationIpc } from '../categorization/categorizationIpc.js';
import { UserProfileRepository } from '../database/UserProfileRepository.js';
import { registerUserProfileIpc } from '../profile/userProfileIpc.js';
import { IntelligenceRepository } from '../database/IntelligenceRepository.js';
import { GeminiClient } from '../intelligence/GeminiClient.js';
import { UserProfileContextProvider } from '../intelligence/IntelligenceContext.js';
import { IntelligenceService } from '../intelligence/IntelligenceService.js';
import { IntelligenceScheduler } from '../intelligence/IntelligenceScheduler.js';
import { IntelligenceTimelineSource } from '../intelligence/IntelligenceTimelineSource.js';
import { registerIntelligenceIpc } from '../intelligence/intelligenceIpc.js';
import { LearnedRuleCandidateRepository } from '../database/LearnedRuleCandidateRepository.js';
import { LearnedRuleService } from '../learning/LearnedRuleService.js';
import { registerLearnedRulesIpc } from '../learning/learnedRulesIpc.js';
import { toLearningActivities } from '../learning/LearningTimeline.js';
import { describeClassification, describePattern } from '../learning/LearnedPattern.js';
import { ReflectionRepository } from '../database/ReflectionRepository.js';
import { createBlockDescriber, createEventLocator, toReflectionActivities } from '../reflection/ReflectionActivities.js';
import { ReflectionAnnotator } from '../reflection/ReflectionAnnotator.js';
import { PROFILE_CHANGE_CHANNELS, TIMELINE_CHANGE_CHANNELS, affectedRange } from '../reflection/ReflectionChanges.js';
import { ReflectionHistory } from '../reflection/ReflectionHistory.js';
import { ReflectionMetricsService } from '../reflection/ReflectionMetricsService.js';
import { DEFAULT_REFLECTION_CONFIG, type TaxonomyNames } from '../reflection/ReflectionModels.js';
import { ReflectionScheduler } from '../reflection/ReflectionScheduler.js';
import { ReflectionService } from '../reflection/ReflectionService.js';
import { registerReflectionIpc } from '../reflection/reflectionIpc.js';
import { periodContaining, setDayStartMinutes } from '../reflection/ReflectionPeriods.js';
import { CoachRepository } from '../database/CoachRepository.js';
import { CoachService } from '../coach/CoachService.js';
import { registerCoachIpc } from '../coach/coachIpc.js';
import { BackgroundRepository } from '../database/BackgroundRepository.js';
import { AppSettingsStore } from '../background/AppSettings.js';
import { BackgroundStatusService, type BackgroundStatus } from '../background/BackgroundStatus.js';
import { Notifier } from '../background/Notifier.js';
import { ReflectionNotifier } from '../background/ReflectionNotifier.js';
import {
  ShutdownSequence,
  acquireSingleInstance,
  isBackgroundLaunch,
  syncLoginItem,
  type LoginItemResult,
} from '../background/Startup.js';
import { TrackingController } from '../background/TrackingController.js';
import { buildTrayModel, createTrayDispatcher, type TrayAction, type TrayItem } from '../background/TrayMenu.js';
import { MainWindowController, type MainWindowLike } from '../background/MainWindowController.js';
import { TRAY_ICON_SIZE, renderTrayIcon } from '../background/trayIcon.js';
import { WidgetController, widgetWindowOptions, type WidgetWindowLike } from '../background/WidgetController.js';
import type { Rect } from '../background/widgetGeometry.js';
import {
  PendingNavigation,
  registerBackgroundIpc,
  type BackgroundSettingsView,
  type UiNavigation,
} from '../background/backgroundIpc.js';
import type { RuleCondition } from '../categorization/Classification.js';
import type { ActivitySample } from '../models/Event.js';
import {
  getActiveBrowserDomain,
  getDomain,
  isInternalPage,
  normalizeBrowserName,
} from '../tracker/browserUrl.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let database: Database | null = null;
let trackingService: TrackingService | null = null;
let focusService: FocusService | null = null;
let intelligenceScheduler: IntelligenceScheduler | null = null;
let reflectionScheduler: ReflectionScheduler | null = null;
/** True once the background runtime has been shut down: windows may now really close. */
let quitting = false;
let appLogger: Logger | null = null;
/** The ordered shutdown of the background runtime; set once the runtime is up. */
let shutdown: ShutdownSequence | null = null;
/** Navigation requests for the main window, which may not exist yet. */
const navigation = new PendingNavigation();
/** Runs whenever the main window comes on screen. */
let onMainWindowShown: (() => void) | null = null;
/** The runtime is up: services exist and IPC is registered, so a window may be opened. */
let runtimeReady = false;
/** The user launched Reflect again while it was still starting. */
let openWhenReady = false;

/**
 * LIFECYCLE OWNERSHIP
 *
 * The Electron main process IS the background runtime: the database,
 * tracking, Focus, the intelligence + reflection schedulers, notifications,
 * the tray and the floating widget are all created and owned here, and none
 * of them needs a window.
 *
 * The main BrowserWindow is a client of that runtime. It is created only when
 * somebody asks for it, closing it hides it, a hidden window is eventually
 * released, and a crashed renderer is simply dropped — in every case the
 * runtime keeps going. Only the tray's Quit (or the OS ending the session)
 * stops it, through `quitApp`.
 */

/** Windows identifies the app by this id: notifications and the login item are filed under it. */
const APP_USER_MODEL_ID = 'com.tanmaychavan.productivitycoach';
/** A hidden main window is released after this long; reopening builds a new one. */
const RELEASE_HIDDEN_WINDOW_AFTER_MS = 10 * 60 * 1000;
/** Silence longer than this (sleep, a frozen process) is not tracked time. */
const TRACKING_MAX_GAP_MS = 30_000;
/** After wake-up, give the network a moment before catching up on missed work. */
const WAKE_CATCH_UP_DELAY_MS = 30_000;

/**
 * This executable doubles as the elevated Focus blocker helper. When started
 * with `--focus-blocker` (through a UAC prompt, by HelperBlockingManager) it
 * runs ONLY the helper: no window, no tray, no database, no tracking.
 */
const blockerHelperMode = isBlockerHelperInvocation(process.argv);
if (blockerHelperMode) {
  app.disableHardwareAcceleration();
  // Keep the elevated instance out of the real profile directory.
  app.setPath('userData', path.join(app.getPath('temp'), 'reflect-focus-blocker'));
  runBlockerHelperProcess(process.argv, (code) => app.exit(code));
}

/**
 * One Reflect per user. A second launch must never build a second tracker,
 * tray or widget (duplicate events, duplicate model calls): it hands over to
 * the running instance — which shows its window — and exits before anything
 * is created. The elevated blocker helper is a different role of the same
 * executable and is not part of this.
 */
const primaryInstance =
  !blockerHelperMode &&
  acquireSingleInstance(app, () => {
    if (runtimeReady) openMain();
    else openWhenReady = true;
  });
if (primaryInstance && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);

// Prototype secret loading: in development, read GEMINI_API_KEY (and friends)
// from a git-ignored `.env` in the project root. The key stays in the main
// process — it is never sent over IPC or exposed through preload.
if (isDev() && !blockerHelperMode) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the real environment.
  }
}

/**
 * Builds the main BrowserWindow. Only the Electron specifics are here; what a
 * close, a hide or a renderer crash MEANS is decided by MainWindowController.
 */
function createMainWindow(): MainWindowLike {
  const win = new BrowserWindow({
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
  mainWindow = win;

  if (isDev()) {
    win.loadURL('http://localhost:5123');
  } else {
    win.loadFile(getUIPath());
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Windows is shutting down or the user is signing out: there may be no
  // `before-quit`, so flush tracking and release blocking right now.
  win.on('session-end', () => {
    void quitApp();
  });

  return {
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    show: () => win.show(),
    hide: () => win.hide(),
    focus: () => win.focus(),
    restore: () => win.restore(),
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    isFocused: () => win.isFocused(),
    send: (channel, payload) => {
      if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    },
    onClose: (listener) => win.on('close', listener),
    onClosed: (listener) => win.on('closed', listener),
    onHide: (listener) => win.on('hide', listener),
    onShow: (listener) => win.on('show', listener),
    onRendererGone: (listener) => win.webContents.on('render-process-gone', (_event, details) => listener(details.reason)),
  };
}

/** Owns when the main window exists. Closing it hides it; it never ends the runtime. */
const mainWindowController = new MainWindowController({
  create: createMainWindow,
  navigation,
  isQuitting: () => quitting,
  releaseAfterHiddenMs: RELEASE_HIDDEN_WINDOW_AFTER_MS,
  onShown: () => onMainWindowShown?.(),
  logger: {
    info: (m) => appLogger?.info(m),
    error: (m) => appLogger?.error(m),
  },
});

/** Show the main window, optionally at a specific place (see MainWindowController.open). */
function openMain(target?: UiNavigation): void {
  mainWindowController.open(target);
}

/** Bring the Focus page forward, optionally opening its pause or end flow. */
function openFocus(intent: FocusIntent): void {
  openMain({ route: 'focus', intent });
}

/** The main window's renderer, when there is one to push to. */
function mainRendererContents(): WebContents[] {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return [];
  return [mainWindow.webContents];
}

/**
 * The floating widget's window. Built from `widgetWindowOptions` (frameless,
 * always on top, out of the taskbar, never focusable) with its own minimal
 * preload; it may not navigate anywhere or open anything.
 */
function createWidgetWindow(bounds: Rect): WidgetWindowLike {
  const win = new BrowserWindow({ ...widgetWindowOptions(getWidgetPreloadPath()), ...bounds, title: 'Reflect' });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (isDev()) {
    void win.loadURL('http://localhost:5123/widget.html');
  } else {
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    void win.loadFile(getWidgetUIPath());
  }
  win.on('session-end', () => void quitApp());
  return {
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    showInactive: () => win.showInactive(),
    getBounds: () => win.getBounds(),
    setBounds: (b) => win.setBounds(b),
    send: (channel, payload) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    },
    onGone: (listener) => {
      win.webContents.on('render-process-gone', () => listener('crashed'));
      win.on('closed', () => listener('closed'));
    },
  };
}

/**
 * A window that is never shown and never loads a page. Windows tells
 * top-level windows when the session is ending; with the main window closed
 * and the widget hidden there would be nobody to hear it. This one always
 * does, so a shutdown or sign-out still flushes tracking and releases Focus
 * blocking.
 */
function createLifecycleWindow(): void {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on('session-end', () => void quitApp());
}

/**
 * Bridges `active-win` (which returns platform-native fields) to our
 * watcher-consumable `ActivitySample`. Kept here rather than in the watcher so
 * the watcher stays fully unit-testable with no `activeWin` import surface.
 */
async function pollActiveWin(): Promise<ActivitySample | null> {
  const w = await activeWin();
  if (!w) return null;

  const app = w.owner?.name ?? undefined;
  let url: string | undefined;
  let browser: string | undefined;

  if (w.platform === 'windows' && typeof w.id === 'number' && app) {
    const domain = getActiveBrowserDomain(w.id, app);
    if (domain) {
      url = domain;
      browser = normalizeBrowserName(app);
    }
  } else if (w.platform === 'macos' && typeof w.url === 'string' && app) {
    // active-win provides the URL on macOS; keep only the domain in the DB.
    if (!isInternalPage(w.url)) {
      const domain = getDomain(w.url);
      if (domain) {
        url = domain;
        browser = normalizeBrowserName(app);
      }
    }
  }

  // Focus only reads this to log an attempt on a blocked site; tracking is
  // unaffected by whether a Focus session exists.
  focusService?.observeDomain(url);

  return {
    watcher: 'window',
    app,
    browser,
    title: w.title || undefined,
    url,
    payload: {
      bundleId: w.owner?.processId,
      platform: w.platform,
      id: w.id,
    },
  };
}

function trayImage(paused: boolean) {
  return nativeImage.createFromBitmap(renderTrayIcon(paused), { width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, scaleFactor: 2 });
}

function createTray(): Tray {
  tray = new Tray(trayImage(false));
  tray.on('click', () => openMain());
  return tray;
}

/** What the tray was last built from; the menu is rebuilt only when this changes. */
let trayMenuKey = '';
let trayPaused = false;

/**
 * The tray renders the background status: tracking on / paused, the Focus
 * session, the widget. It keeps no state of its own. Its "End Focus" and
 * "Quit" entries open the same deliberate exit flow as the Focus page — the
 * tray is not a shortcut around the commitment.
 */
function applyTray(status: BackgroundStatus, dispatch: (action: TrayAction) => void): void {
  if (!tray || tray.isDestroyed()) return;
  const model = buildTrayModel(status);
  tray.setToolTip(model.tooltip);
  if (model.paused !== trayPaused) {
    trayPaused = model.paused;
    tray.setImage(trayImage(model.paused));
  }
  if (model.key === trayMenuKey) return;
  trayMenuKey = model.key;

  const toMenu = (items: TrayItem[]): MenuItemConstructorOptions[] =>
    items.map((item) => {
      if (item.separator) return { type: 'separator' };
      const action = item.action;
      return {
        label: item.label,
        enabled: !item.disabled,
        ...(item.submenu ? { submenu: toMenu(item.submenu) } : {}),
        ...(action ? { click: () => dispatch(action) } : {}),
      };
    });
  tray.setContextMenu(Menu.buildFromTemplate(toMenu(model.items)));
}

/**
 * The real quit — reached only from the tray's Quit, from Electron's own
 * quit (an installer, the OS) and from Windows ending the session. Closing a
 * window never comes here. The shutdown sequence runs once however many of
 * those arrive together; only afterwards may windows close and the process
 * exit.
 */
async function quitApp(): Promise<void> {
  if (shutdown) await shutdown.run();
  quitting = true;
  app.quit();
}

if (primaryInstance) {
  // An always-on background process must not die — or stop on a modal error
  // dialog — because one subsystem threw. Log it and keep tracking.
  process.on('uncaughtException', (err) => {
    console.error('[APP] Uncaught exception:', err);
    appLogger?.error(`[APP] Uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[APP] Unhandled rejection:', reason);
    appLogger?.error(`[APP] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}

if (primaryInstance) app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const logger = new Logger({ dir: userData, source: 'app' });
  appLogger = logger;
  logger.info('[APP] Starting Productivity Coach — Stage 1 tracker.');

  // --- Construct the focus layer first (Stage 3.10) ---
  // FocusService is created early so the tracking engine can notify it of
  // activity for idle detection. The IPC registration happens later after the
  // timeline service is available.
  try {
    database = new Database(Database.filePathFor(userData));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fatal: without the database nothing can be tracked, and pretending
    // otherwise would be worse than not running.
    logger.error(`[APP] FATAL — database initialization failed, tracking is NOT running: ${message}`);
    app.exit(1);
    return;
  }

  // --- Background runtime state ---
  // The application settings (start with Windows, tracking pause, widget,
  // notifications) are read here, in the main process, before any window.
  const backgroundRepo = new BackgroundRepository(database);
  const appSettings = new AppSettingsStore(backgroundRepo, { log: (m) => logger.error(m) });
  const notifier = new Notifier({
    isEnabled: () => appSettings.get().notificationsEnabled,
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    logger,
  });

  const focusRepo = new FocusRepository(database);
  // Real enforcement lives in an elevated helper process (hosts file +
  // process termination); the app only holds a lease on it. The renderer is
  // never the enforcement authority.
  const blockingManager: IBlockingManager =
    process.platform === 'win32'
      ? new HelperBlockingManager({
          launch: createElevatedLauncher({
            execPath: process.execPath,
            // In development Electron needs the app path before our flags.
            leadingArgs: app.isPackaged ? [] : [app.getAppPath()],
            dev: isDev(),
          }),
          log: (m) => logger.info(`[FOCUS] ${m}`),
        })
      : new NoopBlockingManager();
  focusService = new FocusService(focusRepo, blockingManager, {
    // Real keyboard/mouse idleness — window polling keeps reporting the
    // foreground app even when nobody is at the machine.
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    log: (m) => logger.warn(`[FOCUS] ${m}`),
  });
  const focusNotifier = new FocusNotifier(
    () => {
      const prefs = focusService?.getPreferences() ?? focusRepo.getPreferences();
      if (appSettings.get().notificationsEnabled) return prefs;
      // The notification switch silences every optional Focus notification.
      // The loss of blocking is still reported — that rule is FocusNotifier's.
      return { ...prefs, notifyStart: false, notifyIdle: false, notifyComplete: false, notifyBlocked: false };
    },
    // FocusNotifier has already decided this one is to be shown.
    ({ title, body }) => void notifier.show({ title, body, critical: true }),
  );
  focusService.on('notice', (notice) => focusNotifier.onNotice(notice));
  focusService.on('summary', (session, profile) => focusNotifier.onSummary(session, profile));
  // After sleep, timers alone are not trustworthy: reconcile against the
  // clock straight away (countdown expiry, slept time, blocking lease).
  powerMonitor.on('resume', () => focusService?.handleSystemResume());
  // Recover a session left open by a crash, quit or reboot. Not awaited:
  // re-acquiring blocking may wait on a UAC prompt, and the window should
  // not. Any Focus action taken meanwhile queues behind it.
  void focusService
    .reconcileActiveSession()
    .catch((e) => logger.error(`[FOCUS] startup reconciliation failed: ${(e as Error)?.message ?? e}`))
    .then(() => {
      // A crash or power loss can leave Focus's entries in the hosts file with
      // no session to own them. Say so instead of leaving sites mysteriously
      // blocked; removing them needs the user's approval (elevation).
      if (!focusService?.hasBlockingResidue()) return;
      notifier.show({
        title: 'Focus blocking is still on',
        body: 'Blocking from an earlier Focus session was not removed. Open Focus to remove it.',
        critical: true,
        onClick: () => openFocus('open'),
      });
    });
  logger.info('[APP] Focus service ready.');

  // --- Construct the tracking stack via DI ---
  const repo = new EventRepository(database);
  const engine = new HeartbeatEngine(repo, () => new Date(), 5000, undefined, TRACKING_MAX_GAP_MS);
  const trackerLogger = {
    info: (m: string) => logger.info(m),
    warn: (m: string) => logger.warn(m),
    error: (m: string) => logger.error(m),
  };

  const windowWatcher = new WindowWatcher(pollActiveWin, engine, 1000, trackerLogger);

  trackingService = new TrackingService([windowWatcher], engine, trackerLogger);

  // The one authority on whether tracking is on. It starts the tracker with
  // the runtime (below) and stops it only for a pause the user asked for.
  const trackingController = new TrackingController({
    tracking: trackingService,
    settings: appSettings,
    pauses: backgroundRepo,
    nextDayStart: (now) => new Date(periodContaining('day', now).end),
    logger: trackerLogger,
  });

  // The floating widget and the status every surface renders.
  const widgetController = new WidgetController({
    host: {
      createWindow: createWidgetWindow,
      displays: () => {
        const primaryId = screen.getPrimaryDisplay().id;
        return screen.getAllDisplays().map((d) => ({ workArea: d.workArea, primary: d.id === primaryId }));
      },
      cursor: () => screen.getCursorScreenPoint(),
    },
    settings: appSettings,
    onVisibilityChanged: () => statusService.refresh(),
    logger: trackerLogger,
  });
  const statusService = new BackgroundStatusService({
    tracking: trackingController,
    events: repo,
    focus: focusService,
    widgetVisible: () => widgetController.visible,
    dayStart: (now) => new Date(periodContaining('day', now).start),
    logger,
  });

  registerTrackerIpc(repo, ipcMainHandle, mainRendererContents);

  // Reflections are written from the verified timeline and the user profile.
  // Handlers registered through this wrapper tell the reflection layer (built
  // further down) when a mutation may have changed what a past reflection was
  // based on, so it can be re-checked — never silently rewritten.
  let reflectionService: ReflectionService | null = null;
  const timelineChangeChannels = new Set(TIMELINE_CHANGE_CHANNELS);
  const profileChangeChannels = new Set(PROFILE_CHANGE_CHANNELS);
  const ipcHandleTracked: typeof ipcMainHandle = (key, handler) =>
    ipcMainHandle(key, async (payload) => {
      const result = await handler(payload);
      try {
        if (timelineChangeChannels.has(key)) {
          reflectionService?.notifyDataChanged({ kind: 'timeline', range: affectedRange(key, payload, repo) });
        } else if (profileChangeChannels.has(key)) {
          reflectionService?.notifyDataChanged({ kind: 'profile' });
        }
      } catch (e) {
        logger.error(`[REFLECTION] change notification failed: ${(e as Error)?.message ?? e}`);
      }
      return result;
    });

  // --- Construct the session layer (read-side transform over raw events) ---
  // Sessions are derived on demand from the same raw repo; never persisted.
  const sessionService = new SessionService(repo);
  registerSessionIpc(sessionService, ipcMainHandle, mainRendererContents);
  logger.info('[APP] Session service ready.');

  // --- Construct the timeline layer (Stage 3) ---
  // User edits overlay the generated sessions; the timeline is rederived on
  // demand. Edit log lives in timeline_edits (append-only + undone_at).
  const editRepo = new EditRepository(database, (msg) => logger.warn(msg));
  const activityRuleRepo = new ActivityRuleRepository(database);
  const categorizationRepo = new CategorizationRepository(database);
  // The intelligence repository + timeline adapter are constructed here so the
  // timeline can show persisted AI activities (with deterministic sessions as
  // the fallback) and user edits can protect them from later AI runs.
  const intelligenceRepo = new IntelligenceRepository(database);
  const aiTimelineSource = new IntelligenceTimelineSource(intelligenceRepo);
  // Corrections that do not become an explicit rule are handed to the
  // learning layer, which is constructed further down (it needs the timeline).
  let learnedRuleService: LearnedRuleService | null = null;
  const categorizationService = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, repo, aiTimelineSource, {
    onCorrection: (correction) => learnedRuleService?.onCorrection(correction),
  });
  const timelineService = new TimelineService(sessionService, editRepo, activityRuleRepo, categorizationService, aiTimelineSource);
  const timelineIpc = registerTimelineIpc(timelineService, activityRuleRepo, ipcHandleTracked, mainRendererContents);
  registerCategorizationIpc(categorizationService, ipcHandleTracked, mainRendererContents);
  logger.info('[APP] Timeline + categorization services ready.');

  // --- Construct the intelligence layer (Gemini) ---
  // An enhancement only: if Gemini is unavailable the app, tracking and the
  // deterministic timeline keep working. The manual IPC trigger and the hourly
  // scheduler both run IntelligenceService.analyzeWindow.
  const intelligenceLogger = {
    info: (m: string) => logger.info(m),
    warn: (m: string) => logger.warn(m),
    error: (m: string) => logger.error(m),
  };
  // --- Construct the user profile layer (onboarding context) ---
  // Kept separate from events. The same repository backs the renderer IPC and
  // the intelligence context, so a profile edit reaches the next analysis.
  const userProfileRepo = new UserProfileRepository(database);
  registerUserProfileIpc(userProfileRepo, ipcHandleTracked);
  logger.info('[APP] User profile ready.');

  const geminiClient = new GeminiClient();
  const userContextProvider = new UserProfileContextProvider(userProfileRepo);

  // --- Construct the learning layer (learned patterns) ---
  // Gemini generalises a correction into rule conditions once; everything
  // after that — counting, eligibility, suggestions — is local. A candidate
  // only becomes a tracking rule when the user confirms it.
  learnedRuleService = new LearnedRuleService({
    repo: new LearnedRuleCandidateRepository(database),
    gemini: geminiClient,
    events: repo,
    activityRules: activityRuleRepo,
    categorization: categorizationRepo,
    intelligence: intelligenceRepo,
    userContext: userContextProvider,
    getActivities: (from, to) => toLearningActivities(timelineService.getByRange(from, to)),
    onRulesChanged: () => timelineIpc.notifyTimelineChanged(),
    logger: intelligenceLogger,
  });
  registerLearnedRulesIpc(learnedRuleService, ipcHandleTracked);
  logger.info('[APP] Learned-pattern service ready.');

  const intelligenceService = new IntelligenceService({
    events: repo,
    repo: intelligenceRepo,
    gemini: geminiClient,
    activityRules: activityRuleRepo,
    categorization: categorizationRepo,
    focus: focusRepo,
    userContext: userContextProvider,
    getUserEditedEventIds: (from, to) => timelineService.getUserEditedEventIds(from, to),
    logger: intelligenceLogger,
  });
  // --- Construct the reflection layer ---
  // The meaning layer on top of the verified timeline: deterministic metrics
  // + the user's own priorities + personal baselines → Gemini → validated,
  // persisted reflections. An enhancement only: if Gemini is unavailable the
  // Reflection tab still shows deterministic numbers and earlier reports.
  const reflectionRepo = new ReflectionRepository(database);
  const reflectionTaxonomy = (): TaxonomyNames => {
    const names = (dimension: 'area' | 'intent' | 'quality') =>
      Object.fromEntries(categorizationRepo.listDimensionsByType(dimension).map((d) => [d.id, d.name]));
    return {
      contexts: Object.fromEntries(activityRuleRepo.listActivities().map((a) => [a.id, a.name])),
      areas: names('area'),
      intents: names('intent'),
      qualities: names('quality'),
    };
  };
  const reflectionMetrics = new ReflectionMetricsService(
    {
      // Reflection sees exactly what the Timeline shows: AI activities where
      // they exist, deterministic sessions elsewhere, user edits applied.
      getActivities: (from, to) => toReflectionActivities(timelineService.getByRange(from, to), { start: from, end: to }),
      focus: focusRepo,
      taxonomy: reflectionTaxonomy,
      firstEventAt: () => repo.getFirstEventStart(),
      // A pause is missing data, not inactivity — the reflection is told so.
      trackingPausedMs: (from, to) => backgroundRepo.pausedMsBetween(from, to) + trackingController.currentPauseMsBetween(from, to),
      // Evidence is anchored to raw events; this finds the block that holds them now.
      locateEvents: createEventLocator(repo, timelineService),
    },
    reflectionRepo,
    { config: DEFAULT_REFLECTION_CONFIG },
  );
  // Rules are classification knowledge the model may use as context: the ones
  // the user wrote are authoritative, the learned ones were confirmed by them.
  // Reflection never creates either.
  const ruleLabels = (source: 'learned' | 'user') => (): string[] => {
    const taxonomy = reflectionTaxonomy();
    const labels: string[] = [];
    for (const rule of activityRuleRepo.listRules()) {
      if (rule.source !== source || rule.enabled !== 1) continue;
      try {
        const pattern = describePattern(JSON.parse(rule.conditions) as RuleCondition[]);
        const classification = describeClassification({
          context: rule.activityId ? taxonomy.contexts[rule.activityId] ?? null : null,
          area: rule.areaId ? taxonomy.areas[rule.areaId] ?? null : null,
          intent: rule.intentId ? taxonomy.intents[rule.intentId] ?? null : null,
          quality: rule.qualityId ? taxonomy.qualities[rule.qualityId] ?? null : null,
        });
        if (pattern && classification) labels.push(`${pattern} ${source === 'user' ? 'is' : 'is usually'} ${classification}`);
      } catch {
        // Malformed rule conditions — not worth mentioning to the model.
      }
      if (labels.length >= 10) break;
    }
    return labels;
  };
  // --- Construct the coach layer ---
  // The final loop: a day's reflection and its coaching are ONE model request
  // (the coach plugs into the reflection pipeline below), recommendations are
  // tracked entities, execution is observed from Focus sessions and the
  // timeline, and outcomes feed the next recommendation. An enhancement only:
  // without Gemini, commitments and their tracking keep working.
  const coachRepo = new CoachRepository(database);
  // The user's day boundary applies to every period Reflection computes.
  setDayStartMinutes(coachRepo.getSettings().dayStartMinutes);
  let notifyCoachChanged: () => void = () => {};
  const coachService = new CoachService({
    repo: coachRepo,
    gemini: geminiClient,
    reflections: reflectionRepo,
    // Reflect's structured memory: how each body of work moved, what is still open.
    history: new ReflectionHistory(reflectionRepo, { metrics: reflectionMetrics, config: DEFAULT_REFLECTION_CONFIG }),
    metrics: reflectionMetrics,
    focus: focusRepo,
    userContext: userContextProvider,
    priorities: () => reflectionService?.syncPriorities() ?? reflectionRepo.listPriorities(),
    onChanged: () => notifyCoachChanged(),
    logger: intelligenceLogger,
  });
  // A Focus session that just ended is the evidence for the action it was for.
  focusService.on('summary', () => void coachService.onFocusEnded());
  // A finished Focus session is part of what that day's reflection is written from.
  focusService.on('summary', (ended: { startedAt?: string | null; endedAt?: string | null }) => {
    const end = ended?.endedAt ?? new Date().toISOString();
    reflectionService?.notifyDataChanged({ kind: 'focus', range: { start: ended?.startedAt ?? end, end } });
  });

  reflectionService = new ReflectionService({
    repo: reflectionRepo,
    gemini: geminiClient,
    metrics: reflectionMetrics,
    annotator: new ReflectionAnnotator({ gemini: geminiClient, repo: reflectionRepo, logger: intelligenceLogger }),
    userContext: userContextProvider,
    profiles: userProfileRepo,
    taxonomy: reflectionTaxonomy,
    learnedPatterns: ruleLabels('learned'),
    explicitRules: ruleLabels('user'),
    coach: coachService,
    dailyReflectionMinutes: () => coachService.getSettings().reflectionMinutes,
    logger: intelligenceLogger,
  });
  const rendererContents = mainRendererContents;
  const reflectionIpc = registerReflectionIpc(
    reflectionService,
    (key, handler) =>
      ipcMainHandle(key, (payload) => {
        // A report read while the window is on screen means the user is looking at it.
        if (key === 'reflection:getReport' && mainWindowController.onScreen) statusService.clearReflectionPending();
        return handler(payload);
      }),
    rendererContents,
  );
  // "Your reflection is ready": decided and sent from here, with no window
  // needed, and at most once per day (the claim is persisted).
  const reflectionNotifier = new ReflectionNotifier({
    ledger: backgroundRepo,
    wantsNotification: () => coachService.getSettings().notifyDailyReflection,
    isUserLooking: () => mainWindowController.focused,
    pendingQuestions: () => coachService.getState().commitments.filter((a) => a.pending !== null).length,
    notify: (request) => notifier.show(request),
    onPending: (notice) => statusService.markReflectionPending(notice.period.start),
    open: (notice) => openMain({ route: 'reflection', anchor: notice.period.start }),
    logger: intelligenceLogger,
  });
  // A cycle runs right behind every intelligence cycle, so the AI activities
  // of the hour that just ended always exist first; its one timer wakes at
  // the user's reflection time so the end-of-day report does not wait an hour.
  reflectionScheduler = new ReflectionScheduler(reflectionService, {
    logger: intelligenceLogger,
    onGenerated: (results) => {
      reflectionIpc.notifyReflectionChanged();
      notifyCoachChanged();
      // The one proactive nudge: the day's reflection is ready — also for a
      // day whose reflection time was missed and is written at the next start.
      reflectionNotifier.onGenerated(results);
    },
    onDailyReflectionDue: () => {
      // Bring the AI activities up to date first; its completion runs the reflection cycle.
      void intelligenceScheduler?.runCycle();
    },
  });
  const coachIpc = registerCoachIpc(coachService, ipcMainHandle, rendererContents, {
    onSettingsChanged: (settings) => {
      setDayStartMinutes(settings.dayStartMinutes);
      reflectionMetrics.invalidate();
      reflectionScheduler?.reschedule();
      reflectionIpc.notifyReflectionChanged();
    },
  });
  notifyCoachChanged = () => coachIpc.notifyCoachChanged();
  logger.info('[APP] Reflection + coach services ready.');

  // New AI activities are matched against candidates locally — no Gemini call.
  const onAnalyzed = () => {
    learnedRuleService?.trackOccurrences();
    timelineIpc.notifyTimelineChanged();
    // The analysed windows lie within the backlog lookback (48h).
    const now = Date.now();
    reflectionService?.notifyDataChanged({
      kind: 'timeline',
      range: { start: new Date(now - 48 * 60 * 60 * 1000).toISOString(), end: new Date(now).toISOString() },
    });
  };
  registerIntelligenceIpc(intelligenceService, ipcMainHandle, onAnalyzed);
  intelligenceScheduler = new IntelligenceScheduler(intelligenceService, {
    logger: intelligenceLogger,
    onAnalyzed,
    onCycleComplete: () => {
      // Reflections first, then a look at whether open commitments happened.
      void reflectionScheduler?.runCycle().then(() => coachService.observe());
    },
  });
  logger.info(
    `[APP] Intelligence service ready (Gemini ${intelligenceService.isConfigured() ? 'configured' : 'not configured — GEMINI_API_KEY missing'}).`,
  );

  // --- Construct the event visibility layer (hide / restore / delete) ---
  // The user decides what stays captured. `repo` is handed over here in its
  // internal role — the only place hidden events can be seen or changed;
  // every other layer above holds it as the visible-only IEventRepository.
  const eventVisibility = new EventVisibilityService({
    transaction: (fn) => database!.transaction(fn),
    events: repo,
    intelligence: intelligenceRepo,
    reflections: reflectionRepo,
    coach: coachService,
    blocksHolding: createBlockDescriber(repo, timelineService),
    onRangeChanged: (range) =>
      reflectionService?.notifyDataChanged({
        kind: 'timeline',
        range: { start: range.start, end: new Date(Date.parse(range.end) + 1).toISOString() },
      }),
    // Only what rested on the event is rebuilt: the analyses that covered its
    // activity, then the reflections that went stale.
    rebuild: async (windows) => {
      let analysed = false;
      for (const window of windows) {
        const result = await intelligenceService.analyzeWindow(window.start, window.end);
        if (result.status !== 'succeeded') continue;
        analysed = true;
        // The window may lie further back than the stretch `onAnalyzed` covers.
        reflectionService?.notifyDataChanged({ kind: 'timeline', range: window });
      }
      if (analysed) onAnalyzed();
      await reflectionScheduler?.runCycle();
      await coachService.observe();
    },
    onChanged: () => {
      timelineIpc.notifyTimelineChanged();
      reflectionIpc.notifyReflectionChanged();
      notifyCoachChanged();
      statusService.refresh();
    },
    logger,
  });
  registerEventVisibilityIpc(eventVisibility, ipcMainHandle);
  logger.info('[APP] Event visibility service ready.');

  // --- Construct the export layer (Stage 3.8) ---
  // Exports go through the same visible-only reads as the UI: a hidden event
  // is never written to a file.
  const exportService = new ExportService(timelineService, repo, sessionService);
  registerExportIpc(exportService, ipcMainHandle);
  logger.info('[APP] Export service ready.');

  // --- Wire focus IPC (Stage 3.10) ---
  registerFocusIpc(focusService, focusRepo, ipcMainHandle, mainRendererContents,
    (session) => {
      const trackedSessionIds: string[] = [];
      let productiveMs = 0;
      if (session.startedAt && session.endedAt) {
        const sessions = timelineService.getByRange(session.startedAt, session.endedAt);
        const focusStart = new Date(session.startedAt).getTime();
        const focusEnd = new Date(session.endedAt).getTime();
        for (const s of sessions) {
          const overlap = Math.max(0, Math.min(focusEnd, new Date(s.endedAt).getTime()) - Math.max(focusStart, new Date(s.startedAt).getTime()));
          if (overlap > 0) {
            trackedSessionIds.push(s.id);
            productiveMs += overlap;
          }
        }
      }
      // The profile may have been deleted since; the session still has a summary.
      const profile = focusRepo.getProfileById(session.profileId) ?? {
        id: session.profileId,
        name: 'Focus',
        description: null,
        isDefault: false,
        mode: session.mode,
        defaultDurationMinutes: session.plannedDurationMinutes,
        blocksDistractions: false,
        soundCue: null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        rules: [],
      };
      const interruptions = focusRepo.getInterruptions(session.id);
      const blockedAttempts = focusRepo.getBlockedAttempts(session.id);
      return {
        session,
        profile,
        trackedSessionIds,
        interruptionCount: interruptions.length,
        blockedAttemptCount: blockedAttempts.length,
        productiveMs,
      };
    },
    // Suggestions for the blocking editor, from what Reflect already sees:
    // apps with an open window, and sites visited in the last day.
    async () => {
      const windows = await activeWin.getOpenWindows().catch(() => []);
      const openApps = windows
        .filter((w) => w.owner?.path && w.owner.processId !== process.pid)
        .map((w) => ({ name: w.owner.name, process: path.basename(w.owner.path) }));
      const now = Date.now();
      const visits = repo
        .getByRange(new Date(now - 24 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString())
        .filter((e) => e.url)
        .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
      return { openApps, recentSites: visits.map((e) => String(e.url)) };
    },
  );
  logger.info('[APP] Focus IPC ready.');

  // --- Background surfaces: tray, widget, settings, status ---
  let loginItem: LoginItemResult = { action: 'skipped-development', disabledBySystem: false };
  const applyLoginItem = () => {
    try {
      loginItem = syncLoginItem(app, {
        enabled: appSettings.get().startWithWindows,
        isPackaged: app.isPackaged,
        execPath: process.execPath,
      });
      if (loginItem.action !== 'unchanged') logger.info(`[APP] Start with Windows: ${loginItem.action}.`);
    } catch (e) {
      logger.error(`[APP] Could not update the login item: ${(e as Error)?.message ?? e}`);
    }
  };
  const backgroundSettingsView = (): BackgroundSettingsView => {
    const settings = appSettings.get();
    return {
      startWithWindows: settings.startWithWindows,
      widgetEnabled: settings.widgetEnabled,
      notificationsEnabled: settings.notificationsEnabled,
      startupAvailable: app.isPackaged,
      startupDisabledBySystem: loginItem.disabledBySystem,
    };
  };

  const dispatchTrayAction = createTrayDispatcher({
    openMain,
    reflectionAnchor: () => statusService.reflectionAnchor,
    resumeFocus: () => {
      void focusService?.resume().catch((e) => logger.error(`[FOCUS] resume failed: ${(e as Error)?.message ?? e}`));
    },
    pauseTracking: (duration) => void trackingController.pause(duration),
    resumeTracking: () => void trackingController.resume(),
    setWidgetVisible: (visible) => widgetController.setEnabled(visible),
    quit: () => void quitApp(),
  });

  // One status, three surfaces. Each just renders what it is handed; a
  // surface that is missing or broken is skipped without affecting the others.
  statusService.onChanged((status) => {
    try {
      applyTray(status, dispatchTrayAction);
    } catch (e) {
      logger.error(`[APP] Tray update failed: ${(e as Error)?.message ?? e}`);
    }
    widgetController.pushStatus(status);
    for (const wc of mainRendererContents()) wc.send('background:status', status);
  });
  trackingController.onChanged(() => statusService.refresh());
  appSettings.onChanged((next, previous) => {
    if (next.startWithWindows !== previous.startWithWindows) applyLoginItem();
    if (next.widgetEnabled !== previous.widgetEnabled) widgetController.sync();
    statusService.refresh();
  });
  // Focus state comes from FocusService alone. The widget counts its own
  // clock between pushes, so the per-second tick only matters here when the
  // minute shown in the tray changes.
  let focusMinuteShown = -1;
  focusService.on('activeSessionChanged', () => {
    focusMinuteShown = -1;
    statusService.refresh();
  });
  focusService.on('tick', (dto) => {
    const minute = Math.ceil((dto.remainingMs ?? dto.liveElapsedMs) / 60_000);
    if (minute === focusMinuteShown) return;
    focusMinuteShown = minute;
    statusService.refresh();
  });
  // A window that comes back on screen while a reflection is waiting re-reads it.
  onMainWindowShown = () => {
    if (statusService.reflectionAnchor !== null || statusService.getStatus().reflectionPending) {
      reflectionIpc.notifyReflectionChanged();
    }
  };
  screen.on('display-added', () => widgetController.handleDisplaysChanged());
  screen.on('display-removed', () => widgetController.handleDisplaysChanged());
  screen.on('display-metrics-changed', () => widgetController.handleDisplaysChanged());

  registerBackgroundIpc(
    {
      status: statusService,
      tracking: trackingController,
      settings: {
        view: backgroundSettingsView,
        update: (patch) => {
          appSettings.update(patch);
          return backgroundSettingsView();
        },
      },
      navigation,
      widget: widgetController,
      openMain,
      reflectionAnchor: () => statusService.reflectionAnchor,
    },
    { handleMain: ipcMainHandle, handleWidget: widgetIpcHandle, onWidget: widgetIpcOn },
  );
  logger.info('[APP] Background IPC ready.');

  // Window frame controls (minimize / maximize / close-to-tray).
  ipcMainOn('sendFrameAction', (action) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    switch (action) {
      case 'MINIMIZE':
        win.minimize();
        break;
      case 'MAXIMIZE':
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case 'CLOSE':
        // To the tray, like every other close. Tracking is not involved.
        mainWindowController.hide();
        break;
    }
  });

  // ── Start the background runtime ──────────────────────────────────────────
  // Everything below runs with no window. Each step is isolated: a tray,
  // widget or login-item problem is logged and never stops tracking.
  const step = (name: string, run: () => void) => {
    try {
      run();
    } catch (e) {
      logger.error(`[APP] Startup step "${name}" failed: ${(e as Error)?.message ?? e}`);
    }
  };

  // The real quit: stop tracking (flushing the open events), stop the
  // schedulers, let Focus release its blocking, remove the widget and the
  // tray, and close the database last.
  shutdown = new ShutdownSequence(
    [
      { name: 'tracking', run: () => trackingController.shutdown() },
      {
        name: 'schedulers',
        run: () => {
          intelligenceScheduler?.stop();
          reflectionScheduler?.stop();
          statusService.stop();
        },
      },
      // Releases blocking and persists the session; an open session is picked
      // up again by startup reconciliation.
      { name: 'focus', run: () => focusService?.shutdown() },
      { name: 'widget', run: () => widgetController.dispose() },
      {
        name: 'tray',
        run: () => {
          tray?.destroy();
          tray = null;
        },
      },
      {
        name: 'database',
        run: () => {
          database?.close();
          database = null;
        },
      },
    ],
    logger,
  );

  // Tracking is passive: it starts here, with the runtime, and needs no
  // window and no click. Only a pause the user asked for keeps it off.
  try {
    const tracking = await trackingController.start();
    logger.info(tracking.state === 'running' ? '[APP] Tracking started.' : '[APP] Tracking is paused by the user.');
  } catch (e) {
    logger.error(`[APP] Tracking failed to start: ${(e as Error)?.message ?? e}`);
  }

  // After sleep nothing may be assumed: sleep is not tracked time, a timed
  // pause may have ended, and the hourly cycle or the reflection time may
  // have passed while every timer stood still.
  powerMonitor.on('suspend', () => trackingController.handleSystemSuspend());
  powerMonitor.on('resume', () => {
    void trackingController.handleSystemResume().then(() => statusService.refresh());
    reflectionScheduler?.reschedule();
    const catchUp = setTimeout(() => void intelligenceScheduler?.runCycle(), WAKE_CATCH_UP_DELAY_MS);
    catchUp.unref?.();
  });

  // Startup reconciliation + hourly analysis — the single scheduler pair,
  // owned by the main process. Work done before the last shutdown is analysed
  // now, and each cycle is followed by a reflection cycle: closed periods
  // still missing their report (a reflection time that was missed while the
  // machine was off), then the evening reflection.
  step('schedulers', () => {
    reflectionScheduler?.start();
    intelligenceScheduler?.start();
  });

  step('tray', () => {
    createTray();
    // Drawn from the current status straight away; later updates arrive as changes.
    applyTray(statusService.getStatus(), dispatchTrayAction);
  });
  step('status', () => statusService.start());
  step('widget', () => widgetController.sync());
  step('login item', applyLoginItem);
  step('lifecycle window', createLifecycleWindow);

  // The main window is opened when somebody asks for it. Started by Windows at
  // sign-in, Reflect stays in the background; started by the user, it shows.
  runtimeReady = true;
  if (isBackgroundLaunch(process.argv) && !openWhenReady) logger.info('[APP] Started in the background (no main window).');
  else step('main window', () => openMain());
  logger.info('[APP] Background runtime ready.');
});

app.on('window-all-closed', () => {
  // Reflect lives in the tray: having no window is its normal state, not a
  // reason to quit. (Without this listener Electron would quit.) Real quit
  // comes from the tray "Quit" menu only.
});

app.on('before-quit', async (e) => {
  // The blocker helper has no tracker, tray or database to flush; a second
  // instance that is only handing over has nothing to shut down either.
  if (!primaryInstance) return;
  // If Electron itself initiates quit (OS shutdown, an installer), give the
  // tracker a chance to flush and Focus a chance to release blocking before
  // exit. `quitApp` sets `quitting` right before its own `app.quit()`, so the
  // second pass through this handler falls straight through.
  if (quitting) return;
  e.preventDefault();
  await quitApp();
});

app.on('activate', () => {
  if (!primaryInstance) return;
  openMain();
});
