/**
 * Core domain types shared across the tracker, repository, and UI.
 *
 * Stage 1 stores only *facts*: what the user was doing, when, and where.
 * No categories, productivity scores, or AI output ever live here.
 *
 * Two layers:
 *  - `ActivitySample` is the lightweight *observation* a watcher produces on
 *    every poll tick (raw, possibly-identical-to-the-last). Watchers emit these.
 *  - `Event` is the *persisted* row produced by the heartbeat engine after
 *    merging an identical run of samples into a single time span.
 */

/** Which watcher produced an event. Low-cardinality string discriminator. */
export type WatcherName =
  | 'window'
  | 'browser'
  // Reserved for future stages — listed now so the union is self-documenting.
  | 'afk'
  | 'webcam'
  | 'microphone'
  | 'editor'
  | 'calendar';

/**
 * A single observation from a watcher. Fields are optional because different
 * watchers populate different columns (e.g. a window watcher never sets `url`).
 * `payload` holds watcher-specific extras as a JSON-serializable object — it
 * is intentionally NOT used for searchable/common fields.
 */
export interface ActivitySample {
  watcher: WatcherName;
  app?: string;
  browser?: string;
  title?: string;
  url?: string;
  /** Reserved for watcher-specific data. Will be JSON-stringified on insert. */
  payload?: Record<string, unknown>;
}

/**
 * A persisted event row. `started_at`/`ended_at` are ISO-8601 strings so the
 * repository is transport-agnostic; the DB stores DATETIME which SQLite keeps
 * as text. `created_at` defaults server-side (in DB) on insert.
 */
export interface Event {
  id: number;
  watcher: WatcherName;
  startedAt: string;
  endedAt: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  payload: string | null;
  createdAt: string | null;
}

/**
 * The subset of columns that *define identity* between two observations — if
 * these match, the heartbeat engine treats successive samples as one event and
 * only advances `ended_at`. `payload` is deliberately excluded so
 * watcher-specific noise (e.g. a changing scroll position) never splits runs.
 */
export function eventKey(s: { watcher: WatcherName; app?: string | null; browser?: string | null; title?: string | null; url?: string | null }): string {
  return [s.watcher, s.app ?? '', s.browser ?? '', s.title ?? '', s.url ?? ''].join('\x1f');
}