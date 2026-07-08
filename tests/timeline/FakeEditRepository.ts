import type { IEditRepository } from '../../src/database/EditRepository';
import type { TimelineEdit, TimelineOperation } from '../../src/timeline/TimelineModels';

/**
 * In-memory fake of `IEditRepository` for TimelineService tests. Records every
 * inserted edit so tests can assert the durable payload the service persisted
 * (after hint resolution). No SQLite needed.
 */
export class FakeEditRepository implements IEditRepository {
  private rows: TimelineEdit[] = [];
  private nextId = 1;
  /** The raw payloads passed to `insert` (before any decode) — one per row. */
  readonly inserted: { operation: TimelineOperation; payload: unknown }[] = [];

  insert(operation: TimelineOperation, payload: unknown): number {
    const id = this.nextId++;
    this.inserted.push({ operation, payload });
    this.rows.push({
      id,
      operation,
      payload: payload as any,
      createdAt: null,
      undoneAt: null,
    });
    return id;
  }

  list(): TimelineEdit[] {
    return this.rows.map((r) => ({ ...r }));
  }

  setUndone(id: number, undoneAt: string | null): void {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.undoneAt = undoneAt;
  }

  lastId(): number | null {
    return this.rows.length ? this.rows[this.rows.length - 1].id : null;
  }
}