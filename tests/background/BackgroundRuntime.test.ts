import { describe, it, expect, vi } from 'vitest';
import { AppSettingsStore } from '../../src/background/AppSettings';
import { BackgroundStatusService } from '../../src/background/BackgroundStatus';
import { MainWindowController } from '../../src/background/MainWindowController';
import { Notifier } from '../../src/background/Notifier';
import { ReflectionNotifier } from '../../src/background/ReflectionNotifier';
import { ShutdownSequence } from '../../src/background/Startup';
import { TrackingController } from '../../src/background/TrackingController';
import { createTrayDispatcher } from '../../src/background/TrayMenu';
import { WidgetController } from '../../src/background/WidgetController';
import { PendingNavigation, registerBackgroundIpc } from '../../src/background/backgroundIpc';
import { IntelligenceScheduler } from '../../src/intelligence/IntelligenceScheduler';
import type { ActiveFocusSessionDto } from '../../src/focus/FocusModels';
import type { ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../src/reflection/ReflectionScheduler';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';
import { TrackingService } from '../../src/tracker/TrackingService';
import { WindowWatcher } from '../../src/tracker/watcher/WindowWatcher';
import { NARROW_SCHEDULE, local, makeReflectionHarness, modelReflection, seedThreads, workday } from '../reflection/helpers';
import { FakeEventRepository } from '../tracker/FakeEventRepository';
import { FakeMainWindow, FakeSettingsRepository, fakeWidgetHost, manualTimers, silentLogger } from './helpers';

/**
 * The background runtime, assembled the way `main.ts` assembles it — real
 * tracking, pause control, status, widget, main-window lifecycle, schedulers
 * and notifications — with only Electron itself replaced by fakes.
 *
 * These tests are about what must NOT depend on what: nothing below needs the
 * main window, and no failing subsystem may take tracking down.
 */

/** What survives a restart: the settings row, the events, the pause log, the notification ledger. */
function persistentState() {
  return {
    settings: new FakeSettingsRepository(),
    events: new FakeEventRepository(),
    pauses: [] as { startedAt: string; endedAt: string }[],
    notified: new Set<string>(),
  };
}

function boot(disk = persistentState(), startAt = new Date(2026, 9, 5, 9, 0, 0)) {
  let now = startAt;
  let focus: ActiveFocusSessionDto | null = null;

  // Tracking: watcher → heartbeat engine → repository, exactly as in production.
  const engine = new HeartbeatEngine(disk.events, () => now, 5000, undefined, 30_000);
  // The real watcher, with nothing in front: the tests feed samples through observe().
  const watcher = new WindowWatcher(async () => null, engine, 1_000_000, silentLogger);
  const tracking = new TrackingService([watcher], engine, silentLogger);
  const settings = new AppSettingsStore(disk.settings);
  const pauseTimers = manualTimers();
  const trackingController = new TrackingController({
    tracking,
    settings,
    pauses: { recordPause: (startedAt, endedAt) => disk.pauses.push({ startedAt, endedAt }) },
    nextDayStart: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1),
    now: () => now,
    timers: pauseTimers,
    logger: silentLogger,
  });

  // Surfaces.
  const widgetHost = fakeWidgetHost();
  const widget: WidgetController = new WidgetController({
    host: widgetHost.host,
    settings,
    onVisibilityChanged: () => statusService.refresh(),
    setTimeout: () => undefined,
  });
  const mainWindows: FakeMainWindow[] = [];
  const state = { quitting: false };
  const navigation = new PendingNavigation();
  const mainWindow = new MainWindowController({
    create: () => {
      const window = new FakeMainWindow();
      mainWindows.push(window);
      return window;
    },
    navigation,
    isQuitting: () => state.quitting,
    releaseAfterHiddenMs: 600_000,
    timers: manualTimers(),
  });

  const statusService: BackgroundStatusService = new BackgroundStatusService({
    tracking: trackingController,
    events: {
      sumTrackedMs: (from, to) =>
        disk.events.getOverlapping(from, to).reduce((sum, e) => sum + (Date.parse(e.endedAt) - Date.parse(e.startedAt)), 0),
      getLatest: () => disk.events.getAll().at(-1) ?? null,
    },
    focus: { getActiveSession: () => focus },
    widgetVisible: () => widget.visible,
    dayStart: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate()),
    now: () => now,
    timers: manualTimers(),
  });
  const trayStatuses: string[] = [];
  statusService.onChanged((status) => {
    trayStatuses.push(status.tracking);
    widget.pushStatus(status);
    mainWindow.send('background:status', status);
  });
  trackingController.onChanged(() => statusService.refresh());
  settings.onChanged((next, previous) => {
    if (next.widgetEnabled !== previous.widgetEnabled) widget.sync();
    statusService.refresh();
  });

  // Quit.
  const dbClosed = vi.fn();
  const shutdown = new ShutdownSequence(
    [
      { name: 'tracking', run: () => trackingController.shutdown() },
      { name: 'status', run: () => statusService.stop() },
      { name: 'widget', run: () => widget.dispose() },
      { name: 'database', run: dbClosed },
    ],
    silentLogger,
  );
  const quit = vi.fn(async () => {
    await shutdown.run();
    state.quitting = true;
  });
  const tray = createTrayDispatcher({
    openMain: (target) => mainWindow.open(target),
    reflectionAnchor: () => statusService.reflectionAnchor,
    resumeFocus: () => {},
    pauseTracking: (duration) => void trackingController.pause(duration),
    resumeTracking: () => void trackingController.resume(),
    setWidgetVisible: (visible) => widget.setEnabled(visible),
    quit: () => void quit(),
  });

  const start = async (options: { background: boolean }) => {
    await trackingController.start();
    statusService.start();
    widget.sync();
    if (!options.background) mainWindow.open();
  };

  return {
    disk,
    tracking,
    trackingController,
    settings,
    widget,
    widgetHost,
    mainWindow,
    mainWindows,
    navigation,
    statusService,
    trayStatuses,
    tray,
    quit,
    shutdown,
    dbClosed,
    start,
    /** One watcher poll at the given time, with the given app in front. */
    async observe(app: string, at: Date) {
      now = at;
      engine.emit({ watcher: 'window', app, title: app });
      engine.flush();
    },
    setNow: (d: Date) => {
      now = d;
    },
    setFocus: (dto: ActiveFocusSessionDto | null) => {
      focus = dto;
      statusService.refresh();
    },
  };
}

