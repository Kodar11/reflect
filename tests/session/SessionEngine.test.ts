import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEngine } from '../../src/session/SessionEngine';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/Session';
import { gapRule, afkRule, manualSplitRule, shouldStartNewSession } from '../../src/session/SessionRules';
import { computeStatistics } from '../../src/session/SessionStatistics';
import type { Event } from '../../src/models/Event';
import type { Session, SessionConfig } from '../../src/session/Session';
import { ev, evAt, at, DEFAULTS, resetIds } from './helpers';

/**
 * The 20-scenario design doc, as tests. Each "Should" mirrors a row of the
 * doc. The biggest invariant — "every raw event appears in exactly one
 * session" — is asserted globally by `partitionInvariant`.
 */

function build(events: Event[], config: SessionConfig = DEFAULT_SESSION_CONFIG): Session[] {
  return new SessionEngine().buildSessions(events, config);
}

/** Assert: events across all sessions partition the input (same multiset). */
function partitionInvariant(sessions: Session[], events: Event[]) {
  const got = sessions.flatMap((s) => s.events).map((e) => e.id).sort((a, b) => a - b);
  const want = events.map((e) => e.id).sort((a, b) => a - b);
  expect(got).toEqual(want);
  // no empty sessions
  expect(sessions.every((s) => s.events.length > 0)).toBe(true);
  // deterministic id shape
  for (const s of sessions) {
    expect(s.id).toMatch(/^s-\d+-\d+$/);
  }
}

