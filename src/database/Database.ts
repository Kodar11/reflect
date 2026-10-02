import BetterSqliteDB from 'better-sqlite3';
import type { Database as BetterSqlite } from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * `Database` is the only module permitted to import `better-sqlite3`.
 *
 * Responsibilities:
 * - open / create the SQLite file in the app's userData directory
 * - apply pragmas for reliability and concurrency
 * - run idempotent schema creation + user_version migrations
 * - expose a prepare helper
 * - close cleanly on shutdown
 */
export class Database {
  private readonly db: BetterSqlite;

  constructor(filePath: string) {
    try {
      this.db = new BetterSqliteDB(filePath);
      this.applyPragmas();
      this.migrate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[Database] Failed to initialize database at ${filePath}: ${message}`,
      );
      throw new Error(`Database initialization failed: ${message}`);
    }
  }

  /** Resolve the on-disk path for the tracker DB given Electron's userData dir. */
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
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('auto_vacuum = INCREMENTAL');
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', {
      simple: true,
    }) as number;

    if (version >= 10) return;

    const tableHasColumn = (
      tableName: string,
      columnName: string,
    ): boolean => {
      const cols = this.db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as { name: string }[];

      return cols.some((c) => c.name === columnName);
    };

    // ─────────────────────────────────────────────────────────────────────
    // v0 → v5
    // Base schema
    // ─────────────────────────────────────────────────────────────────────

    if (version < 5) {
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

        CREATE INDEX IF NOT EXISTS idx_events_started_at
          ON events (started_at);

        CREATE INDEX IF NOT EXISTS idx_events_watcher
          ON events (watcher);

        CREATE INDEX IF NOT EXISTS idx_events_app
          ON events (app);

        CREATE TABLE IF NOT EXISTS timeline_edits (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          operation   TEXT    NOT NULL,
          payload     TEXT    NOT NULL,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          undone_at   DATETIME
        );

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
          FOREIGN KEY (activity_id)
            REFERENCES activities (id)
            ON DELETE CASCADE
        );

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

        CREATE TABLE IF NOT EXISTS focus_rules (
          id         TEXT PRIMARY KEY,
          type       TEXT NOT NULL,
          target     TEXT NOT NULL,
          action     TEXT NOT NULL DEFAULT 'block',
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS focus_profile_rules (
          profile_id TEXT NOT NULL,
          rule_id    TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

          PRIMARY KEY (profile_id, rule_id),

          FOREIGN KEY (profile_id)
            REFERENCES focus_profiles (id)
            ON DELETE CASCADE,

          FOREIGN KEY (rule_id)
            REFERENCES focus_rules (id)
            ON DELETE CASCADE
        );

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

          FOREIGN KEY (profile_id)
            REFERENCES focus_profiles (id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_focus_sessions_started_at
          ON focus_sessions (started_at);

        CREATE INDEX IF NOT EXISTS idx_focus_sessions_state
          ON focus_sessions (state);

        CREATE TABLE IF NOT EXISTS focus_interruptions (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          type        TEXT NOT NULL,
          reason      TEXT,
          occurred_at DATETIME NOT NULL,
          idle_ms     INTEGER,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,

          FOREIGN KEY (session_id)
            REFERENCES focus_sessions (id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_focus_interruptions_session_id
          ON focus_interruptions (session_id);

        CREATE TABLE IF NOT EXISTS blocked_attempts (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL,
          type          TEXT NOT NULL,
          target        TEXT NOT NULL,
          attempted_at  DATETIME NOT NULL,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,

          FOREIGN KEY (session_id)
            REFERENCES focus_sessions (id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_blocked_attempts_session_id
          ON blocked_attempts (session_id);
      `);

      const hasLegacyBackup = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='focus_profile_rules_legacy'",
        )
        .get() as { name: string } | undefined;