const t9 = (m: number, s = 0) => new Date(2026, 9, 5, 9, m, s);

describe('background runtime — startup', () => {
  it('started in the background: tracking, status and widget are up and no main window exists', async () => {
    const rt = boot();
    await rt.start({ background: true });

    expect(rt.tracking.isRunning).toBe(true);
    expect(rt.widget.visible).toBe(true);
    expect(rt.mainWindows).toHaveLength(0); // the UI was never opened
    expect(rt.statusService.getStatus()).toMatchObject({ tracking: 'running', widgetVisible: true });

    await rt.observe('Code', t9(0, 5));
    await rt.observe('Chrome', t9(2));
    expect(rt.disk.events.inserts.map((e) => e.app)).toContain('Chrome');
  });

  it('started by the user: the same runtime, plus the window', async () => {
    const rt = boot();
    await rt.start({ background: false });
    expect(rt.mainWindows).toHaveLength(1);
    expect(rt.tracking.isRunning).toBe(true);
  });

  it('tracking does not depend on the main window being open', async () => {
    const rt = boot();
    await rt.start({ background: false });
    await rt.observe('Code', t9(0, 5));

    rt.mainWindows[0].userCloses(); // X
    expect(rt.mainWindows[0].visible).toBe(false);
    expect(rt.tracking.isRunning).toBe(true);
    await rt.observe('Chrome', t9(1));
    await rt.observe('Slack', t9(3));

    rt.mainWindows[0].minimized = true; // minimize
    await rt.observe('Code', t9(5));

    rt.mainWindows[0].crash(); // renderer gone
    expect(rt.mainWindow.exists).toBe(false);
    await rt.observe('Figma', t9(8));

    expect(rt.tracking.isRunning).toBe(true);
    expect(rt.disk.events.inserts.map((e) => e.app)).toEqual(['Code', 'Chrome', 'Slack', 'Code', 'Figma']);
    expect(rt.trackingController.getState().state).toBe('running');

    // Reopened: a new window, and everything captured meanwhile is there.
    rt.mainWindow.open();
    expect(rt.mainWindows).toHaveLength(2);
    expect(rt.disk.events.getAll()).toHaveLength(5);
  });
});

