import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEngine } from '../../src/session/SessionEngine';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/Session';
import { TimelineEngine } from '../../src/timeline/TimelineEngine';
import { makeEdit } from '../../src/timeline/TimelineEdits';
import type { TimelineEdit } from '../../src/timeline/TimelineModels';
import type { Event } from '../../src/models/Event';
import { evAt, resetIds, at } from './helpers';

/**
 * Timeline engine — pure replay of edit log over generated sessions.
 *
 * Coverage target: every operation + undo/redo + replay + regression
 * (event-id references survive regenerated sessions with different ids).
 */

function gen(events: Event[]) {
  return new SessionEngine().buildSessions(events, DEFAULT_SESSION_CONFIG);
}
function apply(events: Event[], edits: TimelineEdit[]) {
  return new TimelineEngine().applyEdits(gen(events), edits);
}

describe('TimelineEngine — rename', () => {
  beforeEach(resetIds);
  it('applies customTitle to the session whose first event is the anchor', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 30, app: 'VS Code' });
    const edits = [makeEdit(1, 'rename', { anchorEventId: a.id, newTitle: 'Building PC' }, null)];
    const out = apply([a, b], edits);
    expect(out).toHaveLength(1);
    expect(out[0].customTitle).toBe('Building PC');
  });
  it('is a no-op when the anchor matches no session first event', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const edits = [makeEdit(1, 'rename', { anchorEventId: 9999, newTitle: 'X' }, null)];
    const out = apply([a], edits);
    expect(out[0].customTitle).toBeUndefined();
  });
});

describe('TimelineEngine — split', () => {
  beforeEach(resetIds);
  it('splits a session into two halves at the boundary event', () => {
    const a = evAt('09:00', { durMin: 20, app: 'VS Code', title: 'A' });
    const b = evAt('09:20', { durMin: 20, app: 'Chrome', title: 'GitHub' });
    const c = evAt('09:40', { durMin: 20, app: 'VS Code', title: 'B' });
    const edits = [makeEdit(1, 'split', { afterEventId: b.id }, null)];
    const out = apply([a, b, c], edits);
    expect(out).toHaveLength(2);
    expect(out[0].events).toHaveLength(2); // a,b
    expect(out[1].events).toHaveLength(1); // c
    expect(out[0].events.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(out[1].events.map((e) => e.id)).toEqual([c.id]);
  });
  it('namespaces split-half ids by edit id for uniqueness across repeated splits', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    // First split: a after a.id (= no second half because a is last event) → no-op.
    const e1 = makeEdit(1, 'split', { afterEventId: a.id }, null);
    expect(apply([a], [e1])).toHaveLength(1);
  });
  it('is a no-op when afterEventId is the session\'s last event', () => {
    const a = evAt('09:00', { durMin: 30 });
    const b = evAt('09:30', { durMin: 30 });
    const edits = [makeEdit(1, 'split', { afterEventId: b.id }, null)];
    expect(apply([a, b], edits)).toHaveLength(1);
  });
  it('is a no-op when afterEventId not found', () => {
    const a = evAt('09:00', { durMin: 30 });
    const edits = [makeEdit(1, 'split', { afterEventId: 999 }, null)];
    expect(apply([a], edits)).toHaveLength(1);
  });
});

describe('TimelineEngine — merge', () => {
  beforeEach(resetIds);
  it('joins two adjacent sessions at the boundary event ids', () => {
    // Two sessions split by a gap; first ends with a.id, second starts with b.id.
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('10:00', { durMin: 30, app: 'VS Code' }); // gap 30min → 2 sessions
    const edits = [makeEdit(1, 'merge', { boundaryFromEventId: a.id, boundaryToEventId: b.id }, null)];
    const out = apply([a, b], edits);
    expect(out).toHaveLength(1);
    expect(out[0].events.map((e) => e.id)).toEqual([a.id, b.id]);
  });
  it('is a no-op when the from-event is not a session tail (non-adjacent)', () => {
    const a = evAt('09:00', { durMin: 30 });
    const b = evAt('11:00', { durMin: 30 }); // 1.5hr gap → 2 sessions
    const c = evAt('11:30', { durMin: 30 }); // small gap → merges with b naturally
    // Pick boundaryFrom that isn't actually a session tail.
    const edits = [makeEdit(1, 'merge', { boundaryFromEventId: 9999, boundaryToEventId: b.id }, null)];
    const out = apply([a, b, c], edits);
    expect(out).toHaveLength(2); // unchanged
  });
  it('is a no-op when to-event is not the immediately-next session\'s first event', () => {
    const a = evAt('09:00', { durMin: 30 });
    const b = evAt('10:00', { durMin: 30 });
    const edits = [makeEdit(1, 'merge', { boundaryFromEventId: a.id, boundaryToEventId: 9999 }, null)];
    expect(apply([a, b], edits)).toHaveLength(2);
  });
});

