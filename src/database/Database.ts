import BetterSqliteDB from 'better-sqlite3';
import type { Database as BetterSqlite } from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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
   * Schema is created idempotently (`CREATE TABLE IF NOT EXISTS`). Migrations
   * branch on SQLite's `user_version` pragma.
   */
  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= 5) return;

    // Base schema (idempotent). Does not include the per-profile rules table.
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

      -- Stage 3: append-only timeline edit log.
      CREATE TABLE IF NOT EXISTS timeline_edits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        operation   TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        undone_at   DATETIME
      );

      -- Stage 3.9: Activities and User-Defined Tracking Rules.
      CREATE TABLE IF NOT EXISTS activities (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tracking_rules (
        id          TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        conditions  TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        priority    INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (activity_id) REFERENCES activities (id) ON DELETE CASCADE
      );

      -- Stage 3.10: Focus Mode.
      CREATE TABLE IF NOT EXISTS focus_profiles (
        id                       TEXT PRIMARY KEY,
        name                     TEXT NOT NULL,
        description              TEXT,
        is_default               INTEGER NOT NULL DEFAULT 0,
        mode                     TEXT NOT NULL DEFAULT 'countdown',
        default_duration_minutes INTEGER,
        blocks_distractions      INTEGER NOT NULL DEFAULT 1,
        sound_cue                TEXT,
        created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Global pool of blocking rules.
      CREATE TABLE IF NOT EXISTS focus_rules (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        target     TEXT NOT NULL,
        action     TEXT NOT NULL DEFAULT 'block',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Profile-to-rule selection join table.
      CREATE TABLE IF NOT EXISTS focus_profile_rules (
        profile_id TEXT NOT NULL,
        rule_id    TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (profile_id, rule_id),
        FOREIGN KEY (profile_id) REFERENCES focus_profiles (id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id)    REFERENCES focus_rules    (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_profile_id ON focus_profile_rules (profile_id);
      CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_rule_id    ON focus_profile_rules (rule_id);

      CREATE TABLE IF NOT EXISTS focus_sessions (
        id                       TEXT PRIMARY KEY,
        profile_id               TEXT NOT NULL,
        task                     TEXT NOT NULL,
        notes                    TEXT,
        mode                     TEXT NOT NULL,
        planned_duration_minutes INTEGER,
        state                    TEXT NOT NULL DEFAULT 'planned',
        started_at               DATETIME,
        ended_at                 DATETIME,
        paused_at                DATETIME,
        total_pause_ms           INTEGER NOT NULL DEFAULT 0,
        elapsed_ms               INTEGER NOT NULL DEFAULT 0,
        blocking_lease_id        TEXT,
        created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (profile_id) REFERENCES focus_profiles (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_focus_sessions_started_at ON focus_sessions (started_at);
      CREATE INDEX IF NOT EXISTS idx_focus_sessions_state      ON focus_sessions (state);

      CREATE TABLE IF NOT EXISTS focus_interruptions (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        type        TEXT NOT NULL,
        reason      TEXT,
        occurred_at DATETIME NOT NULL,
        idle_ms     INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES focus_sessions (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_focus_interruptions_session_id ON focus_interruptions (session_id);

      CREATE TABLE IF NOT EXISTS blocked_attempts (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        type          TEXT NOT NULL,
        target        TEXT NOT NULL,
        attempted_at  DATETIME NOT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES focus_sessions (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocked_attempts_session_id ON blocked_attempts (session_id);
    `);

    // Migrate legacy per-profile rules to the global pool + join table.
    const legacyTable = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='focus_profile_rules'"
    ).get() as { name: string } | undefined;
    if (legacyTable) {
      // Rename the legacy table to avoid clashing with the new join table.
      this.db.exec(`ALTER TABLE focus_profile_rules RENAME TO focus_profile_rules_legacy`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS focus_profile_rules (
          profile_id TEXT NOT NULL,
          rule_id    TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (profile_id, rule_id),
          FOREIGN KEY (profile_id) REFERENCES focus_profiles (id) ON DELETE CASCADE,
          FOREIGN KEY (rule_id)    REFERENCES focus_rules    (id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_profile_id ON focus_profile_rules (profile_id);
        CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_rule_id    ON focus_profile_rules (rule_id);
      `);
      const legacyRows = this.db.prepare('SELECT * FROM focus_profile_rules_legacy').all() as any[];
      const insertRule = this.db.prepare(`
        INSERT INTO focus_rules (id, type, target, action, enabled, created_at, updated_at)
        VALUES (@id, @type, @target, @action, 1, @created_at, @updated_at)
      `);
      const insertJoin = this.db.prepare(`
        INSERT OR IGNORE INTO focus_profile_rules (profile_id, rule_id, created_at, updated_at)
        VALUES (@profile_id, @rule_id, @created_at, @updated_at)
      `);
      const ruleIds = new Map<string, string>();
      for (const r of legacyRows) {
        const key = `${r.type}:${r.target}:${r.action}`;
        let ruleId = ruleIds.get(key);
        if (!ruleId) {
          ruleId = randomUUID();
          ruleIds.set(key, ruleId);
          insertRule.run({
            id: ruleId,
            type: r.type,
            target: r.target,
            action: r.action,
            created_at: r.created_at,
            updated_at: r.updated_at,
          });
        }
        insertJoin.run({
          profile_id: r.profile_id,
          rule_id: ruleId,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
      this.db.exec(`DROP TABLE focus_profile_rules_legacy`);
    }

    this.db.pragma('user_version = 5');

    // Seed default activities and rules if empty
    const actCount = this.db.prepare('SELECT COUNT(*) as count FROM activities').get() as { count: number };
    if (actCount.count === 0) {
      this.db.exec(`
        INSERT INTO activities (id, name, color) VALUES
          ('coding', 'Coding', 'blue'),
          ('learning', 'Learning', 'green'),
          ('meetings', 'Meetings', 'yellow'),
          ('chatgpt', 'ChatGPT', 'purple'),
          ('browsing', 'Browsing', 'gray');

        INSERT INTO tracking_rules (id, activity_id, conditions, enabled, priority) VALUES
          ('rule_coding', 'coding', '[{"type":"app_equals","value":"VS Code"}]', 1, 0),
          ('rule_learning', 'learning', '[{"type":"domain_equals","value":"youtube.com"}]', 1, 0),
          ('rule_meetings', 'meetings', '[{"type":"title_contains","value":"Meet"}]', 1, 0),
          ('rule_chatgpt', 'chatgpt', '[{"type":"domain_equals","value":"chatgpt.com"}]', 1, 0);
      `);
    }

    // Seed default focus profile and rules if empty
    const profileCount = this.db.prepare('SELECT COUNT(*) as count FROM focus_profiles').get() as { count: number };
    if (profileCount.count === 0) {
      const now = new Date().toISOString();
      const ruleSocial = randomUUID();
      const ruleEntertainment = randomUUID();
      this.db.exec(`
        INSERT INTO focus_profiles (id, name, description, is_default, mode, default_duration_minutes, blocks_distractions, sound_cue, created_at, updated_at)
        VALUES ('default-deep-work', 'Deep Work', 'Block distractions and focus on one task.', 1, 'countdown', 25, 1, NULL, '${now}', '${now}');

        INSERT INTO focus_rules (id, type, target, action, enabled, created_at, updated_at) VALUES
          ('${ruleSocial}', 'category', 'social-media', 'block', 1, '${now}', '${now}'),
          ('${ruleEntertainment}', 'category', 'entertainment', 'block', 1, '${now}', '${now}');

        INSERT INTO focus_profile_rules (profile_id, rule_id, created_at, updated_at) VALUES
          ('default-deep-work', '${ruleSocial}', '${now}', '${now}'),
          ('default-deep-work', '${ruleEntertainment}', '${now}', '${now}');
      `);
    }
  }
}