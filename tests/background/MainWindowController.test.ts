import { describe, it, expect, vi } from 'vitest';
import { MainWindowController } from '../../src/background/MainWindowController';
import { PendingNavigation } from '../../src/background/backgroundIpc';
import { FakeMainWindow, manualTimers, silentLogger } from './helpers';

const RELEASE_MS = 10 * 60_000;

function setup() {
  const windows: FakeMainWindow[] = [];
  const navigation = new PendingNavigation();
  const timers = manualTimers();
  const state = { quitting: false };
  const onShown = vi.fn();
  const controller = new MainWindowController({
    create: () => {
      const window = new FakeMainWindow();
      windows.push(window);
      return window;
    },
    navigation,
    isQuitting: () => state.quitting,
    releaseAfterHiddenMs: RELEASE_MS,
    onShown,
    logger: silentLogger,
    timers,
  });
  return { controller, windows, navigation, timers, state, onShown, current: () => windows.at(-1)! };
}

describe('MainWindowController — the window is not the application', () => {
  it('no window exists until somebody asks for one', () => {
    const t = setup();
    expect(t.windows).toHaveLength(0);
    expect(t.controller.exists).toBe(false);
    expect(t.controller.onScreen).toBe(false);
    // Pushing to a window that does not exist is a no-op, not an error.
    expect(() => t.controller.send('background:status', {})).not.toThrow();
  });

  it('closing the window hides it instead of quitting', () => {
    const t = setup();
    t.controller.open();
    const closed = t.current().userCloses(); // X / Alt+F4
    expect(closed).toBe(false);
    expect(t.current().destroyed).toBe(false);
    expect(t.current().visible).toBe(false);
    expect(t.controller.exists).toBe(true);
    expect(t.controller.onScreen).toBe(false);
  });

  it('the frame’s close button also only hides', () => {
    const t = setup();
    t.controller.open();
    t.controller.hide();
    expect(t.current().visible).toBe(false);
    expect(t.current().destroyed).toBe(false);
  });

  it('a minimized window is still there — and is not "on screen"', () => {
    const t = setup();
    t.controller.open();
    t.current().minimized = true;
    expect(t.controller.exists).toBe(true);
    expect(t.controller.onScreen).toBe(false);
    t.controller.open();
    expect(t.current().minimized).toBe(false);
    expect(t.windows).toHaveLength(1);
  });

  it('only a real quit lets the window close', () => {
    const t = setup();
    t.controller.open();
    t.state.quitting = true; // set by quitApp after the runtime has shut down
    expect(t.current().userCloses()).toBe(true);
    expect(t.current().destroyed).toBe(true);
    expect(t.controller.exists).toBe(false);
  });

  it('reopening shows the same window while it exists', () => {
    const t = setup();
    t.controller.open();
    t.current().userCloses();
    t.controller.open();
    expect(t.windows).toHaveLength(1);
    expect(t.current().visible).toBe(true);
    expect(t.onShown).toHaveBeenCalled();
  });
});

describe('MainWindowController — releasing and recreating', () => {
  it('a window left hidden is released after a while; opening builds a new one', () => {
    const t = setup();
    t.controller.open();
    t.current().userCloses();
    expect(t.timers.pending).toHaveLength(1);
    expect(t.timers.pending[0].ms).toBe(RELEASE_MS);

    t.timers.fire();
    expect(t.windows[0].destroyed).toBe(true);
    expect(t.controller.exists).toBe(false);

    t.controller.open();
    expect(t.windows).toHaveLength(2);
    expect(t.controller.onScreen).toBe(true);
  });

  it('a window that is shown again in time is not released', () => {
    const t = setup();
    t.controller.open();
    t.current().userCloses();
    t.controller.open();
    expect(t.timers.pending).toHaveLength(0);
    expect(t.current().destroyed).toBe(false);
  });

  it('a renderer crash drops the window; the next open recreates it', () => {
    const t = setup();
    t.controller.open();
    t.current().crash('oom');
    expect(t.windows[0].destroyed).toBe(true);
    expect(t.controller.exists).toBe(false);
    expect(() => t.controller.send('background:status', {})).not.toThrow();

    t.controller.open();
    expect(t.windows).toHaveLength(2);
    expect(t.controller.exists).toBe(true);
  });

  it('pushing to a renderer that just died does not throw into the runtime', () => {
    const t = setup();
    t.controller.open();
    t.current().failSend = true;
    expect(() => t.controller.send('background:status', {})).not.toThrow();
  });
});

describe('MainWindowController — opening at a specific place', () => {
  it('parks the request for a new window to collect when it mounts', () => {
    const t = setup();
    t.controller.open({ route: 'reflection', anchor: '2026-10-04T00:00:00.000Z' });
    expect(t.windows).toHaveLength(1);
    // The renderer is still loading; it asks for the request itself.
    expect(t.navigation.take()).toEqual({ route: 'reflection', anchor: '2026-10-04T00:00:00.000Z' });
  });

  it('pings an existing window so it collects the request now', () => {
    const t = setup();
    t.controller.open();
    t.current().userCloses();
    t.controller.open({ route: 'focus', intent: 'end' });
    expect(t.current().sent.at(-1)).toEqual({ channel: 'background:navigate', payload: null });
    expect(t.navigation.take()).toEqual({ route: 'focus', intent: 'end' });
    expect(t.current().visible).toBe(true);
  });

  it('a plain open leaves no navigation behind', () => {
    const t = setup();
    t.controller.open();
    expect(t.navigation.take()).toBeNull();
  });
});
