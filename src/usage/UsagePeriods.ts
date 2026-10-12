import { periodContaining, periodFromKey, shiftPeriod } from '../reflection/ReflectionPeriods.js';
import type { UsagePeriodType, UsageRange, UsageRequest, UsageWindow } from './UsageModels.js';

/**
 * Which two ranges a usage request compares. Period boundaries themselves
 * come from `ReflectionPeriods` (local calendar, Monday weeks, the user's day
 * boundary); this only adds "up to now" and "the same stretch of the period
 * before".
 *
 * A period that is still running is measured up to `now`, and the previous
 * period is cut at the same point — Monday to Wednesday 3 PM is compared with
 * the previous Monday to Wednesday 3 PM, never with a whole week.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A request the IPC boundary can trust, or null. */
export function parseUsageRequest(input: unknown): UsageRequest | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as { type?: unknown; startDate?: unknown; endDate?: unknown };
  if (r.type === 'day' || r.type === 'week' || r.type === 'month' || r.type === 'year') return { type: r.type };
  if (r.type !== 'custom' || typeof r.startDate !== 'string' || typeof r.endDate !== 'string') return null;
  if (!DATE.test(r.startDate) || !DATE.test(r.endDate)) return null;
  if (!periodFromKey('day', r.startDate) || !periodFromKey('day', r.endDate)) return null;
  // Dates in either order mean the same range.
  return r.startDate <= r.endDate
    ? { type: 'custom', startDate: r.startDate, endDate: r.endDate }
    : { type: 'custom', startDate: r.endDate, endDate: r.startDate };
}

export function resolveUsageWindow(request: UsageRequest, now: Date): UsageWindow {
  if (request.type === 'custom') return customWindow(request.startDate, request.endDate, now);

  const period = periodContaining(request.type, now);
  const before = shiftPeriod(period, -1);
  return windowFor(
    request.type,
    { start: period.start, end: period.end },
    { start: before.start, end: before.end },
    now,
    (at) => shiftInstant(request.type as Exclude<UsagePeriodType, 'custom'>, at),
  );
}

function customWindow(startDate: string, endDate: string, now: Date): UsageWindow {
  const first = periodFromKey('day', startDate);
  const last = periodFromKey('day', endDate);
  if (!first || !last) throw new Error('Invalid usage date range');
  const days = calendarDaysBetween(new Date(first.start), new Date(last.start)) + 1;
  // The range of the same number of days ending where this one begins.
  const beforeStart = shiftPeriod(first, -days).start;
  return windowFor(
    'custom',
    { start: first.start, end: last.end },
    { start: beforeStart, end: first.start },
    now,
    (at) => shiftDays(at, -days),
  );
}

function windowFor(
  type: UsagePeriodType,
  period: UsageRange,
  before: UsageRange,
  now: Date,
  toPrevious: (at: Date) => Date,
): UsageWindow {
  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.end);
  const nowMs = now.getTime();
  const inProgress = nowMs < endMs;
  if (!inProgress) return { type, period, current: period, previous: before, inProgress };

  // A range that has not begun yet measures nothing, on both sides.
  const cutoff = Math.max(startMs, nowMs);
  const beforeStartMs = Date.parse(before.start);
  const beforeEndMs = Date.parse(before.end);
  const previousCutoff =
    cutoff === startMs ? beforeStartMs : Math.min(beforeEndMs, Math.max(beforeStartMs, toPrevious(now).getTime()));
  return {
    type,
    period,
    current: { start: period.start, end: new Date(cutoff).toISOString() },
    previous: { start: before.start, end: new Date(previousCutoff).toISOString() },
    inProgress,
  };
}

/**
 * The same wall-clock moment one period earlier. Calendar arithmetic, so a
 * DST change in between does not move it. A day the earlier month does not
 * have (the 31st) lands past that month's end and is clamped by the caller.
 */
function shiftInstant(type: Exclude<UsagePeriodType, 'custom'>, at: Date): Date {
  switch (type) {
    case 'day':
      return shiftDays(at, -1);
    case 'week':
      return shiftDays(at, -7);
    case 'month':
      return withDate(at, at.getFullYear(), at.getMonth() - 1, at.getDate());
    case 'year':
      return withDate(at, at.getFullYear() - 1, at.getMonth(), at.getDate());
  }
}

function shiftDays(at: Date, days: number): Date {
  return withDate(at, at.getFullYear(), at.getMonth(), at.getDate() + days);
}

function withDate(at: Date, year: number, month: number, day: number): Date {
  return new Date(year, month, day, at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds());
}

function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000,
  );
}
