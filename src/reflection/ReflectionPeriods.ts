import type { ReflectionPeriod, ReflectionPeriodType } from './ReflectionModels.js';

/**
 * The single home of period boundaries. Pure: every function takes the
 * instant it works from, and all boundaries are LOCAL calendar boundaries
 * (the user's timezone), computed with calendar arithmetic so a DST change
 * never shifts a day, week or month.
 *
 *   Day   = local calendar day
 *   Week  = Monday–Sunday
 *   Month = calendar month
 *   Year  = calendar year
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');

export function startOfLocalDay(at: Date | string): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local calendar day, `YYYY-MM-DD`. */
export function localDayKey(at: Date | string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday of the local week containing `at`. */
function startOfLocalWeek(at: Date | string): Date {
  const d = startOfLocalDay(at);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return d;
}

/** ISO-8601 week label of the week starting on `monday`: `2026-W40`. */
function isoWeekKey(monday: Date): string {
  // The ISO week-year is the calendar year of that week's Thursday.
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const firstMonday = startOfLocalWeek(jan4);
  // Calendar-day distance, immune to DST shifts.
  const days = Math.round(
    (Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()) -
      Date.UTC(firstMonday.getFullYear(), firstMonday.getMonth(), firstMonday.getDate())) /
      86_400_000,
  );
  return `${thursday.getFullYear()}-W${pad(Math.floor(days / 7) + 1)}`;
}

function build(type: ReflectionPeriodType, start: Date): ReflectionPeriod {
  let end: Date;
  let key: string;
  switch (type) {
    case 'day':
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      key = localDayKey(start);
      break;
    case 'week':
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
      key = isoWeekKey(start);
      break;
    case 'month':
      end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
      break;
    case 'year':
      end = new Date(start.getFullYear() + 1, 0, 1);
      key = String(start.getFullYear());
      break;
  }
  return { type, key, start: start.toISOString(), end: end.toISOString() };
}

/** The period of `type` that contains the instant `at`. */
export function periodContaining(type: ReflectionPeriodType, at: Date | string): ReflectionPeriod {
  const d = new Date(at);
  switch (type) {
    case 'day':
      return build('day', startOfLocalDay(d));
    case 'week':
      return build('week', startOfLocalWeek(d));
    case 'month':
      return build('month', new Date(d.getFullYear(), d.getMonth(), 1));
    case 'year':
      return build('year', new Date(d.getFullYear(), 0, 1));
  }
}

/** The period `offset` periods after (negative: before) `period`. */
export function shiftPeriod(period: ReflectionPeriod, offset: number): ReflectionPeriod {
  const s = new Date(period.start);
  switch (period.type) {
    case 'day':
      return build('day', new Date(s.getFullYear(), s.getMonth(), s.getDate() + offset));
    case 'week':
      return build('week', new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * offset));
    case 'month':
      return build('month', new Date(s.getFullYear(), s.getMonth() + offset, 1));
    case 'year':
      return build('year', new Date(s.getFullYear() + offset, 0, 1));
  }
}

/** The `count` periods immediately before `period`, most recent first. */
export function previousPeriods(period: ReflectionPeriod, count: number): ReflectionPeriod[] {
  const out: ReflectionPeriod[] = [];
  for (let i = 1; i <= count; i++) out.push(shiftPeriod(period, -i));
  return out;
}

export function isPeriodClosed(period: ReflectionPeriod, now: Date | string): boolean {
  return new Date(now).getTime() >= Date.parse(period.end);
}

export function isCurrentPeriod(period: ReflectionPeriod, now: Date | string): boolean {
  const t = new Date(now).getTime();
  return t >= Date.parse(period.start) && t < Date.parse(period.end);
}

export function isFuturePeriod(period: ReflectionPeriod, now: Date | string): boolean {
  return new Date(now).getTime() < Date.parse(period.start);
}

/** Every local day in [start, end), in order. */
export function listDays(start: string | Date, end: string | Date): ReflectionPeriod[] {
  const out: ReflectionPeriod[] = [];
  const endMs = new Date(end).getTime();
  let cursor = periodContaining('day', start);
  while (Date.parse(cursor.start) < endMs) {
    out.push(cursor);
    cursor = shiftPeriod(cursor, 1);
  }
  return out;
}

export interface PeriodBucket {
  key: string;
  label: string;
  start: string;
  end: string;
}

/**
 * The natural sub-divisions of a period, used for "how did it move across
 * the period" series: week → days, month → weeks (clipped to the month),
 * year → months. A day has none.
 */