describe('background runtime — widget and tray', () => {
  it('hiding the widget does not pause tracking, schedulers or Focus', async () => {
    const rt = boot();
    await rt.start({ background: true });
    rt.tray({ type: 'set-widget', visible: false });

    expect(rt.widget.visible).toBe(false);
    expect(rt.tracking.isRunning).toBe(true);
    expect(rt.statusService.getStatus()).toMatchObject({ tracking: 'running', widgetVisible: false });
    await rt.observe('Code', t9(1));
    expect(rt.disk.events.inserts).toHaveLength(1);

    rt.tray({ type: 'set-widget', visible: true });
    expect(rt.widget.visible).toBe(true);
    expect(rt.tracking.isRunning).toBe(true);
  });

  it('the widget survives the main window closing, being released and being recreated', async () => {
    const rt = boot();
    await rt.start({ background: false });
    const widgetWindow = rt.widgetHost.windows[0];

    rt.mainWindows[0].userCloses();
    rt.mainWindows[0].destroy(); // released
    rt.mainWindow.open();

    expect(rt.widgetHost.windows).toHaveLength(1);
    expect(widgetWindow.destroyed).toBe(false);
    expect(rt.widget.visible).toBe(true);
  });

  it('pause and resume from the tray show up on every surface', async () => {
    const rt = boot();
    await rt.start({ background: true });
    const widgetWindow = rt.widgetHost.windows[0];

    rt.tray({ type: 'pause-tracking', duration: '1h' });
    await vi.waitFor(() => expect(rt.tracking.isRunning).toBe(false));
    expect(rt.statusService.getStatus().tracking).toBe('paused');
    expect(widgetWindow.sent.at(-1)).toMatchObject({ channel: 'widget:status', payload: { tracking: 'paused' } });
    expect(rt.trayStatuses.at(-1)).toBe('paused');

    rt.tray({ type: 'resume-tracking' });
    await vi.waitFor(() => expect(rt.tracking.isRunning).toBe(true));
    expect(widgetWindow.sent.at(-1)).toMatchObject({ payload: { tracking: 'running' } });
    expect(rt.trayStatuses.at(-1)).toBe('running');
  });

  it('the widget shows the Focus session FocusService reports', async () => {
    const rt = boot();
    await rt.start({ background: true });
    rt.setFocus({
      session: { id: 'fs-1', task: 'Build landing page' },
      profile: { name: 'Deep Work' },
      liveElapsedMs: 0,
      isRunning: true,
      remainingMs: 50 * 60_000,
      plannedEndsAt: null,
      pauseKind: null,
      blocking: { status: 'active', ruleCount: 2, message: null },
    } as unknown as ActiveFocusSessionDto);

    expect(rt.widgetHost.windows[0].sent.at(-1)).toMatchObject({
      payload: { focus: { task: 'Build landing page', isRunning: true, remainingMs: 50 * 60_000 } },
    });
    rt.setFocus(null);
    expect(rt.widgetHost.windows[0].sent.at(-1)).toMatchObject({ payload: { focus: null } });
  });

  it('Focus state is still served with the main window closed', async () => {
    const rt = boot();
    await rt.start({ background: false });
    rt.mainWindows[0].userCloses();
    rt.setFocus({
      session: { id: 'fs-1', task: 'Write tests' },
      profile: { name: 'Deep Work' },
      liveElapsedMs: 5_000,
      isRunning: true,
      remainingMs: null,
      plannedEndsAt: null,
      pauseKind: null,
      blocking: { status: 'off', ruleCount: 0, message: null },
    } as unknown as ActiveFocusSessionDto);
    expect(rt.statusService.getStatus().focus).toMatchObject({ task: 'Write tests', isRunning: true });
    expect(rt.tracking.isRunning).toBe(true);
  });

  it('the widget may ask for exactly what its IPC allows — and "hide" leaves tracking on', async () => {
    const rt = boot();
    await rt.start({ background: true });
    const widgetChannels = new Map<string, (p?: any) => any>();
    registerBackgroundIpc(
      {
        status: rt.statusService,
        tracking: rt.trackingController,
        settings: { view: () => ({}) as never, update: () => ({}) as never },
        navigation: rt.navigation,
        widget: rt.widget,
        openMain: (target) => rt.mainWindow.open(target),
        reflectionAnchor: () => null,
      },
      { handleMain: () => {}, handleWidget: (key, handler) => widgetChannels.set(key, handler), onWidget: () => {} },
    );

    await widgetChannels.get('widget:act')!({ type: 'hide' });
    expect(rt.widget.visible).toBe(false);
    expect(rt.tracking.isRunning).toBe(true);
    expect(rt.disk.settings.stored?.widgetEnabled).toBe(false);

    await widgetChannels.get('widget:act')!({ type: 'open-main' });
    expect(rt.mainWindows).toHaveLength(1);
  });
});

