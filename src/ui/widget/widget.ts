import './widget.css';
import { formatFocusClock } from '../../background/statusFormat';
import { buildWidgetView, focusClockMs, type WidgetButton, type WidgetView } from './widgetView';

/**
 * The floating widget's renderer. It draws the background status it is handed
 * and reports clicks; it keeps no state of its own beyond "is the card open".
 *
 * Deliberately small and quiet: plain DOM instead of the app's React bundle,
 * repaints only when a status arrives, and one timer — the Focus clock, which
 * runs only while a Focus session is counting.
 */

const HOVER_OPEN_MS = 140;
const HOVER_CLOSE_MS = 320;
const DRAG_THRESHOLD_PX = 4;

const api = window.widget;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const root = $('widget');
const pillLabel = $('pill-label');
const pillValue = $('pill-value');
const cardTitle = $('card-title');
const cardClock = $('card-clock');
const cardBody = $('card-body');
const cardActions = $('card-actions');

let status: BackgroundStatusDto | null = null;
let expanded = false;
let choosingPause = false;
let dragging = false;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// ── Rendering ────────────────────────────────────────────────────────────────

function render(): void {
  if (!status) return;
  const view = buildWidgetView(status, new Date(), choosingPause);
  root.dataset.state = view.tone;
  pillLabel.textContent = view.pill.label;
  pillValue.textContent = view.pill.value;
  cardTitle.textContent = view.card.title;
  cardClock.textContent = view.card.clock;
  cardBody.replaceChildren(...bodyNodes(view));
  cardActions.dataset.layout = view.card.grid ? 'grid' : 'row';
  cardActions.replaceChildren(...view.card.buttons.map(buttonNode));
  setClock(view.ticking);
}

function bodyNodes(view: WidgetView): HTMLElement[] {
  const rows = view.card.rows.map((row) => {
    const el = document.createElement('div');
    el.className = 'row';
    el.append(span('row-label', row.label), span('row-value', row.value));
    return el;
  });
  const lines = view.card.lines.map((line) =>
    span(`line${line.kind === 'muted' ? ' line-muted' : line.kind === 'note' ? ' note' : ''}`, line.text, 'div'),
  );
  return [...rows, ...lines];
}

function span(className: string, text: string, tag: 'span' | 'div' = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  el.title = text;
  return el;
}

function buttonNode(button: WidgetButton): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = button.label;
  if (button.primary) el.className = 'primary';
  el.addEventListener('click', () => void onButton(button));
  return el;
}

/** The only per-second work, and only while a Focus session is counting. */
function setClock(ticking: boolean): void {
  if (ticking && clockTimer === null) {
    clockTimer = setInterval(() => {
      if (!status?.focus) return;
      const clock = formatFocusClock(focusClockMs(status, new Date()));
      pillValue.textContent = clock;
      if (!choosingPause) cardClock.textContent = status.focus.remainingMs !== null ? `${clock} left` : clock;
    }, 1000);
  } else if (!ticking && clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function onButton(button: WidgetButton): Promise<void> {
  if (button.action === 'choose-pause' || button.action === 'cancel-pause') {
    choosingPause = button.action === 'choose-pause';
    render();
    return;
  }
  choosingPause = false;
  try {
    await api.act(button.action);
  } catch (e) {
    console.error('[widget] action failed', e);
  }
  render();
}

// ── Pill ↔ card ──────────────────────────────────────────────────────────────

async function expand(): Promise<void> {
  if (expanded) return;
  expanded = true;
  // Grow the window first, then show the card in it.
  await api.setExpanded(true).catch(() => {});
  if (expanded) root.dataset.view = 'card';
}

async function collapse(): Promise<void> {
  if (!expanded) return;
  expanded = false;
  choosingPause = false;
  // Back to the pill first, then shrink the window around it.
  root.dataset.view = 'pill';
  render();
  await api.setExpanded(false).catch(() => {});
}

const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
  if (timer !== null) clearTimeout(timer);
  return null;
};

root.addEventListener('mouseenter', () => {
  closeTimer = cancel(closeTimer);
  if (!expanded && !dragging) openTimer = setTimeout(() => void expand(), HOVER_OPEN_MS);
});
root.addEventListener('mouseleave', () => {
  openTimer = cancel(openTimer);
  if (expanded && !dragging) closeTimer = setTimeout(() => void collapse(), HOVER_CLOSE_MS);
});

// ── Dragging ─────────────────────────────────────────────────────────────────
// The widget only says "a drag started / moved / ended"; the main process
// moves the window with the OS cursor. Buttons are not drag handles.

let press: { x: number; y: number; id: number } | null = null;
let moveQueued = false;

root.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
  press = { x: e.screenX, y: e.screenY, id: e.pointerId };
});
root.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!dragging) {
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD_PX) return;
    dragging = true;
    openTimer = cancel(openTimer);
    closeTimer = cancel(closeTimer);
    root.setPointerCapture(press.id);
    api.drag('start');
  }
  if (moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    if (dragging) api.drag('move');
  });
});
const endPress = () => {
  if (dragging) api.drag('end');
  else if (press && !expanded) void expand(); // a plain click opens the card
  dragging = false;
  press = null;
};
root.addEventListener('pointerup', endPress);
root.addEventListener('pointercancel', endPress);

// ── Status ───────────────────────────────────────────────────────────────────

function onStatus(next: BackgroundStatusDto): void {
  status = next;
  if (next.tracking === 'paused') choosingPause = false;
  render();
}

api.onStatus(onStatus);
api.getStatus().then(onStatus).catch((e) => console.error('[widget] could not load status', e));
