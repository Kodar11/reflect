import { formatClock, formatDay } from '../../../reflection/ReflectionPeriods';
import { humanDurationShort } from './activityUtils';

/**
 * How the usage report is put into words and rows. Pure: every figure comes
 * from the report (computed in the main process); this only formats, filters
 * and pages what is already there.
 */

export const USAGE_PERIODS: { type: UsagePeriodTypeDto; label: string }[] = [
  { type: 'day', label: 'Today' },
  { type: 'week', label: 'Week' },
  { type: 'month', label: 'Month' },
  { type: 'year', label: 'Year' },
  { type: 'custom', label: 'Custom' },
];

/** How many rows an expanded list shows before "Show all". */
export const USAGE_LIST_INITIAL = 10;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as `YYYY-MM-DD` — the format of a custom range and of a date input. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The custom range first offered: the last seven days, today included. */
export function defaultCustomRequest(now: Date): Extract<UsageRequestDto, { type: 'custom' }> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return { type: 'custom', startDate: dateKey(start), endDate: dateKey(now) };
}

/** A stored request, if it is still one the page can show. */
export function parseStoredRequest(raw: string | null): UsageRequestDto | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as { type?: string; startDate?: string; endDate?: string };
    if (r.type === 'day' || r.type === 'week' || r.type === 'month' || r.type === 'year') return { type: r.type };
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (r.type === 'custom' && date.test(r.startDate ?? '') && date.test(r.endDate ?? '')) {
      return { type: 'custom', startDate: r.startDate!, endDate: r.endDate! };
    }
  } catch {
    // Not ours, or damaged: fall back to the default.
  }
  return null;
}

export function requestKey(request: UsageRequestDto): string {
  return request.type === 'custom' ? `custom:${request.startDate}:${request.endDate}` : request.type;
}

/** How often a report is re-read while its period is still running; null once it is over. */
export function refreshIntervalMs(window: UsageWindowDto): number | null {
  if (!window.inProgress) return null;
  if (window.type === 'day') return 30_000;
  if (window.type === 'month' || window.type === 'year') return 300_000;
  return 60_000;
}

/** What the two compared ranges are called. */
export function periodNames(type: UsagePeriodTypeDto): { current: string; previous: string } {
  switch (type) {
    case 'day':
      return { current: 'Today', previous: 'Yesterday' };
    case 'week':
      return { current: 'This week', previous: 'Last week' };
    case 'month':
      return { current: 'This month', previous: 'Last month' };
    case 'year':
      return { current: 'This year', previous: 'Last year' };
    case 'custom':
      return { current: 'Selected range', previous: 'Preceding range' };
  }
}

/**
 * A range as dates: `Mon, Oct 6 – Sun, Oct 12` for whole days, and with the
 * cut-off time when it stops part-way (`Mon, Oct 6 – Wed, Oct 8, 3:00 PM`).
 */
export function formatRange(range: UsageRangeDto, now: Date = new Date()): string {
  const start = new Date(range.start);
  const end = new Date(range.end);
  const day = (d: Date) => (d.getFullYear() === now.getFullYear() ? formatDay(d) : `${formatDay(d)}, ${d.getFullYear()}`);
  const sameDate = (a: Date, b: Date) => dateKey(a) === dateKey(b);

  const wholeDays = end > start && end.getHours() === start.getHours() && end.getMinutes() === start.getMinutes() && end.getSeconds() === 0;
  if (wholeDays) {
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1, end.getHours(), end.getMinutes());
    return sameDate(start, last) ? day(start) : `${day(start)} – ${day(last)}`;
  }
  if (sameDate(start, end)) return `${day(start)}, until ${formatClock(end)}`;
  return `${day(start)} – ${day(end)}, ${formatClock(end)}`;
}

export const formatUsageDuration = humanDurationShort;

/**
 * A share of tracked time in whole percent. Anything that would round to 0%
 * or to 100% without being that reads `<1%` / `>99%`, so a rounded figure
 * never claims more than the data does.
 */
