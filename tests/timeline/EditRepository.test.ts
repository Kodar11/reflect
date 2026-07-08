import { describe, it, expect } from 'vitest';
import { EditRepository } from '../../src/database/EditRepository';
import type { Database } from '../../src/database/Database';

/**
 * Part A — crash-proof: `EditRepository.list()` must never throw on a
 * malformed/stale payload row. It should skip the row (logged via callback)
 * and return only the well-formed ones. The bad row stays in the table for
 * audit; the engine never sees it.
 *
 * We use a tiny fake `Database.prepare` that returns scripted rows without a
 * real SQLite file. This keeps the test headless (no better-sqlite3 ABI).
 */
function fakeDb(rows: { id: number; operation: string; payload: string; created_at: null; undone_at: null }[]): Database {
  return {
    prepare: (_sql: string) => ({
      all: () => rows,
      run: () => ({ lastInsertRowid: 0 }),
      get: () => ({ one: rows.length ? rows[rows.length - 1].id : null }),
    }),
  } as unknown as Database;
}

describe('EditRepository.list (Part A) — skip malformed rows, never throw', () => {
  it('skips a row whose payload fails to decode and returns the rest', () => {
    const rows = [
      { id: 1, operation: 'rename', payload: '{"anchorEventId":5,"newTitle":"OK"}', created_at: null, undone_at: null },
      { id: 2, operation: 'split', payload: '{"afterEventIndex":0}', created_at: null, undone_at: null }, // missing afterEventId
      { id: 3, operation: 'rename', payload: '{"anchorEventId":7,"newTitle":"Also OK"}', created_at: null, undone_at: null },
    ];
    const logs: string[] = [];
    const repo = new EditRepository(fakeDb(rows), (m) => logs.push(m));

    const edits = repo.list();

    expect(edits).toHaveLength(2); // row 2 skipped
    expect(edits.map((e) => e.id)).toEqual([1, 3]);
    expect(logs.some((m) => m.includes('#2') && m.includes('split'))).toBe(true);
  });

  it('returns empty array if every row is malformed', () => {
    const rows = [
      { id: 1, operation: 'split', payload: 'garbage', created_at: null, undone_at: null },
      { id: 2, operation: 'delete', payload: '{"eventIds":"not-array"}', created_at: null, undone_at: null },
    ];
    const logs: string[] = [];
    const repo = new EditRepository(fakeDb(rows), (m) => logs.push(m));

    const edits = repo.list();
    expect(edits).toEqual([]);
    expect(logs).toHaveLength(2);
  });

  it('returns all rows when all payloads are well-formed', () => {
    const rows = [
      { id: 1, operation: 'rename', payload: '{"anchorEventId":1,"newTitle":"X"}', created_at: null, undone_at: null },
      { id: 2, operation: 'create_offline', payload: '{"startedAt":"a","endedAt":"b","title":"c"}', created_at: null, undone_at: null },
    ];
    const logs: string[] = [];
    const repo = new EditRepository(fakeDb(rows), (m) => logs.push(m));

    const edits = repo.list();
    expect(edits).toHaveLength(2);
    expect(logs).toHaveLength(0);
  });
});