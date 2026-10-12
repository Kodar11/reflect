import type { IUsageSource, UsageAggregateRow, UsageKind, UsageTitleRow } from '../../src/usage/UsageModels';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** One (application, website) aggregate row; opens default to 1 each. */
export function row(app: string | null, url: string | null, ms: number, opens: { app?: number; url?: number } = {}, last = '2026-10-14T09:00:00.000Z'): UsageAggregateRow {
  return { app, url, ms, appOpens: opens.app ?? 1, urlOpens: url ? (opens.url ?? 1) : 0, lastStartedAt: last };
}

/**
 * A usage source answering from scripted ranges, recording what it was asked.
 * `ranges` maps a range start to the rows of the range beginning there.
 */
export class FakeUsageSource implements IUsageSource {
  readonly asked: { from: string; to: string }[] = [];
  titles: UsageTitleRow[] = [];
  titleQueries: { from: string; to: string; kind: UsageKind; key: string }[] = [];

  constructor(
    private readonly ranges: Record<string, UsageAggregateRow[]>,
    private readonly firstEventStart: string | null = '2020-01-01T00:00:00.000Z',
  ) {}

  aggregateUsage(from: string, to: string): UsageAggregateRow[] {
    this.asked.push({ from, to });
    return this.ranges[from] ?? [];
  }

  usageTitles(from: string, to: string, kind: UsageKind, key: string): UsageTitleRow[] {
    this.titleQueries.push({ from, to, kind, key });
    return this.titles;
  }

  getFirstEventStart(): string | null {
    return this.firstEventStart;
  }
}
