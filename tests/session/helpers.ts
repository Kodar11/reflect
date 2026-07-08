import type { Event, WatcherName } from '../../src/models/Event';

/**
 * Test helpers for the session suite. Synthesize `Event` rows without a DB.
 * Times are friendly strings → ISO. Event ids are explicit so tests read like
 * the design doc and `manualSplits` has stable targets.
 */

let nextId = 1;
export function resetIds() {
  nextId = 1;
}

/** "09:00" → ISO on a fixed day (2026-01-01, local). Deterministic. */
export function at(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 0, 1, h, m, 0).toISOString();
}

/** Build an event. `end` defaults to `start + durMin` (or instant if no dur). */
export function ev(
  start: string,
  opts: {
    id?: number;
    end?: string;
    durMin?: number;
    app?: string | null;
    browser?: string | null;
    title?: string | null;
    url?: string | null;
    watcher?: WatcherName;
  } = {},
): Event {
  const id = opts.id ?? nextId++;
  const startMs = new Date(start).getTime();
  const end = opts.end ?? new Date(startMs + (opts.durMin ?? 0) * 60_000).toISOString();
  return {
    id,
    watcher: opts.watcher ?? 'window',
    startedAt: start,
    endedAt: end,
    app: opts.app ?? null,
    browser: opts.browser ?? null,
    title: opts.title ?? null,
    url: opts.url ?? null,
    payload: null,
    createdAt: null,
  };
}

/** Convenience: `ev(at('09:00'), ...)` without repeating `at()`. */
export function evAt(
  hhmm: string,
  opts: Parameters<typeof ev>[1] = {},
): Event {
  return ev(at(hhmm), opts);
}

export const DEFAULTS = {
  gapThresholdMs: 15 * 60_000,
  afkThresholdMs: 5 * 60_000,
  manualSplits: [] as { afterEventId: number }[],
};