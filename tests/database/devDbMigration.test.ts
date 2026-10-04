/**
 * Opt-in check: migrate a COPY of an existing database file and verify the
 * Focus data survived. Skipped unless REFLECT_DB_COPY points at the copy —
 * never point it at a live database.
 *
 *   copy productivity-coach.db (+ -wal / -shm) somewhere, then:
 *   REFLECT_DB_COPY=<copy> npm run test:db -- tests/database/devDbMigration.test.ts
 */
import { it, expect } from 'vitest';
import BetterSqliteDB from 'better-sqlite3';
import { Database } from '../../src/database/Database';
import { FocusRepository } from '../../src/database/FocusRepository';

const copy = process.env.REFLECT_DB_COPY;

it.skipIf(!copy)('migrates a copy of the development database to v15 and keeps its Focus data', () => {
  const before = new BetterSqliteDB(copy!);
  const fromVersion = before.pragma('user_version', { simple: true });
  const sessionsBefore = (before.prepare('SELECT COUNT(*) AS n FROM focus_sessions').get() as { n: number }).n;
  const eventsBefore = (before.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  before.close();

  const db = new Database(copy!);
  const repo = new FocusRepository(db);
  const profiles = repo.getProfiles();
  const sessions = repo.getAllSessions(100_000);
  const open = repo.getOpenSessions();
  db.close();
  new Database(copy!).close(); // idempotent

  const after = new BetterSqliteDB(copy!);
  const toVersion = after.pragma('user_version', { simple: true });
  const eventsAfter = (after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const fk = after.pragma('foreign_key_check');
  const missingReason = (after
    .prepare("SELECT COUNT(*) AS n FROM focus_sessions WHERE state IN ('completed','cancelled') AND end_reason IS NULL")
    .get() as { n: number }).n;
  after.close();

  console.log(
    JSON.stringify({ fromVersion, toVersion, sessionsBefore, sessionsAfter: sessions.length, open: open.length, profiles: profiles.length, eventsBefore, eventsAfter }),
  );
  expect(toVersion).toBe(15);
  expect(sessions.length).toBe(sessionsBefore);
  expect(eventsAfter).toBe(eventsBefore);
  expect(fk).toEqual([]);
  expect(missingReason).toBe(0);
  expect(profiles.length).toBeGreaterThan(0);
});
