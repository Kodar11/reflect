/**
 * What the export dialog shows and sends. Pure: the dialog keeps a draft,
 * this module turns it into a request and words the summary, so all of it is
 * testable without a DOM. The main process re-validates everything.
 */
import {
  DEFAULT_EXPORT_CATEGORIES,
  EXPORT_CATEGORIES,
  EXPORT_CATEGORY_INFO,
  EXPORT_PRESET_LABELS,
  categoryFileNames,
  categoryFormat,
  isSingleFileExport,
  localDayKey,
  resolveExportRange,
  type ExportCategory,
  type ExportEstimate,
  type ExportFormat,
  type ExportPreset,
  type ExportRequest,
  type ResolvedExportRange,
} from '../../export/ExportModels';

export interface ExportDraft {
  categories: ExportCategory[];
  preset: ExportPreset;
  /** `YYYY-MM-DD`, used when `preset` is `custom`. */
  customFrom: string;
  customTo: string;
  format: ExportFormat;
}

export function initialExportDraft(now: Date): ExportDraft {
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return {
    categories: [...DEFAULT_EXPORT_CATEGORIES],
    preset: 'all',
    customFrom: localDayKey(weekAgo),
    customTo: localDayKey(now),
    format: 'json',
  };
}

/** Toggle one category, keeping the canonical order. */
export function toggleCategory(draft: ExportDraft, category: ExportCategory): ExportDraft {
  const on = draft.categories.includes(category);
  const next = on ? draft.categories.filter((c) => c !== category) : [...draft.categories, category];
  return { ...draft, categories: EXPORT_CATEGORIES.filter((c) => next.includes(c)) };
}

export function selectAllCategories(draft: ExportDraft): ExportDraft {
  return { ...draft, categories: [...EXPORT_CATEGORIES] };
}

export function clearCategories(draft: ExportDraft): ExportDraft {
  return { ...draft, categories: [] };
}

export function toExportRequest(draft: ExportDraft): ExportRequest {
  return {
    categories: draft.categories,
    format: draft.format,
    range: draft.preset === 'custom' ? { preset: 'custom', from: draft.customFrom, to: draft.customTo } : { preset: draft.preset },
  };
}

/** Why the draft cannot be exported yet, or null. */
export function draftProblem(draft: ExportDraft, now: Date): string | null {
  if (draft.categories.length === 0) return 'Choose at least one kind of data to export.';
  const range = resolveExportRange(toExportRequest(draft).range, now);
  return range.ok ? null : range.error;
}

// ── Wording ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(dayKey: string): { d: number; m: string; y: number } {
  const [y, m, d] = dayKey.split('-').map(Number);
  return { d, m: MONTHS[m - 1], y };
}

/** "All available data", "15 Oct 2026", "9 – 15 Oct 2026", "28 Sep – 4 Oct 2026". */
export function describeRange(range: ResolvedExportRange): string {
  if (!range.firstDay || !range.lastDay) return EXPORT_PRESET_LABELS.all;
  const a = formatDay(range.firstDay);
  const b = formatDay(range.lastDay);
  if (range.firstDay === range.lastDay) return `${b.d} ${b.m} ${b.y}`;
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
  return `${a.d} – ${b.d} ${b.m} ${b.y}`;
}

const n = (value: number) => value.toLocaleString('en-US');
const plural = (value: number, one: string, many: string) => `${n(value)} ${value === 1 ? one : many}`;

/** One line per selected category for the summary. */
export function describeEstimate(estimate: ExportEstimate): string {
  switch (estimate.category) {
    case 'timeline':
      return estimate.sourceEvents === 0 ? 'Nothing recorded in this range' : `From ${plural(estimate.sourceEvents, 'event', 'events')}`;
    case 'events':
      return plural(estimate.events, 'event', 'events');
    case 'focus':
      return plural(estimate.sessions, 'session', 'sessions');
    case 'reflection':
      return [
        plural(estimate.reports, 'reflection', 'reflections'),
        plural(estimate.coachActions, 'suggestion', 'suggestions'),
        plural(estimate.coachMessages, 'message', 'messages'),
      ].join(' · ');
    case 'personalization':
      return 'Current settings';
  }
}

/** How the export is packaged: "One CSV file", or "ZIP · 7 files + manifest". */
export function describePackaging(draft: Pick<ExportDraft, 'categories' | 'format'>): string {
  if (draft.categories.length === 0) return '—';
  if (isSingleFileExport(draft)) return `One ${categoryFormat(draft.categories[0], draft.format).toUpperCase()} file`;
  const files = draft.categories.reduce((n, c) => n + categoryFileNames(c, draft.format).length, 0);
  return `ZIP · ${files} files + manifest`;
}

/** What is exported as it is now rather than by date, or null when everything selected is dated. */
export function undatedNote(categories: ExportCategory[]): string | null {
  const parts: string[] = [];
  if (categories.includes('personalization')) parts.push('settings and rules');
  if (categories.includes('reflection')) parts.push('priorities and Coach memory');
  return parts.length ? `Not filtered by date: ${parts.join(', ')} are exported as they are now.` : null;
}

/** The count shown on a category's row, from the preview. */
export function estimateFor(estimates: ExportEstimate[] | undefined, category: ExportCategory): string | null {
  const estimate = estimates?.find((e) => e.category === category);
  return estimate ? describeEstimate(estimate) : null;
}

/** Said under the format choice when CSV does not apply to everything selected. */
export function formatNote(draft: Pick<ExportDraft, 'categories' | 'format'>): string | null {
  if (draft.format !== 'csv') return null;
  const jsonOnly = draft.categories.filter((c) => !EXPORT_CATEGORY_INFO[c].csv);
  if (jsonOnly.length === 0) return null;
  if (jsonOnly.length === draft.categories.length) {
    return 'This data has nested details a spreadsheet cannot hold, so it is exported as JSON.';
  }
  return `${jsonOnly.map((c) => EXPORT_CATEGORY_INFO[c].label).join(' and ')} ${jsonOnly.length === 1 ? 'stays' : 'stay'} JSON (nested details); the rest is CSV.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
