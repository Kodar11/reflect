/**
 * Where the floating widget sits. Pure geometry — no Electron — so the
 * placement rules are testable.
 *
 * The stored position is the top-left of the COLLAPSED widget. Everything
 * else (the expanded card, recovery after a monitor disappears) is derived
 * from it, and the result is always fully on a visible display.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface DisplayArea {
  /** The usable area of the display (excludes the taskbar). */
  workArea: Rect;
  primary: boolean;
}

// Windows will not make a window shorter than about 39px, so the pill is 40.
export const WIDGET_COLLAPSED_SIZE: Size = { width: 208, height: 40 };
export const WIDGET_EXPANDED_SIZE: Size = { width: 272, height: 140 };
/** Gap kept between the widget and the edge of the screen by default. */
export const WIDGET_MARGIN = 16;

const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const contains = (area: Rect, p: Point) => p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height;

export function primaryDisplay(displays: DisplayArea[]): DisplayArea | null {
  return displays.find((d) => d.primary) ?? displays[0] ?? null;
}

/** Upper-right corner of the primary display. */
export function defaultWidgetPosition(displays: DisplayArea[], size: Size = WIDGET_COLLAPSED_SIZE): Point {
  const display = primaryDisplay(displays);
  if (!display) return { x: 0, y: 0 };
  const { workArea } = display;
  return { x: workArea.x + workArea.width - size.width - WIDGET_MARGIN, y: workArea.y + WIDGET_MARGIN };
}

/** Move `rect` the least distance needed to lie completely inside `area`. */
export function clampToArea(rect: Rect, area: Rect): Rect {
  const maxX = area.x + Math.max(0, area.width - rect.width);
  const maxY = area.y + Math.max(0, area.height - rect.height);
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), maxY)),
  };
}

/** The display a rectangle belongs to: the one holding its centre, if any. */
export function displayFor(rect: Rect, displays: DisplayArea[]): DisplayArea | null {
  const center = centerOf(rect);
  return displays.find((d) => contains(d.workArea, center)) ?? null;
}

/**
 * Bounds of the collapsed widget for a stored position.
 *
 * No stored position → the default corner. A position whose display is gone
 * (monitor unplugged, resolution changed) → back to the primary display. A
 * position partly outside its display → nudged fully inside.
 */
export function resolveWidgetBounds(saved: Point | null, displays: DisplayArea[], size: Size = WIDGET_COLLAPSED_SIZE): Rect {
  const fallback = { ...defaultWidgetPosition(displays, size), ...size };
  if (!saved) return fallback;
  const rect = { x: saved.x, y: saved.y, ...size };
  const display = displayFor(rect, displays);
  if (!display) return fallback;
  return clampToArea(rect, display.workArea);
}

/**
 * Where a widget that was just dropped comes to rest: fully inside the
 * display nearest to where it was let go — never off-screen, never jumping
 * back to the default corner.
 */
export function settleWidgetBounds(rect: Rect, displays: DisplayArea[]): Rect {
  const center = centerOf(rect);
  let nearest: DisplayArea | null = null;
  let best = Infinity;
  for (const display of displays) {
    const a = display.workArea;
    const dx = Math.max(a.x - center.x, 0, center.x - (a.x + a.width));
    const dy = Math.max(a.y - center.y, 0, center.y - (a.y + a.height));
    const distance = Math.hypot(dx, dy);
    if (distance < best) {
      best = distance;
      nearest = display;
    }
  }
  return nearest ? clampToArea(rect, nearest.workArea) : rect;
}

/**
 * Bounds of the expanded card for a collapsed widget. The card grows away
 * from the nearer screen edge: a widget on the right half keeps its right
 * edge, one on the left half keeps its left edge.
 */
export function expandedWidgetBounds(collapsed: Rect, displays: DisplayArea[], size: Size = WIDGET_EXPANDED_SIZE): Rect {
  const display = displayFor(collapsed, displays) ?? primaryDisplay(displays);
  if (!display) return { x: collapsed.x, y: collapsed.y, ...size };
  const { workArea } = display;
  const onRightHalf = centerOf(collapsed).x >= workArea.x + workArea.width / 2;
  const x = onRightHalf ? collapsed.x + collapsed.width - size.width : collapsed.x;
  return clampToArea({ x, y: collapsed.y, ...size }, workArea);
}