describe('background runtime — quit and restart', () => {
  it('closing the window never quits; the tray’s Quit stops tracking, flushes and shuts everything down', async () => {
    const rt = boot();
    await rt.start({ background: false });
    await rt.observe('Code', t9(0, 5));

    rt.mainWindows[0].userCloses();
    expect(rt.quit).not.toHaveBeenCalled();
    expect(rt.tracking.isRunning).toBe(true);

    rt.setNow(t9(0, 20));
    rt.tray({ type: 'quit' });
    await vi.waitFor(() => expect(rt.dbClosed).toHaveBeenCalledTimes(1));

    expect(rt.tracking.isRunning).toBe(false);
    expect(rt.widget.visible).toBe(false);
    // The open event was flushed up to the moment of quitting.
    expect(rt.disk.events.getAll()[0].endedAt).toBe(t9(0, 20).toISOString());
    // Only now may the window really close.
    expect(rt.mainWindows[0].userCloses()).toBe(true);
  });

  it('two quit requests at once shut down once', async () => {
    const rt = boot();
    await rt.start({ background: true });
    await Promise.all([rt.quit(), rt.quit(), rt.shutdown.run()]);
    expect(rt.dbClosed).toHaveBeenCalledTimes(1);
  });

  it('a restart recovers: tracking starts again, and the widget and its position are as the user left them', async () => {
    const first = boot();
    await first.start({ background: true });
    await first.observe('Code', t9(0, 5));
    first.widgetHost.state.cursor = { x: 1700, y: 30 };
    first.widget.dragStart();
    first.widgetHost.state.cursor = { x: 400, y: 300 };
    first.widget.dragMove();
    first.widget.dragEnd();
    await first.quit();

    // Windows restarts; Reflect is started by the login item.
    const second = boot(first.disk, new Date(2026, 9, 6, 8, 0));
    await second.start({ background: true });
    expect(second.tracking.isRunning).toBe(true);
    expect(second.mainWindows).toHaveLength(0);
    expect(second.widgetHost.windows[0].bounds).toMatchObject(first.disk.settings.stored!.widgetPosition!);

    await second.observe('Code', new Date(2026, 9, 6, 8, 0, 5));
    const events = second.disk.events.getAll();
    expect(events).toHaveLength(2); // the night between the two runs belongs to no event
    expect(events[0].endedAt < events[1].startedAt).toBe(true);
  });

  it('an unexpected termination loses at most the unflushed tail, and the next start is clean', async () => {
    const first = boot();
    await first.start({ background: true });
    await first.observe('Code', t9(0, 5));
    await first.observe('Code', t9(0, 10));
    // The process is killed here: no shutdown, nothing flushed after 09:00:10.

    const second = boot(first.disk, new Date(2026, 9, 5, 9, 30));
    await second.start({ background: true });
    await second.observe('Code', new Date(2026, 9, 5, 9, 30, 5));

    const events = second.disk.events.getAll();
    expect(events).toHaveLength(2);
    expect(events[0].endedAt).toBe(t9(0, 10).toISOString()); // not stretched over the 20 minutes it was dead
    expect(second.tracking.isRunning).toBe(true);
  });

  it('a pause and a hidden widget both survive a restart', async () => {
    const first = boot();
    await first.start({ background: true });
    await first.trackingController.pause('manual');
    first.widget.setEnabled(false);
    await first.quit();

    const second = boot(first.disk, new Date(2026, 9, 6, 8, 0));
    await second.start({ background: true });
    expect(second.tracking.isRunning).toBe(false);
    expect(second.statusService.getStatus().tracking).toBe('paused');
    expect(second.widget.visible).toBe(false);
    expect(second.widgetHost.windows).toHaveLength(0);
  });
});

