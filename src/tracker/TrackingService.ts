import { IWatcher } from './watcher/IWatcher.js';
import { HeartbeatEngine } from './HeartbeatEngine.js';
import { Logger } from '../service/logger.js';

/**
 * `TrackingService` is the lifecycle owner of the whole capture stack:
 *
 *   config → HeartbeatEngine (started once) → N independent watchers (started)
 *
 * The UI never talks to watchers or the engine directly — it sees results via
 * the repository through IPC. This class is the only place that decides "when
 * tracking is on" and the only place that knows the full watcher list, which
 * is exactly the dependency-injection seam the spec asked for.
 *
 * Isolation contract: a failure in any single watcher — during `start()` or at
 * runtime — must NOT take down the others. Each watcher is wrapped, and a
 * crashed watcher is recorded as failed; the rest keep running. The engine is
 * kept running across watcher failures because it owns open-event bookkeeping
 * and must flush even if its producers die.
 *
 * Everything is injected:
 *   - watchers: `IWatcher[]` (so the list is configurable + testable)
 *   - engine: `HeartbeatEngine` (concrete today, but the engine itself takes an
 *     `IEventRepository`, and the sink it implements is what watchers accept)
 *   - logger: the existing app Logger
 */
export class TrackingService {
  private started = false;
  private readonly watcherState: Map<string, 'running' | 'failed'> = new Map();

  constructor(
    private readonly watchers: IWatcher[],
    private readonly engine: HeartbeatEngine,
    private readonly logger: { info(m: string): void; warn(m: string): void; error(m: string): void } = console,
  ) {
    if (watchers.length === 0) {
      this.logger.warn('[TrackingService] constructed with no watchers.');
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.engine.start();
    this.logger.info('[TrackingService] heartbeat engine started.');

    // Start each watcher in its own try/catch so a single broken watcher never
    // blocks siblings. We `await` sequentially — start cost is one tick per
    // watcher and isolation matters more than sub-ms parallelism.
    for (const w of this.watchers) {
      try {
        await w.start();
        this.watcherState.set(w.name, 'running');
        this.logger.info(`[TrackingService] watcher '${w.name}' started.`);
      } catch (e) {
        this.watcherState.set(w.name, 'failed');
        this.logger.error(`[TrackingService] watcher '${w.name}' failed to start: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Stop watchers first so no new samples arrive, THEN flush the engine so
    // every open event gets its final `ended_at` written before close.
    await Promise.all(
      this.watchers.map(async (w) => {
        try {
          await w.stop();
          this.watcherState.set(w.name, 'running');
        } catch (e) {
          this.logger.error(`[TrackingService] watcher '${w.name}' failed to stop: ${(e as Error)?.message ?? e}`);
        }
      }),
    );
    this.engine.stop();
    this.logger.info('[TrackingService] stopped (watchers + heartbeat).');
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Snapshot for a future health panel; Stable1 just logs failures. */
  get health(): Record<string, 'running' | 'failed'> {
    return Object.fromEntries(this.watcherState);
  }
}

/** Convenience export for code that imports the engine type alongside. */
export type { HeartbeatEngine };
export type { IWatcher };
export { Logger };