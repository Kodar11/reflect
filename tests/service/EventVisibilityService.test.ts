import { describe, it, expect } from 'vitest';
import type { IEventVisibilityStore } from '../../src/database/EventRepository';
import type { AnalysisWindow } from '../../src/database/IntelligenceRepository';
import type { StoredEvent } from '../../src/models/Event';
import type { RemovedEvents } from '../../src/reflection/ReflectionChanges';
import { EventVisibilityService, type EventVisibilityDeps } from '../../src/service/EventVisibilityService';

/**
 * The visibility service on its own, with every collaborator recorded: what
 * a removal tells each derived layer, in which order, and what happens when
 * something fails.
 */

const at = (hhmm: string) => `2026-10-05T${hhmm}:00.000Z`;
const NOW = '2026-10-06T08:00:00.000Z';

function stored(id: number, start: string, end: string, hiddenAt: string | null = null): StoredEvent {
  return { id, watcher: 'window', startedAt: at(start), endedAt: at(end), app: 'Chrome', browser: null, title: `PRIVATE TITLE ${id}`, url: `private.example/${id}`, payload: null, createdAt: null, hiddenAt };
}

class FakeStore implements IEventVisibilityStore {
  calls: string[] = [];
  constructor(public rows: StoredEvent[]) {}
  findIncludingHidden(ids: number[]): StoredEvent[] {
    return this.rows.filter((r) => ids.includes(r.id));
  }
  hide(ids: number[], nowIso: string): number[] {
    this.calls.push(`hide:${ids.join(',')}`);
    for (const r of this.rows) if (ids.includes(r.id)) r.hiddenAt = nowIso;
    return ids;
  }
  unhide(ids: number[]): number[] {
    this.calls.push(`unhide:${ids.join(',')}`);
    for (const r of this.rows) if (ids.includes(r.id)) r.hiddenAt = null;
    return ids;
  }
  deletePermanently(ids: number[]): number[] {
    this.calls.push(`delete:${ids.join(',')}`);
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    return ids;
  }
  listHidden(): StoredEvent[] {
    return this.rows.filter((r) => r.hiddenAt !== null);
  }
}

function harness(rows: StoredEvent[], overrides: Partial<EventVisibilityDeps> = {}) {
  const store = new FakeStore(rows);
  const order: string[] = [];
  const retireCalls: { eventIds: number[]; range: AnalysisWindow; purge: boolean }[] = [];
  const redactions: { removed: RemovedEvents; signatures: string[] }[] = [];
  const coachCalls: RemovedEvents[] = [];
  const coachPurges: boolean[] = [];
  const ranges: AnalysisWindow[] = [];
  const rebuilds: AnalysisWindow[][] = [];
  const logs: string[] = [];
  const timers: (() => void)[] = [];
  let cancelled = 0;
  let transactions = 0;
  let changes = 0;

  const service = new EventVisibilityService({
    transaction: (fn) => {
      transactions++;
      return fn();
    },
    events: store,
    intelligence: {
      retireForEvents: (eventIds, range, _now, options) => {
        order.push('intelligence');
        retireCalls.push({ eventIds, range, purge: options?.purge === true });
        return { activityIds: ['ai-1'], windows: [{ start: at('09:00'), end: at('10:00') }] };
      },
      supersedeRunsOverlapping: (range) => {
        order.push('supersede');
        return [{ start: range.start.slice(0, 14) + '00:00.000Z', end: at('10:00') }];
      },
    },
    reflections: {
      redactRemovedEvents: (removed, signatures) => {
        order.push('reflection');
        redactions.push({ removed, signatures });
        return [];
      },
    },
    coach: {
      onEventsRemoved: (removed, options) => {
        order.push('coach');
        coachCalls.push(removed);
        coachPurges.push(options?.purge === true);
        return 0;
      },
    },
    blocksHolding: () => {
      order.push('blocks');
      return [
        { id: 'ai-1', signature: 'sig-a' },
        { id: 's-9', signature: 'sig-a' },
        { id: 's-10', signature: '' },
      ];
    },
    onRangeChanged: (range) => {
      order.push('range');
      ranges.push(range);
    },
    rebuild: (windows) => {
      rebuilds.push(windows);
    },
    onChanged: () => {
      changes++;
    },
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => new Date(NOW),
    schedule: (run) => {
      timers.push(run);
      return timers.length;
    },
    cancel: () => {
      cancelled++;
    },
    ...overrides,
  });

  const fireLastTimer = async () => {
    timers[timers.length - 1]?.();
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    service, store, order, retireCalls, redactions, coachCalls, coachPurges, ranges, rebuilds, logs, timers, fireLastTimer,
    get cancelled() { return cancelled; },
    get transactions() { return transactions; },
    get changes() { return changes; },
  };
}

