/**
 * Minimal in-memory fake of `IEventRepository` for unit tests. Records every
 * call so tests can assert merge behavior without a real SQLite file.
 */
import type { IEventRepository } from '../../src/database/EventRepository';
import type { Event, WatcherName } from '../../src/models/Event';

export interface RecordedInsert {
  watcher: WatcherName;
  startedAt: string;
  endedAt: string;
  app?: string | null;
  browser?: string | null;
  title?: string | null;
  url?: string | null;
  payload?: string | null;
}

export class FakeEventRepository implements IEventRepository {
  inserts: RecordedInsert[] = [];
  updates: { id: number; endedAt: string }[] = [];
  private nextId = 1;
  private readonly store = new Map<number, Event>();

  insert(s: RecordedInsert): number {
    const id = this.nextId++;
    const ev: Event = {
      id,
      watcher: s.watcher,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      app: s.app ?? null,
      browser: s.browser ?? null,
      title: s.title ?? null,
      url: s.url ?? null,
      payload: s.payload ?? null,
      createdAt: null,
    };
    this.inserts.push(s);
    this.store.set(id, ev);
    return id;
  }

  updateEndedAt(id: number, endedAt: string): void {
    this.updates.push({ id, endedAt });
    const ev = this.store.get(id);
    if (ev) ev.endedAt = endedAt;
  }

  getToday(): Event[] {
    return [...this.store.values()];
  }
  getByRange(_from: string, _to: string): Event[] {
    return [...this.store.values()];
  }
  getAll(_limit?: number): Event[] {
    return [...this.store.values()];
  }
}