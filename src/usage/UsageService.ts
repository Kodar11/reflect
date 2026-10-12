import {
  NEGLIGIBLE_MIN_MS,
  NEGLIGIBLE_SHARE,
  UNKNOWN_APP_NAME,
  USAGE_MOVER_COUNT,
  USAGE_TOP_COUNT,
  type IUsageSource,
  type UsageAggregateRow,
  type UsageChange,
  type UsageHistory,
  type UsageItem,
  type UsageItemDetail,
  type UsageKind,
  type UsageReport,
  type UsageRequest,
  type UsageWindow,
} from './UsageModels.js';
import { resolveUsageWindow } from './UsagePeriods.js';

const DETAIL_TITLE_COUNT = 8;

/**
 * The usage report for a period: one aggregate read per range, then plain
 * arithmetic. The current and the previous range go through the same query
 * and the same folding, so a comparison always compares like with like.
 */
export class UsageService {
  constructor(
    private readonly source: IUsageSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getReport(request: UsageRequest): UsageReport {
    const now = this.now();
    const window = resolveUsageWindow(request, now);
    return buildUsageReport({
      window,
      current: this.source.aggregateUsage(window.current.start, window.current.end),
      previous: this.source.aggregateUsage(window.previous.start, window.previous.end),
      trackingSince: this.source.getFirstEventStart(),
      generatedAt: now.toISOString(),
    });
  }

  getItemDetail(request: UsageRequest, kind: UsageKind, key: string): UsageItemDetail {
    const { current } = resolveUsageWindow(request, this.now());
    const rows = this.source.usageTitles(current.start, current.end, kind, key);
    const latest = rows.reduce<(typeof rows)[number] | null>(
      (best, row) => (!best || row.lastStartedAt > best.lastStartedAt ? row : best),
      null,
    );
    const titled = rows.filter((row) => row.title && row.title.trim());
    return {
      kind,
      key,
      titles: titled
        .map((row) => ({ title: row.title as string, ms: Math.round(row.ms) }))
        .sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title))
        .slice(0, DETAIL_TITLE_COUNT),
      titleCount: titled.length,
      latestTitle: latest?.title?.trim() || null,
      lastActiveAt: latest?.lastStartedAt ?? null,
    };
  }
}

export function buildUsageReport(input: {
  window: UsageWindow;
  current: UsageAggregateRow[];
  previous: UsageAggregateRow[];
  trackingSince: string | null;
  generatedAt: string;
}): UsageReport {
  const { window } = input;
  const history = historyOf(window, input.trackingSince);
  const current = fold(input.current);
  const previous = fold(input.previous);
  const compare = (currentMs: number, previousMs: number) => (history === 'none' ? null : changeOf(currentMs, previousMs));

  const negligibleBelowMs = Math.max(NEGLIGIBLE_MIN_MS, Math.ceil(current.trackedMs * NEGLIGIBLE_SHARE));
  const itemsOf = (kind: UsageKind, now: Map<string, Tally>, before: Map<string, Tally>): UsageItem[] =>
    [...now.entries()]
      .filter(([, tally]) => tally.ms > 0)
      .map(([key, tally]) => ({
        kind,
        key,
        name: nameOf(kind, key),
        ms: tally.ms,
        share: current.trackedMs > 0 ? tally.ms / current.trackedMs : 0,
        opens: tally.opens,
        lastActiveAt: tally.lastStartedAt,
        negligible: tally.ms < negligibleBelowMs,
        change: compare(tally.ms, before.get(key)?.ms ?? 0),
      }))
      .sort(byUsage);

  const apps = itemsOf('app', current.apps, previous.apps);
  const websites = itemsOf('website', current.websites, previous.websites);

  return {
    window,
    generatedAt: input.generatedAt,
    trackedMs: current.trackedMs,
    history,
    trackingSince: input.trackingSince,
    totals: {
      tracked: compare(current.trackedMs, previous.trackedMs),
      websites: compare(current.websiteMs, previous.websiteMs),
      outsideWebsites: compare(current.trackedMs - current.websiteMs, previous.trackedMs - previous.websiteMs),
    },
    websiteMs: current.websiteMs,
    apps,
    websites,
    topApps: topOf(apps),
    topWebsites: topOf(websites),
    mostOpened: [...apps, ...websites].sort((a, b) => b.opens - a.opens || byUsage(a, b))[0] ?? null,
    movers:
      history === 'none'
        ? []
        : [...apps, ...websites, ...goneItems('app', current.apps, previous.apps), ...goneItems('website', current.websites, previous.websites)]
            .filter((item) => Math.abs(item.change?.deltaMs ?? 0) >= negligibleBelowMs)
            .sort((a, b) => Math.abs(b.change!.deltaMs) - Math.abs(a.change!.deltaMs) || byUsage(a, b))
            .slice(0, USAGE_MOVER_COUNT),
    negligibleBelowMs,
  };
}

