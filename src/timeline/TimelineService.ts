import type { IEditRepository } from '../database/EditRepository.js';
import type { TimelineEdit, TimelineOperation, VerifiedSession } from './TimelineModels.js';
import type {
  RenamePayload,
  SplitPayload,
  MergePayload,
  DeletePayload,
  CreateOfflinePayload,
  OverrideEnvelopePayload,
  DuplicatePayload,
  NotePayload,
  MarkOfflinePayload,
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
 * merge / delete / create_offline / override_envelope / duplicate / note /
 * mark_offline) goes through `apply(operation, payload)`, which resolves
 * renderer hints into durable event-id payloads before persisting a new
 * append row. Undo/redo flip the `undone_at` flag of the appropriate row(s);
 * because the engine skips undone rows, the verified timeline updates
 * deterministically on the next read.
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
   * Append a new user edit. Payload may be a renderer *hint* or a fully-durable
   * payload. `resolveHint()` translates hints into durable event-id payloads
   * before persisting. Throws `SessionNotFoundError` if the hint targets a
   * session that no longer exists (caller should refresh).
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

  private resolveHint(operation: TimelineOperation, payload: unknown): unknown {
    // create_offline is fully durable and needs no event ids.
    if (operation === 'create_offline') return payload;

    const p = payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return payload;

    // Fully durable payload (no hint fields) → passthrough.
    if (!('sessionIdHint' in p) && !('eventIdsHint' in p)) return payload;

    const sessions = this.getToday();
    const session = this.findSessionFromHint(sessions, p);
    if (!session || session.events.length === 0) {
      throw new SessionNotFoundError(String(p.sessionIdHint ?? p.eventIdsHint ?? 'unknown'));
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
          throw new SessionNotFoundError(`${session.id} (no adjacent session to merge)`);
        }
        const mp: MergePayload = {
          boundaryFromEventId: session.events[session.events.length - 1].id,
          boundaryToEventId: next.events[0].id,
        };
        return mp;
      }
      case 'override_envelope': {
        const op: OverrideEnvelopePayload = {
          eventIds: session.events.map((e) => e.id),
          newStartedAt: p.newStartedAt as string,
          newEndedAt: p.newEndedAt as string,
        };
        return op;
      }
      case 'duplicate': {
        const dp: DuplicatePayload = {
          eventIds: session.events.map((e) => e.id),
          offsetMinutes: p.offsetMinutes as number | undefined,
        };
        return dp;
      }
      case 'note': {
        const np: NotePayload = {
          eventIds: session.events.map((e) => e.id),
          note: p.note as string,
        };
        return np;
      }
      case 'mark_offline': {
        const mp: MarkOfflinePayload = {
          eventIds: session.events.map((e) => e.id),
          offline: p.offline as boolean,
        };
        return mp;
      }
      default:
        return payload;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private findSessionFromHint(sessions: VerifiedSession[], p: Record<string, unknown>): VerifiedSession | undefined {
    // Prefer durable event-id hints over regenerated session ids.
    const eventIdsHint = p.eventIdsHint;
    if (Array.isArray(eventIdsHint) && eventIdsHint.every((n) => typeof n === 'number')) {
      const want = sortedKey(eventIdsHint as number[]);
      return sessions.find((s) => sortedKey(s.events.map((e) => e.id)) === want);
    }

    const sessionId = p.sessionIdHint;
    if (typeof sessionId === 'string' && sessionId) {
      return sessions.find((s) => s.id === sessionId);
    }

    return undefined;
  }

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

function sortedKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}