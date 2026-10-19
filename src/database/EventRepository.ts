import type { Database } from './Database.js';
import type { Event, StoredEvent, WatcherName } from '../models/Event.js';
import type { UsageAggregateRow, UsageTitleRow } from '../usage/UsageModels.js';

/**
 * The storage seam the heartbeat engine + watchers depend on. Watchers NEVER
 * touch SQL directly — they emit `ActivitySample` to the heartbeat engine,
 * which calls this repository. Tests substitute an in-memory fake.
 *
 * PRIVACY BOUNDARY: every read on this interface returns VISIBLE events only.
 * An event the user has hidden does not exist for anything built on it — the
 * Events view, sessions, the Timeline, classification, the analysis sent to
 * Gemini, Reflection, the Coach, exports, the tray and the widget. No caller
 * has to remember a filter. Hidden events are reachable only through
 * `IEventVisibilityStore`, which exists for the hide / restore / delete
 * controls and nothing else.
 *
 * Times are ISO-8601 (string) at the interface boundary. SQLite DATETIME columns
 * round-trip these strings trivially and stay human-readable in the DB file.
 */
export interface IEventRepository {
  /** Insert a new event; returns the assigned row id. */
  insert(sample: { watcher: WatcherName; startedAt: string; endedAt: string; app?: string | null; browser?: string | null; title?: string | null; url?: string | null; payload?: string | null }): number;
  /** Advance the ended timestamp of an in-flight event (heartbeat flush). */
  updateEndedAt(id: number, endedAt: string): void;
  /** All events with started_at >= start of the current local day (newest first). */
  getToday(): Event[];
  /** Events whose started_at falls inside [from, to) ISO strings (newest first). */
  getByRange(from: string, to: string): Event[];
  /** Events that overlap [from, to) at all — including ones that started
   * before `from` or end after `to` (oldest first). */
  getOverlapping(from: string, to: string): Event[];
  /** Events whose ids are in the provided list (newest first). */
  getByIds(ids: number[]): Event[];
  /** Every event, newest first. Used by the dev viewer when no filter is set. */
  getAll(limit?: number): Event[];
}

/**
 * The internal side of the privacy boundary: the only way to see or change a
 * hidden event. Used by the visibility controls; never hand this to a layer
 * that derives, analyses, displays or exports activity.
 */
export interface IEventVisibilityStore {
  /** The stored rows for these ids, hidden ones included; ids that do not exist are absent. */
  findIncludingHidden(ids: number[]): StoredEvent[];
  /** Hide the visible events among `ids`. Returns the ids that were hidden by this call. */
  hide(ids: number[], nowIso: string): number[];
  /** Make the hidden events among `ids` visible again. Returns the ids that were restored. */
  unhide(ids: number[]): number[];
  /** Remove the rows for good. Returns the ids that existed and are now gone. */
  deletePermanently(ids: number[]): number[];
  /** Hidden events, most recently hidden first. */
  listHidden(limit?: number): StoredEvent[];
}

interface EventRow {
  id: number;
  watcher: WatcherName;
  started_at: string;
  ended_at: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  payload: string | null;
  created_at: string | null;
  hidden_at: string | null;
}

/** The one condition that makes a query user-facing. */
const VISIBLE = 'hidden_at IS NULL';

/**
 * The window watcher's visible events that overlap [@from, @to), each with
 * the time it contributes: clipped to the range, and to the start of the
 * next event so two overlapping rows never count the same instant twice.
 * Whole milliseconds per event, so totals are exact sums. `prev_*` is what
 * was in front just before, for counting switches.
 */
const USAGE_SPANS = `
  WITH ordered AS (
    SELECT app, url, title, started_at,
           MAX(started_at, @from) AS span_start,
           MIN(ended_at, @to, COALESCE(LEAD(started_at) OVER w, @to)) AS span_end,
           LAG(app) OVER w AS prev_app,
           LAG(url) OVER w AS prev_url,
           ROW_NUMBER() OVER w = 1 AS first_in_range
    FROM events
    WHERE ${VISIBLE} AND watcher = 'window' AND started_at < @to AND ended_at > @from
    WINDOW w AS (ORDER BY started_at, id)
  ),
  spans AS (
    SELECT *, MAX(0, CAST(ROUND((julianday(span_end) - julianday(span_start)) * 86400000.0) AS INTEGER)) AS ms
    FROM ordered
  )`;

/**
 * `EventRepository` owns all SQL knowledge. Column↔field mapping happens only
 * here, so a schema change is a one-file edit. Implements `IEventRepository`
 * so consumers can depend on the interface instead of this class.
 */
