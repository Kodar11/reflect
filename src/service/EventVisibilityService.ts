import type { IEventVisibilityStore } from '../database/EventRepository.js';
import type { AnalysisWindow, RetiredIntelligence } from '../database/IntelligenceRepository.js';
import type { StoredEvent } from '../models/Event.js';
import type { RemovedEvents } from '../reflection/ReflectionChanges.js';

/**
 * The user's control over what Reflect has captured: an event can be kept,
 * hidden, or deleted for good.
 *
 *   hide      the row stays stored (it can be restored) but leaves everything
 *             user-facing — `IEventRepository` no longer returns it;
 *   unhide    it is a visible event again;
 *   delete    the row is removed. Irreversible.
 *
 * Leaving the raw event out of future reads is only half of it: activities,
 * reflections and coach suggestions written while the event was visible would
 * keep describing it. So a removal is one transaction over the event AND what
 * was derived from it:
 *
 *   AI activity that held it        retired; its other events fall back to
 *                                   deterministic sessions at once
 *   analyses that covered it        superseded, then run again (background)
 *   reflections written from it     citing insights removed, report stale,
 *                                   rewritten at the next cycle (background)
 *   coach suggestions made from it  withdrawn (deleted with the event), or
 *                                   stripped of the citation if already decided
 *   cached days over that stretch   dropped and derived again on demand
 *
 * Only derived data that actually rested on the event is touched; nothing is
 * rebuilt wholesale. Sessions, the Timeline, classification and exports hold
 * no state of their own — they are re-derived from the visible events on the
 * next read.
 *
 * Nothing here logs an event's title, URL or app.
 */

export interface TimelineBlockRef {
  /** Timeline block id (AI activity id, or deterministic session id). */
  id: string;
  /** Reflection's cache key for the block's thread / priority link. */
  signature: string;
}

export interface EventVisibilityLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface EventVisibilityDeps {
  /** Runs `fn` atomically: an event and what was derived from it change together. */
  transaction<T>(fn: () => T): T;
  events: IEventVisibilityStore;
  intelligence: {
    retireForEvents(eventIds: number[], range: AnalysisWindow, nowIso: string, options?: { purge?: boolean }): RetiredIntelligence;
    supersedeRunsOverlapping(range: AnalysisWindow, nowIso: string): AnalysisWindow[];
  };
  reflections: {
    redactRemovedEvents(removed: RemovedEvents, signatures: string[], nowIso: string): unknown[];
  };
  coach?: { onEventsRemoved(removed: RemovedEvents, options?: { purge?: boolean }): number };
  /** The timeline blocks that hold these (visible) events right now. */
  blocksHolding(eventIds: number[]): TimelineBlockRef[];
  /** What is cached about this stretch of time no longer holds. */
  onRangeChanged(range: AnalysisWindow): void;
  /**
   * Bring derived data up to date: analyse these windows again, then let the
   * reflections that went stale be rewritten. Runs in the background; the
   * user never waits for it.
   */
  rebuild?(windows: AnalysisWindow[]): Promise<void> | void;
  /** Something the renderer shows has changed. */
  onChanged?(): void;
  logger?: EventVisibilityLogger;
  now?: () => Date;
  /** Defers the background rebuild. Defaults to an unref'd timer. */
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export type EventVisibilityResult =
  | {
      ok: true;
      /** The events this call actually changed. */
      eventIds: number[];
      /** Derived data is being brought up to date in the background. */
      updating: boolean;
    }
  | { ok: false; error: string };

/** Several removals in a row are followed by one rebuild, not one each. */
const REBUILD_DELAY_MS = 2_000;

export class EventVisibilityService {
  private readonly now: () => Date;
  private readonly pendingWindows = new Map<string, AnalysisWindow>();
  private rebuildHandle: unknown = null;

