import type { Database } from './Database.js';
import type { Event, WatcherName } from '../models/Event.js';

/**
 * The storage seam the heartbeat engine + watchers depend on. Watchers NEVER
 * touch SQL directly — they emit `ActivitySample` to the heartbeat engine,
 * which calls this repository. Tests substitute an in-memory fake.
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
  /** Every event, newest first. Used by the dev viewer when no filter is set. */
  getAll(limit?: number): Event[];
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
}

/**
 * `EventRepository` owns all SQL knowledge. Column↔field mapping happens only
 * here, so a schema change is a one-file edit. Implements `IEventRepository`
 * so consumers can depend on the interface instead of this class.
 */
export class EventRepository implements IEventRepository {
  private readonly insertStmt;
  private readonly updateEndedAtStmt;
  private readonly todayStmt;
  private readonly rangeStmt;
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
      `SELECT * FROM events WHERE started_at >= @from ORDER BY started_at DESC`,
    );
    this.rangeStmt = db.prepare(
      `SELECT * FROM events WHERE started_at >= @from AND started_at < @to ORDER BY started_at DESC`,
    );
    this.allStmt = db.prepare(
      `SELECT * FROM events ORDER BY started_at DESC LIMIT @limit`,
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

  getAll(limit = 1000): Event[] {
    return (this.allStmt.all({ limit }) as unknown[] as EventRow[]).map(rowToEvent);
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