import { describe, it, expect, vi } from 'vitest';
import { buildTrayModel, createTrayDispatcher, type TrayAction, type TrayItem } from '../../src/background/TrayMenu';
import { TRAY_ICON_SIZE, renderTrayIcon } from '../../src/background/trayIcon';
import { focusStatus, status } from './helpers';

const NOW = new Date(2026, 9, 5, 14, 0);

const flatten = (items: TrayItem[]): TrayItem[] => items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])]);
const labels = (items: TrayItem[]) => flatten(items).filter((i) => !i.separator).map((i) => i.label);
const actionOf = (items: TrayItem[], label: string): TrayAction | undefined => flatten(items).find((i) => i.label === label)?.action;

describe('tray menu', () => {
  it('while tracking: status, pause choices, Focus, open, widget, settings, quit', () => {
    const model = buildTrayModel(status(), NOW);
    expect(model.tooltip).toBe('Reflect — Tracking');
    expect(model.paused).toBe(false);
    expect(labels(model.items)).toEqual([
      'Reflect — Tracking',
      'Pause Tracking',
      'For 15 minutes',
      'For 1 hour',
      'Until tomorrow',
      'Until I resume',
      'Start Focus',
      'Open Reflect',
      'Hide Widget',
      'Settings',
      'Quit Reflect',
    ]);
    expect(model.items[0].disabled).toBe(true); // the status line is not clickable
  });

  it('every entry does exactly one thing', () => {
    const { items } = buildTrayModel(status(), NOW);
    expect(actionOf(items, 'Open Reflect')).toEqual({ type: 'open-main' });
    expect(actionOf(items, 'For 15 minutes')).toEqual({ type: 'pause-tracking', duration: '15m' });
    expect(actionOf(items, 'For 1 hour')).toEqual({ type: 'pause-tracking', duration: '1h' });
    expect(actionOf(items, 'Until tomorrow')).toEqual({ type: 'pause-tracking', duration: 'tomorrow' });
    expect(actionOf(items, 'Until I resume')).toEqual({ type: 'pause-tracking', duration: 'manual' });
    expect(actionOf(items, 'Start Focus')).toEqual({ type: 'open-focus', intent: 'open' });
    expect(actionOf(items, 'Hide Widget')).toEqual({ type: 'set-widget', visible: false });
    expect(actionOf(items, 'Settings')).toEqual({ type: 'open-settings' });
    expect(actionOf(items, 'Quit Reflect')).toEqual({ type: 'quit' });
  });

  it('shows the paused state clearly and offers Resume', () => {
    const until = new Date(2026, 9, 5, 15, 30).toISOString();
    const model = buildTrayModel(status({ tracking: 'paused', pausedUntil: until, currentActivity: null }), NOW);
    expect(model.paused).toBe(true);
    expect(model.tooltip).toMatch(/^Reflect — Tracking paused until /);
    expect(labels(model.items)).toContain('Resume Tracking');
    expect(labels(model.items)).not.toContain('Pause Tracking');
    expect(actionOf(model.items, 'Resume Tracking')).toEqual({ type: 'resume-tracking' });

    const manual = buildTrayModel(status({ tracking: 'paused' }), NOW);
    expect(manual.tooltip).toBe('Reflect — Tracking paused');
  });

  it('offers Show Widget when it is hidden', () => {
    const { items } = buildTrayModel(status({ widgetVisible: false }), NOW);
    expect(actionOf(items, 'Show Widget')).toEqual({ type: 'set-widget', visible: true });
    expect(labels(items)).not.toContain('Hide Widget');
  });

  it('points at an unread reflection', () => {
    const { items } = buildTrayModel(status({ reflectionPending: true }), NOW);
    expect(actionOf(items, 'Open your reflection')).toEqual({ type: 'open-reflection' });
    expect(labels(buildTrayModel(status(), NOW).items)).not.toContain('Open your reflection');
  });

  it('mirrors the Focus session FocusService reports', () => {
    const model = buildTrayModel(status({ focus: focusStatus() }), NOW);
    expect(model.tooltip).toBe('Focus · 39 min left — Build landing page');
    expect(labels(model.items)).toEqual(
      expect.arrayContaining(['Focus: 39 min left', 'Build landing page', 'Blocking active', 'Open Focus', 'Pause Focus…', 'End Focus…']),
    );
    expect(actionOf(model.items, 'Pause Focus…')).toEqual({ type: 'open-focus', intent: 'pause' });
    expect(actionOf(model.items, 'End Focus…')).toEqual({ type: 'open-focus', intent: 'end' });

    const paused = buildTrayModel(status({ focus: focusStatus({ isRunning: false, pauseKind: 'manual' }) }), NOW);
    expect(actionOf(paused.items, 'Resume Focus')).toEqual({ type: 'resume-focus' });
    expect(labels(paused.items)).toContain('Focus paused: 39 min left');

    const stopwatch = buildTrayModel(status({ focus: focusStatus({ remainingMs: null }) }), NOW);
    expect(labels(stopwatch.items)).toContain('Focus: 11 min');
  });

  it('is not a shortcut around a Focus commitment: quitting goes through the exit flow', () => {
    const { items } = buildTrayModel(status({ focus: focusStatus() }), NOW);
    expect(labels(items)).not.toContain('Quit Reflect');
    expect(actionOf(items, 'Quit (end Focus first)…')).toEqual({ type: 'open-focus', intent: 'end' });
    expect(flatten(items).some((i) => i.action?.type === 'quit')).toBe(false);
  });

  it('tracking can still be paused during Focus, and both states are visible', () => {
    const model = buildTrayModel(status({ tracking: 'paused', focus: focusStatus() }), NOW);
    expect(model.tooltip).toContain('tracking paused');
    expect(labels(model.items)).toContain('Resume Tracking');
  });

  it('rebuilds the menu only when its contents change', () => {
    const base = buildTrayModel(status(), NOW).key;
    expect(buildTrayModel(status({ todayTrackedMs: 1 }), NOW).key).toBe(base); // not shown in the menu
    expect(buildTrayModel(status({ tracking: 'paused' }), NOW).key).not.toBe(base);
    expect(buildTrayModel(status({ widgetVisible: false }), NOW).key).not.toBe(base);
    expect(buildTrayModel(status({ reflectionPending: true }), NOW).key).not.toBe(base);

    const focus = buildTrayModel(status({ focus: focusStatus() }), NOW).key;
    expect(buildTrayModel(status({ focus: focusStatus({ remainingMs: 38 * 60_000 + 5_000 }) }), NOW).key).toBe(focus); // same minute
    expect(buildTrayModel(status({ focus: focusStatus({ remainingMs: 37 * 60_000 }) }), NOW).key).not.toBe(focus);
  });
});

