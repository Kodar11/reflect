import { IEventSink, IWatcher } from './IWatcher.js';

/**
 * Stage 1 ships the Window Watcher; the Browser Watcher is intentionally
 * deferred. See ADR "Browser URL capture has no reliable native path".
 *
 * This stub exists for two reasons:
 *   1. It proves the `IWatcher` contract is satisfiable by a second,
 *      unrelated watcher without touching `TrackingService` — the pluggable
 *      seam is real, not theoretical.
 *   2. When browser capture is implemented (browser extension + native
 *      messaging host, or --remote-debugging-port), the change is localized
 *      here; the service, repository, engine, and DB are untouched.
 *
 * The stub is *not* registered in `TrackingService` for Stage 1, so it never
 * runs. It exists only to keep the catch-all default of a future progress
 * visible: it is a "this slot reserved" marker in code.
 */
export class BrowserWatcher implements IWatcher {
  readonly name = 'browser';
  private _running = false;

  constructor(
    private readonly sink: IEventSink,
    private readonly log: { warn(msg: string): void; info(msg: string): void } = console,
  ) {}

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    this._running = true;
    this.log.info('[BrowserWatcher] deferred for Stage 1 — registered only when implemented.');
  }

  async stop(): Promise<void> {
    this._running = false;
  }
}