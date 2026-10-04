import { describe, it, expect, vi } from 'vitest';
import {
  PendingNavigation,
  parsePauseDuration,
  parseSettingsPatch,
  parseWidgetAction,
  registerBackgroundIpc,
  type BackgroundSettingsView,
} from '../../src/background/backgroundIpc';
import { status } from './helpers';

function setup() {
  const main = new Map<string, (payload?: any) => any>();
  const widget = new Map<string, (payload?: any) => any>();
  const widgetEvents = new Map<string, (payload: any) => void>();
  const view: BackgroundSettingsView = {
    startWithWindows: true,
    widgetEnabled: true,
    notificationsEnabled: true,
    startupAvailable: true,
    startupDisabledBySystem: false,
  };
  const deps = {
    status: { getStatus: vi.fn(() => status()) },
    tracking: {
      pause: vi.fn(async () => ({ state: 'paused' as const, pausedSince: 'x', pausedUntil: null })),
      resume: vi.fn(async () => ({ state: 'running' as const, pausedSince: null, pausedUntil: null })),
    },
    settings: { view: vi.fn(() => view), update: vi.fn((patch) => ({ ...view, ...patch })) },
    navigation: new PendingNavigation(),
    widget: { setEnabled: vi.fn(), setExpanded: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
    openMain: vi.fn(),
    reflectionAnchor: vi.fn(() => '2026-10-04T00:00:00.000Z'),
  };
  registerBackgroundIpc(deps, {
    handleMain: (key, handler) => main.set(key, handler),
    handleWidget: (key, handler) => widget.set(key, handler),
    onWidget: (key, handler) => widgetEvents.set(key, handler),
  });
  return { deps, main, widget, widgetEvents };
}

describe('background IPC — surface', () => {
  it('registers a small, fixed set of channels per page', () => {
    const t = setup();
    expect([...t.main.keys()].sort()).toEqual([
      'background:getSettings',
      'background:getStatus',
      'background:pauseTracking',
      'background:resumeTracking',
      'background:takeNavigation',
      'background:updateSettings',
    ]);
    expect([...t.widget.keys()].sort()).toEqual(['widget:act', 'widget:getStatus', 'widget:setExpanded']);
    expect([...t.widgetEvents.keys()]).toEqual(['widget:drag']);
  });

  it('the widget is handed the status and nothing else', () => {
    const t = setup();
    expect(t.widget.get('widget:getStatus')!()).toEqual(status());
    // No widget channel gives it the database, events, timeline or settings.
    for (const key of [...t.widget.keys(), ...t.widgetEvents.keys()]) expect(key.startsWith('widget:')).toBe(true);
  });
});

describe('background IPC — arguments are validated', () => {
  it('settings: only the three known booleans are accepted', () => {
    expect(parseSettingsPatch({ widgetEnabled: false })).toEqual({ widgetEnabled: false });
    expect(parseSettingsPatch({ startWithWindows: true, notificationsEnabled: false })).toEqual({
      startWithWindows: true,
      notificationsEnabled: false,
    });
    expect(() => parseSettingsPatch(null)).toThrow();
    expect(() => parseSettingsPatch('widgetEnabled')).toThrow();
    expect(() => parseSettingsPatch([true])).toThrow();
    expect(() => parseSettingsPatch({ widgetEnabled: 'no' })).toThrow(/boolean/);
    // The renderer cannot write the pause state or the widget position through this channel.
    expect(() => parseSettingsPatch({ trackingPause: null })).toThrow(/does not accept/);
    expect(() => parseSettingsPatch({ widgetPosition: { x: 1, y: 1 } })).toThrow(/does not accept/);
    expect(() => parseSettingsPatch({ __proto__: { polluted: true }, widgetEnabled: true })).not.toThrow();
  });

  it('pause durations are a closed set', () => {
    expect(parsePauseDuration({ duration: '15m' }, 'c')).toBe('15m');
    expect(parsePauseDuration({ duration: 'tomorrow' }, 'c')).toBe('tomorrow');
    for (const bad of [undefined, null, {}, { duration: 15 }, { duration: 'forever' }, { duration: '9999h' }, '1h']) {
      expect(() => parsePauseDuration(bad, 'background:pauseTracking')).toThrow(/valid duration/);
    }
  });

  it('widget actions are a closed set', () => {
    expect(parseWidgetAction({ type: 'hide' })).toEqual({ type: 'hide' });
    expect(parseWidgetAction({ type: 'pause-tracking', duration: '1h', extra: 'ignored' })).toEqual({ type: 'pause-tracking', duration: '1h' });
    for (const bad of [undefined, null, 'hide', {}, { type: 'quit' }, { type: 'run', command: 'calc.exe' }, { type: 'pause-tracking' }]) {
      expect(() => parseWidgetAction(bad)).toThrow();
    }
  });

  it('handlers reject bad payloads before anything happens', async () => {
    const t = setup();
    expect(() => t.main.get('background:updateSettings')!({ widgetEnabled: 1 })).toThrow();
    await expect(t.main.get('background:pauseTracking')!({ duration: 'always' })).rejects.toThrow();
    expect(() => t.widget.get('widget:setExpanded')!('true')).toThrow();
    await expect(t.widget.get('widget:act')!({ type: 'quit' })).rejects.toThrow();
    t.widgetEvents.get('widget:drag')!('teleport'); // ignored, not thrown: it arrives on a one-way channel
    t.widgetEvents.get('widget:drag')!({ x: 0, y: 0 });

    expect(t.deps.settings.update).not.toHaveBeenCalled();
    expect(t.deps.tracking.pause).not.toHaveBeenCalled();
    expect(t.deps.widget.setExpanded).not.toHaveBeenCalled();
    expect(t.deps.widget.dragStart).not.toHaveBeenCalled();
    expect(t.deps.widget.dragMove).not.toHaveBeenCalled();
  });
});

describe('background IPC — behaviour', () => {
  it('pause and resume go to the tracking controller and return the new status', async () => {
    const t = setup();
    expect(await t.main.get('background:pauseTracking')!({ duration: '1h' })).toEqual(status());
    expect(t.deps.tracking.pause).toHaveBeenCalledWith('1h');
    await t.main.get('background:resumeTracking')!();
    expect(t.deps.tracking.resume).toHaveBeenCalledTimes(1);
  });

  it('hiding the widget does not pause tracking', async () => {
    const t = setup();
    await t.widget.get('widget:act')!({ type: 'hide' });
    expect(t.deps.widget.setEnabled).toHaveBeenCalledWith(false);
    expect(t.deps.tracking.pause).not.toHaveBeenCalled();
  });

  it('the widget’s quick actions open the main window at the right place', async () => {
    const t = setup();
    const act = t.widget.get('widget:act')!;
    await act({ type: 'open-main' });
    await act({ type: 'open-focus' });
    await act({ type: 'open-reflection' });
    expect(t.deps.openMain.mock.calls).toEqual([
      [],
      [{ route: 'focus', intent: 'open' }], // never straight to pause or end
      [{ route: 'reflection', anchor: '2026-10-04T00:00:00.000Z' }],
    ]);
    await act({ type: 'pause-tracking', duration: '15m' });
    await act({ type: 'resume-tracking' });
    expect(t.deps.tracking.pause).toHaveBeenCalledWith('15m');
    expect(t.deps.tracking.resume).toHaveBeenCalledTimes(1);
  });

  it('dragging carries no coordinates: only start, move, end', () => {
    const t = setup();
    const drag = t.widgetEvents.get('widget:drag')!;
    drag('start');
    drag('move');
    drag('move');
    drag('end');
    expect(t.deps.widget.dragStart).toHaveBeenCalledTimes(1);
    expect(t.deps.widget.dragMove).toHaveBeenCalledTimes(2);
    expect(t.deps.widget.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('a navigation request is handed to the renderer exactly once', () => {
    const t = setup();
    const take = t.main.get('background:takeNavigation')!;
    expect(take()).toBeNull();
    t.deps.navigation.set({ route: 'reflection', anchor: '2026-10-04T00:00:00.000Z' });
    t.deps.navigation.set({ route: 'settings' }); // the latest request wins
    expect(take()).toEqual({ route: 'settings' });
    expect(take()).toBeNull();
  });
});