describe('EventVisibilityService', () => {
  it('hide: derived data is invalidated in the same transaction, before the event leaves view', () => {
    const h = harness([stored(1, '09:00', '09:20'), stored(2, '09:20', '09:30'), stored(3, '09:30', '09:58')]);

    expect(h.service.hide([2])).toEqual({ ok: true, eventIds: [2], updating: true });

    // The blocks are located while the event is still on the timeline.
    expect(h.order).toEqual(['blocks', 'intelligence', 'reflection', 'coach', 'range']);
    expect(h.transactions).toBe(1);
    expect(h.store.calls).toEqual(['hide:2']);
    expect(h.retireCalls).toEqual([{ eventIds: [2], range: { start: at('09:20'), end: at('09:30') }, purge: false }]);
    // What stood on the event: the retired AI activity and every block that held it.
    expect(h.redactions[0].removed).toEqual({ eventIds: [2], ranges: [{ start: at('09:20'), end: at('09:30') }], activityIds: ['ai-1', 's-9', 's-10'] });
    expect(h.redactions[0].signatures).toEqual(['sig-a']);
    expect(h.coachCalls[0]).toEqual(h.redactions[0].removed);
    expect(h.coachPurges).toEqual([false]);
    expect(h.ranges).toEqual([{ start: at('09:20'), end: at('09:30') }]);
    expect(h.changes).toBe(1);
    expect(h.store.rows.find((r) => r.id === 2)!.hiddenAt).toBe(NOW);
    expect(h.store.rows.filter((r) => r.hiddenAt === null).map((r) => r.id)).toEqual([1, 3]);
  });

  it('delete: the same invalidation, with the kept history purged, then the row removed', () => {
    const h = harness([stored(1, '09:00', '09:20'), stored(2, '09:20', '09:30')]);

    expect(h.service.deletePermanently([2])).toEqual({ ok: true, eventIds: [2], updating: true });

    expect(h.retireCalls[0].purge).toBe(true);
    expect(h.coachPurges).toEqual([true]);
    expect(h.store.calls).toEqual(['delete:2']);
    expect(h.store.rows.map((r) => r.id)).toEqual([1]);
  });

  it('an already hidden event can be deleted, but is not hidden twice', () => {
    const h = harness([stored(2, '09:20', '09:30', NOW)]);

    expect(h.service.hide([2])).toEqual({ ok: true, eventIds: [], updating: false });
    expect(h.store.calls).toEqual([]);

    expect(h.service.deletePermanently([2])).toMatchObject({ ok: true, eventIds: [2] });
    // It is on no timeline block any more, so there is nothing to locate.
    expect(h.order).not.toContain('blocks');
    expect(h.retireCalls[0]).toMatchObject({ eventIds: [2], purge: true });
  });

  it('unhide restores visibility and has the analyses of that stretch redone', async () => {
    const h = harness([stored(2, '09:20', '09:30', NOW)]);

    expect(h.service.unhide([2])).toEqual({ ok: true, eventIds: [2], updating: true });

    expect(h.store.calls).toEqual(['unhide:2']);
    expect(h.order).toEqual(['supersede', 'range']);
    expect(h.redactions).toEqual([]);
    await h.fireLastTimer();
    expect(h.rebuilds).toEqual([[{ start: at('09:00'), end: at('10:00') }]]);
    // A visible event has nothing to restore.
    expect(h.service.unhide([2])).toEqual({ ok: true, eventIds: [], updating: false });
  });

  it('several removals in a row are followed by ONE rebuild of the distinct windows', async () => {
    const h = harness([stored(1, '09:00', '09:20'), stored(2, '09:20', '09:30'), stored(3, '09:30', '09:58')]);

    h.service.hide([1]);
    h.service.hide([2]);
    h.service.hide([3]);

    expect(h.rebuilds).toEqual([]); // nothing runs while the user is still clicking
    expect(h.cancelled).toBe(2);
    await h.fireLastTimer();
    expect(h.rebuilds).toEqual([[{ start: at('09:00'), end: at('10:00') }]]);
  });

  it('ignores ids that are not events', () => {
    const h = harness([stored(1, '09:00', '09:20')]);
    expect(h.service.hide([Number.NaN, -3, 1.5, 404] as number[])).toEqual({ ok: true, eventIds: [], updating: false });
    expect(h.service.hide('1' as unknown as number[])).toEqual({ ok: true, eventIds: [], updating: false });
    expect(h.transactions).toBe(0);
  });

  it('a failure is a result, not an exception — and the event is left as it was', () => {
    const h = harness([stored(2, '09:20', '09:30')], {
      reflections: {
        redactRemovedEvents: () => {
          throw new Error('disk full');
        },
      },
    });

    const result = h.service.hide([2]);

    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Nothing was changed.' });
    expect(h.store.calls).toEqual([]);
    expect(h.changes).toBe(0);
    expect(h.timers).toHaveLength(0);
  });

  it('still removes the event when the timeline blocks cannot be located', () => {
    const h = harness([stored(2, '09:20', '09:30')], {
      blocksHolding: () => {
        throw new Error('timeline unavailable');
      },
    });

    expect(h.service.hide([2])).toMatchObject({ ok: true, eventIds: [2] });
    expect(h.redactions[0].removed.activityIds).toEqual(['ai-1']);
    expect(h.store.calls).toEqual(['hide:2']);
  });

  it('never logs what the event was', () => {
    const h = harness([stored(2, '09:20', '09:30')], {
      coach: {
        onEventsRemoved: () => {
          throw new Error('coach failed');
        },
      },
    });
    h.service.hide([2]);
    const ok = harness([stored(2, '09:20', '09:30')]);
    ok.service.hide([2]);
    ok.service.unhide([2]);
    ok.service.deletePermanently([2]);

    const everything = [...h.logs, ...ok.logs].join('\n');
    expect(everything).toContain('[PRIVACY]');
    expect(everything).not.toContain('PRIVATE TITLE');
    expect(everything).not.toContain('private.example');
    expect(everything).not.toContain('Chrome');
  });

  it('lists hidden events for the restore / delete controls', () => {
    const h = harness([stored(1, '09:00', '09:20'), stored(2, '09:20', '09:30', NOW)]);
    expect(h.service.listHidden().map((e) => e.id)).toEqual([2]);
  });
});
