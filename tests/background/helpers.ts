import { vi } from 'vitest';
import {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type IAppSettingsRepository,
} from '../../src/background/AppSettings';
import type { BackgroundStatus } from '../../src/background/BackgroundStatus';
import type { MainWindowLike } from '../../src/background/MainWindowController';
import type { WidgetHost, WidgetWindowLike } from '../../src/background/WidgetController';
import type { DisplayArea, Point, Rect } from '../../src/background/widgetGeometry';
import type { IWatcher } from '../../src/tracker/watcher/IWatcher';

/** In-memory settings row — what survives an app restart. */
export class FakeSettingsRepository implements IAppSettingsRepository {
  stored: AppSettings | null = null;
  saves = 0;
  failWrites = false;

  getSettings(): AppSettings {
    return this.stored ? { ...this.stored } : { ...DEFAULT_APP_SETTINGS };
  }

  saveSettings(settings: AppSettings): void {
    if (this.failWrites) throw new Error('disk full');
    this.stored = { ...settings };
    this.saves++;
  }
}

export function makeSettings(initial: Partial<AppSettings> = {}) {
  const repo = new FakeSettingsRepository();
  repo.stored = { ...DEFAULT_APP_SETTINGS, ...initial };
  return { repo, store: new AppSettingsStore(repo) };
}

/** Timers that only fire when the test says so. */
export function manualTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
    setInterval: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearInterval: (handle: unknown) => {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
    /** Fire the oldest pending timer (one-shot semantics). */
    fire() {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending timer');
      entry.fn();
    },
  };
}

/** A watcher that counts how often it was started — a duplicate tracker would show here. */
export function countingWatcher(name = 'window') {
  const state = { starts: 0, stops: 0, running: false };
  const watcher: IWatcher = {
    name,
    get running() {
      return state.running;
    },
    async start() {
      state.starts++;
      state.running = true;
    },
    async stop() {
      state.stops++;
      state.running = false;
    },
  };
  return { watcher, state };
}

export const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export const PRIMARY: DisplayArea = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true };
export const SECONDARY: DisplayArea = { workArea: { x: 1920, y: 0, width: 1280, height: 984 }, primary: false };

export class FakeWidgetWindow implements WidgetWindowLike {
  destroyed = false;
  shownInactive = 0;
  bounds: Rect;
  sent: { channel: string; payload: unknown }[] = [];
  failSend = false;
  private goneListeners: ((reason: 'crashed' | 'closed') => void)[] = [];

  constructor(bounds: Rect) {
    this.bounds = { ...bounds };
  }

  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    // Electron emits 'closed' for a destroyed window too.
    this.goneListeners.forEach((l) => l('closed'));
  }
  showInactive() {
    this.shownInactive++;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: Rect) {
    this.bounds = { ...bounds };
  }
  send(channel: string, payload: unknown) {
    if (this.failSend) throw new Error('Object has been destroyed');
    this.sent.push({ channel, payload });
  }
  onGone(listener: (reason: 'crashed' | 'closed') => void) {
    this.goneListeners.push(listener);
  }
  /** The renderer process died. */
  crash() {
    this.goneListeners.forEach((l) => l('crashed'));
  }
}

export function fakeWidgetHost(displays: DisplayArea[] = [PRIMARY]) {
  const windows: FakeWidgetWindow[] = [];
  const state = { displays, cursor: { x: 0, y: 0 } as Point, failCreate: false };
  const host: WidgetHost = {
    createWindow: (bounds) => {
      if (state.failCreate) throw new Error('GPU process unavailable');
      const window = new FakeWidgetWindow(bounds);
      windows.push(window);
      return window;
    },
    displays: () => state.displays,
    cursor: () => state.cursor,
  };
  return { host, windows, state };
}

export class FakeMainWindow implements MainWindowLike {
  destroyed = false;
  visible = true;
  minimized = false;
  focusedNow = true;
  sent: { channel: string; payload: unknown }[] = [];
  failSend = false;
  private closeListeners: ((event: { preventDefault(): void }) => void)[] = [];
  private closedListeners: (() => void)[] = [];
  private hideListeners: (() => void)[] = [];
  private showListeners: (() => void)[] = [];
  private goneListeners: ((reason: string) => void)[] = [];

  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.closedListeners.forEach((l) => l());
  }
  show() {
    this.visible = true;
    this.showListeners.forEach((l) => l());
  }
  hide() {
    this.visible = false;
    this.hideListeners.forEach((l) => l());
  }
  focus() {
    this.focusedNow = true;
  }
  restore() {
    this.minimized = false;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isFocused() {
    return this.focusedNow;
  }
  send(channel: string, payload: unknown) {
    if (this.failSend) throw new Error('Render frame was disposed');
    this.sent.push({ channel, payload });
  }
  onClose(listener: (event: { preventDefault(): void }) => void) {
    this.closeListeners.push(listener);
  }
  onClosed(listener: () => void) {
    this.closedListeners.push(listener);
  }
  onHide(listener: () => void) {
    this.hideListeners.push(listener);
  }
  onShow(listener: () => void) {
    this.showListeners.push(listener);
  }
  onRendererGone(listener: (reason: string) => void) {
    this.goneListeners.push(listener);
  }

  /** The user clicked X / pressed Alt+F4. Returns whether the close went through. */
  userCloses(): boolean {
    let prevented = false;
    this.closeListeners.forEach((l) => l({ preventDefault: () => (prevented = true) }));
    if (!prevented) this.destroy();
    return !prevented;
  }
  /** The renderer process died. */
  crash(reason = 'crashed') {
    this.goneListeners.forEach((l) => l(reason));
  }
}

export function status(overrides: Partial<BackgroundStatus> = {}): BackgroundStatus {
  return {
    tracking: 'running',
    pausedSince: null,
    pausedUntil: null,
    todayTrackedMs: (3 * 60 + 18) * 60_000,
    currentActivity: { label: 'Code', since: '2026-10-05T08:00:00.000Z' },
    focus: null,
    widgetVisible: true,
    reflectionPending: false,
    asOf: '2026-10-05T09:00:00.000Z',
    ...overrides,
  };
}

export const focusStatus = (overrides: Partial<NonNullable<BackgroundStatus['focus']>> = {}): NonNullable<BackgroundStatus['focus']> => ({
  sessionId: 'fs-1',
  task: 'Build landing page',
  profileName: 'Deep Work',
  isRunning: true,
  pauseKind: null,
  remainingMs: 38 * 60_000 + 24_000,
  elapsedMs: 11 * 60_000 + 36_000,
  blocking: 'active',
  ...overrides,
});
