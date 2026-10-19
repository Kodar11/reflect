import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EventRepository } from '../database/EventRepository.js';
import type { TimelineService } from '../timeline/TimelineService.js';
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../database/CategorizationRepository.js';
import type { FocusRepository } from '../database/FocusRepository.js';
import type { ReflectionRepository } from '../database/ReflectionRepository.js';
import type { CoachRepository } from '../database/CoachRepository.js';
import type { UserProfileRepository } from '../database/UserProfileRepository.js';
import type { IAppSettingsRepository } from '../background/AppSettings.js';
import type { Event } from '../models/Event.js';
import type { VerifiedSession } from '../timeline/TimelineModels.js';
import type { FocusSession } from '../focus/FocusModels.js';
import { toVerifiedSessionDto, type VerifiedSessionDto } from '../timeline/timelineDto.js';
import { CSV_BOM, csvRow } from '../export/csv.js';
import { ZipWriter } from '../export/ZipWriter.js';
import {
  EXPORT_CATEGORY_INFO,
  EXPORT_SCHEMA_VERSION,
  categoryFileNames,
  categoryFormat,
  estimateIsEmpty,
  isSingleFileExport,
  resolveExportRange,
  suggestedExportFileName,
  type ExportCategory,
  type ExportEstimate,
  type ExportPreview,
  type ExportRequest,
  type ResolvedExportRange,
} from '../export/ExportModels.js';

/**
 * The unified data export.
 *
 * Read-only by construction: every dependency is narrowed to read methods,
 * so an export can never change history, classification, reflections or
 * settings. Reads go through the same visible-only repositories as the UI —
 * an event the user hid is not exported, nor anything derived from it.
 *
 * Large exports stay responsive: events are read in keyset pages, the
 * Timeline is rebuilt one local month at a time, output is streamed (and
 * compressed) as it is produced, and the service yields to the event loop
 * between pages. The file is written next to its destination and renamed
 * into place only when complete, so a failure never leaves half an export.
 *
 * The service never chooses a path: `write` is given the one the user picked
 * in the save dialog (see exportIpc).
 */

export interface ExportDeps {
  events: Pick<EventRepository, 'getPageAscending' | 'countStartedInRange' | 'getFirstEventStart'>;
  timeline: Pick<TimelineService, 'getByRange'>;
  activities: Pick<ActivityRuleRepository, 'listActivities' | 'listRules'>;
  categorization: Pick<CategorizationRepository, 'listDimensions' | 'listOverrides' | 'listEventClassifications'>;
  focus: Pick<FocusRepository, 'getSessionsByRange' | 'getInterruptions' | 'getBlockedAttempts' | 'getProfiles' | 'getRules' | 'getPreferences'>;
  reflection: Pick<ReflectionRepository, 'listCurrentReportsOverlapping' | 'countCurrentReportsOverlapping' | 'listPriorities'>;
  coach: Pick<CoachRepository, 'listActions' | 'listActionEvents' | 'listMemories' | 'listMessages' | 'getSettings'>;
  profile: Pick<UserProfileRepository, 'getProfile'>;
  appSettings: Pick<IAppSettingsRepository, 'getSettings'>;
  appVersion: string;
  now?: () => Date;
  /** Lets other work run between pages. Default: one turn of the event loop. */
  pause?: () => Promise<void>;
  /** Events per page. */
  pageSize?: number;
}

export interface ExportWriteResult {
  files: string[];
  bytes: number;
}

export class ExportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRangeError';
  }
}

/** Bounds standing in for "no limit" in ISO-string comparisons. */
const MIN_ISO = '0000-01-01T00:00:00.000Z';
const MAX_ISO = '9999-12-31T23:59:59.999Z';
const FLUSH_AT = 256 * 1024;
const ALL_MESSAGES = 1_000_000_000;

interface ExportFile {
  name: string;
  chunks: () => AsyncGenerator<string>;
}

/** What one export run read, for the manifest. */
type Counts = Partial<Record<string, number>>;

export class ExportService {
  private readonly now: () => Date;
  private readonly pause: () => Promise<void>;
  private readonly pageSize: number;

  constructor(private readonly deps: ExportDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pause = deps.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.pageSize = deps.pageSize ?? 5000;
  }

