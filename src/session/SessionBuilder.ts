import type { Event } from '../models/Event.js';
import type { Session, SessionConfig } from './Session.js';
import {
  DEFAULT_RULES,
  SessionRule,
  shouldStartNewSession,
  dateMs,
} from './SessionRules.js';
import { computeStatistics } from './SessionStatistics.js';

/**
 * Pure batch builder: `Event[] × SessionConfig → Session[]`.
 *
 * Algorithm:
 *   1. Sort events by startedAt asc (tie-break watcher name asc) — fixed,
 *      deterministic input ordering regardless of how the repo returned rows.
 *   2. Walk events. At each prev→cur pair, consult the rule chain. If any rule
 *      fires, close the current session and start a new one at `cur`.
 *   3. After the walk, compute statistics into each session.
 *
 * Invariants (asserted in tests):
 *   - sessions partition the input: every event appears in exactly one session.
 *   - events inside a session stay chronologically ordered.
 *   - no empty sessions ever emitted.
 *
 * Look-back is supported because the rule context receives the whole
 * `session` built so far, not just `prev`/`cur` — enabling future rules that
 * need the session's character (e.g. "is the running session primarily coding?").
 *
 * Pure: no Date.now/Math.random, no I/O, no React/Electron/SQLite.
 */
export class SessionBuilder {
  constructor(
    private readonly rules: SessionRule[] = DEFAULT_RULES,
  ) {}

  build(events: Event[], config: SessionConfig): Session[] {
    if (events.length === 0) return [];

    const sorted = [...events].sort(compareEvents);
    const sessions: Event[][] = [];
    let current: Event[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const sessionView = toSession(current);

      const split = shouldStartNewSession(
        { session: sessionView, prev, cur, config },
        this.rules,
      );

      if (split) {
        sessions.push(current);
        current = [cur];
      } else {
        current.push(cur);
      }
    }
    sessions.push(current);

    return sessions.map((evs) => finalize(evs));
  }
}

/** Comparator: startedAt asc, then watcher asc for stable ties. */
function compareEvents(a: Event, b: Event): number {
  const s = dateMs(a.startedAt) - dateMs(b.startedAt);
  if (s !== 0) return s;
  return a.watcher < b.watcher ? -1 : a.watcher > b.watcher ? 1 : 0;
}

/** Build a minimal Session (no computed stats yet) for rule inspection. */
function toSession(events: Event[]): Session {
  return {
    id: '',
    startedAt: new Date(0),
    endedAt: new Date(0),
    duration: 0,
    activeDuration: 0,
    events,
    appsUsed: [],
    browserTabs: [],
    eventCount: events.length,
  };
}

/** Assign deterministic id + compute all statistics. */
function finalize(events: Event[]): Session {
  const session = toSession(events);
  session.id = `s-${events[0].id}-${events.length}`;
  return computeStatistics(session);
}