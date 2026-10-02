import type { IEditRepository } from '../database/EditRepository.js';
import type { TimelineEdit, TimelineOperation, VerifiedSession, AssignActivityPayload } from './TimelineModels.js';
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
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import type { CategorizationService } from '../categorization/CategorizationService.js';
import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';
import { referencedEventIds } from './TimelineEdits.js';

/**
 * Seam to the intelligence layer. The timeline stays in charge of the
 * pipeline; the source only (a) swaps AI-covered events for AI activities and
 * (b) is told which events the user edited so later AI runs respect them.
 */
export interface AiTimelineSource {
  /** AI activities where they exist, deterministic sessions everywhere else. */
  compose(deterministic: Session[], resessionize: (events: Event[]) => Session[]): Session[];
  /** Mark AI activities owning any of these events as user-edited. */
  lockActivitiesForEvents(eventIds: number[]): void;
}

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
    private readonly activityRuleRepo?: ActivityRuleRepository,
    private readonly categorizationService?: CategorizationService,
    private readonly aiSource?: AiTimelineSource,
  ) {}

  /** Verified timeline for today. */
  getToday(): VerifiedSession[] {
    return this.applyEngine(this.generated(this.sessionService.getToday()));
  }

  getByRange(from: string, to: string): VerifiedSession[] {
    return this.applyEngine(this.generated(this.sessionService.getByRange(from, to)));
  }

  getAll(limit?: number): VerifiedSession[] {
    return this.applyEngine(this.generated(this.sessionService.getAll(limit)));
  }

  /**
   * Event ids of every generated block (AI or deterministic) around
   * [from, to] that an active timeline edit or a manual classification
   * override refers to. The intelligence layer treats these as user-owned:
   * a later AI run never re-assigns them.
   */
  getUserEditedEventIds(from: string, to: string): number[] {
    const referenced = new Set<number>();
    for (const edit of this.edits.list()) {
      if (edit.undoneAt !== null) continue;
      for (const id of referencedEventIds(edit.payload)) referenced.add(id);
    }
    for (const override of this.categorizationService?.listOverrides() ?? []) {
      for (const id of override.eventIds) referenced.add(id);
      if (override.anchorEventId !== null) referenced.add(override.anchorEventId);
    }
    if (referenced.size === 0) return [];

    // Whole local days, so blocks are derived the same way the timeline shows them.
    const dayStart = new Date(from);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(to);
    dayEnd.setHours(24, 0, 0, 0);

    const blocks = this.generated(this.sessionService.getByRange(dayStart.toISOString(), dayEnd.toISOString()));
    const edited: number[] = [];
    for (const block of blocks) {
      if (block.events.some((e) => referenced.has(e.id))) {
        for (const e of block.events) edited.push(e.id);
      }
    }
    return edited;
  }

  /**
   * Append a new user edit. Payload may be a renderer *hint* or a fully-durable
   * payload. `resolveHint()` translates hints into durable event-id payloads
   * before persisting. Throws `SessionNotFoundError` if the hint targets a
   * session that no longer exists (caller should refresh).
   */
  apply(operation: TimelineOperation, payload: unknown): number {
    const durable = this.resolveHint(operation, payload);
    const editId = this.edits.insert(operation, durable);
    // USER EDIT > AI: an AI activity the user edited is never rewritten by a
    // later analysis. Non-critical — the edit itself is already persisted.
    try {
      this.aiSource?.lockActivitiesForEvents(referencedEventIds(durable));
    } catch (e) {
      console.error('[TimelineService] could not lock AI activities for edit', e);
    }
    return editId;
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
      case 'assign_activity': {
        const ap: AssignActivityPayload = {
          eventIds: session.events.map((e) => e.id),
          activityId: p.activityId as string | null,
        };
        return ap;
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

  /** Generated sessions = AI activities + deterministic fallback. If the
   * intelligence layer is absent or fails, the deterministic sessions are
   * used as-is. */
  private generated(deterministic: Session[]): Session[] {
    if (!this.aiSource) return deterministic;
    try {
      return this.aiSource.compose(deterministic, (events) => this.sessionService.deriveFrom(events));
    } catch (e) {
      console.error('[TimelineService] AI timeline composition failed; using deterministic sessions', e);
      return deterministic;
    }
  }

  private applyEngine(sessions: Session[]): VerifiedSession[] {
    const verified = this.engine.applyEdits(sessions, this.edits.list());
    this.categorizationService?.classifySessions(verified);
    return verified;
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