describe('tray dispatcher', () => {
  function setup() {
    const deps = {
      openMain: vi.fn(),
      reflectionAnchor: vi.fn(() => '2026-10-04T00:00:00.000Z'),
      resumeFocus: vi.fn(),
      pauseTracking: vi.fn(),
      resumeTracking: vi.fn(),
      setWidgetVisible: vi.fn(),
      quit: vi.fn(),
    };
    return { deps, dispatch: createTrayDispatcher(deps) };
  }

  it('Open Reflect / Settings / reflection / Focus open the main window at the right place', () => {
    const { deps, dispatch } = setup();
    dispatch({ type: 'open-main' });
    dispatch({ type: 'open-settings' });
    dispatch({ type: 'open-reflection' });
    dispatch({ type: 'open-focus', intent: 'end' });
    expect(deps.openMain.mock.calls).toEqual([
      [],
      [{ route: 'settings' }],
      [{ route: 'reflection', anchor: '2026-10-04T00:00:00.000Z' }],
      [{ route: 'focus', intent: 'end' }],
    ]);
  });

  it('Pause / Resume reach the tracking controller', () => {
    const { deps, dispatch } = setup();
    dispatch({ type: 'pause-tracking', duration: '1h' });
    dispatch({ type: 'resume-tracking' });
    expect(deps.pauseTracking).toHaveBeenCalledWith('1h');
    expect(deps.resumeTracking).toHaveBeenCalledTimes(1);
  });

  it('Show / Hide Widget only touches the widget', () => {
    const { deps, dispatch } = setup();
    dispatch({ type: 'set-widget', visible: false });
    dispatch({ type: 'set-widget', visible: true });
    expect(deps.setWidgetVisible.mock.calls).toEqual([[false], [true]]);
    expect(deps.pauseTracking).not.toHaveBeenCalled();
    expect(deps.resumeTracking).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('Quit — and only Quit — quits', () => {
    const { deps, dispatch } = setup();
    dispatch({ type: 'open-main' });
    dispatch({ type: 'resume-focus' });
    expect(deps.quit).not.toHaveBeenCalled();
    dispatch({ type: 'quit' });
    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(deps.resumeFocus).toHaveBeenCalledTimes(1);
  });
});

describe('tray icon', () => {
  it('draws a visible icon, and a different one while paused', () => {
    const running = renderTrayIcon(false);
    const paused = renderTrayIcon(true);
    expect(running).toHaveLength(TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4);
    const opaque = (b: Buffer) => b.filter((_, i) => i % 4 === 3 && b[i] === 255).length;
    expect(opaque(running)).toBeGreaterThan(400); // not the old transparent placeholder
    expect(running.equals(paused)).toBe(false);
    // Corners stay transparent: it is a disc.
    expect(running[3]).toBe(0);
  });
});