// ── Schedulers and notifications, with no window anywhere ────────────────────

const day = (d: number) => periodContaining('day', local(d));
const week = (d: number) => periodContaining('week', local(d));

function reflectionRuntime(now: Date, ledger = new Set<string>(), notificationsFail = false) {
  const h = makeReflectionHarness({ activities: [5, 6, 7, 8, 9, 12, 13, 14, 15].flatMap(workday), now, config: NARROW_SCHEDULE });
  seedThreads(h.repo, h.activities);

  const shown: { title: string; body: string; click: () => void }[] = [];
  const notifier = new Notifier({
    isEnabled: () => true,
    isSupported: () => true,
    create: (options) => {
      let click = () => {};
      return {
        show: () => {
          if (notificationsFail) throw new Error('notification centre unavailable');
          shown.push({ ...options, click: () => click() });
        },
        on: (event, listener) => {
          if (event === 'click') click = () => listener();
        },
      };
    },
    logger: silentLogger,
  });
  let clock = now;
  const opened: string[] = [];
  const pending: string[] = [];
  const makeScheduler = () => {
    const reflectionNotifier = new ReflectionNotifier({
      ledger: {
        claim: (key) => {
          if (ledger.has(key)) return false;
          ledger.add(key);
          return true;
        },
      },
      wantsNotification: () => true,
      isUserLooking: () => false, // there is no window at all
      pendingQuestions: () => 0,
      notify: (request) => notifier.show(request),
      onPending: (notice) => pending.push(notice.period.key),
      open: (notice) => opened.push(notice.period.key),
      now: () => clock,
    });
    const scheduler = new ReflectionScheduler(h.service, { onGenerated: (results) => reflectionNotifier.onGenerated(results) });
    scheduler.start();
    return scheduler;
  };
  return {
    h,
    shown,
    opened,
    pending,
    ledger,
    makeScheduler,
    script: (...periods: ReflectionPeriod[]) => periods.forEach((p) => h.gemini.push(modelReflection(p))),
    setNow: (d: Date) => {
      clock = d;
      h.setNow(d);
    },
  };
}