describe('SessionEngine — design doc scenarios 1–20', () => {
  beforeEach(resetIds);

  it('1. empty day → 0 sessions', () => {
    expect(build([])).toEqual([]);
  });

  it('2. single event → one session', () => {
    const e = evAt('09:00', { durMin: 30, app: 'VS Code', title: 'App.tsx' });
    const s = build([e]);
    expect(s).toHaveLength(1);
    expect(s[0].eventCount).toBe(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, [e]);
  });

  it('3. title change same app no gap → one session', () => {
    const a = evAt('09:00', { durMin: 20, app: 'VS Code', title: 'A.tsx' });
    const b = evAt('09:20', { durMin: 20, app: 'VS Code', title: 'B.tsx' });
    const s = build([a, b]);
    expect(s).toHaveLength(1);
    expect(s[0].eventCount).toBe(2);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, [a, b]);
  });

  it('4. app switch no gap (VS Code→Chrome/GitHub→VS Code) → one session', () => {
    const a = evAt('09:00', { durMin: 25, app: 'VS Code' });
    const b = evAt('09:25', { durMin: 15, app: 'Chrome', title: 'GitHub' });
    const c = evAt('09:40', { durMin: 20, app: 'VS Code' });
    const s = build([a, b, c]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, [a, b, c]);
  });

  it('5. research tour interleaved with coding → one session (Rule 6)', () => {
    const a = evAt('09:00', { durMin: 20, app: 'VS Code' });
    const b = evAt('09:20', { durMin: 8, app: 'Chrome', url: 'github.com' });
    const c = evAt('09:28', { durMin: 7, app: 'Chrome', url: 'stackoverflow.com' });
    const d = evAt('09:35', { durMin: 10, app: 'Chrome', url: 'react.dev' });
    const e = evAt('09:45', { durMin: 15, app: 'VS Code' });
    const s = build([a, b, c, d, e]);
    expect(s).toHaveLength(1);
    expect(s[0].browserTabs.sort()).toEqual(
      ['github.com', 'stackoverflow.com', 'react.dev'].sort(),
    );
    partitionInvariant(s, [a, b, c, d, e]);
  });

  it('6. large gap (20m ≥ 15m) splits into two sessions', () => {
    const a = evAt('09:00', { durMin: 60, app: 'VS Code' }); // ends 10:00
    const b = evAt('10:20', { durMin: 20, app: 'VS Code' });
    const s = build([a, b]);
    expect(s).toHaveLength(2);
    expect(s[0].events).toHaveLength(1);
    expect(s[1].events).toHaveLength(1);
    partitionInvariant(s, [a, b]);
  });

  it('7. small gap (5m < 15m) merges; duration includes bridged gap', () => {
    const a = evAt('09:00', { durMin: 60, app: 'VS Code' }); // ends 10:00
    const b = evAt('10:05', { durMin: 25, app: 'VS Code' }); // starts 10:05
    const s = build([a, b]);
    expect(s).toHaveLength(1);
    expect(s[0].duration).toBe(90 * 60_000); // 09:00 → 10:30 envelope
    expect(s[0].activeDuration).toBe(85 * 60_000); // 60+25, excludes 5m gap
    partitionInvariant(s, [a, b]);
  });

  it('8. short interruption (Discord 2m) → one session, primary = VS Code', () => {
    const a = evAt('09:00', { durMin: 25, app: 'VS Code' });
    const b = evAt('09:25', { durMin: 2, app: 'Discord' });
    const c = evAt('09:27', { durMin: 23, app: 'VS Code' });
    const s = build([a, b, c]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, [a, b, c]);
  });

  it('9. day starts with short Discord then VS Code → one session', () => {
    const a = evAt('09:00', { durMin: 2, app: 'Discord' });
    const b = evAt('09:02', { durMin: 58, app: 'VS Code' });
    const s = build([a, b]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    partitionInvariant(s, [a, b]);
  });

  it('10. Discord 30m then VS Code (no gap) → structurally ONE (classification deferred)', () => {
    const a = evAt('09:00', { durMin: 30, app: 'Discord' });
    const b = evAt('09:30', { durMin: 30, app: 'VS Code' });
    const s = build([a, b]);
    expect(s).toHaveLength(1); // documented: Stage 2 cannot tell Netflix from GitHub
    partitionInvariant(s, [a, b]);
  });

  it('11. VS Code → YouTube tutorial → VS Code → one session structurally', () => {
    const a = evAt('09:00', { durMin: 20, app: 'VS Code' });
    const b = evAt('09:20', { durMin: 18, app: 'Chrome', title: 'YouTube' });
    const c = evAt('09:38', { durMin: 22, app: 'VS Code' });
    const s = build([a, b, c]);
    expect(s).toHaveLength(1);
    partitionInvariant(s, [a, b, c]);
  });

  it('12. VS Code → Gmail → VS Code → one session structurally', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 3, app: 'Chrome', title: 'Gmail' });
    const c = evAt('09:33', { durMin: 27, app: 'VS Code' });
    const s = build([a, b, c]);
    expect(s).toHaveLength(1);
    partitionInvariant(s, [a, b, c]);
  });

  it('13. AFK event ≥ afkThreshold → own session + closes previous', () => {
    const a = evAt('09:00', { durMin: 60, app: 'VS Code' }); // ends 10:00
    const afk = evAt('10:00', { durMin: 10, watcher: 'afk' }); // 10m ≥ 5m
    const b = evAt('10:10', { durMin: 30, app: 'VS Code' });
    const s = build([a, afk, b]);
    expect(s).toHaveLength(3);
    expect(s[1].primaryApp).toBeUndefined(); // away session, no app
    expect(s[1].events[0].watcher).toBe('afk');
    partitionInvariant(s, [a, afk, b]);
  });

  it('14. many tiny gaps same intent → one session; active excludes gaps', () => {
    const a = evAt('09:00', { durMin: 10, app: 'VS Code' });
    const b = evAt('09:11', { durMin: 10, app: 'VS Code' });
    const c = evAt('09:22', { durMin: 10, app: 'VS Code' });
    const d = evAt('09:33', { durMin: 10, app: 'VS Code' });
    const s = build([a, b, c, d]);
    expect(s).toHaveLength(1);
    expect(s[0].activeDuration).toBe(40 * 60_000);
    expect(s[0].duration).toBe(43 * 60_000); // 09:00 → 09:43
    partitionInvariant(s, [a, b, c, d]);
  });

  it('15. VS Code → Netflix contiguous → one session (classification deferred)', () => {
    const a = evAt('09:00', { durMin: 60, app: 'VS Code' });
    const b = evAt('10:00', { durMin: 60, app: 'Chrome', title: 'Netflix' });
    const s = build([a, b]);
    expect(s).toHaveLength(1); // documented structural limitation; spec #15 split deferred
    partitionInvariant(s, [a, b]);
  });

  it('16. manual split seam fires after the configured event id', () => {
    const a = evAt('09:00', { id: 100, durMin: 25, app: 'VS Code' });
    const b = evAt('09:25', { id: 101, durMin: 15, app: 'Chrome', title: 'GitHub' });
    const c = evAt('09:40', { id: 102, durMin: 20, app: 'VS Code' });
    const config: SessionConfig = { ...DEFAULTS, manualSplits: [{ afterEventId: 100 }] };
    const s = build([a, b, c], config);
    expect(s).toHaveLength(2);
    expect(s[0].events.map((e) => e.id)).toEqual([100]);
    expect(s[1].events.map((e) => e.id)).toEqual([101, 102]);
    partitionInvariant(s, [a, b, c]);
  });

  it('17. multi-tab browser session; primaryUrl tie-break by duration', () => {
    const a = evAt('10:00', { durMin: 15, app: 'Chrome', url: 'A' });
    const b = evAt('10:15', { durMin: 15, app: 'Chrome', url: 'B' });
    const c = evAt('10:30', { durMin: 5, app: 'Chrome', url: 'A' }); // A total 20m, B 15m
    const s = build([a, b, c]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryUrl).toBe('A');
    expect(s[0].browserTabs.sort()).toEqual(['A', 'B']);
    partitionInvariant(s, [a, b, c]);
  });

  it('18. multiple watchers overlapping → sorted by startedAt then watcher', () => {
    const w = evAt('09:00', { durMin: 60, app: 'VS Code', watcher: 'window' });
    const b = evAt('09:10', { durMin: 5, url: 'X', watcher: 'browser' });
    const s = build([w, b]);
    expect(s).toHaveLength(1);
    expect(s[0].events.map((e) => e.watcher)).toEqual(['window', 'browser']);
    partitionInvariant(s, [w, b]);
  });

  it('19. whole day is one AFK event → one away session, primaryApp null', () => {
    const afk = evAt('09:00', { durMin: 480, watcher: 'afk' });
    const s = build([afk]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBeUndefined();
    partitionInvariant(s, [afk]);
  });

  it('20. 2-hour coding block with distractions → one session, primary VS Code', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code' });
    const b = evAt('09:30', { durMin: 5, app: 'Chrome', url: 'GitHub' });
    const c = evAt('09:35', { durMin: 25, app: 'VS Code' });
    const d = evAt('10:00', { durMin: 1, app: 'Slack' });
    const e = evAt('10:01', { durMin: 49, app: 'VS Code' });
    const f = evAt('10:50', { durMin: 8, app: 'Chrome', url: 'MDN' });
    const g = evAt('10:58', { durMin: 2, app: 'VS Code' });
    const s = build([a, b, c, d, e, f, g]);
    expect(s).toHaveLength(1);
    expect(s[0].primaryApp).toBe('VS Code');
    expect(s[0].browserTabs.sort()).toEqual(['GitHub', 'MDN']);
    expect(s[0].eventCount).toBe(7);
    partitionInvariant(s, [a, b, c, d, e, f, g]);
  });
});