export class EventRepository implements IEventRepository, IEventVisibilityStore {
  private readonly insertStmt;
  private readonly updateEndedAtStmt;
  private readonly todayStmt;
  private readonly rangeStmt;
  private readonly overlappingStmt;
  private readonly allStmt;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO events (watcher, started_at, ended_at, app, browser, title, url, payload)
       VALUES (@watcher, @started_at, @ended_at, @app, @browser, @title, @url, @payload)`,
    );
    this.updateEndedAtStmt = db.prepare(
      `UPDATE events SET ended_at = @ended_at WHERE id = @id`,
    );
    this.todayStmt = db.prepare(
      `SELECT * FROM events WHERE ${VISIBLE} AND started_at >= @from ORDER BY started_at DESC`,
    );
    this.rangeStmt = db.prepare(
      `SELECT * FROM events WHERE ${VISIBLE} AND started_at >= @from AND started_at < @to ORDER BY started_at DESC`,
    );
    this.overlappingStmt = db.prepare(
      `SELECT * FROM events WHERE ${VISIBLE} AND started_at < @to AND ended_at > @from ORDER BY started_at ASC, id ASC`,
    );
    this.allStmt = db.prepare(
      `SELECT * FROM events WHERE ${VISIBLE} ORDER BY started_at DESC LIMIT @limit`,
    );
  }

  insert(sample: { watcher: WatcherName; startedAt: string; endedAt: string; app?: string | null; browser?: string | null; title?: string | null; url?: string | null; payload?: string | null }): number {
    const info = this.insertStmt.run({
      watcher: sample.watcher,
      started_at: sample.startedAt,
      ended_at: sample.endedAt,
      app: sample.app ?? null,
      browser: sample.browser ?? null,
      title: sample.title ?? null,
      url: sample.url ?? null,
      payload: sample.payload ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  updateEndedAt(id: number, endedAt: string): void {
    this.updateEndedAtStmt.run({ id, ended_at: endedAt });
  }

  getToday(): Event[] {
    const from = startOfTodayIso();
    return (this.todayStmt.all({ from }) as unknown[] as EventRow[]).map(rowToEvent);
  }

  getByRange(from: string, to: string): Event[] {
    return (this.rangeStmt.all({ from, to }) as unknown[] as EventRow[]).map(rowToEvent);
  }

  getOverlapping(from: string, to: string): Event[] {
    return (this.overlappingStmt.all({ from, to }) as unknown[] as EventRow[]).map(rowToEvent);
  }

  getByIds(ids: number[]): Event[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT * FROM events WHERE ${VISIBLE} AND id IN (${placeholders}) ORDER BY started_at DESC`,
    );
    return (stmt.all(...ids) as unknown[] as EventRow[]).map(rowToEvent);
  }

  getAll(limit = 1000): Event[] {
    return (this.allStmt.all({ limit }) as unknown[] as EventRow[]).map(rowToEvent);
  }

  /**
   * Tracked time inside [from, to), in ms: the summed duration of the window
   * watcher's events, clipped to the range. One aggregate query — cheap enough
   * for the always-on status surfaces (tray, widget).
   */
  sumTrackedMs(from: string, to: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
            (julianday(MIN(ended_at, @to)) - julianday(MAX(started_at, @from))) * 86400000.0
          ), 0) AS ms
         FROM events
         WHERE ${VISIBLE} AND watcher = 'window' AND started_at < @to AND ended_at > @from`,
      )
      .get({ from, to }) as { ms: number | null };
    return Math.max(0, Math.round(row.ms ?? 0));
  }

  /**
   * Tracked time inside [from, to) per (application, website) pair, in ms,
   * with how often each came to the foreground. Aggregated in SQL: a year is
   * one indexed scan, and no raw event leaves the database.
   */
  aggregateUsage(from: string, to: string): UsageAggregateRow[] {
    return this.db
      .prepare(
        `${USAGE_SPANS}
         SELECT app, url,
                SUM(ms) AS ms,
                SUM(first_in_range OR app IS NOT prev_app) AS appOpens,
                SUM(url IS NOT NULL AND (first_in_range OR url IS NOT prev_url)) AS urlOpens,
                MAX(started_at) AS lastStartedAt
         FROM spans
         GROUP BY app, url`,
      )
      .all({ from, to }) as UsageAggregateRow[];
  }

  /** Tracked time inside [from, to) per window title of one application or website. */
  usageTitles(from: string, to: string, kind: 'app' | 'website', key: string): UsageTitleRow[] {
    const match = kind === 'website' ? `url = @key` : `COALESCE(TRIM(app), '') = @key`;
    return this.db
      .prepare(
        `${USAGE_SPANS}
         SELECT title, SUM(ms) AS ms, MAX(started_at) AS lastStartedAt
         FROM spans
         WHERE ${match}
         GROUP BY title`,
      )
      .all({ from, to, key }) as UsageTitleRow[];
  }

  /** The most recently updated event, or null with no events. */
  getLatest(): Event | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE ${VISIBLE} ORDER BY ended_at DESC, id DESC LIMIT 1`).get() as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * One page of the visible events starting inside [from, to), oldest first,
   * continuing after `after` (keyset paging, so a page never skips or repeats
   * a row however large the history is). For exports.
   */
  getPageAscending(from: string, to: string, after: { startedAt: string; id: number } | null, limit: number): Event[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE ${VISIBLE} AND started_at >= @from AND started_at < @to
           AND (@after_started IS NULL OR started_at > @after_started OR (started_at = @after_started AND id > @after_id))
         ORDER BY started_at ASC, id ASC
         LIMIT @limit`,
      )
      .all({ from, to, after_started: after?.startedAt ?? null, after_id: after?.id ?? 0, limit }) as unknown[] as EventRow[];
    return rows.map(rowToEvent);
  }

  /** How many visible events start inside [from, to). */
  countStartedInRange(from: string, to: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE ${VISIBLE} AND started_at >= @from AND started_at < @to`)
      .get({ from, to }) as { count: number };
    return row.count;
  }

  /** When tracking began: the earliest event start, or null with no events. */
  getFirstEventStart(): string | null {
    const row = this.db.prepare(`SELECT MIN(started_at) AS first FROM events WHERE ${VISIBLE}`).get() as { first: string | null };
    return row.first ?? null;
  }

  // ── IEventVisibilityStore (internal: the only queries that see hidden rows) ──

  findIncludingHidden(ids: number[]): StoredEvent[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id IN (SELECT value FROM json_each(@ids)) ORDER BY started_at ASC, id ASC`)
      .all({ ids: JSON.stringify(ids) }) as unknown[] as EventRow[];
    return rows.map(rowToStoredEvent);
  }

  hide(ids: number[], nowIso: string): number[] {
    return this.changing(ids, VISIBLE, (id) =>
      this.db.prepare(`UPDATE events SET hidden_at = @now WHERE id = @id AND ${VISIBLE}`).run({ id, now: nowIso }).changes,
    );
  }

  unhide(ids: number[]): number[] {
    return this.changing(ids, 'hidden_at IS NOT NULL', (id) =>
      this.db.prepare(`UPDATE events SET hidden_at = NULL WHERE id = @id AND hidden_at IS NOT NULL`).run({ id }).changes,
    );
  }

  deletePermanently(ids: number[]): number[] {
    // Rows that reference the event (its classification, its AI membership)
    // go with it through ON DELETE CASCADE.
    return this.changing(ids, '1 = 1', (id) => this.db.prepare(`DELETE FROM events WHERE id = @id`).run({ id }).changes);
  }

  listHidden(limit = 200): StoredEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE hidden_at IS NOT NULL ORDER BY hidden_at DESC, id DESC LIMIT @limit`)
      .all({ limit }) as unknown[] as EventRow[];
    return rows.map(rowToStoredEvent);
  }

  /** Apply `change` to each id matching `condition`, atomically; returns the ids it changed. */
  private changing(ids: number[], condition: string, change: (id: number) => number): number[] {
    const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id));
    if (wanted.length === 0) return [];
    return this.db.transaction(() => {
      const matching = this.db
        .prepare(`SELECT id FROM events WHERE ${condition} AND id IN (SELECT value FROM json_each(@ids))`)
        .all({ ids: JSON.stringify(wanted) }) as { id: number }[];
      return matching.filter(({ id }) => change(id) > 0).map(({ id }) => id);
    });
  }
}

function rowToEvent(r: EventRow): Event {
  return {
    id: r.id,
    watcher: r.watcher,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    app: r.app,
    browser: r.browser,
    title: r.title,
    url: r.url,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

function rowToStoredEvent(r: EventRow): StoredEvent {
  return { ...rowToEvent(r), hiddenAt: r.hidden_at };
}

/**
 * Local-midnight of "now" as an ISO string. We deliberately use wall-clock
 * local day (not UTC) because "today's events" is a user-facing concept and
 * the dev viewer shows human times. The `started_at` stored values themselves
 * are full ISO timestamps, so timezones are preserved exactly.
 */
function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
