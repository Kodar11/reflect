import { describe, it, expect } from 'vitest';
import { computeLaneLayout } from '../../src/ui/Timeline/timelineUtils';

function s(id: string, start: string, end: string) {
  return { id, startedAt: start, endedAt: end };
}

describe('computeLaneLayout', () => {
  it('assigns a single session to one full-width lane', () => {
    const layout = computeLaneLayout([s('a', '2026-01-01T09:00:00', '2026-01-01T10:00:00')]);
    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 1 });
  });

  it('splits two overlapping sessions into two lanes', () => {
    const layout = computeLaneLayout([
      s('a', '2026-01-01T09:00:00', '2026-01-01T10:00:00'),
      s('b', '2026-01-01T09:30:00', '2026-01-01T10:30:00'),
    ]);
    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 2 });
    expect(layout.get('b')).toEqual({ lane: 1, laneCount: 2 });
  });

  it('returns to full width when overlap ends (back-to-back sessions)', () => {
    // a and b overlap; c starts exactly when the cluster ends, so it starts a
    // fresh full-width cluster rather than squeezing into a leftover lane.
    const layout = computeLaneLayout([
      s('a', '2026-01-01T09:00:00', '2026-01-01T10:00:00'),
      s('b', '2026-01-01T09:30:00', '2026-01-01T10:00:00'),
      s('c', '2026-01-01T10:00:00', '2026-01-01T11:00:00'),
    ]);
    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 2 });
    expect(layout.get('b')).toEqual({ lane: 1, laneCount: 2 });
    expect(layout.get('c')).toEqual({ lane: 0, laneCount: 1 });
  });

  it('starts a new cluster (full width) after a gap', () => {
    const layout = computeLaneLayout([
      s('a', '2026-01-01T09:00:00', '2026-01-01T10:00:00'),
      s('b', '2026-01-01T09:30:00', '2026-01-01T10:00:00'),
      s('c', '2026-01-01T11:00:00', '2026-01-01T12:00:00'),
    ]);
    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 2 });
    expect(layout.get('b')).toEqual({ lane: 1, laneCount: 2 });
    // c is in a new cluster with no overlap → full width.
    expect(layout.get('c')).toEqual({ lane: 0, laneCount: 1 });
  });

  it('handles three simultaneous sessions with three lanes', () => {
    const layout = computeLaneLayout([
      s('a', '2026-01-01T09:00:00', '2026-01-01T10:00:00'),
      s('b', '2026-01-01T09:00:00', '2026-01-01T09:30:00'),
      s('c', '2026-01-01T09:00:00', '2026-01-01T09:45:00'),
    ]);
    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 3 });
    expect(layout.get('b')).toEqual({ lane: 1, laneCount: 3 });
    expect(layout.get('c')).toEqual({ lane: 2, laneCount: 3 });
  });
});