import { describe, it, expect, vi } from 'vitest';
import { WidgetController, widgetWindowOptions } from '../../src/background/WidgetController';
import {
  WIDGET_COLLAPSED_SIZE,
  WIDGET_EXPANDED_SIZE,
  WIDGET_MARGIN,
  clampToArea,
  defaultWidgetPosition,
  expandedWidgetBounds,
  resolveWidgetBounds,
  settleWidgetBounds,
  type Rect,
} from '../../src/background/widgetGeometry';
import type { AppSettings } from '../../src/background/AppSettings';
import { PRIMARY, SECONDARY, fakeWidgetHost, makeSettings, silentLogger, status } from './helpers';

const inside = (rect: Rect, area: Rect) =>
  rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;

function setup(initial: Partial<AppSettings> = {}, displays = [PRIMARY]) {
  const { repo, store } = makeSettings(initial);
  const fake = fakeWidgetHost(displays);
  const visibility: boolean[] = [];
  const scheduled: (() => void)[] = [];
  const controller = new WidgetController({
    host: fake.host,
    settings: store,
    onVisibilityChanged: (v) => visibility.push(v),
    logger: silentLogger,
    setTimeout: (fn) => scheduled.push(fn),
  });
  return { controller, repo, store, ...fake, visibility, scheduled, current: () => fake.windows.at(-1)! };
}

describe('widget geometry', () => {
  it('defaults to the upper-right corner of the primary display', () => {
    expect(defaultWidgetPosition([SECONDARY, PRIMARY])).toEqual({
      x: 1920 - WIDGET_COLLAPSED_SIZE.width - WIDGET_MARGIN,
      y: WIDGET_MARGIN,
    });
    expect(resolveWidgetBounds(null, [PRIMARY])).toEqual({ x: 1696, y: 16, ...WIDGET_COLLAPSED_SIZE });
  });

  it('keeps a saved position, including one on a second monitor', () => {
    expect(resolveWidgetBounds({ x: 300, y: 500 }, [PRIMARY])).toMatchObject({ x: 300, y: 500 });
    expect(resolveWidgetBounds({ x: 2400, y: 300 }, [PRIMARY, SECONDARY])).toMatchObject({ x: 2400, y: 300 });
  });

  it('relocates to the primary display when the saved display has disappeared', () => {
    // Saved on the second monitor, which is now unplugged.
    expect(resolveWidgetBounds({ x: 2400, y: 300 }, [PRIMARY])).toEqual(resolveWidgetBounds(null, [PRIMARY]));
    // Saved far outside anything.
    expect(resolveWidgetBounds({ x: -5000, y: 9000 }, [PRIMARY])).toEqual(resolveWidgetBounds(null, [PRIMARY]));
  });

  it('never leaves the widget partly off-screen', () => {
    const nudged = resolveWidgetBounds({ x: 1850, y: 1030 }, [PRIMARY]); // hanging over the bottom-right corner
    expect(inside(nudged, PRIMARY.workArea)).toBe(true);
    expect(clampToArea({ x: -40, y: -10, width: 208, height: 36 }, PRIMARY.workArea)).toMatchObject({ x: 0, y: 0 });
  });

  it('a dropped widget settles inside the nearest display', () => {
    const dropped = settleWidgetBounds({ x: 1900, y: -30, ...WIDGET_COLLAPSED_SIZE }, [PRIMARY]);
    expect(inside(dropped, PRIMARY.workArea)).toBe(true);
    const offEverything = settleWidgetBounds({ x: 5000, y: 400, ...WIDGET_COLLAPSED_SIZE }, [PRIMARY, SECONDARY]);
    expect(inside(offEverything, SECONDARY.workArea)).toBe(true);
  });

  it('the card opens away from the nearer edge and stays on screen', () => {
    const right = resolveWidgetBounds(null, [PRIMARY]);
    const cardRight = expandedWidgetBounds(right, [PRIMARY]);
    expect(cardRight.x + cardRight.width).toBe(right.x + right.width); // right edges aligned
    expect(cardRight).toMatchObject(WIDGET_EXPANDED_SIZE);

    const left = { x: 40, y: 1020, ...WIDGET_COLLAPSED_SIZE };
    const cardLeft = expandedWidgetBounds(left, [PRIMARY]);
    expect(cardLeft.x).toBe(40); // left edges aligned
    expect(inside(cardLeft, PRIMARY.workArea)).toBe(true); // pushed up from the bottom edge
  });
});

