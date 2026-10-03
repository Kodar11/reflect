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
import { FocusRepository } from '../database/FocusRepository.js';
import { FocusService } from '../focus/FocusService.js';
import { StubBlockingManager } from '../focus/BlockingManager.js';
import { registerFocusIpc } from '../focus/focusIpc.js';
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

// Prototype secret loading: in development, read GEMINI_API_KEY (and friends)
// from a git-ignored `.env` in the project root. The key stays in the main
// process — it is never sent over IPC or exposed through preload.
if (isDev()) {
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
  intelligenceScheduler?.stop();
  reflectionScheduler?.stop();
  try {
    focusService?.destroy();
  } catch (e) {
    logger.error(`[APP] focus service destroy error: ${(e as Error)?.message ?? e}`);
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
  const blockingManager = new StubBlockingManager();
  focusService = new FocusService(focusRepo, blockingManager);
  await focusService.reconcileActiveSession();
  focusService.on('activeSessionChanged', (dto) => {
    tray?.setToolTip(dto ? `▶ ${dto.session.task} — ${formatFocusMs(dto.remainingMs ?? dto.liveElapsedMs)}` : 'Productivity Coach');
  });
  logger.info('[APP] Focus service ready.');

  // --- Construct the tracking stack via DI ---
  const repo = new EventRepository(database);
  const engine = new HeartbeatEngine(repo, () => new Date(), 5000, () => focusService?.recordActivity());

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
  // Confirmed learned rules are classification knowledge the model may use as
  // context. Reflection never creates them.
  const learnedPatternLabels = (): string[] => {
    const taxonomy = reflectionTaxonomy();
    const labels: string[] = [];
    for (const rule of activityRuleRepo.listRules()) {
      if (rule.source !== 'learned' || rule.enabled !== 1) continue;
      try {
        const pattern = describePattern(JSON.parse(rule.conditions) as RuleCondition[]);
        const classification = describeClassification({
          context: rule.activityId ? taxonomy.contexts[rule.activityId] ?? null : null,
          area: rule.areaId ? taxonomy.areas[rule.areaId] ?? null : null,
          intent: rule.intentId ? taxonomy.intents[rule.intentId] ?? null : null,
          quality: rule.qualityId ? taxonomy.qualities[rule.qualityId] ?? null : null,
        });
        if (pattern && classification) labels.push(`${pattern} is usually ${classification}`);
      } catch {
        // Malformed rule conditions — not worth mentioning to the model.
      }
      if (labels.length >= 10) break;
    }
    return labels;
  };
  reflectionService = new ReflectionService({
    repo: reflectionRepo,
    gemini: geminiClient,
    metrics: reflectionMetrics,
    annotator: new ReflectionAnnotator({ gemini: geminiClient, repo: reflectionRepo, logger: intelligenceLogger }),
    userContext: userContextProvider,
    profiles: userProfileRepo,
    taxonomy: reflectionTaxonomy,
    learnedPatterns: learnedPatternLabels,
    logger: intelligenceLogger,
  });
  const reflectionIpc = registerReflectionIpc(reflectionService, ipcMainHandle, () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents).filter((wc) => !wc.isDestroyed()),
  );
  // No timer of its own: a cycle runs right behind every intelligence cycle,
  // so the AI activities of the hour that just ended always exist first.
  reflectionScheduler = new ReflectionScheduler(reflectionService, {
    logger: intelligenceLogger,
    onGenerated: () => reflectionIpc.notifyReflectionChanged(),
  });
  logger.info('[APP] Reflection service ready.');

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
      void reflectionScheduler?.runCycle();
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
  registerFocusIpc(focusService, focusRepo, ipcMainHandle, () =>
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
      const profile = focusRepo.getProfileById(session.profileId);
      if (!profile) {
        throw new Error(`Focus profile not found for session: ${session.profileId}`);
      }
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
  );
  logger.info('[APP] Focus service ready.');

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
