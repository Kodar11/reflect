import { describe, it, expect } from 'vitest';
import { resolveSelection } from '../../src/ui/Timeline/timelineSelection';
import type { VerifiedSessionDto } from '../../src/timeline/timelineIpc';

function makeSession(id: string, eventIds: number[]): VerifiedSessionDto {
  return {
    id,
    startedAt: '2024-01-01T09:00:00Z',
    endedAt: '2024-01-01T09:30:00Z',
    duration: 1800000,
    activeDuration: 1800000,
    eventCount: eventIds.length,
    title: 'Session',
    isCustomTitle: false,
    primaryApp: 'App',
    primaryBrowser: null,
    primaryTitle: 'Title',
    primaryUrl: null,
    appsUsed: ['App'],
    browserTabs: [],
    source: 'generated',
    eventIds,
  };
}

describe('resolveSelection', () => {
  it('keeps the current selection when the session still exists', () => {
    const sessions = [makeSession('s-10-5', [10, 11, 12])];
    const result = resolveSelection(sessions, 's-10-5', null);
    expect(result.nextId).toBe('s-10-5');
    expect(result.nextAnchor).toBe(10);
  });

  it('migrates selection to a session with the same anchor event id', () => {
    const before = makeSession('s-10-5', [10, 11, 12]);
    const after = makeSession('s-10-6', [10, 11, 12, 13]);
    const result = resolveSelection([after], 's-10-5', before.eventIds[0]);
    expect(result.nextId).toBe('s-10-6');
    expect(result.nextAnchor).toBe(10);
  });

  it('clears selection when the session no longer exists and there is no anchor match', () => {
    const sessions = [makeSession('s-20-2', [20, 21])];
    const result = resolveSelection(sessions, 's-10-5', 10);
    expect(result.nextId).toBeNull();
    expect(result.nextAnchor).toBeNull();
  });

  it('clears selection when selectedId is null', () => {
    const sessions = [makeSession('s-10-5', [10, 11, 12])];
    const result = resolveSelection(sessions, null, null);
    expect(result.nextId).toBeNull();
    expect(result.nextAnchor).toBeNull();
  });

  it('migrates even when the migrated session is not the first in the list', () => {
    const sessions = [
      makeSession('s-20-2', [20, 21]),
      makeSession('s-10-6', [10, 11, 12, 13]),
      makeSession('s-30-1', [30]),
    ];
    const result = resolveSelection(sessions, 's-10-5', 10);
    expect(result.nextId).toBe('s-10-6');
  });

  it('prefers exact id match over anchor migration', () => {
    const sessions = [
      makeSession('s-10-5', [10, 11, 12]),
      makeSession('s-10-6', [10, 11, 12, 13]),
    ];
    const result = resolveSelection(sessions, 's-10-5', 10);
    expect(result.nextId).toBe('s-10-5');
  });
});