  /** The resolved range, suggested file name and exact record counts — without building anything. */
  preview(request: ExportRequest): ExportPreview {
    const resolved = resolveExportRange(request.range, this.now());
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const range = resolved.range;
    const estimates = request.categories.map((c) => this.estimate(c, range));
    return {
      ok: true,
      range,
      fileName: suggestedExportFileName(request, this.now()),
      estimates,
      empty: estimates.every(estimateIsEmpty),
    };
  }

  /** Write the export to `destination` (chosen by the user). Throws on failure; nothing is left behind. */
  async write(request: ExportRequest, destination: string): Promise<ExportWriteResult> {
    const exportedAt = this.now();
    const resolved = resolveExportRange(request.range, exportedAt);
    if (!resolved.ok) throw new ExportRangeError(resolved.error);
    const range = resolved.range;

    const counts: Counts = {};
    const files = request.categories.flatMap((c) => this.filesFor(c, request, range, exportedAt, counts));

    const dir = path.dirname(destination);
    const temp = path.join(dir, `.${path.basename(destination)}.${randomBytes(4).toString('hex')}.part`);
    const handle = await fs.promises.open(temp, 'wx');
    let closed = false;
    try {
      const sink = { write: (chunk: Buffer) => handle.write(chunk) };
      let written: string[];
      if (isSingleFileExport(request)) {
        for await (const chunk of coalesce(files[0].chunks())) await sink.write(Buffer.from(chunk, 'utf8'));
        written = [path.basename(destination)];
      } else {
        const zip = new ZipWriter(sink);
        for (const file of files) await zip.addFile(file.name, coalesce(file.chunks()), exportedAt);
        const manifest = this.manifest(request, range, exportedAt, files, counts);
        await zip.addFile('manifest.json', [JSON.stringify(manifest, null, 2) + '\n'], exportedAt);
        await zip.finish();
        written = [...files.map((f) => f.name), 'manifest.json'];
      }
      await handle.close();
      closed = true;
      await fs.promises.rename(temp, destination);
      const { size } = await fs.promises.stat(destination);
      return { files: written, bytes: size };
    } catch (err) {
      if (!closed) await handle.close().catch(() => undefined);
      await fs.promises.unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  // ── Estimates ────────────────────────────────────────────────────────────

  private estimate(category: ExportCategory, range: ResolvedExportRange): ExportEstimate {
    const from = range.from ?? MIN_ISO;
    const to = range.to ?? MAX_ISO;
    switch (category) {
      case 'timeline':
        return { category, sourceEvents: this.deps.events.countStartedInRange(from, to) };
      case 'events':
        return { category, events: this.deps.events.countStartedInRange(from, to) };
      case 'focus':
        return { category, sessions: this.focusSessions(from, to).length };
      case 'reflection':
        return {
          category,
          reports: this.deps.reflection.countCurrentReportsOverlapping(from, to),
          coachActions: this.coachActions(from, to).length,
          coachMessages: this.coachMessages(from, to).length,
        };
      case 'personalization':
        return { category };
    }
  }

  // ── Files per category ───────────────────────────────────────────────────

  private filesFor(category: ExportCategory, request: ExportRequest, range: ResolvedExportRange, exportedAt: Date, counts: Counts): ExportFile[] {
    const format = categoryFormat(category, request.format);
    const [name, ...rest] = categoryFileNames(category, request.format);
    const header = this.header(category, range, exportedAt);
    const from = range.from ?? MIN_ISO;
    const to = range.to ?? MAX_ISO;

    switch (category) {
      case 'timeline': {
        const blocks = () => counted(this.timelineBlocks(range), counts, 'timeline');
        return [{ name, chunks: () => (format === 'csv' ? csvFile(TIMELINE_COLUMNS, map(blocks(), timelineRow)) : jsonRecords(header, blocks())) }];
      }
      case 'events': {
        const events = () => counted(this.eventsInRange(from, to), counts, 'events');
        return [
          {
            name,
            chunks: () => (format === 'csv' ? csvFile(EVENT_COLUMNS, map(events(), eventRow)) : jsonRecords(header, map(events(), eventJson))),
          },
        ];
      }
      case 'focus': {
        if (format === 'json') {
          return [{ name, chunks: () => jsonRecords(header, counted(this.focusRecords(from, to), counts, 'focus')) }];
        }
        const [interruptionsName, attemptsName] = rest;
        return [
          { name, chunks: () => csvFile(FOCUS_COLUMNS, map(counted(this.focusRecords(from, to), counts, 'focus'), focusRow)) },
          { name: interruptionsName, chunks: () => csvFile(INTERRUPTION_COLUMNS, this.focusChildRows(from, to, 'interruptions')) },
          { name: attemptsName, chunks: () => csvFile(BLOCKED_COLUMNS, this.focusChildRows(from, to, 'blockedAttempts')) },
        ];
      }
      case 'reflection':
        return [{ name, chunks: () => this.reflectionDocument(header, from, to, counts) }];
      case 'personalization':
        return [{ name, chunks: () => this.personalizationDocument(header) }];
    }
  }

  private header(category: ExportCategory, range: ResolvedExportRange, exportedAt: Date): Record<string, unknown> {
    return {
      format: 'reflect-export',
      schemaVersion: EXPORT_SCHEMA_VERSION,
      category,
      exportedAt: exportedAt.toISOString(),
      timeZone: localTimeZone(),
      range: EXPORT_CATEGORY_INFO[category].dated === 'none' ? null : rangeForFile(range),
    };
  }

  // ── Timeline ─────────────────────────────────────────────────────────────

  /**
   * The verified Timeline, rebuilt one local month at a time — the same
   * service, edits and classification the Timeline page uses. Blocks the
   * user created by hand appear in every rebuild, so they are taken only from
   * the month they start in.
   */
  private async *timelineBlocks(range: ResolvedExportRange): AsyncGenerator<VerifiedSessionDto> {
    const activities = this.deps.activities.listActivities();
    const seen = new Set<string>();
    for (const chunk of this.timelineChunks(range)) {
      const blocks = this.deps.timeline
        .getByRange(chunk.from, chunk.to)
        .filter((s) => s.source !== 'user' || inRange(s.startedAt.toISOString(), chunk.from, chunk.to))
        .sort(byStartThenId);
      for (const block of blocks) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        yield toVerifiedSessionDto(block, activities);
      }
      await this.pause();
    }
  }

  private timelineChunks(range: ResolvedExportRange): { from: string; to: string }[] {
    if (range.from && range.to) return monthChunks(new Date(range.from), new Date(range.to));
    const first = this.deps.events.getFirstEventStart();
    if (!first) return [{ from: MIN_ISO, to: MAX_ISO }];
    const start = startOfLocalMonth(new Date(first));
    const now = this.now();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    // The open-ended edges hold no tracked events, only blocks the user added by hand (or clock-skewed events).
    return [{ from: MIN_ISO, to: start.toISOString() }, ...monthChunks(start, end), { from: end.toISOString(), to: MAX_ISO }];
  }

  // ── Raw events ───────────────────────────────────────────────────────────

  private async *eventsInRange(from: string, to: string): AsyncGenerator<Event> {
    let after: { startedAt: string; id: number } | null = null;
    for (;;) {
      const page = this.deps.events.getPageAscending(from, to, after, this.pageSize);
      for (const event of page) yield event;
      if (page.length < this.pageSize) return;
      const last = page[page.length - 1];
      after = { startedAt: last.startedAt, id: last.id };
      await this.pause();
    }
  }

  // ── Focus ────────────────────────────────────────────────────────────────

  /** Sessions that started in the range. Planned sessions that never started have no date and are left out. */
  private focusSessions(from: string, to: string): FocusSession[] {
    return this.deps.focus
      .getSessionsByRange(from, to)
      .filter((s) => s.startedAt !== null && inRange(s.startedAt, from, to))
      .sort((a, b) => cmp(a.startedAt!, b.startedAt!) || cmp(a.id, b.id));
  }

  private async *focusRecords(from: string, to: string): AsyncGenerator<FocusRecord> {
    const profiles = new Map(this.deps.focus.getProfiles().map((p) => [p.id, p.name]));
    let n = 0;
    for (const s of this.focusSessions(from, to)) {
      yield {
        id: s.id,
        task: s.task,
        notes: s.notes,
        profile: { id: s.profileId, name: profiles.get(s.profileId) ?? null },
        mode: s.mode,
        state: s.state,
        endReason: s.endReason,
        endNote: s.endNote,
        plannedDurationMinutes: s.plannedDurationMinutes,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        activeMs: s.elapsedMs,
        pausedMs: s.totalPauseMs,
        blocking: s.blockingConfig,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        interruptions: this.deps.focus.getInterruptions(s.id).map(({ sessionId: _s, ...i }) => i),
        blockedAttempts: this.deps.focus.getBlockedAttempts(s.id).map(({ sessionId: _s, ...a }) => a),
      };
      if (++n % 200 === 0) await this.pause();
    }
  }

  private async *focusChildRows(from: string, to: string, kind: 'interruptions' | 'blockedAttempts'): AsyncGenerator<unknown[]> {
    for await (const session of this.focusRecords(from, to)) {
      if (kind === 'interruptions') {
        for (const i of session.interruptions) {
          yield [session.id, i.type, i.reason, localDateTime(i.occurredAt), i.occurredAt, i.idleMs === null ? null : Math.round(i.idleMs / 1000)];
        }
      } else {
        for (const a of session.blockedAttempts) yield [session.id, a.type, a.target, localDateTime(a.attemptedAt), a.attemptedAt];
      }
    }
  }

  // ── Reflection & Coach ───────────────────────────────────────────────────

  private coachActions(from: string, to: string) {
    return this.deps.coach
      .listActions(from)
      .filter((a) => inRange(a.createdAt, from, to))
      .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  }

  private coachMessages(from: string, to: string) {
    return this.deps.coach.listMessages(ALL_MESSAGES).filter((m) => inRange(m.createdAt, from, to));
  }

  private async *reflectionDocument(header: Record<string, unknown>, from: string, to: string, counts: Counts): AsyncGenerator<string> {
    const deps = this.deps;
    const pause = this.pause;
    async function* reports() {
      for (const report of deps.reflection.listCurrentReportsOverlapping(from, to)) {
        // Internal failure details are not part of the user's data.
        const { error: _e, errorCategory: _c, ...rest } = report;
        yield rest;
      }
    }
    const coachActions = this.coachActions(from, to);
    async function* actions() {
      let n = 0;
      for (const action of coachActions) {
        yield { ...action, history: deps.coach.listActionEvents(action.id) };
        if (++n % 200 === 0) await pause();
      }
    }
    yield* jsonDocument(
      {
        ...header,
        note: EXPORT_CATEGORY_INFO.reflection.currentOnly,
      },
      [
        ['reports', counted(reports(), counts, 'reflectionReports')],
        ['coachActions', counted(actions(), counts, 'coachActions')],
        ['coachMessages', counted(iterate(this.coachMessages(from, to)), counts, 'coachMessages')],
        ['priorities', iterate(deps.reflection.listPriorities())],
        ['coachMemory', iterate(deps.coach.listMemories())],
      ],
    );
  }

  // ── Personalization & rules ──────────────────────────────────────────────

  private async *personalizationDocument(header: Record<string, unknown>): AsyncGenerator<string> {
    const d = this.deps;
    const app = d.appSettings.getSettings();
    const coach = d.coach.getSettings();
    yield* jsonDocument({
      ...header,
      note: EXPORT_CATEGORY_INFO.personalization.currentOnly,
      profile: d.profile.getProfile(),
      classification: {
        contexts: d.activities.listActivities(),
        dimensions: d.categorization.listDimensions(),
        rules: d.activities.listRules().map((r) => ({ ...r, conditions: parseJsonOr(r.conditions) })),
        manualCorrections: d.categorization.listOverrides(),
        eventClassifications: d.categorization.listEventClassifications(),
      },
      focus: {
        profiles: d.focus.getProfiles(),
        blockRules: d.focus.getRules(),
        preferences: d.focus.getPreferences(),
      },
      preferences: {
        startWithWindows: app.startWithWindows,
        floatingWidget: app.widgetEnabled,
        notifications: app.notificationsEnabled,
        dailyReflectionTime: minutesToClock(coach.reflectionMinutes),
        dayStartsAt: minutesToClock(coach.dayStartMinutes),
        notifyDailyReflection: coach.notifyDailyReflection,
      },
    }, []);
  }

  // ── Manifest ─────────────────────────────────────────────────────────────

  private manifest(request: ExportRequest, range: ResolvedExportRange, exportedAt: Date, files: ExportFile[], counts: Counts) {
    return {
      format: 'reflect-export',
      schemaVersion: EXPORT_SCHEMA_VERSION,
      app: { name: 'Reflect', version: this.deps.appVersion },
      exportedAt: exportedAt.toISOString(),
      timeZone: localTimeZone(),
      range: rangeForFile(range),
      requestedFormat: request.format,
      categories: request.categories.map((category) => ({
        id: category,
        label: EXPORT_CATEGORY_INFO[category].label,
        format: categoryFormat(category, request.format),
        files: categoryFileNames(category, request.format),
        filteredByDate: EXPORT_CATEGORY_INFO[category].dated,
        ...(EXPORT_CATEGORY_INFO[category].currentOnly ? { note: EXPORT_CATEGORY_INFO[category].currentOnly } : {}),
      })),
      recordCounts: counts,
      files: [...files.map((f) => f.name), 'manifest.json'],
      notes: [
        'Days are local calendar days, midnight to midnight, in the time zone above. Timestamps ending in "Z" are UTC.',
        'Timeline blocks and raw events are included when they start inside the range. Focus sessions, Coach actions and Coach messages likewise. A reflection is included when its period overlaps the range.',
        'The Timeline is rebuilt one calendar month at a time, so a block running across midnight at the end of a month appears as two blocks.',
        'Events you hid in Reflect are not exported, nor is anything derived from them.',
        'API keys, credentials and encryption material are never exported.',
        'This is a readable copy of your data, not a backup that Reflect can restore.',
      ],
    };
  }
}

// ── Record shapes ──────────────────────────────────────────────────────────

interface FocusRecord {
  id: string;
  task: string;
  notes: string | null;
  profile: { id: string; name: string | null };
  mode: string;
  state: string;
  endReason: string | null;
  endNote: string | null;
  plannedDurationMinutes: number | null;
  startedAt: string | null;
  endedAt: string | null;
  activeMs: number;
  pausedMs: number;
  blocking: unknown;
  createdAt: string;
  updatedAt: string;
  interruptions: { id: string; type: string; reason: string | null; occurredAt: string; idleMs: number | null; createdAt: string }[];
  blockedAttempts: { id: string; type: string; target: string; attemptedAt: string; createdAt: string }[];
}

const TIMELINE_COLUMNS = [
  'title', 'start_local', 'end_local', 'start_utc', 'end_utc', 'duration_seconds', 'active_seconds',
  'context', 'area', 'intent', 'quality', 'classified_by', 'primary_app', 'primary_browser', 'primary_title',
  'primary_url', 'apps_used', 'websites', 'event_count', 'source', 'renamed', 'ai_summary', 'note', 'id',
];

function timelineRow(s: VerifiedSessionDto): unknown[] {
  const c = s.classification;
  return [
    s.title, localDateTime(s.startedAt), localDateTime(s.endedAt), s.startedAt, s.endedAt,
    seconds(s.duration), seconds(s.activeDuration),
    c?.context?.name ?? s.activity?.name ?? null, c?.area?.name ?? null, c?.intent?.name ?? null, c?.quality?.name ?? null,
    c?.source ?? null, s.primaryApp, s.primaryBrowser, s.primaryTitle, s.primaryUrl,
    s.appsUsed.join('; '), s.browserTabs.join('; '), s.eventCount, s.source, s.isCustomTitle,
    s.ai?.summary ?? null, s.note ?? null, s.id,
  ];
}

const EVENT_COLUMNS = ['id', 'start_local', 'end_local', 'start_utc', 'end_utc', 'duration_seconds', 'watcher', 'app', 'browser', 'title', 'url', 'payload'];

function eventRow(e: Event): unknown[] {
  return [
    e.id, localDateTime(e.startedAt), localDateTime(e.endedAt), e.startedAt, e.endedAt,
    seconds(Date.parse(e.endedAt) - Date.parse(e.startedAt)), e.watcher, e.app, e.browser, e.title, e.url, e.payload,
  ];
}

function eventJson(e: Event) {
  return {
    id: e.id,
    watcher: e.watcher,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationMs: Math.max(0, Date.parse(e.endedAt) - Date.parse(e.startedAt)),
    app: e.app,
    browser: e.browser,
    title: e.title,
    url: e.url,
    payload: e.payload === null ? null : parseJsonOr(e.payload),
  };
}

const FOCUS_COLUMNS = [
  'id', 'task', 'profile', 'mode', 'state', 'end_reason', 'planned_minutes', 'start_local', 'end_local', 'start_utc', 'end_utc',
  'active_seconds', 'paused_seconds', 'interruptions', 'blocked_attempts', 'notes', 'end_note',
];

function focusRow(s: FocusRecord): unknown[] {
  return [
    s.id, s.task, s.profile.name, s.mode, s.state, s.endReason, s.plannedDurationMinutes,
    s.startedAt ? localDateTime(s.startedAt) : null, s.endedAt ? localDateTime(s.endedAt) : null, s.startedAt, s.endedAt,
    seconds(s.activeMs), seconds(s.pausedMs), s.interruptions.length, s.blockedAttempts.length, s.notes, s.endNote,
  ];
}

const INTERRUPTION_COLUMNS = ['session_id', 'type', 'reason', 'occurred_local', 'occurred_utc', 'idle_seconds'];
const BLOCKED_COLUMNS = ['session_id', 'type', 'target', 'attempted_local', 'attempted_utc'];

// ── Serialization helpers ──────────────────────────────────────────────────

async function* csvFile(columns: string[], rows: AsyncIterable<unknown[]>): AsyncGenerator<string> {
  yield CSV_BOM + csvRow(columns);
  for await (const row of rows) yield csvRow(row);
}

async function* jsonRecords(header: Record<string, unknown>, records: AsyncIterable<unknown>): AsyncGenerator<string> {
  yield* jsonDocument(header, [['records', records]]);
}

/**
 * A pretty-printed JSON object whose last members are arrays streamed item by
 * item. Equivalent to `JSON.stringify({...fields, ...arrays}, null, 2)`.
 */
async function* jsonDocument(fields: Record<string, unknown>, arrays: [string, AsyncIterable<unknown>][]): AsyncGenerator<string> {
  const members = Object.entries(fields).filter(([, v]) => v !== undefined);
  const total = members.length + arrays.length;
  let index = 0;
  yield '{\n';
  for (const [key, value] of members) {
    index++;
    yield `  ${JSON.stringify(key)}: ${indent(JSON.stringify(value, null, 2), 2)}${index < total ? ',' : ''}\n`;
  }
  for (const [key, items] of arrays) {
    index++;
    let first = true;
    for await (const item of items) {
      yield `${first ? `  ${JSON.stringify(key)}: [\n` : ',\n'}    ${indent(JSON.stringify(item, null, 2), 4)}`;
      first = false;
    }
    yield `${first ? `  ${JSON.stringify(key)}: []` : '\n  ]'}${index < total ? ',' : ''}\n`;
  }
  yield '}\n';
}

function indent(json: string, spaces: number): string {
  return json.includes('\n') ? json.replace(/\n/g, `\n${' '.repeat(spaces)}`) : json;
}

/** Join small pieces into larger writes. */
async function* coalesce(source: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const piece of source) {
    buffer += piece;
    if (buffer.length >= FLUSH_AT) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

async function* map<T, U>(source: AsyncIterable<T>, fn: (item: T) => U): AsyncGenerator<U> {
  for await (const item of source) yield fn(item);
}

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

async function* counted<T>(source: AsyncIterable<T>, counts: Counts, key: string): AsyncGenerator<T> {
  counts[key] = counts[key] ?? 0;
  for await (const item of source) {
    counts[key] = (counts[key] ?? 0) + 1;
    yield item;
  }
}

// ── Small pure helpers ─────────────────────────────────────────────────────

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const inRange = (iso: string, from: string, to: string) => iso >= from && iso < to;
const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

function byStartThenId(a: VerifiedSession, b: VerifiedSession): number {
  return a.startedAt.getTime() - b.startedAt.getTime() || cmp(a.id, b.id);
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** [from, to) cut at local month starts. */
export function monthChunks(from: Date, to: Date): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  let start = from;
  while (start.getTime() < to.getTime()) {
    const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const end = next.getTime() < to.getTime() ? next : to;
    chunks.push({ from: start.toISOString(), to: end.toISOString() });
    start = end;
  }
  return chunks;
}

/** `2026-10-15 14:03:07` in local time, for spreadsheets. */
export function localDateTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function rangeForFile(range: ResolvedExportRange) {
  return {
    preset: range.preset,
    firstDay: range.firstDay,
    lastDay: range.lastDay,
    from: range.from,
    to: range.to,
    description: range.firstDay ? `${range.firstDay} to ${range.lastDay} (local days, inclusive)` : 'All available data',
  };
}

function minutesToClock(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