export function changeOf(currentMs: number, previousMs: number): UsageChange {
  const deltaMs = currentMs - previousMs;
  return { currentMs, previousMs, deltaMs, percent: previousMs > 0 ? (deltaMs / previousMs) * 100 : null };
}

interface Tally {
  ms: number;
  opens: number;
  lastStartedAt: string | null;
}

interface Folded {
  trackedMs: number;
  websiteMs: number;
  apps: Map<string, Tally>;
  websites: Map<string, Tally>;
}

/**
 * Per-application and per-website totals from the (application, website)
 * pairs. Durations are rounded once, per pair, so the application totals, the
 * website totals and tracked time are sums of the same whole numbers.
 */
function fold(rows: UsageAggregateRow[]): Folded {
  const out: Folded = { trackedMs: 0, websiteMs: 0, apps: new Map(), websites: new Map() };
  for (const row of rows) {
    const ms = Math.max(0, Math.round(row.ms));
    out.trackedMs += ms;
    add(out.apps, row.app?.trim() ?? '', ms, row.appOpens, row.lastStartedAt);
    const domain = row.url?.trim();
    if (domain) {
      out.websiteMs += ms;
      add(out.websites, domain, ms, row.urlOpens, row.lastStartedAt);
    }
  }
  return out;
}

function add(into: Map<string, Tally>, key: string, ms: number, opens: number, lastStartedAt: string): void {
  const tally = into.get(key) ?? { ms: 0, opens: 0, lastStartedAt: null };
  tally.ms += ms;
  tally.opens += opens;
  if (!tally.lastStartedAt || lastStartedAt > tally.lastStartedAt) tally.lastStartedAt = lastStartedAt;
  into.set(key, tally);
}

/** Items used in the previous range and not at all in this one. */
function goneItems(kind: UsageKind, now: Map<string, Tally>, before: Map<string, Tally>): UsageItem[] {
  return [...before.entries()]
    .filter(([key, tally]) => tally.ms > 0 && !(now.get(key)?.ms ?? 0))
    .map(([key, tally]) => ({
      kind,
      key,
      name: nameOf(kind, key),
      ms: 0,
      share: 0,
      opens: 0,
      lastActiveAt: null,
      negligible: true,
      change: changeOf(0, tally.ms),
    }));
}

/** The overview leaves negligible items out — unless that would leave nothing. */
function topOf(items: UsageItem[]): UsageItem[] {
  const notable = items.filter((item) => !item.negligible);
  return (notable.length > 0 ? notable : items).slice(0, USAGE_TOP_COUNT);
}

function historyOf(window: UsageWindow, trackingSince: string | null): UsageHistory {
  if (!trackingSince) return 'none';
  const since = Date.parse(trackingSince);
  if (since >= Date.parse(window.previous.end)) return 'none';
  return since > Date.parse(window.previous.start) ? 'partial' : 'full';
}

function nameOf(kind: UsageKind, key: string): string {
  return kind === 'app' && !key ? UNKNOWN_APP_NAME : key;
}

/** Most time first; equal times in name order, so the ranking is stable. */
function byUsage(a: UsageItem, b: UsageItem): number {
  return b.ms - a.ms || a.name.localeCompare(b.name);
}
