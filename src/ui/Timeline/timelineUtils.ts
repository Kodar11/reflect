/**
 * Shared time / color / summary helpers for the calendar-style Day View timeline.
 * Pure functions only — no React, no Electron.
 *
 * Stage 3.6 collapses the Stage 3.5 multi-zoom system into a single, polished
 * Day View. One density (px/hour), one snap grid (minutes), one ruler — so the
 * whole timeline reads at a glance with no layout recalculation or virtualization
 * gymnastics. Keeping this file zoom-free removes a prop that threaded through
 * six components for a feature we explicitly deferred (premium zoom).
 */

/** Pixels per hour for the Day View. ~1728px full-day height. */
export const DAY_PX_PER_HOUR = 72;
/** Snap grid for drag/resize, in minutes. */
export const DAY_SNAP_MIN = 15;
/** Left ruler column width. Wide enough for "12:00" + half-hour "30" ticks. */
export const RULER_WIDTH = 64;
export const TIMELINE_SIDE_PADDING = 22;
/** Minimum rendered block height so very short sessions stay clickable.
 * Rize-style: tiny 2–3 minute sessions still render tall enough to read. */
export const MIN_BLOCK_HEIGHT = 44;

/** Minutes in a day. */
export const DAY_MIN = 24 * 60;

/** Full 24-hour canvas height. */
export function fullDayHeight(): number {
  return DAY_PX_PER_HOUR * 24;
}

/** Convert a wall-clock Date to a Y pixel offset from the start of `baseDay`. */
export function timeToPx(baseDay: Date, time: Date): number {
  const base = startOfDay(baseDay).getTime();
  return ((time.getTime() - base) / 3600_000) * DAY_PX_PER_HOUR;
}

/** Convert a Y pixel offset back to a wall-clock Date on `baseDay`. */
export function pxToTime(baseDay: Date, px: number): Date {
  const base = startOfDay(baseDay).getTime();
  return new Date(base + (px / DAY_PX_PER_HOUR) * 3600_000);
}

/** Snap a date to the Day View grid (DAY_SNAP_MIN minutes). */
export function snapTime(date: Date): Date {
  const d = new Date(date);
  const min = d.getHours() * 60 + d.getMinutes();
  const snapped = Math.round(min / DAY_SNAP_MIN) * DAY_SNAP_MIN;
  d.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
  return d;
}

/** Start of local day for the given Date. */
export function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

/** End of local day (exclusive) for the given Date. */
export function endOfDay(d: Date): Date {
  const e = startOfDay(d);
  e.setDate(e.getDate() + 1);
  return e;
}

