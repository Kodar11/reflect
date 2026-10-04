// Belt-and-suspenders for the elevation flow: UAC doesn't reliably forward
// env vars, so the relaunched admin instance won't have NODE_ENV set even
// though it was launched from a dev session. We pass --dev as an argv flag
// from elevation.ts; mirror that into NODE_ENV here so any third-party code
// that reads process.env.NODE_ENV (rather than our isDev()) also sees dev.
// Done before any other imports so it lands before module init code runs.
if (process.argv.includes('--dev') && process.env.NODE_ENV !== 'development') {
  process.env.NODE_ENV = 'development';
}

import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, powerMonitor } from 'electron';
import path from 'node:path';
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
import { FocusRepository } from '../database/FocusRepository.js';
import { FocusService } from '../focus/FocusService.js';
import { NoopBlockingManager, type IBlockingManager } from '../focus/BlockingManager.js';
import { HelperBlockingManager } from '../focus/blocker/HelperBlockingManager.js';
import { createElevatedLauncher } from '../focus/blocker/elevatedLauncher.js';
import { isBlockerHelperInvocation, runBlockerHelperProcess } from '../focus/blocker/blockerHelper.js';
import { FocusNotifier } from '../focus/FocusNotifier.js';
import { registerFocusIpc, type FocusIntent } from '../focus/focusIpc.js';
import type { ActiveFocusSessionDto } from '../focus/FocusModels.js';
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
import { toReflectionActivities } from '../reflection/ReflectionActivities.js';
import { ReflectionAnnotator } from '../reflection/ReflectionAnnotator.js';
import { PROFILE_CHANGE_CHANNELS, TIMELINE_CHANGE_CHANNELS, affectedRange } from '../reflection/ReflectionChanges.js';
import { ReflectionMetricsService } from '../reflection/ReflectionMetricsService.js';
import { DEFAULT_REFLECTION_CONFIG, type TaxonomyNames } from '../reflection/ReflectionModels.js';
import { ReflectionScheduler } from '../reflection/ReflectionScheduler.js';
import { ReflectionService } from '../reflection/ReflectionService.js';
import { registerReflectionIpc } from '../reflection/reflectionIpc.js';
import { setDayStartMinutes } from '../reflection/ReflectionPeriods.js';
import { CoachRepository } from '../database/CoachRepository.js';
import { CoachService } from '../coach/CoachService.js';
import { registerCoachIpc } from '../coach/coachIpc.js';
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
let quitting = false;
let quitStarted = false;
let appLogger: Logger | null = null;
/** Set once the Focus IPC is registered; routes tray actions to the renderer. */
let sendFocusIntent: ((intent: FocusIntent) => void) | null = null;

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

  // Closing the window never ends tracking or Focus: it hides to the tray.
  // Only a real quit (tray menu, OS shutdown) lets the window go.
  const win = mainWindow;
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Windows is shutting down or the user is signing out: there may be no
  // `before-quit`, so flush tracking and release blocking right now.
  win.on('session-end', () => {
    void quitApp(logger);
  });

  logger.info('[APP] Window ready.');
  return mainWindow;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!appLogger) return;
    createMainWindow(appLogger);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Bring the Focus page forward, optionally opening its pause or end flow. */
