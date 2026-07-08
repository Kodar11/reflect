import type { Event } from '../models/Event.js';
import type { Session, SessionConfig } from './Session.js';

/**
 * Boundary rules. Each rule is a small, independently testable function that
 * answers: "does a session boundary exist between `prev` and `cur`?"
 *
 * The rule chain is the single place future stages extend behavior:
 *   - Stage 3 timeline editing → `manualSplitRule` already wired.
 *   - Future AFK watcher → `afkRule` already wired (inert today).
 *   - Future classification (Netflix vs GitHub) → add a new rule here.
 * Adding a rule never touches the builder, engine, service, or UI.
 *
 * Rules are PURE: deterministic functions of their arguments, no I/O.
 */

export interface RuleContext {
  /** The session currently being built (so a rule may look back). */
  session: Session;
  /** The event that would be appended IF no boundary is forced. */
  cur: Event;
  /** The event immediately preceding `cur` in the sorted day's stream. */
  prev: Event;
  config: SessionConfig;
}

export interface SessionRule {
  /** Stable name for tests + a future rules health panel. */
  name: string;
  /** Return true to force a boundary (session ends before `cur`). */
  fires(ctx: RuleContext): boolean;
}

/**
 * Gap rule. If `cur.startedAt − prev.endedAt ≥ gapThresholdMs` we split.
 * Same-threshold handles Rule 4 (short interruptions merge) implicitly: a
 * 2-minute Discord break has a 0-minute gap (contiguous) or a tiny gap, well
 * under the threshold, so it stays in the session.
 */
export const gapRule: SessionRule = {
  name: 'gap',
  fires({ prev, cur, config }) {
    return timeBetween(prev, cur) >= config.gapThresholdMs;
  },
};

/**
 * AFK rule. A future AFK watcher emits `watcher === 'afk'` events; when such
 * an event's duration ≥ `afkThresholdMs` we start a new session AND the afk
 * event itself heads its own "away" session (per design doc). The away session
 * is also *closed* when a subsequent non-afk event arrives so the next real
 * activity doesn't merge back into the away block. Inert today because Stage 1
 * emits no afk events.
 */
export const afkRule: SessionRule = {
  name: 'afk',
  fires({ session, cur, config }) {
    // Boundary BEFORE a qualifying afk event: it opens its own away session.
    if (cur.watcher === 'afk' && durationMs(cur) >= config.afkThresholdMs) {
      return true;
    }
    // Boundary AFTER an away session: if we're currently inside an away session
    // (its first event is afk) and a non-afk event arrives, close it so the
    // away block stands alone.
    const head = session.events[0];
    if (head && head.watcher === 'afk' && cur.watcher !== 'afk') {
      return true;
    }
    return false;
  },
};

/**
 * Manual split rule. A split point registered "after event id X" fires when
 * `prev.id === X`. Seam for Stage 3 timeline editing; defaults to no splits.
 */
export const manualSplitRule: SessionRule = {
  name: 'manualSplit',
  fires({ prev, config }) {
    return config.manualSplits.some((sp) => sp.afterEventId === prev.id);
  },
};

/** Default rule chain, in evaluation order. First fire wins. */
export const DEFAULT_RULES: SessionRule[] = [
  manualSplitRule,
  afkRule,
  gapRule,
];

/** Returns true if any rule fires at the prev→cur boundary. */
export function shouldStartNewSession(
  ctx: RuleContext,
  rules: SessionRule[] = DEFAULT_RULES,
): boolean {
  return rules.some((r) => {
    try {
      return r.fires(ctx);
    } catch {
      // A buggy rule must never poison the day's reconstruction — log-worthy
      // in a future health panel, but for Stage 2 we treat it as "no fire"
      // so the session continues. Honors the spec's "one event in exactly one
      // session" invariant defensively.
      return false;
    }
  });
}

/** ms between prev.endedAt and cur.startedAt (negative if overlapping). */
export function timeBetween(prev: Event, cur: Event): number {
  return dateMs(cur.startedAt) - dateMs(prev.endedAt);
}

/** ms span of a single event. */
export function durationMs(e: Event): number {
  return dateMs(e.endedAt) - dateMs(e.startedAt);
}

/** Parse an Event ISO timestamp to epoch ms. */
export function dateMs(iso: string): number {
  return new Date(iso).getTime();
}