/** Format as HH:MM. */
export function fmtHm(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Format duration to the most natural unit. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Deterministic hue index (0–7) for an app name. Stable across reloads. */
export type SessionCategory = 'development' | 'learning' | 'meetings' | 'entertainment' | 'offline';

export function sessionCategory(s: VerifiedSessionDto): SessionCategory {
  if (s.source === 'user') return 'offline';

  const haystack = [
    s.primaryApp,
    s.primaryBrowser,
    s.primaryTitle,
    s.primaryUrl,
    ...s.appsUsed,
    ...s.browserTabs,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b(code|vscode|visual studio|terminal|powershell|github|gitlab|node|npm|vite|typescript|react|electron)\b/.test(haystack)) {
    return 'development';
  }
  if (/\b(meet|zoom|teams|slack|calendar|outlook|gmail|mail|call|standup|meeting)\b/.test(haystack)) {
    return 'meetings';
  }
  if (/\b(youtube|netflix|spotify|prime video|hotstar|twitch|reddit|instagram|x.com|twitter|game|steam)\b/.test(haystack)) {
    return 'entertainment';
  }
  if (/\b(docs|documentation|course|learn|tutorial|stackoverflow|stack overflow|wikipedia|medium|coursera|udemy|article)\b/.test(haystack)) {
    return 'learning';
  }
  return 'learning';
}

export function categoryHueIndex(category: SessionCategory): number {
  switch (category) {
    case 'development': return 0;
    case 'learning': return 1;
    case 'meetings': return 2;
    case 'entertainment': return 3;
    case 'offline': return 4;
  }
}

export function sessionColorVar(session: VerifiedSessionDto): string {
  return `var(--block-hue-${categoryHueIndex(sessionCategory(session))})`;
}

/** Whether two [start, end) intervals overlap. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Layout assignment for the Day View lane algorithm (Rize / Google Calendar).
 *
 * 1. Sort sessions by start time.
 * 2. Group them into contiguous overlap clusters. A new cluster starts when the
 *    next session begins at or after the current cluster's end (back-to-back
 *    sessions do not overlap, so they get full width again).
 * 3. Within each cluster, assign lanes greedily by start time: use the lowest
 *    lane whose last occupant ended at or before the current session starts.
 *    This yields the minimum lane count for that cluster.
 * 4. Each session receives `{ lane, laneCount }`. Render width is
 *    `contentWidth / laneCount`; left offset is `lane * width`.
 */
export interface Lane {
  lane: number;
  laneCount: number;
}

export function computeLaneLayout<T extends { id: string; startedAt: string | Date; endedAt: string | Date }>(
  sessions: T[],
): Map<string, Lane> {
  const sorted = sortByStart(sessions);
  const layout = new Map<string, Lane>();

  type Item = {
    session: T;
    start: number;
    end: number;
    lane: number;
  };

  type Cluster = {
    items: Item[];
    lanes: { lastEnd: number }[];
    maxEnd: number;
  };

  let cluster: Cluster | null = null;

  for (const s of sorted) {
    const start = typeof s.startedAt === 'string' ? new Date(s.startedAt).getTime() : s.startedAt.getTime();
    const end = typeof s.endedAt === 'string' ? new Date(s.endedAt).getTime() : s.endedAt.getTime();

    // Start a new cluster when this session no longer overlaps the cluster so far.
    if (!cluster || start >= cluster.maxEnd) {
      // Commit previous cluster before starting a new one.
      if (cluster) {
        for (const item of cluster.items) {
          layout.set(item.session.id, { lane: item.lane, laneCount: cluster.lanes.length });
        }
      }
      cluster = { items: [], lanes: [], maxEnd: end };
    } else if (end > cluster.maxEnd) {
      cluster.maxEnd = end;
    }

    // Find the lowest lane whose last occupant ended at or before this start.
    let laneIndex = cluster.lanes.findIndex((lane) => lane.lastEnd <= start);
    if (laneIndex < 0) {
      laneIndex = cluster.lanes.length;
      cluster.lanes.push({ lastEnd: end });
    } else {
      cluster.lanes[laneIndex].lastEnd = end;
    }

    cluster.items.push({ session: s, start, end, lane: laneIndex });
  }

  if (cluster) {
    for (const item of cluster.items) {
      layout.set(item.session.id, { lane: item.lane, laneCount: cluster.lanes.length });
    }
  }

  return layout;
}

/** Stable sort sessions by start time (ties by id) for deterministic layout. */
export function sortByStart<T extends { startedAt: string | Date; id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const aTime = typeof a.startedAt === 'string' ? new Date(a.startedAt).getTime() : a.startedAt.getTime();
    const bTime = typeof b.startedAt === 'string' ? new Date(b.startedAt).getTime() : b.startedAt.getTime();
    const t = aTime - bTime;
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
}

/** Clamp a value. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Day summary helpers ─────────────────────────────────────────────────────

import type { VerifiedSessionDto } from '../../timeline/timelineIpc';

/** Total tracked time (ms) across a day's sessions. */
export function totalTracked(sessions: VerifiedSessionDto[]): number {
  return sessions.reduce((sum, s) => sum + s.duration, 0);
}

/** The session with the greatest `duration`, or null when the day is empty. */
export function longestSession(sessions: VerifiedSessionDto[]): VerifiedSessionDto | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((best, s) => (s.duration > best.duration ? s : best), sessions[0]);
}

/** Number of user-source ("manual"/offline) sessions in the day. */
export function manualEditCount(sessions: VerifiedSessionDto[]): number {
  return sessions.filter((s) => s.source === 'user').length;
}

/** Total raw event count across the day (timeline integrity proxy). */
export function totalEventCount(sessions: VerifiedSessionDto[]): number {
  return sessions.reduce((sum, s) => sum + s.eventCount, 0);
}

/** Build a plain-text "copy details" summary for a session. */
export function sessionDetailsText(s: VerifiedSessionDto): string {
  const lines: string[] = [];
  lines.push(s.title || '(unlabelled)');
  lines.push(`Time: ${fmtHm(s.startedAt)} – ${fmtHm(s.endedAt)}`);
  lines.push(`Duration: ${fmtDuration(s.duration)}`);
  if (s.activeDuration > 0 && s.activeDuration < s.duration) {
    lines.push(`Active: ${fmtDuration(s.activeDuration)}`);
  }
  if (s.primaryApp) lines.push(`App: ${s.primaryApp}`);
  if (s.primaryBrowser) lines.push(`Browser: ${s.primaryBrowser}`);
  if (s.primaryUrl) lines.push(`URL: ${s.primaryUrl}`);
  if (s.appsUsed.length) lines.push(`Apps (${s.appsUsed.length}): ${s.appsUsed.join(', ')}`);
  if (s.browserTabs.length) lines.push(`Tabs (${s.browserTabs.length}): ${s.browserTabs.join(', ')}`);
  lines.push(`Events: ${s.eventCount}`);
  lines.push(`Source: ${s.source === 'user' ? 'offline' : 'generated'}`);
  if (s.note) lines.push(`Note: ${s.note}`);
  return lines.join('\n');
}