export function formatShare(share: number): string {
  if (!(share > 0)) return '0%';
  if (share < 0.005) return '<1%';
  if (share < 1 && share >= 0.995) return '>99%';
  return `${Math.round(share * 100)}%`;
}

export type ChangeDirection = 'up' | 'down' | 'same' | 'new' | 'none';

export interface ChangeText {
  direction: ChangeDirection;
  /** `+4h · +50%`, `−35m · −12%`, `+2h · new`, `No change`, `—`. */
  text: string;
  /** `+4h`; empty when there is nothing to state. */
  delta: string;
  /** `+50%`; null when a percentage cannot be given. */
  percent: string | null;
  /** The same, spelled out for a tooltip or a screen reader. */
  label: string;
}

/** Differences under half a minute are below what the page displays. */
const SAME_BELOW_MS = 30_000;

export function describeChange(change: UsageChangeDto | null, previousName: string): ChangeText {
  const versus = previousName.toLowerCase();
  if (!change) {
    return { direction: 'none', text: '—', delta: '', percent: null, label: `No earlier data to compare with ${versus}` };
  }
  if (Math.abs(change.deltaMs) < SAME_BELOW_MS) {
    return { direction: 'same', text: 'No change', delta: '', percent: null, label: `About the same as ${versus}` };
  }
  const up = change.deltaMs > 0;
  const sign = up ? '+' : '−';
  const delta = `${sign}${formatUsageDuration(Math.abs(change.deltaMs))}`;
  const was = formatUsageDuration(change.previousMs);
  if (change.percent === null) {
    return {
      direction: 'new',
      text: `${delta} · new`,
      delta,
      percent: null,
      label: `${delta} — none ${versus}, so there is no percentage`,
    };
  }
  const magnitude = Math.abs(change.percent);
  const percent = magnitude >= 1000 ? `>999%` : magnitude < 1 ? `${sign}<1%` : `${sign}${Math.round(magnitude)}%`;
  return {
    direction: up ? 'up' : 'down',
    text: `${delta} · ${percent}`,
    delta,
    percent,
    label: `${delta} (${percent}) compared with ${was} ${versus}`,
  };
}

export interface UsageListState {
  open: boolean;
  showAll: boolean;
}

export const COLLAPSED_LIST: UsageListState = { open: false, showAll: false };

export interface UsageListRows {
  rows: UsageItemDto[];
  /** Items matching the search (all of them with no search). */
  matched: number;
  /** Matching items not shown yet — what "Show all" would add. */
  remaining: number;
  searching: boolean;
  /** Whether the rows are on screen: the list is expanded, or a search is showing its matches. */
  visible: boolean;
}

/**
 * The rows a full list shows. Collapsed: none. Expanded: the first ten, then
 * all on request. A search always looks through every item — not only the ones
 * on screen — and shows every match, whether or not the list was expanded.
 */
export function listRows(items: UsageItemDto[], state: UsageListState, query: string): UsageListRows {
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = searching ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;
  const visible = state.open || searching;
  const rows = !visible ? [] : state.showAll || searching ? matches : matches.slice(0, USAGE_LIST_INITIAL);
  return { rows, matched: matches.length, remaining: visible ? matches.length - rows.length : 0, searching, visible };
}

/** Bar length against the longest bar of the same list, in percent. No minimum: a sliver of time stays a sliver. */
export function barPercent(ms: number, longestMs: number): number {
  if (!(longestMs > 0) || !(ms > 0)) return 0;
  return Math.min(100, (ms / longestMs) * 100);
}

export function opensText(opens: number): string {
  return `${opens.toLocaleString('en-US')} ${opens === 1 ? 'open' : 'opens'}`;
}

export function kindLabel(kind: UsageKindDto): string {
  return kind === 'app' ? 'Application' : 'Website';
}

/** `2:05 PM` today, otherwise `Tue, Oct 28, 2:05 PM`. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return dateKey(d) === dateKey(now) ? formatClock(d) : `${formatDay(d)}, ${formatClock(d)}`;
}