describe('background runtime — reflection without a window', () => {
  it('writes the reflection and notifies with the UI closed; the click opens that report', async () => {
    const rt = reflectionRuntime(local(15, '09:00')); // Thursday morning
    const scheduler = rt.makeScheduler();
    rt.script(week(7), day(12), day(13), day(14));

    const cycle = await scheduler.runCycle();
    // In the order the periods ended.
    expect(cycle.results.filter((r) => r.status === 'succeeded').map((r) => r.period.key)).toEqual([
      '2026-W41',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
    // Persisted — nothing waited for a renderer.
    expect(rt.h.repo.getCurrentReport('day', '2026-10-14')).not.toBeNull();

    // A backlog of three days is ONE notification, about the latest day.
    expect(rt.shown).toHaveLength(1);
    expect(rt.shown[0]).toMatchObject({ title: 'Your reflection is ready', body: 'A few things stood out about yesterday.' });
    expect(rt.pending).toEqual(['2026-10-14']);

    rt.shown[0].click();
    expect(rt.opened).toEqual(['2026-10-14']);
  });

  it('a missed reflection time is recovered at the next start — generated once, notified once', async () => {
    const rt = reflectionRuntime(local(15, '09:00'));
    const scheduler = rt.makeScheduler();
    rt.script(week(7), day(12), day(13), day(14));
    await scheduler.runCycle();
    scheduler.stop();
    // The machine is switched off before Thursday's 22:00 reflection time.
    expect(rt.h.repo.getCurrentReport('day', '2026-10-15')).toBeNull();

    // Friday morning: Reflect starts with Windows. No window is opened.
    rt.setNow(local(16, '09:00'));
    const afterRestart = rt.makeScheduler();
    rt.script(day(15));
    const recovered = await afterRestart.runCycle();
    expect(recovered.results.filter((r) => r.status === 'succeeded').map((r) => r.period.key)).toEqual(['2026-10-15']);
    expect(rt.h.repo.getCurrentReport('day', '2026-10-15')).not.toBeNull();
    expect(rt.shown.map((n) => n.body)).toEqual(['A few things stood out about yesterday.', 'A few things stood out about yesterday.']);
    expect(rt.pending).toEqual(['2026-10-14', '2026-10-15']);

    // Later cycles — and yet another restart — find a valid report: no second
    // model call, no second report, no second notification.
    const calls = rt.h.gemini.requests.length;
    for (let i = 0; i < 3; i++) expect((await afterRestart.runCycle()).results).toEqual([]);
    const again = rt.makeScheduler();
    expect((await again.runCycle()).results).toEqual([]);
    expect(rt.h.gemini.requests.length).toBe(calls);
    expect(rt.h.repo.listCurrentReports('day', 10)).toHaveLength(4);
    expect(rt.shown).toHaveLength(2);
  });

  it('a report that already exists is not announced again after a restart', async () => {
    const ledger = new Set<string>(['reflection-ready:2026-10-14']); // announced before the restart
    const rt = reflectionRuntime(local(15, '09:00'), ledger);
    const scheduler = rt.makeScheduler();
    rt.script(week(7), day(12), day(13), day(14));
    await scheduler.runCycle();
    expect(rt.shown).toHaveLength(0);
  });
});

describe('background runtime — failure isolation', () => {
  it('a Gemini outage stops neither tracking nor the next cycle', async () => {
    const rt = boot();
    await rt.start({ background: true });

    const processBacklog = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed: ENOTFOUND generativelanguage.googleapis.com'))
      .mockResolvedValue({ status: 'completed', windowsConsidered: 0, results: [] });
    const followUp = vi.fn();
    const intelligence = new IntelligenceScheduler(
      { processBacklog, recoverInterruptedRuns: () => 0 },
      { timers: manualTimers(), onCycleComplete: followUp, logger: silentLogger },
    );
    intelligence.start();
    await vi.waitFor(() => expect(followUp).toHaveBeenCalledTimes(1));
    expect(followUp.mock.calls[0][0]).toMatchObject({ status: 'stopped' });

    expect(rt.tracking.isRunning).toBe(true);
    await rt.observe('Code', t9(1));
    expect(rt.disk.events.inserts).toHaveLength(1);

    // Retried later, like any other cycle.
    expect((await intelligence.runCycle()).status).toBe('completed');
    intelligence.stop();
  });

  it('a failed reflection stops neither tracking nor later reflections', async () => {
    const rt = boot();
    await rt.start({ background: true });

    const reflections = reflectionRuntime(local(15, '09:00'));
    const scheduler = reflections.makeScheduler(); // nothing scripted: every model call fails
    const cycle = await scheduler.runCycle();
    expect(cycle.results.some((r) => r.status === 'succeeded')).toBe(false);
    expect(reflections.shown).toHaveLength(0); // nothing was written, so nothing is announced

    expect(rt.tracking.isRunning).toBe(true);
    await rt.observe('Code', t9(1));
    expect(rt.disk.events.inserts).toHaveLength(1);
  });

  it('a failing notification stops neither the reflection nor tracking', async () => {
    const rt = boot();
    await rt.start({ background: true });

    const reflections = reflectionRuntime(local(15, '09:00'), new Set(), true);
    const scheduler = reflections.makeScheduler();
    reflections.script(week(7), day(12), day(13), day(14));
    const cycle = await scheduler.runCycle();

    expect(cycle.status).toBe('completed');
    expect(reflections.h.repo.getCurrentReport('day', '2026-10-14')).not.toBeNull(); // the report is safe
    expect(reflections.pending).toEqual(['2026-10-14']); // the widget and tray still point at it
    expect(rt.tracking.isRunning).toBe(true);
  });

  it('a broken widget or a dead main-window renderer stops nothing', async () => {
    const rt = boot();
    await rt.start({ background: false });
    rt.widgetHost.windows[0].failSend = true;
    rt.mainWindows[0].failSend = true;

    await expect(rt.trackingController.pause('15m')).resolves.toMatchObject({ state: 'paused' });
    await expect(rt.trackingController.resume()).resolves.toMatchObject({ state: 'running' });
    rt.widgetHost.windows[0].crash();

    expect(rt.tracking.isRunning).toBe(true);
    await rt.observe('Code', t9(1));
    expect(rt.disk.events.inserts).toHaveLength(1);
  });
});
