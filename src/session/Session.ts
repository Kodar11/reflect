import type { Event } from '../models/Event.js';

/**
 * Stage 2 — Session layer.
 *
 * A `Session` is a virtual reconstruction of one continuous intent, derived
 * on demand from raw `Event`s. Sessions are **never persisted** — the raw
 * events table remains the single source of truth. Re-deriving from the same
 * event set always yields the same sessions (the engine is pure &
 * deterministic).
 *
 * Layers (all under `src/session/`):
 *   PURE (no React / SQLite / Electron / Date.now / Math.random):
 *     - Session.ts          this file — model + config types
 *     - SessionRules.ts     boundary rules (gap, afk, manual split)
 *     - SessionStatistics.ts derive duration/primary/used from events
 *     - SessionBuilder.ts   Event[] × Config → Session[]
 *     - SessionEngine.ts    deterministic façade
 *   IMPURE:
 *     - SessionService.ts   injects IEventRepository, supplies config
 *     - sessionIpc.ts       exposes session:* via ipcMainHandle
 *
 * This file is pure: only `import type` from models. No runtime imports.
 */

/**
 * A derived session. `events` is the exhaustive, ordered list of raw events
 * that constitute this session — every raw event appears in exactly one
 * session across a day's set. All aggregates (`duration`, `primaryApp`,
 * `appsUsed`, …) are **computed** by `SessionStatistics`; they never live in
 * a DB and are not to be hand-set except by the statistics builder.
 */
export interface Session {
  /** Deterministic: `"s-" + firstEvent.id + "-" + eventCount`. Stable across
   * re-derivations from the same raw set; changes only if the raw set changes. */
  id: string;
  /** Envelope start = first event's startedAt. */
  startedAt: Date;
  /** Envelope end = last event's endedAt. */
  endedAt: Date;
  /** Envelope duration ms = endedAt − startedAt, incl. bridged gaps. */
  duration: number;
  /** Sum of per-event durations = Σ (event.endedAt − event.startedAt). */
  activeDuration: number;
  /** Events that compose this session, in chronological order. */
  events: Event[];
  primaryApp?: string;
  primaryBrowser?: string;
  primaryTitle?: string;
  primaryUrl?: string;
  /** Distinct apps seen (non-null), sorted for determinism. */
  appsUsed: string[];
  /** Distinct browser tabs (url or title) seen, sorted for determinism. */
  browserTabs: string[];
  /** Number of raw events in this session. */
  eventCount: number;
}

/**
 * Knobs the boundary algorithm consults. All times in ms. Defaults match the
 * Stage 2 design doc (15-min gap, 5-min afk). `afkThresholdMs` is inert until
 * a future AFK watcher ships events with `watcher === 'afk'`.
 */
export interface SessionConfig {
  /** Rule 2 — inter-event gap ≥ this forces a new session. Also absorbs Rule 4
   * (short interruptions merge because their gap < this). */
  gapThresholdMs: number;
  /** Rule 1 — an `afk` event with duration ≥ this becomes its own "away"
   * session and closes the previous one. Future-only. */
  afkThresholdMs: number;
  /** Rule 3 — manual split points (Stage 3 timeline editing seam).
   * A split point AFTER event id X starts a new session at the next event. */
  manualSplits: SplitPoint[];
}

export interface SplitPoint {
  /** Split AFTER the event whose `id` === this. */
  afterEventId: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  gapThresholdMs: 15 * 60 * 1000,
  afkThresholdMs: 5 * 60 * 1000,
  manualSplits: [],
};