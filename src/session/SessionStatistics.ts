import type { Event } from '../models/Event.js';
import type { Session } from './Session.js';
import { dateMs, durationMs } from './SessionRules.js';

/**
 * Pure derivation of a `Session`'s aggregates from its events. Never stored,
 * always recomputed. Kept separate from the builder so the statistics
 * contract is independently testable and can evolve without touching the
 * boundary algorithm.
 *
 * Determinism contract (pinned by tests):
 *   primaryApp/primaryBrowser/primaryTitle/primaryUrl =
 *     the value with the largest summed event-duration across the session,
 *     ties broken by earliest startedAt, then lexicographic asc.
 *   appsUsed / browserTabs =
 *     distinct non-null values, lexicographic ascending.
 */

/**
 * Build statistics into a fresh `Session` skeleton (id + events already
 * chosen by the builder). Mutates only the computed fields; the caller owns
 * `id`/`events`. Returns the same object for chaining.
 */
export function computeStatistics(session: Session): Session {
  const evs = session.events;
  if (evs.length === 0) return session;

  session.startedAt = new Date(earliestStart(evs));
  session.endedAt = new Date(latestEnd(evs));
  session.duration = session.endedAt.getTime() - session.startedAt.getTime();
  session.activeDuration = evs.reduce((sum, e) => sum + durationMs(e), 0);
  session.eventCount = evs.length;
  session.appsUsed = distinctSorted(evs.map((e) => e.app));
  session.browserTabs = distinctSorted(
    evs.map((e) => (e.url ?? e.title) ?? null),
  );

  session.primaryApp = pickPrimary(evs, (e) => e.app);
  session.primaryBrowser = pickPrimary(evs, (e) => e.browser);
  session.primaryTitle = pickPrimary(evs, (e) => e.title);
  session.primaryUrl = pickPrimary(evs, (e) => e.url);
  return session;
}

/** Value with the largest summed duration; ties → earliest start → lex asc. */
function pickPrimary(evs: Event[], key: (e: Event) => string | null): string | undefined {
  const totals = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const e of evs) {
    const k = key(e);
    if (k == null) continue;
    totals.set(k, (totals.get(k) ?? 0) + durationMs(e));
    if (!firstSeen.has(k)) firstSeen.set(k, dateMs(e.startedAt));
  }
  let best: string | undefined;
  let bestDur = -1;
  let bestStart = Infinity;
  for (const [k, dur] of totals) {
    const start = firstSeen.get(k)!;
    if (
      dur > bestDur ||
      (dur === bestDur && start < bestStart) ||
      (dur === bestDur && start === bestStart && (best === undefined || k < best))
    ) {
      best = k;
      bestDur = dur;
      bestStart = start;
    }
  }
  return best;
}

function distinctSorted(values: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of values) if (v != null) set.add(v);
  return [...set].sort();
}

function earliestStart(evs: Event[]): number {
  return evs.reduce((min, e) => Math.min(min, dateMs(e.startedAt)), Infinity);
}

function latestEnd(evs: Event[]): number {
  return evs.reduce((max, e) => Math.max(max, dateMs(e.endedAt)), -Infinity);
}