import type { PendingNavigation, UiNavigation } from './backgroundIpc.js';

/**
 * The main window's lifecycle — and the rule that it is NOT the application's.
 *
 * The main window is a client of the background runtime. This class creates
 * it only when somebody asks for it and makes sure that nothing the window
 * does can stop the runtime:
 *
 *   close (X, Alt+F4)  → the window hides to the tray; nothing else changes
 *   minimize           → nothing changes
 *   hidden for a while → the window is released (its renderer is freed)
 *   renderer crashes   → the dead window is dropped
 *   open again         → a new window is built on demand
 *
 * Only a real quit — `isQuitting()` turning true, after the runtime has shut
 * down — lets the window actually close.
 *
 * Electron is reached through `MainWindowLike`, so these rules are testable.
 */

export interface MainWindowLike {
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  /** Push to the window's renderer. */
  send(channel: string, payload: unknown): void;
  onClose(listener: (event: { preventDefault(): void }) => void): void;
  onClosed(listener: () => void): void;
  onHide(listener: () => void): void;
  onShow(listener: () => void): void;
  onRendererGone(listener: (reason: string) => void): void;
}

export interface MainWindowControllerDeps {
  create: () => MainWindowLike;
  navigation: PendingNavigation;
  /** True only once the background runtime has been shut down. */
  isQuitting: () => boolean;
  /** How long a hidden window is kept before it is released. */
  releaseAfterHiddenMs: number;
  onShown?: () => void;
  logger?: { info(m: string): void; error(m: string): void };
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

export class MainWindowController {
  private window: MainWindowLike | null = null;
  private releaseTimer: unknown = null;
  private readonly timers: NonNullable<MainWindowControllerDeps['timers']>;

  constructor(private readonly deps: MainWindowControllerDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /** There is a window (it may be hidden). */
  get exists(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** The window is actually in front of the user's eyes. */
  get onScreen(): boolean {
    return this.exists && this.window!.isVisible() && !this.window!.isMinimized();
  }

  get focused(): boolean {
    return this.onScreen && this.window!.isFocused();
  }

  /**
   * Show the main window, optionally at a specific place. The request is
   * parked for the renderer to collect: an existing window is pinged, a new
   * one asks for it when it mounts — nothing is lost while a window loads.
   */
  open(target?: UiNavigation): void {
    if (target) this.deps.navigation.set(target);
    if (!this.exists) {
      this.build();
    } else {
      const window = this.window!;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    if (target) this.send('background:navigate', null);
  }

  /** Push to the renderer. Without a window — or with a dead one — this is a no-op. */
  send(channel: string, payload: unknown): void {
    if (!this.exists) return;
    try {
      this.window!.send(channel, payload);
    } catch (err) {
      this.deps.logger?.error(`[APP] Could not reach the main window: ${messageOf(err)}`);
    }
  }

  /** The frame's close button: to the tray, like every other close. */
  hide(): void {
    if (this.exists) this.window!.hide();
  }

  private build(): void {
    const window = this.deps.create();
    this.window = window;

    // Closing the window never ends tracking or Focus: it hides to the tray.
    // Only a real quit (tray menu, OS shutdown) lets the window go.
    window.onClose((event) => {
      if (this.deps.isQuitting()) return;
      event.preventDefault();
      window.hide();
    });
    window.onClosed(() => {
      this.clearRelease();
      if (this.window === window) this.window = null;
    });

    // A hidden window is only a parked renderer. Nothing in the background
    // needs it, so after a while it is released; opening builds a new one.
    window.onHide(() => {
      this.clearRelease();
      this.releaseTimer = this.timers.setTimeout(() => {
        this.releaseTimer = null;
        if (window.isDestroyed() || window.isVisible()) return;
        this.deps.logger?.info('[APP] Releasing the hidden main window; the background runtime keeps running.');
        window.destroy();
      }, this.deps.releaseAfterHiddenMs);
    });
    window.onShow(() => {
      this.clearRelease();
      this.deps.onShown?.();
    });

    // A dead renderer takes only the window with it. The window is dropped and
    // rebuilt the next time it is opened; tracking and the schedulers never notice.
    window.onRendererGone((reason) => {
      this.deps.logger?.error(`[APP] Main window renderer gone (${reason}); background services keep running.`);
      if (!window.isDestroyed()) window.destroy();
      if (this.window === window) this.window = null;
    });

    this.deps.logger?.info('[APP] Window ready.');
  }

  private clearRelease(): void {
    if (this.releaseTimer !== null) this.timers.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
