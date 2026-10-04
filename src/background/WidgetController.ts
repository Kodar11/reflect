import type { AppSettingsStore } from './AppSettings.js';
import type { BackgroundStatus } from './BackgroundStatus.js';
import {
  WIDGET_COLLAPSED_SIZE,
  WIDGET_EXPANDED_SIZE,
  clampToArea,
  displayFor,
  expandedWidgetBounds,
  primaryDisplay,
  resolveWidgetBounds,
  settleWidgetBounds,
  type DisplayArea,
  type Point,
  type Rect,
} from './widgetGeometry.js';

/**
 * The floating desktop widget: a small always-on-top pill that shows Reflect
 * is running.
 *
 * It is a UI surface of the background runtime and nothing more:
 *   - it owns no state — it renders the `BackgroundStatus` pushed to it;
 *   - hiding it destroys its window (no renderer is kept for a hidden widget)
 *     and changes nothing else: tracking, schedulers and Focus carry on;
 *   - it does not depend on the main window and outlives it;
 *   - if its renderer dies it is recreated a few times, then left off — a
 *     broken widget never takes tracking with it.
 *
 * Electron is reached only through `WidgetHost`, so the lifecycle and
 * placement rules are testable without it.
 */

export interface WidgetWindowLike {
  isDestroyed(): boolean;
  destroy(): void;
  /** Show without activating — the widget must never take keyboard focus. */
  showInactive(): void;
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
  /** Push to the widget's renderer. */
  send(channel: string, payload: unknown): void;
  /** The renderer process died or the window was closed from outside. */
  onGone(listener: (reason: 'crashed' | 'closed') => void): void;
}

export interface WidgetHost {
  createWindow(bounds: Rect): WidgetWindowLike;
  displays(): DisplayArea[];
  cursor(): Point;
}

/**
 * BrowserWindow options for the widget. Frameless, above normal windows, out
 * of the taskbar, and not focusable: clicking it works, but it never becomes
 * the active window, so it cannot interrupt typing.
 */
export function widgetWindowOptions(preloadPath: string) {
  return {
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  } as const;
}

const MAX_RECREATIONS = 3;
const RECREATE_DELAY_MS = 2_000;

