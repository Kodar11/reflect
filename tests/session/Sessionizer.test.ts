import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEngine } from '../../src/session/SessionEngine';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/Session';
import { sessionize } from '../../src/session/Sessionizer';
import type { Event } from '../../src/models/Event';
import type { Session, SessionConfig } from '../../src/session/Session';
import { evAt, resetIds, DEFAULTS } from './helpers';

function build(events: Event[], config: SessionConfig = DEFAULT_SESSION_CONFIG): Session[] {
  return new SessionEngine().buildSessions(events, config);
}

function ids(sessions: Session[]): number[][] {
  return sessions.map((s) => s.events.map((e) => e.id));
}

/** Events across sessions must partition the input. */
function partitionInvariant(sessions: Session[], events: Event[]) {
  const got = sessions.flatMap((s) => s.events).map((e) => e.id).sort((a, b) => a - b);
  const want = events.map((e) => e.id).sort((a, b) => a - b);
  expect(got).toEqual(want);
  expect(sessions.every((s) => s.events.length > 0)).toBe(true);
}

describe('Sessionizer — basic continuity', () => {
  beforeEach(resetIds);

  it('same app continuous activity → one session', () => {
    const events = [
      evAt('09:00', { durMin: 30, app: 'VS Code' }),
      evAt('09:30', { durMin: 30, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, events);
  });

  it('same domain continuous browser activity → one session', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'Chrome', url: 'github.com/a' }),
      evAt('09:20', { durMin: 20, app: 'Chrome', url: 'github.com/b' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].primaryUrl).toBe('github.com/a'); // earliest on tie not important
    partitionInvariant(s, events);
  });

  it('multiple apps belonging to the same work activity → one session', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 15, app: 'Chrome', url: 'github.com' }),
      evAt('09:35', { durMin: 25, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — short interruption', () => {
  beforeEach(resetIds);

  it('Work → 30-second leisure → Work → one main work session', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 0.5, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:20', { durMin: 20, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, events);
  });

  it('Work → short generic browser switch → Work → no unnecessary split', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 3, app: 'Chrome' }),
      evAt('09:23', { durMin: 20, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — sustained transition', () => {
  beforeEach(resetIds);

  it('Work → sustained YouTube → two sessions', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome', url: 'youtube.com' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(2);
    expect(s[0].primaryApp).toBe('VS Code');
    expect(s[1].primaryUrl).toBe('youtube.com');
    partitionInvariant(s, events);
  });

  it('Work → sustained Netflix → two sessions', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome', url: 'netflix.com' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(2);
    expect(s[0].primaryApp).toBe('VS Code');
    expect(s[1].primaryUrl).toBe('netflix.com');
    partitionInvariant(s, events);
  });

  it('Work → sustained gaming → two sessions', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Steam' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(2);
    expect(s[0].primaryApp).toBe('VS Code');
    expect(s[1].primaryApp).toBe('Steam');
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — ambiguous transitions', () => {
  beforeEach(resetIds);

  it('VS Code → Chrome → VS Code → one session', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome' }),
      evAt('09:30', { durMin: 20, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });

  it('VS Code → GitHub → ChatGPT → VS Code → one coherent research session', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 8, app: 'Chrome', url: 'github.com' }),
      evAt('09:28', { durMin: 7, app: 'Chrome', url: 'chatgpt.com' }),
      evAt('09:35', { durMin: 25, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, events);
  });

  it('same browser, different work domains → do not split immediately', () => {
    const events = [
      evAt('09:00', { durMin: 15, app: 'Chrome', url: 'github.com' }),
      evAt('09:15', { durMin: 15, app: 'Chrome', url: 'stackoverflow.com' }),
      evAt('09:30', { durMin: 15, app: 'Chrome', url: 'developer.mozilla.org' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });

  it('same application, different project-like titles → require stronger evidence', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code', title: 'Project A' }),
      evAt('09:20', { durMin: 20, app: 'VS Code', title: 'Project B' }),
      evAt('09:40', { durMin: 20, app: 'VS Code', title: 'Project C' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — evidence accumulation', () => {
  beforeEach(resetIds);

  it('one different event → no split', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 1, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:21', { durMin: 20, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });

  it('repeated different events → candidate grows', () => {
    const events = [
      evAt('09:00', { durMin: 10, app: 'VS Code' }),
      evAt('09:10', { durMin: 2, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:12', { durMin: 2, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:14', { durMin: 2, app: 'Chrome', url: 'youtube.com' }),
    ];
    const s = build(events);
    // Candidate crosses 5 min → split.
    expect(s).toHaveLength(2);
    partitionInvariant(s, events);
  });

  it('candidate exceeds configured strong threshold → split', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 6, app: 'Chrome', url: 'youtube.com' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(2);
    partitionInvariant(s, events);
  });

  it('candidate disappears before threshold → merge back', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 3, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:23', { durMin: 20, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — long activity', () => {
  beforeEach(resetIds);

  it('continuous 2-hour activity → does not automatically split', () => {
    const events = [evAt('09:00', { durMin: 120, app: 'VS Code' })];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].duration).toBe(120 * 60_000);
    partitionInvariant(s, events);
  });

  it('continuous 3-hour activity → remains coherent if no meaningful transition', () => {
    const events = [
      evAt('09:00', { durMin: 90, app: 'VS Code' }),
      evAt('10:30', { durMin: 90, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(1);
    expect(s[0].duration).toBe(180 * 60_000);
    partitionInvariant(s, events);
  });
});

describe('Sessionizer — determinism', () => {
  beforeEach(resetIds);

  it('same input produces identical sessions', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:30', { durMin: 20, app: 'VS Code' }),
    ];
    const a = build(events);
    const b = build(events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('session IDs are stable across re-runs', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome', url: 'youtube.com' }),
    ];
    const a = build(events).map((s) => s.id);
    const b = build(events).map((s) => s.id);
    expect(a).toEqual(b);
  });

  it('sessionize() is pure and deterministic', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome', url: 'youtube.com' }),
      evAt('09:30', { durMin: 20, app: 'VS Code' }),
    ];
    const a = sessionize(events, DEFAULTS, []);
    const b = sessionize(events, DEFAULTS, []);
    expect(idsFromGroups(a)).toEqual(idsFromGroups(b));
  });
});

describe('Sessionizer — existing behavior preservation', () => {
  beforeEach(resetIds);

  it('gap rule still splits on large idle gap', () => {
    const events = [
      evAt('09:00', { durMin: 30, app: 'VS Code' }),
      evAt('09:45', { durMin: 30, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(2);
    partitionInvariant(s, events);
  });

  it('afk events still create their own away session', () => {
    const events = [
      evAt('09:00', { durMin: 30, app: 'VS Code' }),
      evAt('09:30', { durMin: 10, watcher: 'afk' }),
      evAt('09:40', { durMin: 30, app: 'VS Code' }),
    ];
    const s = build(events);
    expect(s).toHaveLength(3);
    expect(s[1].events[0].watcher).toBe('afk');
    partitionInvariant(s, events);
  });

  it('manual split seam still fires after configured event id', () => {
    const a = evAt('09:00', { id: 100, durMin: 25, app: 'VS Code' });
    const b = evAt('09:25', { id: 101, durMin: 15, app: 'Chrome', url: 'github.com' });
    const c = evAt('09:40', { id: 102, durMin: 20, app: 'VS Code' });
    const config: SessionConfig = { ...DEFAULTS, manualSplits: [{ afterEventId: 100 }] };
    const s = build([a, b, c], config);
    expect(s).toHaveLength(2);
    expect(s[0].events.map((e) => e.id)).toEqual([100]);
    expect(s[1].events.map((e) => e.id)).toEqual([101, 102]);
  });
});

function idsFromGroups(groups: Event[][]): number[][] {
  return groups.map((g) => g.map((e) => e.id));
}
