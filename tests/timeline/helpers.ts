import type { Event, WatcherName } from '../../src/models/Event';

let nextId = 1;
export function resetIds() { nextId = 1; }

export function at(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 0, 1, h, m, 0).toISOString();
}

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
  const end = opts.end ?? new Date(new Date(start).getTime() + (opts.durMin ?? 0) * 60_000).toISOString();
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

export function evAt(hhmm: string, opts: Parameters<typeof ev>[1] = {}): Event {
  return ev(at(hhmm), opts);
}