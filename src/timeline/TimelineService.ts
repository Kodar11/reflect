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

  private applyEngine(sessions: import('../session/Session.js').Session[]): VerifiedSession[] {
    const verified = this.engine.applyEdits(sessions, this.edits.list());
    return this.applyActivityRules(verified);
  }

  private applyActivityRules(sessions: VerifiedSession[]): VerifiedSession[] {
    if (!this.activityRuleRepo) return sessions;
    try {
      const activities = this.activityRuleRepo.listActivities();
      const rules = this.activityRuleRepo.listRules().filter((r) => r.enabled === 1);

      const parsedRules = rules
        .map((r) => {
          try {
            return {
              id: r.id,
              activityId: r.activityId,
              conditions: JSON.parse(r.conditions) as { type: string; value: string }[],
            };
          } catch {
            return null;
          }
        })
        .filter((r) => r !== null) as { id: string; activityId: string; conditions: { type: string; value: string }[] }[];

      return sessions.map((s) => {
        // If s has a manual override, apply it
        if (s.activityId) {
          const act = activities.find((a) => a.id === s.activityId);
          if (act) {
            (s as any).activity = act;
          }
          return s;
        }

        // Match against tracking rules
        for (const rule of parsedRules) {
          if (matchesRule(s, rule.conditions)) {
            const act = activities.find((a) => a.id === rule.activityId);
            if (act) {
              (s as any).activity = act;
              (s as any).activityRuleId = rule.id;
              break;
            }
          }
        }

        return s;
      });
    } catch (e) {
      console.error('[TimelineService] applyActivityRules error', e);
      return sessions;
    }
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

interface RuleCondition {
  type: string;
  value: string;
}

function matchesRule(s: VerifiedSession, conditions: RuleCondition[]): boolean {
  if (conditions.length === 0) return false;
  return conditions.every((c) => {
    const val = c.value.toLowerCase().trim();
    switch (c.type) {
      case 'app_equals': {
        const app = (s.primaryApp ?? '').toLowerCase().trim();
        const apps = (s.appsUsed ?? []).map((x) => x.toLowerCase().trim());
        return app === val || apps.includes(val);
      }
      case 'title_contains': {
        const title = (s.primaryTitle ?? '').toLowerCase();
        return title.includes(val);
      }
      case 'url_contains': {
        const url = (s.primaryUrl ?? '').toLowerCase();
        const tabs = (s.browserTabs ?? []).map((x) => x.toLowerCase());
        return url.includes(val) || tabs.some((t) => t.includes(val));
      }
      case 'url_starts_with': {
        const url = (s.primaryUrl ?? '').toLowerCase();
        const tabs = (s.browserTabs ?? []).map((x) => x.toLowerCase());
        return url.startsWith(val) || tabs.some((t) => t.startsWith(val));
      }
      case 'domain_equals': {
        const getDomain = (rawUrl: string) => {
          try {
            let host = rawUrl;
            if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
            const u = new URL(host);
            return u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
          } catch {
            const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
            return (match && match[1]) ? match[1] : rawUrl;
          }
        };
        const domain = getDomain(s.primaryUrl ?? '').toLowerCase();
        const tabDomains = (s.browserTabs ?? []).map((t) => getDomain(t).toLowerCase());
        return domain === val || tabDomains.includes(val);
      }
      default:
        return false;
    }
  });
}

function sortedKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}