import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { CategorizationRepository } from '../../src/database/CategorizationRepository';

/**
 * Integration tests for the SQLite migration system. Uses real better-sqlite3.
 * Self-skips if the native binary ABI does not match Node (see EventRepository.test.ts).
 */
const nativeOk = (() => {
  const prevError = console.error;
  console.error = () => {};
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-migration-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    console.error = prevError;
  }
})();

const migrationSuite = nativeOk ? describe : describe.skip;

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-migration-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

function tableHasColumn(db: BetterSqliteDB.Database, table: string, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function createV5Database(dbPath: string): void {
  const raw = new BetterSqliteDB(dbPath);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watcher TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at DATETIME NOT NULL,
      app TEXT,
      browser TEXT,
      title TEXT,
      url TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS timeline_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      undone_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracking_rules (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      conditions TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS focus_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'countdown',
      default_duration_minutes INTEGER,
      blocks_distractions INTEGER NOT NULL DEFAULT 1,
      sound_cue TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS focus_rules (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'block',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS focus_profile_rules (
      profile_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS focus_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      task TEXT NOT NULL,
      notes TEXT,
      mode TEXT NOT NULL,
      planned_duration_minutes INTEGER,
      state TEXT NOT NULL DEFAULT 'planned',
      started_at DATETIME,
      ended_at DATETIME,
      paused_at DATETIME,
      total_pause_ms INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      blocking_lease_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS focus_interruptions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      reason TEXT,
      occurred_at DATETIME NOT NULL,
      idle_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blocked_attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      attempted_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  raw.pragma('user_version = 5');
  raw.close();
}

function createV6DatabaseWithoutAnchor(dbPath: string): void {
  // v0-v5 base schema
  createV5Database(dbPath);

  const raw2 = new BetterSqliteDB(dbPath);
  raw2.exec(`
    ALTER TABLE tracking_rules ADD COLUMN area_id TEXT;
    ALTER TABLE tracking_rules ADD COLUMN intent_id TEXT;
    ALTER TABLE tracking_rules ADD COLUMN quality_id TEXT;

    CREATE TABLE IF NOT EXISTS classification_dimensions (
      id TEXT PRIMARY KEY,
      dimension TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categorization_overrides (
      id TEXT PRIMARY KEY,
      event_ids TEXT NOT NULL,
      context_id TEXT,
      area_id TEXT,
      intent_id TEXT,
      quality_id TEXT,
      source TEXT NOT NULL DEFAULT 'user_override',
      rule_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cat_overrides_event_ids ON categorization_overrides (event_ids);
  `);
  raw2.pragma('user_version = 6');
  raw2.close();
}

function createV8Database(dbPath: string): void {
  // v0-v7 schema
  createV6DatabaseWithoutAnchor(dbPath);

  const raw3 = new BetterSqliteDB(dbPath);
  raw3.exec(`
    ALTER TABLE categorization_overrides ADD COLUMN anchor_event_id INTEGER;

    UPDATE categorization_overrides
    SET anchor_event_id = CAST(json_extract(event_ids, '$[0]') AS INTEGER)
    WHERE anchor_event_id IS NULL
      AND event_ids IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_cat_overrides_anchor ON categorization_overrides (anchor_event_id);
  `);
  raw3.pragma('user_version = 8');
  raw3.close();
}

migrationSuite('Database migration', () => {
  let dbPath: string;

  afterEach(() => {
    cleanup(dbPath);
  });

  it('fresh database has event_classifications and CategorizationRepository prepares OK', () => {
    dbPath = tmpDbPath();
    const db = new Database(dbPath);
    expect(db).toBeDefined();

    const raw = new BetterSqliteDB(dbPath);
    expect(tableHasColumn(raw, 'categorization_overrides', 'anchor_event_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'event_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'context_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'area_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'intent_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'quality_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'source')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'rule_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'created_at')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'updated_at')).toBe(true);
    expect(raw.pragma('user_version', { simple: true })).toBe(10);
    raw.close();

    const repo = new CategorizationRepository(db);
    expect(repo.listDimensions()).toBeDefined();
    expect(repo.listOverrides()).toBeDefined();
    expect(repo.getEventClassification(1)).toBeNull();

    db.close();
  });

  it('existing v5 database migrates to v10 with anchor_event_id and event_classifications', () => {
    dbPath = tmpDbPath();
    createV5Database(dbPath);

    const before = new BetterSqliteDB(dbPath);
    expect(before.pragma('user_version', { simple: true })).toBe(5);
    expect(tableHasColumn(before, 'categorization_overrides', 'anchor_event_id')).toBe(false);
    expect(tableHasColumn(before, 'event_classifications', 'event_id')).toBe(false);
    before.close();

    const db = new Database(dbPath);

    const after = new BetterSqliteDB(dbPath);
    expect(after.pragma('user_version', { simple: true })).toBe(10);
    expect(tableHasColumn(after, 'categorization_overrides', 'anchor_event_id')).toBe(true);
    expect(tableHasColumn(after, 'event_classifications', 'event_id')).toBe(true);
    after.close();

    const repo = new CategorizationRepository(db);
    expect(repo.listOverrides()).toEqual([]);
    db.close();
  });

  it('existing v6 database without anchor_event_id gets the column and preserves overrides', () => {
    dbPath = tmpDbPath();
    createV6DatabaseWithoutAnchor(dbPath);

    const before = new BetterSqliteDB(dbPath);
    before.exec(`
      INSERT INTO categorization_overrides (id, event_ids, context_id, area_id, source)
      VALUES ('ov_1', '[10,20,30]', 'ctx_1', 'area_1', 'user_override');
    `);
    before.close();

    const db = new Database(dbPath);

    const after = new BetterSqliteDB(dbPath);
    expect(tableHasColumn(after, 'categorization_overrides', 'anchor_event_id')).toBe(true);

    const row = after.prepare('SELECT * FROM categorization_overrides WHERE id = ?').get('ov_1') as {
      id: string;
      event_ids: string;
      anchor_event_id: number | null;
      context_id: string | null;
    };
    expect(row.id).toBe('ov_1');
    expect(row.event_ids).toBe('[10,20,30]');
    expect(row.context_id).toBe('ctx_1');
    expect(row.anchor_event_id).toBe(10);
    after.close();

    const repo = new CategorizationRepository(db);
    const overrides = repo.listOverrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0].anchorEventId).toBe(10);
    db.close();
  });

  it('migration is safe to run repeatedly', () => {
    dbPath = tmpDbPath();
    createV6DatabaseWithoutAnchor(dbPath);

    const db1 = new Database(dbPath);
    db1.close();

    const db2 = new Database(dbPath);
    db2.close();

    const raw = new BetterSqliteDB(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(10);
    expect(tableHasColumn(raw, 'categorization_overrides', 'anchor_event_id')).toBe(true);
    expect(tableHasColumn(raw, 'event_classifications', 'event_id')).toBe(true);
    raw.close();
  });

  it('existing v8 database migrates to v10 and creates event_classifications without touching overrides', () => {
    dbPath = tmpDbPath();
    createV8Database(dbPath);

    const before = new BetterSqliteDB(dbPath);
    before.exec(`
      INSERT INTO categorization_overrides (id, event_ids, anchor_event_id, context_id, area_id, source)
      VALUES ('ov_v8', '[100,200]', 100, 'ctx_v8', 'area_v8', 'user_override');
    `);
    expect(before.pragma('user_version', { simple: true })).toBe(8);
    expect(tableHasColumn(before, 'event_classifications', 'event_id')).toBe(false);
    before.close();

    const db = new Database(dbPath);

    const after = new BetterSqliteDB(dbPath);
    expect(after.pragma('user_version', { simple: true })).toBe(10);
    expect(tableHasColumn(after, 'event_classifications', 'event_id')).toBe(true);

    const overrideRow = after.prepare('SELECT * FROM categorization_overrides WHERE id = ?').get('ov_v8') as {
      id: string;
      event_ids: string;
      anchor_event_id: number | null;
      context_id: string | null;
    };
    expect(overrideRow.id).toBe('ov_v8');
    expect(overrideRow.event_ids).toBe('[100,200]');
    expect(overrideRow.anchor_event_id).toBe(100);
    expect(overrideRow.context_id).toBe('ctx_v8');
    after.close();

    const repo = new CategorizationRepository(db);
    const overrides = repo.listOverrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0].anchorEventId).toBe(100);
    db.close();
  });

  it('existing database migrates to v10: rules gain a source, intelligence tables appear, data is kept', () => {
    dbPath = tmpDbPath();
    createV8Database(dbPath);

    const before = new BetterSqliteDB(dbPath);
    before.exec(`
      INSERT INTO activities (id, name, color) VALUES ('coding', 'Coding', 'blue');
      INSERT INTO tracking_rules (id, activity_id, conditions, enabled, priority) VALUES
        ('rule_coding', 'coding', '[{"type":"app_equals","value":"VS Code"}]', 1, 0),
        ('rule_1700000000000', 'coding', '[{"type":"title_contains","value":"GameTheory"}]', 1, 10);
      INSERT INTO events (watcher, started_at, ended_at, app) VALUES
        ('window', '2026-03-02T09:00:00.000Z', '2026-03-02T09:30:00.000Z', 'VS Code');
    `);
    expect(tableHasColumn(before, 'tracking_rules', 'source')).toBe(false);
    before.close();

    new Database(dbPath).close();
    new Database(dbPath).close(); // idempotent

    const after = new BetterSqliteDB(dbPath);
    expect(after.pragma('user_version', { simple: true })).toBe(10);
    const rules = after.prepare('SELECT id, source FROM tracking_rules ORDER BY id').all();
    expect(rules).toEqual([
      { id: 'rule_1700000000000', source: 'user' },
      { id: 'rule_coding', source: 'system' },
    ]);
    expect(tableHasColumn(after, 'intelligence_runs', 'window_start')).toBe(true);
    expect(tableHasColumn(after, 'intelligence_activities', 'user_locked')).toBe(true);
    expect(tableHasColumn(after, 'intelligence_activity_events', 'event_id')).toBe(true);
    expect(after.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    expect(after.pragma('foreign_key_check')).toEqual([]);
    after.close();
  });

  it('leaves anchor_event_id NULL when override event_ids is empty or invalid', () => {
    dbPath = tmpDbPath();
    createV6DatabaseWithoutAnchor(dbPath);

    const before = new BetterSqliteDB(dbPath);
    before.exec(`
      INSERT INTO categorization_overrides (id, event_ids, context_id, source)
      VALUES ('ov_empty', '[]', 'ctx_1', 'user_override');
    `);
    before.close();

    const db = new Database(dbPath);

    const after = new BetterSqliteDB(dbPath);
    const row = after.prepare('SELECT anchor_event_id FROM categorization_overrides WHERE id = ?').get('ov_empty') as {
      anchor_event_id: number | null;
    };
    expect(row.anchor_event_id).toBeNull();
    after.close();

    db.close();
  });
});
