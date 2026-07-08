import type { IEditRepository } from '../database/EditRepository.js';
import type { TimelineEdit, TimelineOperation, VerifiedSession } from './TimelineModels.js';
import type {
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
} from './TimelineModels.js';
import { TimelineEngine } from './TimelineEngine.js';
import type { SessionService } from '../session/SessionService.js';

/**
 * `TimelineService` is the impure seam between persisted state and the pure
 * timeline engine. It owns:
 *   - `SessionService` (generates sessions from raw events — Stage 2),
 *   - `IEditRepository` (THE edit log),
 *   - `TimelineEngine` (pure replay),
 *   - the undo/redo cursor over the log.
 *
 * UI never calls the engine directly. Everything mutating (rename / split /
 * merge / delete / create_offline) goes through `apply(operation, payload)`,
 * which persists a new append row. Undo/redo flip the `undone_at` flag of the
 * appropriate row(s); because the engine skips undone rows, the verified
 * timeline updates deterministically on the next read.
 *
 * ── Hint resolution ──
 * The renderer sends *hints* — `sessionIdHint` + (for split) `afterEventIndex`
 * — because the `VerifiedSessionDto` deliberately omits per-event arrays to
 * keep IPC payloads lean. `apply()` resolves hints into **durable event-id
 * payloads** BEFORE persisting so the edit log survives future Stage-2
 * algorithm improvements (which may regenerate sessions with different ids but
 * the same event ids — the primary keys in SQLite).
 *
 *   rename  hint { sessionIdHint, newTitle }
 *           → { anchorEventId: session.events[0].id, newTitle }
 *   split   hint { sessionIdHint, afterEventIndex }
 *           → { afterEventId: session.events[index].id }
 *   delete  hint { sessionIdHint }
 *           → { eventIds: session.events.map(e => e.id) }
 *   merge   hint { sessionIdHint }
 *           → { boundaryFromEventId, boundaryToEventId } (next adjacent session)
 *   create_offline → passthrough (no event ids needed; fully durable).
 *
 * If the session can't be found (stale click — a 1s-poll race) the call throws
 * a `SessionNotFoundError` WITHOUT persisting, so the renderer can refresh.
 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class TimelineService {
  private readonly engine = new TimelineEngine();

  constructor(
    private readonly sessionService: SessionService,
    private readonly edits: IEditRepository,
  ) {}

  /** Verified timeline for today. */
  getToday(): VerifiedSession[] {
    return this.applyEngine(this.sessionService.getToday());
  }

  getByRange(from: string, to: string): VerifiedSession[] {
    return this.applyEngine(this.sessionService.getByRange(from, to));
  }

  getAll(limit?: number): VerifiedSession[] {
    return this.applyEngine(this.sessionService.getAll(limit));
  }

  /**
   * Append a new user edit. The payload may be a *hint* (renderer convenience)
   * or a fully-durable payload (from tests). `resolveHint()` translates hints
   * into durable event-id payloads before persisting. Returns the new row id.
   * Throws `SessionNotFoundError` if the hint targets a session that no longer
   * exists (caller should refresh).
   */
  apply(operation: TimelineOperation, payload: unknown): number {
    const durable = this.resolveHint(operation, payload);
    return this.edits.insert(operation, durable);
  }

  undo(): boolean {
    const lastActive = this.findActiveTail();
    if (!lastActive) return false;
    this.edits.setUndone(lastActive.id, new Date().toISOString());
    return true;
  }

  redo(): boolean {
    const lastUndone = this.findUndoneTail();
    if (!lastUndone) return false;
    this.edits.setUndone(lastUndone.id, null);
    return true;
  }

  activeEditCount(): number {
    return this.edits.list().filter((e) => e.undoneAt === null).length;
  }

  // ── hint resolution ─────────────────────────────────────────────────────────

  /**
   * Translate a renderer *hint* into a durable event-id payload. If the payload
   * is already durable (has event-id fields, not `sessionIdHint`) it passes
   * through unchanged — tests and future direct callers may supply durable
   * payloads to avoid a `getToday` round-trip.
   */
  private resolveHint(operation: TimelineOperation, payload: unknown): unknown {
    if (operation === 'create_offline') return payload; // passthrough, fully durable

    const p = payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return payload;

    // Already durable? (has the typed event-id field, no sessionIdHint) → passthrough.
    if (!('sessionIdHint' in p)) return payload;

    const sessionId = p.sessionIdHint as string;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new SessionNotFoundError(String(p.sessionIdHint));
    }

    // Fetch the current verified timeline to resolve the hint.
    const sessions = this.getToday();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || session.events.length === 0) {
      throw new SessionNotFoundError(sessionId);
    }

    switch (operation) {
      case 'rename': {
        const rp: RenamePayload = {
          anchorEventId: session.events[0].id,
          newTitle: p.newTitle as string,
        };
        return rp;
      }
      case 'split': {
        const idx = Math.min(
          Math.max(0, (p.afterEventIndex as number) ?? 0),
          session.events.length - 1,
        );
        const sp: SplitPayload = { afterEventId: session.events[idx].id };
        return sp;
      }
      case 'delete': {
        const dp: DeletePayload = {
          eventIds: session.events.map((e) => e.id),
        };
        return dp;
      }
      case 'merge': {
        const nextIdx = sessions.indexOf(session) + 1;
        const next = sessions[nextIdx] ?? null;
        if (!next || next.events.length === 0) {
          throw new SessionNotFoundError(`${sessionId} (no adjacent session to merge)`);
        }
        const mp: MergePayload = {
          boundaryFromEventId: session.events[session.events.length - 1].id,
          boundaryToEventId: next.events[0].id,
        };
        return mp;
      }
      default:
        return payload;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyEngine(sessions: import('../session/Session.js').Session[]): VerifiedSession[] {
    return this.engine.applyEdits(sessions, this.edits.list());
  }

  private findActiveTail(): TimelineEdit | null {
    const all = this.edits.list();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].undoneAt === null) return all[i];
    }
    return null;
  }

  private findUndoneTail(): TimelineEdit | null {
    const all = this.edits.list();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].undoneAt !== null) return all[i];
    }
    return null;
  }
}