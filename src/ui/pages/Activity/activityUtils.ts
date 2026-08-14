import type { TrackerEventDto, UsageRow } from './activityTypes';

export const CURATED_COLORS = [
  { name: 'blue', hex: '#3b82f6' },
  { name: 'green', hex: '#10b981' },
  { name: 'purple', hex: '#8b5cf6' },
  { name: 'orange', hex: '#f97316' },
  { name: 'yellow', hex: '#eab308' },
  { name: 'red', hex: '#ef4444' },
  { name: 'cyan', hex: '#06b6d4' },
  { name: 'gray', hex: '#6b7280' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'brown', hex: '#a16207' },
] as const;

export type CuratedColorName = (typeof CURATED_COLORS)[number]['name'];

export function getDomain(rawUrl: string): string {
  try {
    let host = rawUrl.trim();
    if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
    const u = new URL(host);
    return u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
  } catch {
    const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
    return match?.[1] ?? rawUrl;
  }
}

export function getEventNameAndType(e: TrackerEventDto): { name: string; type: 'App' | 'Website' } {
  if (e.url) {
    const domain = getDomain(e.url);
    if (domain) return { name: domain, type: 'Website' };
  }
  return { name: e.app || 'Unknown App', type: 'App' };
}

export function buildUsageData(events: TrackerEventDto[]): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const e of events) {
    const started = new Date(e.startedAt);
    const ended = new Date(e.endedAt);
    const duration = Math.max(0, ended.getTime() - started.getTime());
    const { name, type } = getEventNameAndType(e);

    const key = `${name}|${type}`;
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        name,
        type,
        totalTime: 0,
        sessionCount: 0,
        lastUsed: started,
        latestActivity: e.title || '',
        intervals: [],
      };
      map.set(key, row);
    }

    row.totalTime += duration;
    row.sessionCount += 1;
    if (started.getTime() > row.lastUsed.getTime()) {
      row.lastUsed = started;
      row.latestActivity = e.title || '';
    }
    row.intervals.push({ startedAt: started, endedAt: ended });
  }

  for (const row of map.values()) {
    row.intervals.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
  return Array.from(map.values());
}

export function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtHm(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function humanDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function conditionSummary(conditionsStr: string): string {
  try {
    const conds = JSON.parse(conditionsStr) as { type: string; value: string }[];
    if (conds.length === 0) return '(No conditions)';
    return conds
      .map((c) => {
        const typeLabel =
          c.type === 'app_equals'
            ? 'App ='
            : c.type === 'title_contains'
              ? 'Title contains'
              : c.type === 'url_contains'
                ? 'URL contains'
                : c.type === 'url_starts_with'
                  ? 'URL starts with'
                  : c.type === 'domain_equals'
                    ? 'Domain ='
                    : c.type === 'browser_equals'
                      ? 'Browser ='
                      : c.type;
        return `${typeLabel} "${c.value}"`;
      })
      .join(' AND ');
  } catch {
    return '(Invalid rule)';
  }
}

export function classifySummary(
  rule: { areaId: string | null; intentId: string | null; qualityId: string | null },
  dimensions: { areas: DimensionLike[]; intents: DimensionLike[]; qualities: DimensionLike[] },
): string {
  const area = dimensions.areas.find((d) => d.id === rule.areaId)?.name;
  const intent = dimensions.intents.find((d) => d.id === rule.intentId)?.name;
  const quality = dimensions.qualities.find((d) => d.id === rule.qualityId)?.name;
  const parts = [area, intent, quality].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

interface DimensionLike {
  id: string;
  name: string;
}

export function deterministicColorForName(name: string): CuratedColorName {
  const sum = name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return CURATED_COLORS[sum % CURATED_COLORS.length].name;
}
