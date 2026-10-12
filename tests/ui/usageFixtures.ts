import type { UsageAggregateRow, UsageReport, UsageWindow } from '../../src/usage/UsageModels';
import { buildUsageReport } from '../../src/usage/UsageService';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Wednesday 14 October 2026, 3 PM local. */
export const NOW = new Date(2026, 9, 14, 15, 0);
const local = (month: number, day: number, hour = 0) => new Date(2026, month - 1, day, hour).toISOString();

export const WEEK_WINDOW: UsageWindow = {
  type: 'week',
  period: { start: local(10, 12), end: local(10, 19) },
  current: { start: local(10, 12), end: NOW.toISOString() },
  previous: { start: local(10, 5), end: local(10, 7, 15) },
  inProgress: true,
};

const pair = (app: string, url: string | null, ms: number, opens = 1): UsageAggregateRow => ({
  app,
  url,
  ms,
  appOpens: opens,
  urlOpens: url ? opens : 0,
  lastStartedAt: local(10, 14, 14),
});

/** Built by the real report builder, so the page is tested on figures it would actually receive. */
export function makeReport(overrides: {
  window?: UsageWindow;
  current?: UsageAggregateRow[];
  previous?: UsageAggregateRow[];
  trackingSince?: string | null;
} = {}): UsageReport {
  return buildUsageReport({
    window: overrides.window ?? WEEK_WINDOW,
    current: overrides.current ?? [
      pair('Brave Browser', 'chatgpt.com', 12 * HOUR, 80),
      pair('Brave Browser', 'youtube.com', 3 * HOUR, 30),
      pair('Visual Studio Code', null, 9 * HOUR, 60),
      pair('Figma', null, 2 * HOUR, 10),
    ],
    previous: overrides.previous ?? [
      pair('Brave Browser', 'chatgpt.com', 8 * HOUR),
      pair('Brave Browser', 'youtube.com', 4 * HOUR),
      pair('Visual Studio Code', null, 9 * HOUR),
      pair('Netflix', null, 5 * HOUR),
    ],
    trackingSince: overrides.trackingSince === undefined ? local(1, 1) : overrides.trackingSince,
    generatedAt: NOW.toISOString(),
  });
}

/** `count` applications of decreasing use: 60 min, 59 min, … */
export function manyApps(count: number): UsageAggregateRow[] {
  return Array.from({ length: count }, (_, i) => pair(`App ${String(i + 1).padStart(2, '0')}`, null, (60 - i) * MIN));
}
