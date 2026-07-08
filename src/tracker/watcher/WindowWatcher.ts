import { IEventSink, IWatcher } from './IWatcher.js';
import { ActivitySample } from '../../models/Event.js';

/**
 * Decouples the watching strategy from its data source. In production this is
 * `active-win`. In tests we pass a fake that returns a scripted sequence of
 * samples (or rejects to exercise crash isolation) without touching the OS.
 *
 * Returns `null` to indicate "no foreground window / lookup failed non-fatally";
 * returning null does NOT close the current event (we treat absence as "still
 * the same") to avoid fragmenting events on transient polling hiccups.
 */
export type ActiveWindowPoll = () => Promise<ActivitySample | null>;

/**
 * `WindowWatcher` polls the foreground window at a fixed interval and forwards
 * each observation to the `IEventSink` (the heartbeat engine). The watcher
 * contains *no* persistence knowledge — it only produces `ActivitySample`s.
 *
 * Composition choices:
 *  - The poll function is injected rather than imported at module scope, so a
 *    test never needs to mock `active-win` (or even import Electron).
 *  - `intervalMs` is injected so tests can run fast and production stays on a
 *    conservative 1s cadence.
 *  - The sink is injected as `IEventSink`, so the watcher is agnostic to
 *    whether merging happens (engine) or each sample is written verbatim.
 *
 * Robustness: each `tick()` is fully try/catch'd and logs through the injected
 * logger. A thrown poll never propagates, never stops the watcher, and never
 * affects sibling watchers — the `TrackingService` additionally guards `start`.
 */
export class WindowWatcher implements IWatcher {
  readonly name = 'window';
  private timer: NodeJS.Timeout | null = null;
  private _running = false;

  constructor(
    private readonly poll: ActiveWindowPoll,
    private readonly sink: IEventSink,
    private readonly intervalMs = 1000,
    private readonly log: { warn(msg: string): void; error(msg: string): void; info(msg: string): void } = console,
  ) {}

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    // Fire once immediately so the first event appears without one tick's delay.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this._running) return;
    try {
      const sample = await this.poll();
      if (sample) this.sink.emit(sample);
    } catch (e) {
      // Keep swallows: a transient poll failure must not stop the watcher or
      // crash the process. Logged for diagnosis.
      this.log.warn(`[WindowWatcher] poll failed: ${(e as Error)?.message ?? e}`);
    }
  }
}