export interface WidgetControllerDeps {
  host: WidgetHost;
  settings: Pick<AppSettingsStore, 'get' | 'update'>;
  /** Called when the widget appears or disappears. */
  onVisibilityChanged?: (visible: boolean) => void;
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class WidgetController {
  private window: WidgetWindowLike | null = null;
  /** Bounds of the collapsed pill — the widget's actual position. */
  private anchor: Rect | null = null;
  private expanded = false;
  private drag: { offset: Point } | null = null;
  private recreations = 0;
  private disposed = false;
  private lastStatus: BackgroundStatus | null = null;

  constructor(private readonly deps: WidgetControllerDeps) {}

  get visible(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** Make the window match the stored preference. Safe to call at any time. */
  sync(): void {
    if (this.disposed) return;
    if (this.deps.settings.get().widgetEnabled) this.show();
    else this.hide();
  }

  /** The user's choice: persisted, so a hidden widget stays hidden after a restart. */
  setEnabled(enabled: boolean): void {
    this.deps.settings.update({ widgetEnabled: enabled });
    if (enabled) this.recreations = 0;
    this.sync();
  }

  /** Push the status to the widget. A missing or dead window is simply skipped. */
  pushStatus(status: BackgroundStatus): void {
    this.lastStatus = status;
    if (!this.visible) return;
    try {
      this.window!.send('widget:status', status);
    } catch (err) {
      this.deps.logger?.warn(`[WIDGET] Could not push status: ${messageOf(err)}`);
    }
  }

  /** The widget's renderer asks for the hover card (or for the pill again). */
  setExpanded(expanded: boolean): void {
    if (!this.visible || !this.anchor || this.drag) return;
    this.expanded = expanded;
    this.applyBounds();
  }

  /**
   * Dragging. The renderer only says that a drag started, moved or ended; the
   * position comes from the OS cursor, so the renderer cannot place the
   * window anywhere it likes.
   */
  dragStart(): void {
    if (!this.visible) return;
    const bounds = this.window!.getBounds();
    const cursor = this.deps.host.cursor();
    this.drag = { offset: { x: cursor.x - bounds.x, y: cursor.y - bounds.y } };
  }

  dragMove(): void {
    if (!this.visible || !this.drag) return;
    const cursor = this.deps.host.cursor();
    // The size is stated every time rather than read back from the window, so
    // rounding on a scaled display can never make the widget creep larger.
    const size = this.expanded ? WIDGET_EXPANDED_SIZE : WIDGET_COLLAPSED_SIZE;
    this.window!.setBounds({ ...size, x: cursor.x - this.drag.offset.x, y: cursor.y - this.drag.offset.y });
  }

  dragEnd(): void {
    if (!this.drag) return;
    this.drag = null;
    if (!this.visible) return;
    const displays = this.deps.host.displays();
    const moved = this.window!.getBounds();
    // The pill sits where the dragged window's matching edge ended up.
    const collapsed = this.expanded
      ? collapsedWithin({ ...moved, ...WIDGET_EXPANDED_SIZE }, displays)
      : { ...moved, ...WIDGET_COLLAPSED_SIZE };
    this.anchor = settleWidgetBounds(collapsed, displays);
    this.deps.settings.update({ widgetPosition: { x: this.anchor.x, y: this.anchor.y } });
    this.applyBounds();
  }

  /** A monitor was added, removed or resized: make sure the widget is still on screen. */
  handleDisplaysChanged(): void {
    if (!this.visible) return;
    this.anchor = resolveWidgetBounds(this.deps.settings.get().widgetPosition, this.deps.host.displays());
    this.applyBounds();
  }

  /** The app is quitting. */
  dispose(): void {
    this.disposed = true;
    this.destroyWindow();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private show(): void {
    if (this.visible) return;
    try {
      this.anchor = resolveWidgetBounds(this.deps.settings.get().widgetPosition, this.deps.host.displays());
      this.expanded = false;
      this.drag = null;
      const window = this.deps.host.createWindow(this.anchor);
      this.window = window;
      window.onGone((reason) => this.handleGone(window, reason));
      // Stated again after creation: a new frameless window does not always
      // come up at exactly the size it was asked for.
      window.setBounds(this.anchor);
      window.showInactive();
      this.deps.onVisibilityChanged?.(true);
      if (this.lastStatus) this.pushStatus(this.lastStatus);
    } catch (err) {
      this.window = null;
      this.deps.logger?.error(`[WIDGET] Could not create the widget: ${messageOf(err)}`);
    }
  }

  private hide(): void {
    if (!this.window) return;
    this.destroyWindow();
    this.deps.onVisibilityChanged?.(false);
  }

  private destroyWindow(): void {
    const window = this.window;
    this.window = null;
    this.drag = null;
    this.expanded = false;
    if (!window) return;
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch (err) {
      this.deps.logger?.warn(`[WIDGET] Could not destroy the widget window: ${messageOf(err)}`);
    }
  }

  /** The window went away without being asked to. */
  private handleGone(window: WidgetWindowLike, reason: 'crashed' | 'closed'): void {
    if (this.window !== window) return; // an earlier window, or one we destroyed ourselves
    this.destroyWindow();
    this.deps.onVisibilityChanged?.(false);
    if (this.disposed || !this.deps.settings.get().widgetEnabled) return;
    if (this.recreations >= MAX_RECREATIONS) {
      this.deps.logger?.error('[WIDGET] The widget keeps failing; leaving it off. Tracking is not affected.');
      return;
    }
    this.recreations += 1;
    this.deps.logger?.warn(`[WIDGET] Widget ${reason}; recreating (${this.recreations}/${MAX_RECREATIONS}).`);
    const schedule = this.deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    schedule(() => this.sync(), RECREATE_DELAY_MS);
  }

  private applyBounds(): void {
    if (!this.visible || !this.anchor) return;
    const bounds = this.expanded ? expandedWidgetBounds(this.anchor, this.deps.host.displays()) : this.anchor;
    this.window!.setBounds(bounds);
  }
}

/**
 * Where the pill belongs inside an expanded card that was dragged: at the
 * card's right edge on the right half of the screen, else at its left edge —
 * the inverse of `expandedWidgetBounds`.
 */
function collapsedWithin(card: Rect, displays: DisplayArea[]): Rect {
  const display = displayFor(card, displays) ?? primaryDisplay(displays);
  const onRightHalf = display
    ? card.x + card.width / 2 >= display.workArea.x + display.workArea.width / 2
    : false;
  const x = onRightHalf ? card.x + card.width - WIDGET_COLLAPSED_SIZE.width : card.x;
  const rect = { x, y: card.y, ...WIDGET_COLLAPSED_SIZE };
  return display ? clampToArea(rect, display.workArea) : rect;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
