import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineService, SessionNotFoundError } from '../../src/timeline/TimelineService';
import { SessionService } from '../../src/session/SessionService';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/Session';
import { FakeEditRepository } from './FakeEditRepository';
import type { Event } from '../../src/models/Event';
import type { Session } from '../../src/session/Session';
import { evAt, resetIds } from './helpers';

/**
 * Tests that the TimelineService resolves renderer *hints* (sessionIdHint +
 * afterEventIndex) into durable **event-id payloads** before persisting — so
 * the edit log survives future Stage-2 algorithm changes. Uses a fake
 * `IEditRepository` that records what was actually persisted.
 */

/** Fake SessionService: returns a scripted list of `Session[]` so the timeline
 * service can resolve hints against known event ids, without a real DB. */
class FakeSessionService extends SessionService {
  private readonly stub: Session[];
  constructor(stub: Session[]) {
    // Call super with a null repo (we override every read method).
    super({ getToday: () => [], getByRange: () => [], getAll: () => [] } as any);
    this.stub = stub;
  }
  getToday(): Session[] { return [...this.stub]; }
  getByRange(): Session[] { return [...this.stub]; }
  getAll(): Session[] { return [...this.stub]; }
}

function makeSession(events: Event[], title?: string, id?: string): Session {
  const sid = id ?? `s-${events[0]?.id ?? 0}-${events.length}`;
  return {
    id: sid,
    startedAt: new Date(events[0]?.startedAt ?? 0),
    endedAt: new Date(events[events.length - 1]?.endedAt ?? 0),
    duration: 0,
    activeDuration: 0,
    events,
    appsUsed: [],
    browserTabs: [],
    eventCount: events.length,
    primaryTitle: title,
  };
}

describe('TimelineService — hint resolution (Part B)', () => {
  beforeEach(resetIds);

  it('rename: resolves sessionIdHint + newTitle → { anchorEventId, newTitle }', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 30, app: 'VS Code' });
    const session = makeSession([a, b], 'old');
    const svc = new TimelineService(new FakeSessionService([session]), new FakeEditRepository());

    const editId = svc.apply('rename', { sessionIdHint: session.id, newTitle: 'Coding' });

    expect(editId).toBe(1);
  });

  it('rename: persisted payload has anchorEventId (durable), NOT sessionIdHint', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const session = makeSession([a]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([session]), repo);

    svc.apply('rename', { sessionIdHint: session.id, newTitle: 'Coding' });

    expect(repo.inserted).toHaveLength(1);
    const persisted = repo.inserted[0].payload as any;
    expect(persisted.anchorEventId).toBe(a.id); // durable event id
    expect(persisted.newTitle).toBe('Coding');
    expect(persisted.sessionIdHint).toBeUndefined(); // no hint leaked into storage
  });

  it('split: resolves sessionIdHint + afterEventIndex → { afterEventId }', () => {
    const a = evAt('09:00', { durMin: 20, app: 'VS Code' });
    const b = evAt('09:20', { durMin: 20, app: 'Chrome' });
    const c = evAt('09:40', { durMin: 20, app: 'VS Code' });
    const session = makeSession([a, b, c]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([session]), repo);

    svc.apply('split', { sessionIdHint: session.id, afterEventIndex: 1 });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.afterEventId).toBe(b.id); // index 1 → event b
    expect(persisted.sessionIdHint).toBeUndefined();
  });

  it('split: clamps out-of-range index to last event', () => {
    const a = evAt('09:00', { durMin: 20 });
    const b = evAt('09:20', { durMin: 20 });
    const session = makeSession([a, b]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([session]), repo);

    svc.apply('split', { sessionIdHint: session.id, afterEventIndex: 99 });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.afterEventId).toBe(b.id); // clamped to last
  });

  it('delete: resolves sessionIdHint → { eventIds: [...] } (all event ids)', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 30, app: 'Chrome' });
    const session = makeSession([a, b]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([session]), repo);

    svc.apply('delete', { sessionIdHint: session.id });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.eventIds).toEqual([a.id, b.id]);
    expect(persisted.sessionIdHint).toBeUndefined();
  });

  it('merge: resolves sessionIdHint → { boundaryFromEventId, boundaryToEventId } (next session)', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('10:00', { durMin: 30, app: 'VS Code' }); // gap → 2 sessions
    const s1 = makeSession([a], 'first');
    const s2 = makeSession([b], 'second');
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([s1, s2]), repo);

    svc.apply('merge', { sessionIdHint: s1.id });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.boundaryFromEventId).toBe(a.id); // last event of s1
    expect(persisted.boundaryToEventId).toBe(b.id);  // first event of s2
  });

  it('merge: throws SessionNotFoundError when no adjacent session exists', () => {
    const a = evAt('09:00', { durMin: 30 });
    const s1 = makeSession([a]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([s1]), repo);

    expect(() => svc.apply('merge', { sessionIdHint: s1.id })).toThrow(SessionNotFoundError);
    expect(repo.inserted).toHaveLength(0); // nothing persisted on failure
  });

  it('rename: throws SessionNotFoundError when target session gone (stale click)', () => {
    const a = evAt('09:00', { durMin: 30 });
    const s1 = makeSession([a]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([s1]), repo);

    expect(() => svc.apply('rename', { sessionIdHint: 's-999-1', newTitle: 'X' })).toThrow(SessionNotFoundError);
    expect(repo.inserted).toHaveLength(0); // nothing persisted
  });

  it('create_offline: passthrough (no hint resolution needed, fully durable)', () => {
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([]), repo);

    svc.apply('create_offline', {
      startedAt: '2026-01-01T08:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
      title: 'Lecture',
    });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.title).toBe('Lecture');
    expect(persisted.startedAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('already-durable payload (no sessionIdHint) passes through without resolution', () => {
    const a = evAt('09:00', { durMin: 30 });
    const s1 = makeSession([a]);
    const repo = new FakeEditRepository();
    const svc = new TimelineService(new FakeSessionService([s1]), repo);

    // Durable payload from a test or future direct caller — no hint.
    svc.apply('rename', { anchorEventId: a.id, newTitle: 'Direct' });

    const persisted = repo.inserted[0].payload as any;
    expect(persisted.anchorEventId).toBe(a.id);
    expect(persisted.newTitle).toBe('Direct');
  });
});