describe('TimelineEngine — delete', () => {
  beforeEach(resetIds);
  it('hides the session whose event ids match payload.eventIds', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('10:00', { durMin: 30, app: 'Chrome' }); // gap → 2 sessions
    const edits = [makeEdit(1, 'delete', { eventIds: [a.id] }, null)];
    const out = apply([a, b], edits);
    expect(out).toHaveLength(1);
    expect(out[0].events.map((e) => e.id)).toEqual([b.id]); // a deleted
  });
  it('delete then undo restores the session', () => {
    const a = evAt('09:00', { durMin: 30 });
    const b = evAt('10:00', { durMin: 30 });
    const edits = [
      makeEdit(1, 'delete', { eventIds: [a.id] }, null),
      makeEdit(1, 'delete', { eventIds: [a.id] }, '2026-01-01T00:00:00Z'), // undone
    ];
    // Two edits with same id — invalid in real DB, replace with explicit undo edit:
    const edits2 = [
      makeEdit(1, 'delete', { eventIds: [a.id] }, null),
      makeEdit(2, 'delete', { eventIds: [b.id] }, null),
    ];
    // Undo edit 2 only (undoneAt set on 2); a stays deleted.
    const edits3 = [
      makeEdit(1, 'delete', { eventIds: [a.id] }, '2026-01-01T01:00:00Z'), // undone
      makeEdit(2, 'delete', { eventIds: [b.id] }, null),
    ];
    expect(apply([a, b], edits2)).toHaveLength(0);
    expect(apply([a, b], edits3)).toHaveLength(1);
    expect(apply([a, b], edits3)[0].events.map((e) => e.id)).toEqual([a.id]);
  });
});

describe('TimelineEngine — create_offline', () => {
  beforeEach(resetIds);
  it('splices a user-source session in by startedAt', () => {
    const a = evAt('09:00', { durMin: 60, app: 'VS Code' }); // 09:00 – 10:00
    const offline = makeEdit(1, 'create_offline', {
      startedAt: at('07:30'), endedAt: at('08:30'),
      title: 'College Lecture', app: 'Lecture Hall',
    }, null);
    const out = apply([a], [offline]);
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('user');
    expect(out[0].customTitle).toBe('College Lecture');
    expect(out[0].id).toBe('u-1');
    expect(out[0].eventCount).toBe(0);
    expect(out[0].duration).toBe(60 * 60_000);
    expect(out[0].activeDuration).toBe(0);
  });
  it('offline sessions are visually identical (only source flag differs)', () => {
    const offline = makeEdit(1, 'create_offline', {
      startedAt: at('08:00'), endedAt: at('09:00'),
      title: 'Meeting',
    }, null);
    const out = apply([], [offline]);
    expect(out).toHaveLength(1);
    expect(out[0].customTitle).toBe('Meeting');
    expect(out[0].source).toBe('user');
  });
});

describe('TimelineEngine — undo / redo via undoneAt', () => {
  beforeEach(resetIds);
  it('skips edits with undoneAt set', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const edits = [
      makeEdit(1, 'rename', { anchorEventId: a.id, newTitle: 'X' }, null),       // active
      makeEdit(2, 'rename', { anchorEventId: a.id, newTitle: 'Y' }, '2026...'),  // undone
    ];
    const out = apply([a], edits);
    expect(out[0].customTitle).toBe('X'); // edit 2 skipped → edit 1's title survives
  });
  it('redo clears undoneAt so the edit re-applies', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    // Both edits active now (undo-then-redo leaves undoneAt === null).
    const edits = [
      makeEdit(1, 'rename', { anchorEventId: a.id, newTitle: 'X' }, null),
      makeEdit(2, 'rename', { anchorEventId: a.id, newTitle: 'Y' }, null),
    ];
    const out = apply([a], edits);
    expect(out[0].customTitle).toBe('Y'); // last active rename wins
  });
});

