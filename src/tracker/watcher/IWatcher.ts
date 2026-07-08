import type { ActivitySample } from '../../models/Event.js';

/**
 * Common contract every watcher satisfies. Concrete watchers (`WindowWatcher`,
 * `BrowserWatcher`, and future ones) implement this; `TrackingService` is
 * coded against `IWatcher` so it can start/stop an array of unknown watchers.
 *
 * A watcher is *independent*: it must self-contained its own polling, must not
 * throw across the process (the service isolates failures, but a watcher that
 * throws synchronously in `start()` defeats isolation), and must own its own
 * timers so `stop()` fully releases resources.
 *
 * Communicates outward only via an injected `IEventSink` (the heartbeat
 * engine), never via SQL or global state.
 */
export interface IWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Human label for logs and the (future) watcher health panel. */
  readonly name: string;
  readonly running: boolean;
}

/**
 * Where watchers send samples. The heartbeat engine is the canonical
 * implementation — it merges identical adjacent samples so we store
 * `App — 09:00→09:20` rather than twenty `App` rows.
 *
 * Keeping this separate from `IEventRepository` lets the engine be the single
 * merging authority; a watcher with no merging need (e.g. a future event-style
 * watcher) could substitute its own sink that writes immediately.
 */
export interface IEventSink {
  emit(sample: ActivitySample): void;
}