describe('SessionEngine — determinism + invariants', () => {
  beforeEach(resetIds);

  it('same input twice → identical sessions (deep equal)', () => {
    const events = [
      evAt('09:00', { durMin: 20, app: 'VS Code' }),
      evAt('09:20', { durMin: 10, app: 'Chrome' }),
      evAt('09:30', { durMin: 20, app: 'VS Code' }),
    ];
    const a = build(events);
    const b = build(events);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('unsorted input is sorted internally', () => {
    const a = evAt('09:00', { durMin: 10, app: 'VS Code' });
    const b = evAt('09:10', { durMin: 10, app: 'Chrome' });
    const s = build([b, a]);
    expect(s).toHaveLength(1);
    expect(s[0].events.map((e) => e.id)).toEqual([a.id, b.id]);
  });
});

describe('SessionRules — independent rule tests', () => {
  beforeEach(resetIds);

  it('gapRule fires when gap ≥ threshold, not below', () => {
    const prev = evAt('09:00', { durMin: 30 }); // ends 09:30
    const curOk = evAt('09:35'); // gap 5m
    const curSplit = evAt('09:50'); // gap 20m
    const ctx = (cur: Event) => ({
      session: { events: [prev], id: '', startedAt: new Date(0), endedAt: new Date(0), duration: 0, activeDuration: 0, appsUsed: [], browserTabs: [], eventCount: 1 } as Session,
      prev,
      cur,
      config: DEFAULTS,
    });
    expect(gapRule.fires(ctx(curOk))).toBe(false);
    expect(gapRule.fires(ctx(curSplit))).toBe(true);
  });

  it('afkRule fires only for afk watcher ≥ threshold', () => {
    const win = evAt('09:00', { durMin: 10, watcher: 'window' });
    const afkShort = evAt('09:00', { durMin: 2, watcher: 'afk' });
    const afkLong = evAt('09:00', { durMin: 10, watcher: 'afk' });
    const ctx = (cur: Event, prev: Event) => ({
      session: { events: [prev], id: '', startedAt: new Date(0), endedAt: new Date(0), duration: 0, activeDuration: 0, appsUsed: [], browserTabs: [], eventCount: 1 } as Session,
      prev,
      cur,
      config: DEFAULTS,
    });
    const p = evAt('08:00', { durMin: 10 });
    expect(afkRule.fires(ctx(win, p))).toBe(false);
    expect(afkRule.fires(ctx(afkShort, p))).toBe(false);
    expect(afkRule.fires(ctx(afkLong, p))).toBe(true);
  });

  it('manualSplitRule fires only after the named event id', () => {
    const prev = evAt('09:00', { id: 55, durMin: 10 });
    const cur = evAt('09:10', { durMin: 10 });
    const ctx = {
      session: { events: [prev], id: '', startedAt: new Date(0), endedAt: new Date(0), duration: 0, activeDuration: 0, appsUsed: [], browserTabs: [], eventCount: 1 } as Session,
      prev,
      cur,
      config: { ...DEFAULTS, manualSplits: [{ afterEventId: 55 }] },
    };
    expect(manualSplitRule.fires(ctx)).toBe(true);
    ctx.config = { ...DEFAULTS, manualSplits: [{ afterEventId: 999 }] };
    expect(manualSplitRule.fires(ctx)).toBe(false);
  });

  it('shouldStartNewSession ORs the rule chain (first fire wins)', () => {
    const prev = evAt('09:00', { id: 1, durMin: 60 }); // ends 10:00
    const cur = evAt('10:20', { durMin: 10 }); // gap 20m ≥ 15m
    const ctx = {
      session: { events: [prev], id: '', startedAt: new Date(0), endedAt: new Date(0), duration: 0, activeDuration: 0, appsUsed: [], browserTabs: [], eventCount: 1 } as Session,
      prev,
      cur,
      config: DEFAULTS,
    };
    expect(shouldStartNewSession(ctx)).toBe(true);
  });
});

describe('SessionStatistics — pure derive', () => {
  beforeEach(resetIds);

  it('computes duration, activeDuration, counts, primary by duration', () => {
    const a = evAt('09:00', { durMin: 30, app: 'VS Code', title: 'X' });
    const b = evAt('09:30', { durMin: 10, app: 'Chrome', url: 'g' });
    const c = evAt('09:40', { durMin: 20, app: 'VS Code', title: 'X' });
    const session: Session = {
      id: 's-1-3',
      startedAt: new Date(0),
      endedAt: new Date(0),
      duration: 0,
      activeDuration: 0,
      events: [a, b, c],
      appsUsed: [],
      browserTabs: [],
      eventCount: 0,
    };
    computeStatistics(session);
    expect(session.duration).toBe(60 * 60_000); // 09:00–10:00
    expect(session.activeDuration).toBe(60 * 60_000); // 30+10+20
    expect(session.eventCount).toBe(3);
    expect(session.appsUsed.sort()).toEqual(['Chrome', 'VS Code']);
    expect(session.primaryApp).toBe('VS Code'); // 50m vs 10m
    expect(session.primaryUrl).toBe('g');
  });

  it('primary tie-break by earliest startedAt then lexicographic', () => {
    const a = evAt('09:00', { durMin: 10, app: 'A' });
    const b = evAt('09:10', { durMin: 10, app: 'B' }); // same duration, B later
    const session: Session = {
      id: 's-1-2',
      startedAt: new Date(0),
      endedAt: new Date(0),
      duration: 0,
      activeDuration: 0,
      events: [a, b],
      appsUsed: [],
      browserTabs: [],
      eventCount: 0,
    };
    computeStatistics(session);
    expect(session.primaryApp).toBe('A'); // earliest wins
  });
});