      const hasRulesTable = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='focus_profile_rules'",
        )
        .get() as { name: string } | undefined;

      const isLegacyRulesTable =
        hasRulesTable &&
        tableHasColumn('focus_profile_rules', 'id');

      const migrateFrom = (legacyTableName: string) => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS focus_rules (
            id         TEXT PRIMARY KEY,
            type       TEXT NOT NULL,
            target     TEXT NOT NULL,
            action     TEXT NOT NULL DEFAULT 'block',
            enabled    INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS focus_profile_rules (
            profile_id TEXT NOT NULL,
            rule_id    TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

            PRIMARY KEY (profile_id, rule_id),

            FOREIGN KEY (profile_id)
              REFERENCES focus_profiles (id)
              ON DELETE CASCADE,

            FOREIGN KEY (rule_id)
              REFERENCES focus_rules (id)
              ON DELETE CASCADE
          );
        `);

        const legacyRows = this.db
          .prepare(`SELECT * FROM ${legacyTableName}`)
          .all() as any[];

        const insertRule = this.db.prepare(`
          INSERT INTO focus_rules
            (id, type, target, action, enabled, created_at, updated_at)
          VALUES
            (@id, @type, @target, @action, 1, @created_at, @updated_at)
        `);

        const insertJoin = this.db.prepare(`
          INSERT OR IGNORE INTO focus_profile_rules
            (profile_id, rule_id, created_at, updated_at)
          VALUES
            (@profile_id, @rule_id, @created_at, @updated_at)
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

        this.db.exec(`DROP TABLE ${legacyTableName}`);
      };

      if (hasLegacyBackup) {
        migrateFrom('focus_profile_rules_legacy');
      } else if (isLegacyRulesTable) {
        this.db.exec(
          `ALTER TABLE focus_profile_rules RENAME TO focus_profile_rules_legacy`,
        );

        migrateFrom('focus_profile_rules_legacy');
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_profile_id
          ON focus_profile_rules (profile_id);

        CREATE INDEX IF NOT EXISTS idx_focus_profile_rules_rule_id
          ON focus_profile_rules (rule_id);
      `);

      this.db.pragma('user_version = 5');

      // Default activities and tracking rules.
      const actCount = this.db
        .prepare('SELECT COUNT(*) as count FROM activities')
        .get() as { count: number };

      if (actCount.count === 0) {
        this.db.exec(`
          INSERT INTO activities (id, name, color) VALUES
            ('coding', 'Coding', 'blue'),
            ('learning', 'Learning', 'green'),
            ('meetings', 'Meetings', 'yellow'),
            ('chatgpt', 'ChatGPT', 'purple'),
            ('browsing', 'Browsing', 'gray');

          INSERT INTO tracking_rules
            (id, activity_id, conditions, enabled, priority)
          VALUES
            (
              'rule_coding',
              'coding',
              '[{"type":"app_equals","value":"VS Code"}]',
              1,
              0
            ),
            (
              'rule_learning',
              'learning',
              '[{"type":"domain_equals","value":"youtube.com"}]',
              1,
              0
            ),
            (
              'rule_meetings',
              'meetings',
              '[{"type":"title_contains","value":"Meet"}]',
              1,
              0
            ),
            (
              'rule_chatgpt',
              'chatgpt',
              '[{"type":"domain_equals","value":"chatgpt.com"}]',
              1,
              0
            );
        `);
      }

      // Default Focus profile and rules.
      const profileCount = this.db
        .prepare('SELECT COUNT(*) as count FROM focus_profiles')
        .get() as { count: number };

      if (profileCount.count === 0) {
        const now = new Date().toISOString();
        const ruleSocial = randomUUID();
        const ruleEntertainment = randomUUID();

        this.db.exec(`
          INSERT INTO focus_profiles
            (
              id,
              name,
              description,
              is_default,
              mode,
              default_duration_minutes,
              blocks_distractions,
              sound_cue,
              created_at,
              updated_at
            )
          VALUES
            (
              'default-deep-work',
              'Deep Work',
              'Block distractions and focus on one task.',
              1,
              'countdown',
              25,
              1,
              NULL,
              '${now}',
              '${now}'
            );

          INSERT INTO focus_rules
            (
              id,
              type,
              target,
              action,
              enabled,
              created_at,
              updated_at
            )
          VALUES
            (
              '${ruleSocial}',
              'category',
              'social-media',
              'block',
              1,
              '${now}',
              '${now}'
            ),
            (
              '${ruleEntertainment}',
              'category',
              'entertainment',
              'block',
              1,
              '${now}',
              '${now}'
            );

          INSERT INTO focus_profile_rules
            (
              profile_id,
              rule_id,
              created_at,
              updated_at
            )
          VALUES
            (
              'default-deep-work',
              '${ruleSocial}',
              '${now}',
              '${now}'
            ),
            (
              'default-deep-work',
              '${ruleEntertainment}',
              '${now}',
              '${now}'
            );
        `);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // v5 → v6
    // Categorization & Rules Engine
    //
    // Model:
    //
    // Context
    //   ├── Area
    //   ├── Intent
    //   └── Quality
    //
    // Context remains the existing user-defined Activity.
    // ─────────────────────────────────────────────────────────────────────

    if (version < 6) {
      if (!tableHasColumn('tracking_rules', 'area_id')) {
        this.db.exec(
          `ALTER TABLE tracking_rules ADD COLUMN area_id TEXT`,
        );
      }

      if (!tableHasColumn('tracking_rules', 'intent_id')) {
        this.db.exec(
          `ALTER TABLE tracking_rules ADD COLUMN intent_id TEXT`,
        );
      }

      if (!tableHasColumn('tracking_rules', 'quality_id')) {
        this.db.exec(
          `ALTER TABLE tracking_rules ADD COLUMN quality_id TEXT`,
        );
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS classification_dimensions (
          id         TEXT PRIMARY KEY,
          dimension  TEXT NOT NULL,
          name       TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS categorization_overrides (
          id              TEXT PRIMARY KEY,
          event_ids       TEXT NOT NULL,
          anchor_event_id INTEGER,
          context_id      TEXT,
          area_id         TEXT,
          intent_id       TEXT,
          quality_id      TEXT,
          source          TEXT NOT NULL DEFAULT 'user_override',
          rule_id         TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_cat_overrides_event_ids
          ON categorization_overrides (event_ids);

        CREATE INDEX IF NOT EXISTS idx_cat_overrides_anchor
          ON categorization_overrides (anchor_event_id);
      `);

      // Seed the final classification model.
      const dimCount = this.db
        .prepare(
          'SELECT COUNT(*) as count FROM classification_dimensions',
        )
        .get() as { count: number };

      if (dimCount.count === 0) {
        this.db.exec(`
          INSERT INTO classification_dimensions
            (id, dimension, name, sort_order)
          VALUES

            -- AREA
            ('area_work',     'area', 'Work',     0),
            ('area_personal', 'area', 'Personal', 1),
            ('area_leisure',  'area', 'Leisure',  2),

            -- INTENT
            ('intent_create',       'intent', 'Create',       0),
            ('intent_learn',        'intent', 'Learn',        1),
            ('intent_research',     'intent', 'Research',     2),
            ('intent_communicate',  'intent', 'Communicate',  3),
            ('intent_plan',         'intent', 'Plan',         4),
            ('intent_organize',     'intent', 'Organize',     5),
            ('intent_consume',      'intent', 'Consume',      6),
            ('intent_manage',       'intent', 'Manage',       7),

            -- QUALITY
            ('quality_deep_work',    'quality', 'Deep Work',    0),
            ('quality_focused',       'quality', 'Focused',      1),
            ('quality_routine',      'quality', 'Routine',      2),
            ('quality_distracting',  'quality', 'Distracting',  3),
            ('quality_break_idle',   'quality', 'Break / Idle', 4);
        `);
      }

      this.db.pragma('user_version = 6');
    }

    // ─────────────────────────────────────────────────────────────────────
    // v6 → v7
    // Ensure anchor_event_id exists.
    // ─────────────────────────────────────────────────────────────────────

    if (version < 7) {
      if (
        !tableHasColumn(
          'categorization_overrides',
          'anchor_event_id',
        )
      ) {
        this.db.exec(
          `ALTER TABLE categorization_overrides ADD COLUMN anchor_event_id INTEGER`,
        );
      }

      this.db.exec(`
        UPDATE categorization_overrides
        SET anchor_event_id =
          CAST(json_extract(event_ids, '$[0]') AS INTEGER)
        WHERE anchor_event_id IS NULL
          AND event_ids IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_cat_overrides_anchor
          ON categorization_overrides (anchor_event_id);
      `);

      this.db.pragma('user_version = 7');
    }

    // ─────────────────────────────────────────────────────────────────────
    // v7 → v8
    //
    // Rename the old categorization concept:
    //
    // quality_id → quality_id
    //
    // Existing databases are upgraded safely.
    // Fresh databases already have quality_id.
    // ─────────────────────────────────────────────────────────────────────

    if (version < 8) {
      if (
        tableHasColumn('tracking_rules', 'quality_id') &&
        !tableHasColumn('tracking_rules', 'quality_id')
      ) {
        this.db.exec(
          `ALTER TABLE tracking_rules ADD COLUMN quality_id TEXT`,
        );

        this.db.exec(`
          UPDATE tracking_rules
          SET quality_id = quality_id
          WHERE quality_id IS NULL;
        `);
      }

      if (
        tableHasColumn('categorization_overrides', 'quality_id') &&
        !tableHasColumn('categorization_overrides', 'quality_id')
      ) {
        this.db.exec(
          `ALTER TABLE categorization_overrides ADD COLUMN quality_id TEXT`,
        );

        this.db.exec(`
          UPDATE categorization_overrides
          SET quality_id = quality_id
          WHERE quality_id IS NULL;
        `);
      }

      // Fresh databases already have the correct columns.
      // Existing databases may retain the legacy quality_id column.
      // The application must no longer read/write quality_id.

      this.db.pragma('user_version = 8');
    }

    // ─────────────────────────────────────────────────────────────────────
    // v8 → v9
    //
    // Add event-level classification storage.
    //
    // Each raw event can have at most one classification record specifying:
    //   Context, Area, Intent, Quality, source, and optional rule.
    //
    // This is intentionally separate from categorization_overrides, which
    // remains the session/timeline-level correction mechanism.
    // ─────────────────────────────────────────────────────────────────────

    if (version < 9) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS event_classifications (
          event_id     INTEGER PRIMARY KEY,
          context_id   TEXT,
          area_id      TEXT,
          intent_id    TEXT,
          quality_id   TEXT,
          source       TEXT NOT NULL DEFAULT 'user_override',
          rule_id      TEXT,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,

          FOREIGN KEY (event_id)
            REFERENCES events(id)
            ON DELETE CASCADE,

          FOREIGN KEY (context_id)
            REFERENCES activities(id)
            ON DELETE SET NULL,

          FOREIGN KEY (area_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL,

          FOREIGN KEY (intent_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL,

          FOREIGN KEY (quality_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL,

          FOREIGN KEY (rule_id)
            REFERENCES tracking_rules(id)
            ON DELETE SET NULL
        );
      `);

      this.db.pragma('user_version = 9');
    }

    // ─────────────────────────────────────────────────────────────────────
    // v9 → v10
    //
    // Intelligence layer.
    //
    // 1. tracking_rules.source distinguishes rules the USER created from the
    //    seeded defaults, so only genuine user knowledge is presented to the
    //    model as an explicit personal rule.
    //
    // 2. intelligence_runs / intelligence_activities /
    //    intelligence_activity_events persist AI-derived activities. They
    //    reference raw events by id; the events table itself is untouched.
    // ─────────────────────────────────────────────────────────────────────

    if (version < 10) {
      if (!tableHasColumn('tracking_rules', 'source')) {
        this.db.exec(
          `ALTER TABLE tracking_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
        );
      }

      // The rules seeded by the v5 migration are system defaults.
      this.db.exec(`
        UPDATE tracking_rules
        SET source = 'system'
        WHERE id IN ('rule_coding', 'rule_learning', 'rule_meetings', 'rule_chatgpt');
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS intelligence_runs (
          id             TEXT PRIMARY KEY,
          window_start   DATETIME NOT NULL,
          window_end     DATETIME NOT NULL,
          status         TEXT NOT NULL,
          model          TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          attempt_count  INTEGER NOT NULL DEFAULT 0,
          error          TEXT,
          error_category TEXT,
          output_json    TEXT,
          created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Idempotency: at most one successful analysis per window.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_runs_succeeded_window
          ON intelligence_runs (window_start, window_end)
          WHERE status = 'succeeded';

        CREATE INDEX IF NOT EXISTS idx_intelligence_runs_status
          ON intelligence_runs (status);

        CREATE INDEX IF NOT EXISTS idx_intelligence_runs_window
          ON intelligence_runs (window_start, window_end);

        CREATE TABLE IF NOT EXISTS intelligence_activities (
          id            TEXT PRIMARY KEY,
          started_at    DATETIME NOT NULL,
          ended_at      DATETIME NOT NULL,
          title         TEXT NOT NULL,
          summary       TEXT,
          context_id    TEXT,
          area_id       TEXT,
          intent_id     TEXT,
          quality_id    TEXT,
          confidence    REAL NOT NULL,
          uncertainty   TEXT,
          source_run_id TEXT NOT NULL,
          user_locked   INTEGER NOT NULL DEFAULT 0,
          superseded_at DATETIME,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,

          FOREIGN KEY (source_run_id)
            REFERENCES intelligence_runs(id),

          FOREIGN KEY (context_id)
            REFERENCES activities(id)
            ON DELETE SET NULL,

          FOREIGN KEY (area_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL,

          FOREIGN KEY (intent_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL,

          FOREIGN KEY (quality_id)
            REFERENCES classification_dimensions(id)
            ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_intelligence_activities_started_at
          ON intelligence_activities (started_at);

        CREATE TABLE IF NOT EXISTS intelligence_activity_events (
          activity_id TEXT    NOT NULL,
          event_id    INTEGER NOT NULL,
          position    INTEGER NOT NULL,

          PRIMARY KEY (activity_id, event_id),

          FOREIGN KEY (activity_id)
            REFERENCES intelligence_activities(id)
            ON DELETE CASCADE,

          FOREIGN KEY (event_id)
            REFERENCES events(id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_intelligence_activity_events_event_id
          ON intelligence_activity_events (event_id);
      `);

      this.db.pragma('user_version = 10');
    }
  }
}