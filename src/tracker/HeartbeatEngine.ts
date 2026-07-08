import { IEventRepository } from '../database/EventRepository.js';
import { ActivitySample, WatcherName, eventKey } from '../models/Event.js';
import { IEventSink } from './watcher/IWatcher.js';

/**
 * `HeartbeatEngine` is the merge authority between raw watcher samples and the
 * repository. Watchers emit `ActivitySample`s on every poll tick; many ticks
 * describe the *same* activity. We collapse a maximal run of identical
 * samples into ONE event whose `started_at`/`ended_at` brackets the run.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Per-watcher state holds: { id, key } for the currently-open event.  │
 * │                                                                     │
 * │ sample → no current event  → INSERT new, remember id+key            │
 * │ sample → current, same key  → (in-memory) advance ended_at; lazy    │
 * │ sample → current, new key   → flush old (UPDATE ended_at), INSERT    │
 * │ stop() / flush()            → UPDATE ended_at for every open event  │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Identity (`eventKey`) = (watcher, app, browser, title, url). `payload` is
 * deliberately excluded so watcher-specific noise (changing scroll position,
 * a byte counter, etc.) never fragments a run.
 *
 * Crash-safety: a periodic `flush()` advances every open event's `ended_at`
 * every `flushIntervalMs`; if the process dies, the DB has at most that much
 * lost "tail" per open event — no whole run is dropped.
 *
 * This class implements `IEventSink` and is constructed with an
 * `IEventRepository` (interface), so it's unit-testable with a fake repo and
 * has zero coupling to better-sqlite3.
 */
export class HeartbeatEngine implements IEventSink {
  private open = new Map<WatcherName, { id: number; key: string }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: IEventRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs = 5000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Don't keep the process alive solely for the flush; lifecycle is owned by
    // the app, the timer is a background worker.
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  emit(sample: ActivitySample): void {
    if (!this.running) return;
    const key = eventKey(sample);
    const current = this.open.get(sample.watcher);
    const nowIso = this.now().toISOString();

    if (!current) {
      const id = this.repo.insert({ ...sampleToFields(sample), startedAt: nowIso, endedAt: nowIso });
      this.open.set(sample.watcher, { id, key });
      return;
    }

    if (current.key === key) {
      // Same activity — just advance ended_at lazily. We don't write here on
      // every tick to keep write load low; periodic `flush()` coalesces this.
      return;
    }

    // Activity changed: finalize previous, then open a new event.
    this.repo.updateEndedAt(current.id, nowIso);
    const id = this.repo.insert({ ...sampleToFields(sample), startedAt: nowIso, endedAt: nowIso });
    this.open.set(sample.watcher, { id, key });
  }

  /** Advance `ended_at` for every still-open event to now. */
  flush(): void {
    if (this.open.size === 0) return;
    const nowIso = this.now().toISOString();
    for (const { id } of this.open.values()) {
      this.repo.updateEndedAt(id, nowIso);
    }
  }

  /** Test/debug hook. */
  get openCount(): number {
    return this.open.size;
  }
}

function sampleToFields(s: ActivitySample): {
  watcher: WatcherName;
  app?: string | null;
  browser?: string | null;
  title?: string | null;
  url?: string | null;
  payload?: string | null;
} {
  return {
    watcher: s.watcher,
    app: s.app ?? null,
    browser: s.browser ?? null,
    title: s.title ?? null,
    url: s.url ?? null,
    payload: s.payload ? JSON.stringify(s.payload) : null,
  };
}