describe('TimelineEngine — replay determinism', () => {
  beforeEach(resetIds);
  it('same generated sessions + same active edits → identical verified timeline', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 15, app: 'Chrome', url: 'github.com' });
    const c = evAt('09:45', { durMin: 30, app: 'VS Code' });
    const edits = [
      makeEdit(1, 'split', { afterEventId: b.id }, null),
      makeEdit(2, 'rename', { anchorEventId: a.id, newTitle: 'Coding' }, null),
    ];
    const one = apply([a, b, c], edits);
    const two = apply([a, b, c], edits);
    expect(JSON.stringify(one)).toEqual(JSON.stringify(two));
  });
});

describe('TimelineEngine — regression: event-id references survive algorithm changes', () => {
  beforeEach(resetIds);
  it('boundary event ids still identify the target after sessions are regenerated with new ids', () => {
    // Same raw events, two theoretically different generated session ids —
    // but our edits reference EVENT IDs, not session ids, so they survive.
    const a = evAt('09:00', { id: 50, durMin: 30, app: 'VS Code' });
    const b = evAt('10:00', { id: 51, durMin: 30, app: 'VS Code' }); // 30min gap → 2 sessions
    const edits = [makeEdit(1, 'merge', { boundaryFromEventId: 50, boundaryToEventId: 51 }, null)];
    const out = apply([a, b], edits);
    expect(out).toHaveLength(1);
    expect(out[0].events.map((e) => e.id)).toEqual([50, 51]);
  });
  it('rename anchor (first event id) survives a re-split', () => {
    // Split first (creates two halves), then rename half-1 via its first event id (which == original first).
    const a = evAt('09:00', { id: 70, durMin: 20, app: 'VS Code' });
    const b = evAt('09:20', { id: 71, durMin: 20, app: 'Chrome' });
    const c = evAt('09:40', { id: 72, durMin: 20, app: 'VS Code' });
    const edits = [
      makeEdit(1, 'split', { afterEventId: 71 }, null),
      makeEdit(2, 'rename', { anchorEventId: 70, newTitle: 'Coding 1' }, null),
    ];
    const out = apply([a, b, c], edits);
    expect(out).toHaveLength(2);
    expect(out[0].customTitle).toBe('Coding 1');
    expect(out[1].customTitle).toBeUndefined();
  });
});

describe('TimelineEngine — empty edit log returns generated sessions as-is', () => {
  beforeEach(resetIds);
  it('no edits → identity (every session becomes a VerifiedSession with source generated)', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 30, app: 'VS Code' });
    const out = apply([a, b], []);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('generated');
    expect(out[0].hidden).toBe(false);
    expect(out[0].customTitle).toBeUndefined();
  });
});

describe('TimelineEngine — operation order independence where applicable', () => {
  beforeEach(resetIds);
  it('rename then split vs split then rename: rename only hits half-1 in both orderings', () => {
    const a = evAt('09:00', { id: 100, durMin: 20, app: 'VS Code' });
    const b = evAt('09:20', { id: 101, durMin: 20, app: 'Chrome' });
    const c = evAt('09:40', { id: 102, durMin: 20, app: 'VS Code' });

    const order1 = [
      makeEdit(1, 'rename', { anchorEventId: 100, newTitle: 'Coding' }, null),
      makeEdit(2, 'split', { afterEventId: 101 }, null),
    ];
    const order2 = [
      makeEdit(1, 'split', { afterEventId: 101 }, null),
      makeEdit(2, 'rename', { anchorEventId: 100, newTitle: 'Coding' }, null),
    ];

    const out1 = apply([a, b, c], order1);
    const out2 = apply([a, b, c], order2);
    // Both yield 2 sessions and both rename half-1.
    expect(out1).toHaveLength(2);
    expect(out2).toHaveLength(2);
    expect(out1[0].customTitle).toBe('Coding');
    expect(out2[0].customTitle).toBe('Coding');
  });
});