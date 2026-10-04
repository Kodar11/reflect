import type { Database } from './Database.js';
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
  type IAppSettingsRepository,
} from '../background/AppSettings.js';

/** Finished tracking pauses — the periods in which nothing was recorded on purpose. */
export interface ITrackingPauseLog {
  recordPause(startedAt: string, endedAt: string): void;
  /** Paused time inside [from, to), in ms. */
  pausedMsBetween(from: string, to: string): number;
}

/** Which user-visible notifications were already sent. */
export interface INotificationLog {
  /** True exactly once per key: the caller that gets `true` may notify. */
  claim(key: string, kind: string, nowIso: string): boolean;
}

/**
 * Storage for the background runtime: the application settings row, the log of
 * tracking pauses and the notification ledger. All SQL for those tables lives
 * here.
 */
export class BackgroundRepository implements IAppSettingsRepository, ITrackingPauseLog, INotificationLog {
  private readonly getSettingsStmt;
  private readonly saveSettingsStmt;
  private readonly insertPauseStmt;
  private readonly pausedMsStmt;
  private readonly claimStmt;

  constructor(db: Database) {
    this.getSettingsStmt = db.prepare(`SELECT data FROM app_settings WHERE id = 1`);
    this.saveSettingsStmt = db.prepare(
      `INSERT INTO app_settings (id, data, updated_at) VALUES (1, @data, @now)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    this.insertPauseStmt = db.prepare(`INSERT INTO tracking_pauses (started_at, ended_at) VALUES (@started_at, @ended_at)`);
    this.pausedMsStmt = db.prepare(
      `SELECT COALESCE(SUM(
          (julianday(MIN(ended_at, @to)) - julianday(MAX(started_at, @from))) * 86400000.0
        ), 0) AS ms
       FROM tracking_pauses
       WHERE started_at < @to AND ended_at > @from`,
    );
    this.claimStmt = db.prepare(`INSERT OR IGNORE INTO notification_log (key, kind, created_at) VALUES (@key, @kind, @now)`);
  }

  getSettings(): AppSettings {
    const row = this.getSettingsStmt.get() as { data: string } | undefined;
    if (!row) return { ...DEFAULT_APP_SETTINGS };
    try {
      return normalizeAppSettings(JSON.parse(row.data));
    } catch {
      return { ...DEFAULT_APP_SETTINGS };
    }
  }

  saveSettings(settings: AppSettings, nowIso: string): void {
    this.saveSettingsStmt.run({ data: JSON.stringify(settings), now: nowIso });
  }

  recordPause(startedAt: string, endedAt: string): void {
    if (Date.parse(endedAt) <= Date.parse(startedAt)) return;
    this.insertPauseStmt.run({ started_at: startedAt, ended_at: endedAt });
  }

  pausedMsBetween(from: string, to: string): number {
    const row = this.pausedMsStmt.get({ from, to }) as { ms: number | null };
    return Math.max(0, Math.round(row.ms ?? 0));
  }

  claim(key: string, kind: string, nowIso: string): boolean {
    return this.claimStmt.run({ key, kind, now: nowIso }).changes > 0;
  }
}