function openFocus(intent: FocusIntent): void {
  showMainWindow();
  sendFocusIntent?.(intent);
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

function createTray(logger: Logger): Tray {
  // 16x16 transparent-ish icon; real icon swapped in later. nativeImage.fromBuffer
  // needs bytes — a 1x1 PNG is the cheapest viable placeholder.
  const icon = nativeImage.createFromBuffer(Buffer.from(BASE64_TRAY_ICON, 'base64'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', () => showMainWindow());
  updateTray(focusService?.getActiveSession() ?? null, logger);
  return tray;
}

/** What the tray menu was last built from; rebuilt only when this changes. */
let trayMenuKey = '';

/**
 * The tray mirrors the Focus session. Its "End Focus" and "Quit" entries
 * open the same deliberate exit flow as the Focus page — the tray is not a
 * shortcut around the commitment.
 */
function updateTray(dto: ActiveFocusSessionDto | null, logger: Logger): void {
  if (!tray || tray.isDestroyed()) return;

  if (!dto) {
    tray.setToolTip('Productivity Coach');
    if (trayMenuKey === 'idle') return;
    trayMenuKey = 'idle';
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => showMainWindow() },
      { label: 'Start Focus', click: () => openFocus('open') },
      { type: 'separator' },
      { label: 'Quit', click: () => quitApp(logger) },
    ]));
    return;
  }

  const clock = formatFocusMs(dto.remainingMs ?? dto.liveElapsedMs);
  const paused = !dto.isRunning;
  const task = dto.session.task.length > 48 ? `${dto.session.task.slice(0, 47)}…` : dto.session.task;
  tray.setToolTip(`${paused ? 'Paused' : 'Focus'} ${clock} — ${task}`.slice(0, 120));

  const minutes = Math.ceil((dto.remainingMs ?? dto.liveElapsedMs) / 60_000);
  const timeLabel = dto.remainingMs !== null ? `${minutes} min left` : `${Math.floor(dto.liveElapsedMs / 60_000)} min`;
  const blockingLabel =
    dto.blocking.status === 'active' ? 'Blocking active'
    : dto.blocking.status === 'off' ? 'Blocking off'
    : dto.blocking.status === 'recovering' ? 'Restoring blocking…'
    : dto.blocking.status === 'unavailable' ? 'Blocking unavailable'
    : 'Blocking stopped';
  const key = [dto.session.id, paused, timeLabel, blockingLabel].join('|');
  if (key === trayMenuKey) return;
  trayMenuKey = key;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${paused ? 'Paused' : 'Focus'}: ${timeLabel}`, enabled: false },
    { label: task, enabled: false },
    { label: blockingLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open Focus', click: () => openFocus('open') },
    paused
      ? { label: 'Resume Focus', click: () => void focusService?.resume() }
      : { label: 'Pause Focus…', click: () => openFocus('pause') },
    { label: 'End Focus…', click: () => openFocus('end') },
    { type: 'separator' },
    // Quitting would drop the session's enforcement, so it goes through the
    // same exit flow as ending Focus.
    { label: 'Quit (end Focus first)…', click: () => openFocus('end') },
  ]));
}

async function quitApp(logger: Logger) {
  if (quitStarted) return;
  quitStarted = true;
  logger.info('[APP] Quit requested — flushing tracker.');
  try {
    await trackingService?.stop();
  } catch (e) {
    logger.error(`[APP] tracking stop error: ${(e as Error)?.message ?? e}`);
  }
  intelligenceScheduler?.stop();
  reflectionScheduler?.stop();
  try {
    // Releases blocking and persists the session; an open session is picked
    // up again by startup reconciliation.
    await focusService?.shutdown();
  } catch (e) {
    logger.error(`[APP] focus service shutdown error: ${(e as Error)?.message ?? e}`);
  }
  try {
    database?.close();
  } catch (e) {
    logger.error(`[APP] db close error: ${(e as Error)?.message ?? e}`);
  }
  tray?.destroy();
  quitting = true;
  app.quit();
}

if (!blockerHelperMode) app.whenReady().then(async () => {
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
    logger.error(`[APP] Database initialization failed: ${message}`);
    app.exit(1);
    return;
  }
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
    () => focusService?.getPreferences() ?? focusRepo.getPreferences(),
    ({ title, body }) => {
      if (!Notification.isSupported()) return;
      new Notification({ title, body, silent: true }).show();
    },
  );
  focusService.on('notice', (notice) => focusNotifier.onNotice(notice));
  focusService.on('summary', (session, profile) => focusNotifier.onSummary(session, profile));
  focusService.on('activeSessionChanged', (dto) => updateTray(dto, logger));
  focusService.on('tick', (dto) => updateTray(dto, logger));
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
      if (!focusService?.hasBlockingResidue() || !Notification.isSupported()) return;
      const notice = new Notification({
        title: 'Focus blocking is still on',
        body: 'Blocking from an earlier Focus session was not removed. Open Focus to remove it.',
        silent: true,
      });
      notice.on('click', () => openFocus('open'));
      notice.show();
    });
  logger.info('[APP] Focus service ready.');

  // --- Construct the tracking stack via DI ---
  const repo = new EventRepository(database);
  const engine = new HeartbeatEngine(repo, () => new Date(), 5000);

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
  registerSessionIpc(sessionService, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
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
  const timelineIpc = registerTimelineIpc(timelineService, activityRuleRepo, ipcHandleTracked, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
  registerCategorizationIpc(categorizationService, ipcHandleTracked, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
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
    metrics: reflectionMetrics,
    focus: focusRepo,
    userContext: userContextProvider,
    priorities: () => reflectionService?.syncPriorities() ?? reflectionRepo.listPriorities(),
    onChanged: () => notifyCoachChanged(),
    logger: intelligenceLogger,
  });
  // A Focus session that just ended is the evidence for the action it was for.
  focusService.on('summary', () => void coachService.onFocusEnded());

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
  const rendererContents = () => BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed());
  const reflectionIpc = registerReflectionIpc(reflectionService, ipcMainHandle, rendererContents);
  // A cycle runs right behind every intelligence cycle, so the AI activities
  // of the hour that just ended always exist first; its one timer wakes at
  // the user's reflection time so the end-of-day report does not wait an hour.
  reflectionScheduler = new ReflectionScheduler(reflectionService, {
    logger: intelligenceLogger,
    onGenerated: (results) => {
      reflectionIpc.notifyReflectionChanged();
      notifyCoachChanged();
      // The one proactive nudge: the day's reflection is ready. Calm, silent,
      // and only for a report the scheduler wrote about today or yesterday.
      const daily = results.find((r) => r.status === 'succeeded' && r.period.type === 'day');
      const recent = daily && Date.now() - Date.parse(daily.period.end) < 12 * 60 * 60 * 1000;
      if (!daily || !recent || !coachService.getSettings().notifyDailyReflection || !Notification.isSupported()) return;
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;
      const pending = coachService.getState().commitments.filter((a) => a.pending !== null).length;
      const notice = new Notification({
        title: 'Your reflection is ready',
        body: pending > 0 ? 'Reflect also has a question about something you planned.' : 'A short briefing on today, and what might be worth doing next.',
        silent: true,
      });
      notice.on('click', () => {
        showMainWindow();
        reflectionIpc.requestOpen();
      });
      notice.show();
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

  // --- Construct the export layer (Stage 3.8) ---
  const exportService = new ExportService(timelineService, repo, sessionService);
  registerExportIpc(exportService, ipcMainHandle);
  logger.info('[APP] Export service ready.');

  // --- Wire focus IPC (Stage 3.10) ---
  const focusIpc = registerFocusIpc(focusService, focusRepo, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
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
  sendFocusIntent = (intent) => focusIpc.sendIntent(intent);
  logger.info('[APP] Focus IPC ready.');

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

  // Startup reconciliation + hourly analysis. Runs in the background and never
  // blocks the UI; work done before the last shutdown is analysed now. Each
  // cycle is followed by a reflection cycle (missing closed periods, then the
  // evening reflection).
  reflectionScheduler.start();
  intelligenceScheduler.start();
});

app.on('window-all-closed', () => {
  // Stage 1 keeps tracking alive when the window is closed: hide to tray
  // instead of quitting. Real quit comes from the tray "Quit" menu only.
  if (process.platform === 'darwin') return;
  BrowserWindow.getAllWindows().forEach((w) => w.hide());
});

app.on('before-quit', async (e) => {
  // The blocker helper has no tracker, tray or database to flush.
  if (blockerHelperMode) return;
  // If Electron itself initiates quit (OS shutdown, an installer), give the
  // tracker a chance to flush and Focus a chance to release blocking before
  // exit. `quitApp` sets `quitting` right before its own `app.quit()`, so the
  // second pass through this handler falls straight through.
  if (quitting) return;
  e.preventDefault();
  await quitApp(appLogger ?? new Logger({ dir: app.getPath('userData'), source: 'app' }));
});

app.on('activate', () => {
  if (blockerHelperMode) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    const logger = new Logger({ dir: app.getPath('userData'), source: 'app' });
    createMainWindow(logger);
  }
});

function formatFocusMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// 16x16 1x1 transparent PNG (minimal placeholder tray icon).
const BASE64_TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAA3XAAAN1wFCKJt4AAAA' +
  'DklEQVR42mNk+M9QDwADhwH/xpYk2gAAAABJRU5ErkJggg==';
