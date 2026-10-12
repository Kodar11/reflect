/**
 * What the Usage page shows: where tracked time went in a period, and how
 * that compares with the period before it. Facts only — durations, shares,
 * counts and differences. Nothing here says what the usage means.
 *
 * Definitions, used everywhere on the page:
 *
 *   Tracked time   The foreground-window time recorded in the range, each
 *                  event clipped to the range and to the start of the next
 *                  event, so no instant is counted twice.
 *   Application    The foreground application. A browser is an application:
 *                  its time includes the time spent on websites in it.
 *   Website        The domain in the foreground browser tab. Website time is
 *                  therefore a part of application time, never added to it.
 *   Share          An item's part of tracked time. Application shares add up
 *                  to 100%; website shares add up to the browser share.
 *   Opens          How many times the item came to the foreground from
 *                  something else (or was in front when the range began).
 */

export type UsagePeriodType = 'day' | 'week' | 'month' | 'year' | 'custom';

/** Local calendar dates, `YYYY-MM-DD`, both inclusive. */
export type UsageRequest =
  | { type: 'day' | 'week' | 'month' | 'year' }
  | { type: 'custom'; startDate: string; endDate: string };

/** `[start, end)` as ISO instants. */
export interface UsageRange {
  start: string;
  end: string;
}

export interface UsageWindow {
  type: UsagePeriodType;
  /** The whole selected period, including any part of it still to come. */
  period: UsageRange;
  /** What was measured: the period up to now. */
  current: UsageRange;
  /** The equivalent stretch of the period before: same start offset, same elapsed time. */
  previous: UsageRange;
  /** The selected period is still running, so both ranges stop part-way. */
  inProgress: boolean;
}

export interface UsageChange {
  currentMs: number;
  previousMs: number;
  deltaMs: number;
  /** Percentage change; null when the previous value was zero. */
  percent: number | null;
}

export type UsageKind = 'app' | 'website';

export interface UsageItem {
  kind: UsageKind;
  /** The stored value: application name or domain ('' when the application is unknown). */
  key: string;
  name: string;
  ms: number;
  /** Part of tracked time, 0–1. */
  share: number;
  opens: number;
  lastActiveAt: string | null;
  /** Too small for the overview; still listed in full and counted in every total. */
  negligible: boolean;
  /** Null when there is nothing earlier to compare with. */
  change: UsageChange | null;
}

/**
 * How much of the previous range tracking covers: all of it, only its later
 * part (tracking began inside it), or none.
 */
export type UsageHistory = 'full' | 'partial' | 'none';

export interface UsageReport {
  window: UsageWindow;
  generatedAt: string;
  trackedMs: number;
  history: UsageHistory;
  /** When tracking began; null with no events at all. */
  trackingSince: string | null;
  totals: {
    tracked: UsageChange | null;
    /** Time on websites. */
    websites: UsageChange | null;
    /** Tracked time that was not on a website. */
    outsideWebsites: UsageChange | null;
  };
  websiteMs: number;
  /** Every application / website with time in the range, most used first. */
  apps: UsageItem[];
  websites: UsageItem[];
  /** At most five each, negligible items left out. */
  topApps: UsageItem[];
  topWebsites: UsageItem[];
  mostOpened: UsageItem | null;
  /** The largest differences from the previous range, biggest first. */
  movers: UsageItem[];
  /** Items below this are `negligible`. */
  negligibleBelowMs: number;
}

export interface UsageItemDetail {
  kind: UsageKind;
  key: string;
  /** Window titles with the most time in the range. */
  titles: { title: string; ms: number }[];
  /** How many distinct titles there were in all. */
  titleCount: number;
  latestTitle: string | null;
  lastActiveAt: string | null;
}

/** One (application, website) pair of the aggregate query. */
export interface UsageAggregateRow {
  app: string | null;
  url: string | null;
  ms: number;
  appOpens: number;
  urlOpens: number;
  lastStartedAt: string;
}

export interface UsageTitleRow {
  title: string | null;
  ms: number;
  lastStartedAt: string;
}

/** The storage the usage report reads. Visible events only. */
export interface IUsageSource {
  aggregateUsage(from: string, to: string): UsageAggregateRow[];
  usageTitles(from: string, to: string, kind: UsageKind, key: string): UsageTitleRow[];
  getFirstEventStart(): string | null;
}

export const USAGE_TOP_COUNT = 5;
export const USAGE_MOVER_COUNT = 6;
/**
 * An item is negligible under a minute, or under a thousandth of tracked time
 * (ten minutes of a 170-hour year) — whichever is more.
 */
export const NEGLIGIBLE_MIN_MS = 60_000;
export const NEGLIGIBLE_SHARE = 0.001;
export const UNKNOWN_APP_NAME = 'Unknown application';
