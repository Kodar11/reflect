import type { Database } from './Database.js';
import type { TimelineEdit, TimelineOperation } from '../timeline/TimelineModels.js';
import { encodePayload, decodePayload } from '../timeline/TimelineEdits.js';

/**
 * Repository seam for the `timeline_edits` table. Mirrors `EventRepository`
 * — `Database` is the only better-sqlite3 importer; this module is the only
 * SQL-knower for the edit log. The service + IPC layer depend on the
 * `IEditRepository` interface (typed below) so tests substitute a fake.
 *
 * Append-mostly model: INSERT for every user action; `setUndone(id, at | null)`
 * flips an edit's "undone" state. The row is never DELETEd (audit + replay
 * fidelity). The engine's `applyEdits` skips rows whose `undone_at` is set.
 */
export interface IEditRepository {
  /** Persist a typed payload; returns the assigned row id. */
  insert(operation: TimelineOperation, payload: unknown): number;
  /** All edits in insertion order. The engine picks active ones. */
  list(): TimelineEdit[];
  /** Mark edit as undone (at = ISO timestamp string), or restore (pass null). */
  setUndone(id: number, undoneAt: string | null): void;
  /** Convenience: last edit id (for undo targeting). */
  lastId(): number | null;
}

interface EditRow {
  id: number;
  operation: TimelineOperation;
  payload: string;
  created_at: string | null;
  undone_at: string | null;
}

export class EditRepository implements IEditRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly setUndoneStmt;
  private readonly lastIdStmt;
  /** Optional sink for decode-failure warnings. Keeps this module free of the
   * Logger type while letting the app surface stale-row skips. */
  private readonly onDecodeError?: (msg: string) => void;

  constructor(
    private readonly db: Database,
    onDecodeError?: (msg: string) => void,
  ) {
    this.onDecodeError = onDecodeError;
    this.insertStmt = db.prepare(
      `INSERT INTO timeline_edits (operation, payload) VALUES (?, ?)`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM timeline_edits ORDER BY id ASC`,
    );
    this.setUndoneStmt = db.prepare(
      `UPDATE timeline_edits SET undone_at = ? WHERE id = ?`,
    );
    this.lastIdStmt = db.prepare(`SELECT MAX(id) AS one FROM timeline_edits`);
  }

  insert(operation: TimelineOperation, payload: unknown): number {
    const info = this.insertStmt.run(operation, encodePayload(payload as any));
    return Number(info.lastInsertRowid);
  }

  list(): TimelineEdit[] {
    const rows = this.listStmt.all() as unknown[] as EditRow[];
    const out: TimelineEdit[] = [];
    for (const r of rows) {
      try {
        out.push({
          id: r.id,
          operation: r.operation,
          payload: decodePayload(r.operation, r.payload),
          createdAt: r.created_at,
          undoneAt: r.undone_at,
        });
      } catch (e) {
        // A malformed/stale row is logged + skipped — the engine never sees it.
        // The row stays in the table for audit; throwing here would take down
        // every timeline read, which violates the spec's "engine never throws
        // on stale edits" contract. Caught at the repository seam so the pure
        // decoder stays clean for tests.
        const msg = (e as Error)?.message ?? e;
        this.onDecodeError?.(`[EditRepository] skipping edit #${r.id}: ${msg}`);
      }
    }
    return out;
  }

  setUndone(id: number, undoneAt: string | null): void {
    this.setUndoneStmt.run(undoneAt, id);
  }

  lastId(): number | null {
    const row = this.lastIdStmt.get() as { one: number | null } | undefined;
    return row?.one ?? null;
  }
}