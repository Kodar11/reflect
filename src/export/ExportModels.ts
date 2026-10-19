/**
 * The data export: what can be exported, for which dates, in which format.
 *
 * Pure and shared: the main process validates every request with it, and the
 * renderer builds its choices and its summary from the same definitions. No
 * Electron, Node or React imports.
 *
 * Dates are LOCAL calendar days, midnight to midnight — the way the Timeline
 * and Activity pages show them. Stored timestamps are UTC ISO strings, so a
 * range is resolved to the UTC instants of those local midnights.
 */

export const EXPORT_SCHEMA_VERSION = 1;

export const EXPORT_CATEGORIES = ['timeline', 'events', 'focus', 'reflection', 'personalization'] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

export const EXPORT_PRESETS = ['all', 'today', 'last7', 'last30', 'thisMonth', 'custom'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

export type ExportFormat = 'json' | 'csv';

export interface ExportRangeRequest {
  preset: ExportPreset;
  /** Custom range only: first local day, `YYYY-MM-DD`. */
  from?: string | null;
  /** Custom range only: last local day (inclusive), `YYYY-MM-DD`. */
  to?: string | null;
}

export interface ExportRequest {
  categories: ExportCategory[];
  range: ExportRangeRequest;
  format: ExportFormat;
}

/** A range resolved to instants. `null` bounds mean "no limit" (all available data). */
export interface ResolvedExportRange {
  preset: ExportPreset;
  /** Inclusive start, UTC ISO. */
  from: string | null;
  /** Exclusive end, UTC ISO. */
  to: string | null;
  /** First local day, `YYYY-MM-DD`. */
  firstDay: string | null;
  /** Last local day (inclusive), `YYYY-MM-DD`. */
  lastDay: string | null;
}

export interface ExportCategoryInfo {
  label: string;
  description: string;
  /** `full`: every record is filtered by date. `partial`: some parts are current settings. `none`: current settings only. */
  dated: 'full' | 'partial' | 'none';
  /** False when CSV cannot represent the data faithfully; such a category is always exported as JSON. */
  csv: boolean;
  /** Shown when the category is selected. */
  warning?: string;
  /** What is exported as it is now rather than filtered by date. */
  currentOnly?: string;
}

export const EXPORT_CATEGORY_INFO: Record<ExportCategory, ExportCategoryInfo> = {
  timeline: {
    label: 'Timeline',
    description: 'Activity blocks as your Timeline shows them, with your titles, notes, edits and classification.',
    dated: 'full',
    csv: true,
  },
  events: {
    label: 'Raw activity events',
    description: 'Every captured app and window event with its exact start and end time.',
    dated: 'full',
    csv: true,
    warning: 'Window titles and website addresses can contain private details such as document names, email subjects or searches.',
  },
  focus: {
    label: 'Focus sessions',
    description: 'Tasks, planned and actual durations, how each session ended, pauses and blocked attempts.',
    dated: 'full',
    csv: true,
  },
  reflection: {
    label: 'Reflection & Coach',
    description: 'Reflections with their insights and your feedback, Coach suggestions and the Coach conversation.',
    dated: 'partial',
    csv: false,
    currentOnly: 'Your stated priorities and what the Coach remembers are exported as they are now.',
  },
  personalization: {
    label: 'Personalization & rules',
    description: 'Your personal context, classification rules and corrections, Focus profiles and app preferences.',
    dated: 'none',
    csv: false,
    currentOnly: 'Exported as currently configured — not filtered by date.',
  },
};

/** Selected the first time the dialog opens. Raw events are opt-in: they are large and the most sensitive. */
export const DEFAULT_EXPORT_CATEGORIES: ExportCategory[] = ['timeline', 'focus', 'reflection', 'personalization'];

export const EXPORT_PRESET_LABELS: Record<ExportPreset, string> = {
  all: 'All available data',
  today: 'Today',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
  custom: 'Custom range',
};

/** File stem for a single-category export. */
const CATEGORY_FILE_STEM: Record<ExportCategory, string> = {
  timeline: 'timeline',
  events: 'activity-events',
  focus: 'focus-sessions',
  reflection: 'reflection-coach',
  personalization: 'personalization',
};

/** The format a category is actually written in: CSV only where CSV is faithful. */
export function categoryFormat(category: ExportCategory, format: ExportFormat): ExportFormat {
  return EXPORT_CATEGORY_INFO[category].csv ? format : 'json';
}

/**
 * The files a category produces. Focus as CSV is three tables (sessions,
 * interruptions, blocked attempts); everything else is one file.
 */
export function categoryFileNames(category: ExportCategory, format: ExportFormat): string[] {
  const stem = CATEGORY_FILE_STEM[category];
  const f = categoryFormat(category, format);
  if (category === 'focus' && f === 'csv') {
    return ['focus-sessions.csv', 'focus-interruptions.csv', 'focus-blocked-attempts.csv'];
  }
  return [`${stem}.${f}`];
}

/** One plain file when the request produces exactly one; otherwise a ZIP with a manifest. */
export function isSingleFileExport(request: Pick<ExportRequest, 'categories' | 'format'>): boolean {
  return request.categories.length === 1 && categoryFileNames(request.categories[0], request.format).length === 1;
}

/** `reflect-export-2026-10-15.zip`, or `reflect-timeline-2026-10-15.csv` for a single file. */
export function suggestedExportFileName(request: Pick<ExportRequest, 'categories' | 'format'>, now: Date): string {
  const day = localDayKey(now);
  if (isSingleFileExport(request)) {
    const category = request.categories[0];
    return `reflect-${CATEGORY_FILE_STEM[category]}-${day}.${categoryFormat(category, request.format)}`;
  }
  return `reflect-export-${day}.zip`;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` of a local date. */
export function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` day, or null when it is not a real calendar date. */
export function parseLocalDay(value: string): Date | null {
  const m = DAY_PATTERN.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 9999) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar arithmetic, so a daylight-saving change never shifts a boundary off midnight. */
function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export type RangeResult = { ok: true; range: ResolvedExportRange } | { ok: false; error: string };

/** Resolve a preset (or a custom pair of days) against `now`. */
export function resolveExportRange(request: ExportRangeRequest, now: Date): RangeResult {
  const today = startOfLocalDay(now);
  const span = (first: Date, last: Date): RangeResult => ({
    ok: true,
    range: {
      preset: request.preset,
      from: first.toISOString(),
      to: addLocalDays(last, 1).toISOString(),
      firstDay: localDayKey(first),
      lastDay: localDayKey(last),
    },
  });

  switch (request.preset) {
    case 'all':
      return { ok: true, range: { preset: 'all', from: null, to: null, firstDay: null, lastDay: null } };
    case 'today':
      return span(today, today);
    case 'last7':
      return span(addLocalDays(today, -6), today);
    case 'last30':
      return span(addLocalDays(today, -29), today);
    case 'thisMonth':
      return span(new Date(today.getFullYear(), today.getMonth(), 1), today);
    case 'custom': {
      if (!request.from || !request.to) return { ok: false, error: 'Choose both a start and an end date.' };
      const first = parseLocalDay(request.from);
      const last = parseLocalDay(request.to);
      if (!first || !last) return { ok: false, error: 'Enter valid dates.' };
      if (first.getTime() > last.getTime()) return { ok: false, error: 'The start date is after the end date.' };
      return span(first, last);
    }
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

export type ParsedExportRequest = { ok: true; request: ExportRequest } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate an export request that crossed IPC. Strict: unknown fields are
 * refused (a request can never carry a file path), categories are deduped and
 * put in canonical order, and custom days must be real dates.
 */
export function parseExportRequest(raw: unknown): ParsedExportRequest {
  const invalid = (error: string): ParsedExportRequest => ({ ok: false, error });
  if (!isObject(raw)) return invalid('Invalid export request.');
  if (Object.keys(raw).some((k) => !['categories', 'range', 'format'].includes(k))) return invalid('Invalid export request.');

  const { categories, range, format } = raw;
  if (!Array.isArray(categories) || categories.length === 0 || categories.length > EXPORT_CATEGORIES.length * 2) {
    return invalid('Choose at least one kind of data to export.');
  }
  if (!categories.every((c) => typeof c === 'string' && (EXPORT_CATEGORIES as readonly string[]).includes(c))) {
    return invalid('Invalid export request.');
  }
  if (format !== 'json' && format !== 'csv') return invalid('Invalid export request.');

  if (!isObject(range) || Object.keys(range).some((k) => !['preset', 'from', 'to'].includes(k))) return invalid('Invalid export request.');
  const preset = range.preset;
  if (typeof preset !== 'string' || !(EXPORT_PRESETS as readonly string[]).includes(preset)) return invalid('Invalid export request.');
  const day = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= 10 ? v : undefined);
  const from = day(range.from);
  const to = day(range.to);
  if (from === undefined || to === undefined) return invalid('Invalid export request.');

  const ordered = EXPORT_CATEGORIES.filter((c) => (categories as string[]).includes(c));
  return {
    ok: true,
    request: {
      categories: ordered,
      format,
      range: preset === 'custom' ? { preset, from, to } : { preset: preset as ExportPreset },
    },
  };
}

// ── What the renderer is told ──────────────────────────────────────────────

/** Record counts that can be computed exactly without building the export. */
export type ExportEstimate =
  | { category: 'timeline'; sourceEvents: number }
  | { category: 'events'; events: number }
  | { category: 'focus'; sessions: number }
  | { category: 'reflection'; reports: number; coachActions: number; coachMessages: number }
  | { category: 'personalization' };

export type ExportPreview =
  | {
      ok: true;
      range: ResolvedExportRange;
      fileName: string;
      estimates: ExportEstimate[];
      /** True when every selected category is dated and has nothing in the range. */
      empty: boolean;
    }
  | { ok: false; error: string };

export type ExportRunResult =
  | { status: 'saved'; fileName: string; folder: string; files: string[]; bytes: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** True when an estimate holds no dated records. */
export function estimateIsEmpty(estimate: ExportEstimate): boolean {
  switch (estimate.category) {
    case 'timeline':
      return estimate.sourceEvents === 0;
    case 'events':
      return estimate.events === 0;
    case 'focus':
      return estimate.sessions === 0;
    case 'reflection':
      // Current priorities and Coach memory are always exported, so this is
      // only "empty" in the dated sense.
      return estimate.reports === 0 && estimate.coachActions === 0 && estimate.coachMessages === 0;
    case 'personalization':
      return false;
  }
}
