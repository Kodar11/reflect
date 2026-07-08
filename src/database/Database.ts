import BetterSqliteDB from 'better-sqlite3';
import type { Database as BetterSqlite } from 'better-sqlite3';
import path from 'node:path';

/**
 * `Database` is the *only* module permitted to import `better-sqlite3`. Every
 * other consumer goes through `EventRepository` (or its interface
 * `IEventRepository`). This keeps the storage library swappable behind a seam —
 * a test or a future alternative (sql.js, remote sync) implements the same
 * interface and nothing else changes.
 *
 * Responsibilities:
 *  - open / create the SQLite file in the app's userData directory
 *  - apply pragmas for reliability and concurrency
 *  - run idempotent schema creation + simple `user_version`-based migrations
 *  - expose a `prepare` helper so the repository owns its own SQL statements
 *  - close cleanly on shutdown
 *
 * Design note: better-sqlite3 is synchronous. We run in the Electron *main*
 * process, never on the UI thread, so blocking calls here cannot jank the
 * renderer. The trade-off is simplicity + zero IPC marshalling overhead vs.
 * an async driver — worth it for Stage 1's volume.
 */
export class Database {
  private readonly db: BetterSqlite;

  constructor(filePath: string) {
    // `verbose` on dev can surface slow queries; we log via console for now.
    this.db = new BetterSqliteDB(filePath);
    this.applyPragmas();
    this.migrate();
  }

  /** Resolve the on-disk path for the tracker DB given electron's userData dir. */
  static filePathFor(userDataDir: string): string {
    return path.join(userDataDir, 'productivity-coach.db');
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }

  private applyPragmas(): void {
    // WAL gives concurrent readers + one writer and survives abrupt exits far
    // better than the default rollback journal. `busy_timeout` makes write
    // contention from the periodic heartbeat flush wait instead of erroring.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    // Avoid pathological growth early; revisit if events balloon.
    this.db.pragma('auto_vacuum = INCREMENTAL');
  }

  /**
   * Schema is created idempotently (`CREATE TABLE IF NOT EXISTS`). Future
   * additive migrations branch on SQLite's `user_version` pragma here —
   * number is bumped only when an incompatible schema change ships. Stage 1
   * stays at v1.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        watcher    TEXT    NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at   DATETIME NOT NULL,
        app        TEXT,
        browser    TEXT,
        title      TEXT,
        url        TEXT,
        payload    TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_events_started_at ON events (started_at);
      CREATE INDEX IF NOT EXISTS idx_events_watcher    ON events (watcher);
      CREATE INDEX IF NOT EXISTS idx_events_app         ON events (app);

      -- Stage 3: append-only timeline edit log. Generated sessions are never
      -- modified; user edits live here and are replayed by the TimelineEngine.
      -- undone_at is NULL for active edits; non-NULL marks a logical undo
      -- (the row stays for audit + replay fidelity; the engine skips it).
      CREATE TABLE IF NOT EXISTS timeline_edits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        operation   TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        undone_at   DATETIME
      );

      PRAGMA user_version = 2;
    `);
  }
}