export function subBuckets(period: ReflectionPeriod): PeriodBucket[] {
  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.end);
  switch (period.type) {
    case 'day':
      return [];
    case 'week':
      return listDays(period.start, period.end).map((d) => ({
        key: d.key,
        label: formatDay(new Date(d.start)),
        start: d.start,
        end: d.end,
      }));
    case 'month': {
      const out: PeriodBucket[] = [];
      let week = periodContaining('week', period.start);
      while (Date.parse(week.start) < endMs) {
        const s = Math.max(Date.parse(week.start), startMs);
        const e = Math.min(Date.parse(week.end), endMs);
        const last = new Date(e - 1);
        out.push({
          key: `w${out.length + 1}`,
          label: `${formatDayShort(new Date(s))}–${formatDayShort(last)}`,
          start: new Date(s).toISOString(),
          end: new Date(e).toISOString(),
        });
        week = shiftPeriod(week, 1);
      }
      return out;
    }
    case 'year': {
      const out: PeriodBucket[] = [];
      let month = periodContaining('month', period.start);
      while (Date.parse(month.start) < endMs) {
        out.push({
          key: month.key,
          label: MONTHS_LONG[new Date(month.start).getMonth()],
          start: month.start,
          end: month.end,
        });
        month = shiftPeriod(month, 1);
      }
      return out;
    }
  }
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** `Tue, Oct 28`. */
export function formatDay(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** `Oct 28`. */
export function formatDayShort(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** `2:05 PM`. */
export function formatClock(at: Date | string): string {
  const d = new Date(at);
  return formatClockMinutes(d.getHours() * 60 + d.getMinutes());
}

/** Minutes since local midnight → `2:05 PM`. */
export function formatClockMinutes(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Whole local hour → `2 PM`. */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** `Tue, Oct 28, 2:05 PM` — the timestamp format shown to the model. */
export function formatLocalDateTime(at: Date | string): string {
  const d = new Date(at);
  return `${formatDay(d)}, ${formatClock(d)}`;
}

export interface PeriodLabel {
  /** `Today`, `This week`, `Last month`, `October 2026`, `2026`. */
  title: string;
  /** `Sat, Oct 3`, `Sep 28 – Oct 4`, `October 2026`, `2026`. */
  range: string;
}

/** Human labels for a period, relative to `now`. */
export function describePeriod(period: ReflectionPeriod, now: Date | string): PeriodLabel {
  const start = new Date(period.start);
  const last = new Date(Date.parse(period.end) - 1);
  const current = periodContaining(period.type, now);
  const offset = period.key === current.key ? 0 : period.key === shiftPeriod(current, -1).key ? -1 : null;

  switch (period.type) {
    case 'day': {
      const range = formatDay(start);
      return { title: offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : range, range };
    }
    case 'week': {
      const range = `${formatDayShort(start)} – ${formatDayShort(last)}`;
      return { title: offset === 0 ? 'This week' : offset === -1 ? 'Last week' : `Week of ${formatDayShort(start)}`, range };
    }
    case 'month': {
      const range = `${MONTHS_LONG[start.getMonth()]} ${start.getFullYear()}`;
      return { title: offset === 0 ? 'This month' : offset === -1 ? 'Last month' : range, range };
    }
    case 'year': {
      const range = String(start.getFullYear());
      return { title: offset === 0 ? 'This year' : offset === -1 ? 'Last year' : range, range };
    }
  }
}

/** `previous day`, `previous week`… — how a comparison names its reference. */
export function previousPeriodName(type: ReflectionPeriodType): string {
  return `previous ${type}`;
}

/** Parse a period key back into its period; `null` when malformed. */
export function periodFromKey(type: ReflectionPeriodType, key: string): ReflectionPeriod | null {
  let at: Date | null = null;
  if (type === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (m) at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else if (type === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (m) at = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  } else if (type === 'year') {
    const m = /^(\d{4})$/.exec(key);
    if (m) at = new Date(Number(m[1]), 0, 1);
  } else {
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    if (m) {
      // Week 1 is the week containing January 4th.
      const firstMonday = startOfLocalWeek(new Date(Number(m[1]), 0, 4));
      at = new Date(firstMonday.getFullYear(), firstMonday.getMonth(), firstMonday.getDate() + (Number(m[2]) - 1) * 7);
    }
  }
  if (!at || Number.isNaN(at.getTime())) return null;
  const period = periodContaining(type, at);
  return period.key === key ? period : null;
}