  constructor(private readonly deps: EventVisibilityDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Take events out of everything user-facing. They stay stored and can be restored. */
  hide(eventIds: number[]): EventVisibilityResult {
    return this.remove(eventIds, 'hide');
  }

  /** Remove events for good, together with everything that was written from them. */
  deletePermanently(eventIds: number[]): EventVisibilityResult {
    return this.remove(eventIds, 'delete');
  }

  /** Make hidden events visible again. What is derived from them is rebuilt, not restored. */
  unhide(eventIds: number[]): EventVisibilityResult {
    try {
      const targets = this.deps.events.findIncludingHidden(sanitize(eventIds)).filter((e) => e.hiddenAt !== null);
      if (targets.length === 0) return { ok: true, eventIds: [], updating: false };
      const ids = targets.map((e) => e.id);
      const nowIso = this.now().toISOString();

      const windows = this.deps.transaction(() => {
        this.deps.events.unhide(ids);
        // The analyses of that stretch were made without these events.
        return targets.flatMap((e) => this.deps.intelligence.supersedeRunsOverlapping({ start: e.startedAt, end: e.endedAt }, nowIso));
      });

      this.deps.onRangeChanged(envelope(targets));
      this.deps.logger?.info(`[PRIVACY] Restored ${ids.length} hidden event(s).`);
      return this.finish(ids, windows);
    } catch (err) {
      return this.failed('restore', err);
    }
  }

  /** Hidden events, most recently hidden first — for the restore / delete controls only. */
  listHidden(limit?: number): StoredEvent[] {
    return this.deps.events.listHidden(limit);
  }

  private remove(eventIds: number[], mode: 'hide' | 'delete'): EventVisibilityResult {
    try {
      const stored = this.deps.events.findIncludingHidden(sanitize(eventIds));
      // An already hidden event can still be deleted; hiding it again changes nothing.
      const targets = mode === 'hide' ? stored.filter((e) => e.hiddenAt === null) : stored;
      if (targets.length === 0) return { ok: true, eventIds: [], updating: false };
      const ids = targets.map((e) => e.id);
      const range = envelope(targets);
      const nowIso = this.now().toISOString();

      // Read while the events are still on the timeline.
      const blocks = this.blocksHolding(targets.filter((e) => e.hiddenAt === null).map((e) => e.id));

      const retired = this.deps.transaction(() => {
        const intelligence = this.deps.intelligence.retireForEvents(ids, range, nowIso, { purge: mode === 'delete' });
        const removed: RemovedEvents = {
          eventIds: ids,
          ranges: targets.map((e) => ({ start: e.startedAt, end: e.endedAt })),
          activityIds: [...new Set([...intelligence.activityIds, ...blocks.map((b) => b.id)])],
        };
        this.deps.reflections.redactRemovedEvents(removed, [...new Set(blocks.map((b) => b.signature).filter(Boolean))], nowIso);
        this.deps.coach?.onEventsRemoved(removed, { purge: mode === 'delete' });
        if (mode === 'hide') this.deps.events.hide(ids, nowIso);
        else this.deps.events.deletePermanently(ids);
        return intelligence;
      });

      this.deps.onRangeChanged(range);
      this.deps.logger?.info(
        `[PRIVACY] ${mode === 'hide' ? 'Hid' : 'Permanently deleted'} ${ids.length} event(s); ` +
          `${retired.activityIds.length} AI activity(ies) retired, ${retired.windows.length} window(s) to analyse again.`,
      );
      return this.finish(ids, retired.windows);
    } catch (err) {
      return this.failed(mode, err);
    }
  }

  private blocksHolding(eventIds: number[]): TimelineBlockRef[] {
    if (eventIds.length === 0) return [];
    try {
      return this.deps.blocksHolding(eventIds);
    } catch (err) {
      // The removal itself must not depend on the timeline being derivable.
      this.deps.logger?.error(`[PRIVACY] Could not locate the timeline blocks of removed events: ${messageOf(err)}`);
      return [];
    }
  }

  private finish(eventIds: number[], windows: AnalysisWindow[]): EventVisibilityResult {
    const updating = this.scheduleRebuild(windows);
    try {
      this.deps.onChanged?.();
    } catch {
      // A UI notification must never undo a completed removal.
    }
    return { ok: true, eventIds, updating };
  }

  private scheduleRebuild(windows: AnalysisWindow[]): boolean {
    if (!this.deps.rebuild) return false;
    for (const w of windows) this.pendingWindows.set(`${w.start}|${w.end}`, w);
    const schedule =
      this.deps.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return timer;
      });
    const cancel = this.deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (this.rebuildHandle !== null) cancel(this.rebuildHandle);
    this.rebuildHandle = schedule(() => {
      this.rebuildHandle = null;
      const batch = [...this.pendingWindows.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      this.pendingWindows.clear();
      void Promise.resolve()
        .then(() => this.deps.rebuild?.(batch))
        .catch((err) => this.deps.logger?.error(`[PRIVACY] Rebuild after an event removal failed: ${messageOf(err)}`));
    }, REBUILD_DELAY_MS);
    return true;
  }

  private failed(what: string, err: unknown): EventVisibilityResult {
    this.deps.logger?.error(`[PRIVACY] Could not ${what} event(s): ${messageOf(err)}`);
    return { ok: false, error: 'That change could not be saved. Nothing was changed.' };
  }
}

function sanitize(eventIds: unknown): number[] {
  if (!Array.isArray(eventIds)) return [];
  return [...new Set(eventIds.filter((id): id is number => Number.isInteger(id) && id > 0))];
}

function envelope(events: Pick<StoredEvent, 'startedAt' | 'endedAt'>[]): AnalysisWindow {
  let start = events[0].startedAt;
  let end = events[0].endedAt;
  for (const e of events) {
    if (e.startedAt < start) start = e.startedAt;
    if (e.endedAt > end) end = e.endedAt;
  }
  return { start, end };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
