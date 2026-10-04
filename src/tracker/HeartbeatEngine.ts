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
 * Unobserved time is never tracked time. When `maxGapMs` is set and nothing
 * was observed for longer than that (the machine slept or hibernated, the
 * process was frozen, the clock was set back), the open events are closed at
 * the last moment they were actually seen and the next sample starts a new
 * event — a night of sleep never becomes one eight-hour activity. `stop()`
 * and `closeOpen()` end the open events for the same reason: what follows a
 * pause or a suspend is a new observation, not a continuation.
 *
 * This class implements `IEventSink` and is constructed with an
 * `IEventRepository` (interface), so it's unit-testable with a fake repo and
 * has zero coupling to better-sqlite3.
 */
export class HeartbeatEngine implements IEventSink {
  private open = new Map<WatcherName, { id: number; key: string }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** When a sample or flush was last processed (ms); null while stopped. */
  private lastBeatAt: number | null = null;

  constructor(
    private readonly repo: IEventRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs = 5000,
    private readonly onActivity?: () => void,
    /** Longest silence that still counts as continuous observation. Unset = no gap detection. */
    private readonly maxGapMs?: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastBeatAt = this.now().getTime();
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
    this.closeOpen();
    this.lastBeatAt = null;
  }

  /**
   * End every open event now. Used when observation is about to stop (the
   * machine is going to sleep, tracking is being paused): whatever is in
   * front afterwards is recorded as a new event.
   */
  closeOpen(): void {
    this.flush();
    this.open.clear();
  }

  emit(sample: ActivitySample): void {
    if (!this.running) return;
    this.onActivity?.();
    const key = eventKey(sample);
    const now = this.now();
    this.closeAcrossGap(now.getTime());
    const current = this.open.get(sample.watcher);
    const nowIso = now.toISOString();

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
    const now = this.now();
    this.closeAcrossGap(now.getTime());
    if (this.open.size === 0) return;
    const nowIso = now.toISOString();
    for (const { id } of this.open.values()) {
      this.repo.updateEndedAt(id, nowIso);
    }
  }

  /**
   * If the engine was not beating for longer than `maxGapMs` — or the clock
   * moved backwards — the open events end at the last beat instead of being
   * stretched across time nobody observed.
   */
  private closeAcrossGap(nowMs: number): void {
    const last = this.lastBeatAt;
    this.lastBeatAt = nowMs;
    if (this.maxGapMs === undefined || last === null || this.open.size === 0) return;
    if (nowMs - last <= this.maxGapMs && nowMs >= last) return;
    const lastIso = new Date(last).toISOString();
    for (const { id } of this.open.values()) {
      this.repo.updateEndedAt(id, lastIso);
    }
    this.open.clear();
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