describe('widget window', () => {
  it('cannot take keyboard focus, stays out of the taskbar and above normal windows', () => {
    const options = widgetWindowOptions('C:/app/widgetPreload.cjs');
    expect(options).toMatchObject({
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      frame: false,
      resizable: false,
      show: false,
    });
  });

  it('keeps the renderer isolated: no Node, context isolation, sandbox, its own preload', () => {
    expect(widgetWindowOptions('C:/app/widgetPreload.cjs').webPreferences).toEqual({
      preload: 'C:/app/widgetPreload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });
});

describe('WidgetController — visibility', () => {
  it('appears when enabled, shown without being activated', () => {
    const t = setup();
    t.controller.sync();
    expect(t.windows).toHaveLength(1);
    expect(t.current().shownInactive).toBe(1); // showInactive — the only way it is ever shown
    expect(t.controller.visible).toBe(true);
    expect(t.visibility).toEqual([true]);
    expect(t.current().bounds).toEqual({ x: 1696, y: 16, ...WIDGET_COLLAPSED_SIZE });
  });

  it('stays away when disabled — no window, no renderer', () => {
    const t = setup({ widgetEnabled: false });
    t.controller.sync();
    expect(t.windows).toHaveLength(0);
    expect(t.controller.visible).toBe(false);
  });

  it('hiding destroys the window and persists the choice; it does not come back after a restart', () => {
    const t = setup();
    t.controller.sync();
    t.controller.setEnabled(false);
    expect(t.current().destroyed).toBe(true);
    expect(t.controller.visible).toBe(false);
    expect(t.repo.stored?.widgetEnabled).toBe(false);
    expect(t.visibility).toEqual([true, false]);

    // Restart: a new controller over the same stored settings.
    const restarted = new WidgetController({ host: t.host, settings: t.store });
    restarted.sync();
    expect(t.windows).toHaveLength(1);

    restarted.setEnabled(true); // shown again from the tray or Settings
    expect(t.windows).toHaveLength(2);
    expect(t.repo.stored?.widgetEnabled).toBe(true);
  });

  it('sync is idempotent: one widget, however often it is called', () => {
    const t = setup();
    t.controller.sync();
    t.controller.sync();
    t.controller.sync();
    expect(t.windows).toHaveLength(1);
  });

  it('is destroyed on quit and not recreated afterwards', () => {
    const t = setup();
    t.controller.sync();
    t.controller.dispose();
    expect(t.current().destroyed).toBe(true);
    t.controller.sync();
    expect(t.windows).toHaveLength(1);
  });
});

describe('WidgetController — position', () => {
  it('dragging follows the OS cursor and the new position persists', () => {
    const t = setup();
    t.controller.sync();
    t.state.cursor = { x: 1700, y: 30 }; // grabbed 4px / 14px into the pill
    t.controller.dragStart();
    t.state.cursor = { x: 900, y: 500 };
    t.controller.dragMove();
    expect(t.current().bounds).toEqual({ x: 896, y: 486, ...WIDGET_COLLAPSED_SIZE });
    t.controller.dragEnd();
    expect(t.repo.stored?.widgetPosition).toEqual({ x: 896, y: 486 });

    // After a restart the widget is where the user left it.
    const restarted = setupFrom(t);
    restarted.sync();
    expect(t.current().bounds).toMatchObject({ x: 896, y: 486 });
  });

  it('a widget dropped off-screen is pulled back fully onto the display', () => {
    const t = setup();
    t.controller.sync();
    t.state.cursor = { x: 1700, y: 30 };
    t.controller.dragStart();
    t.state.cursor = { x: 2500, y: -200 };
    t.controller.dragMove();
    t.controller.dragEnd();
    expect(inside(t.current().bounds, PRIMARY.workArea)).toBe(true);
    const saved = t.repo.stored!.widgetPosition!;
    expect(inside({ ...saved, ...WIDGET_COLLAPSED_SIZE }, PRIMARY.workArea)).toBe(true);
  });

  it('recovers when the monitor it was on goes away', () => {
    const t = setup({ widgetPosition: { x: 2400, y: 300 } }, [PRIMARY, SECONDARY]);
    t.controller.sync();
    expect(t.current().bounds).toMatchObject({ x: 2400, y: 300 });

    t.state.displays = [PRIMARY]; // second monitor unplugged
    t.controller.handleDisplaysChanged();
    expect(t.current().bounds).toEqual(resolveWidgetBounds(null, [PRIMARY]));
  });

  it('an off-screen saved position is never used as-is', () => {
    const t = setup({ widgetPosition: { x: -4000, y: -4000 } });
    t.controller.sync();
    expect(inside(t.current().bounds, PRIMARY.workArea)).toBe(true);
  });

  it('expands into the card on request and returns to exactly the same pill', () => {
    const t = setup();
    t.controller.sync();
    const pill = t.current().bounds;
    t.controller.setExpanded(true);
    expect(t.current().bounds).toMatchObject(WIDGET_EXPANDED_SIZE);
    expect(inside(t.current().bounds, PRIMARY.workArea)).toBe(true);
    t.controller.setExpanded(false);
    expect(t.current().bounds).toEqual(pill);
    // Expanding is not moving: nothing was written.
    expect(t.repo.saves).toBe(0);
  });

  function setupFrom(t: ReturnType<typeof setup>) {
    return new WidgetController({ host: t.host, settings: t.store });
  }
});

describe('WidgetController — status and failure isolation', () => {
  it('pushes the status it is given — tracking, pause and Focus state alike', () => {
    const t = setup();
    t.controller.sync();
    const paused = status({ tracking: 'paused', pausedUntil: '2026-10-05T10:00:00.000Z' });
    t.controller.pushStatus(paused);
    expect(t.current().sent).toEqual([{ channel: 'widget:status', payload: paused }]);
  });

  it('a widget shown later starts with the latest status', () => {
    const t = setup({ widgetEnabled: false });
    const latest = status({ todayTrackedMs: 60_000 });
    t.controller.pushStatus(latest); // no window: skipped, remembered
    t.controller.setEnabled(true);
    expect(t.current().sent).toEqual([{ channel: 'widget:status', payload: latest }]);
  });

  it('a dead renderer never throws into the runtime', () => {
    const t = setup();
    t.controller.sync();
    t.current().failSend = true;
    expect(() => t.controller.pushStatus(status())).not.toThrow();

    const hidden = setup({ widgetEnabled: false });
    expect(() => hidden.controller.pushStatus(status())).not.toThrow();
    expect(() => hidden.controller.setExpanded(true)).not.toThrow();
    expect(() => hidden.controller.dragMove()).not.toThrow();
  });

  it('a crashed widget is recreated — a few times, then left off', () => {
    const t = setup();
    t.controller.sync();

    for (let i = 1; i <= 3; i++) {
      t.current().crash();
      expect(t.controller.visible).toBe(false);
      t.scheduled.shift()!(); // the delayed re-sync
      expect(t.windows).toHaveLength(1 + i);
      expect(t.controller.visible).toBe(true);
    }

    t.current().crash(); // the fourth time it stays off
    expect(t.scheduled).toHaveLength(0);
    expect(t.controller.visible).toBe(false);
    // The user's preference is untouched: it was not them who hid it.
    expect(t.repo.stored?.widgetEnabled).toBe(true);
  });

  it('a widget that cannot be created is logged and skipped', () => {
    const t = setup();
    t.state.failCreate = true;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const controller = new WidgetController({ host: t.host, settings: t.store, logger });
    expect(() => controller.sync()).not.toThrow();
    expect(controller.visible).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});
