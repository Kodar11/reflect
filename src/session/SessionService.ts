import type { IEventRepository } from '../database/EventRepository.js';
import type { Event } from '../models/Event.js';
import type { Session, SessionConfig } from './Session.js';
import { DEFAULT_SESSION_CONFIG } from './Session.js';
import { SessionEngine } from './SessionEngine.js';
import type { SessionRule } from './SessionRules.js';

/**
 * `SessionService` is the impure seam between the persisted raw events and the
 * pure session engine. It owns:
 *   - the `IEventRepository` (injected, so tests swap a fake),
 *   - the active `SessionConfig` (defaults today; later stages read from
 *     settings / user edits),
 *   - the rule chain (defaults today; later stages substitute an extended one
 *     WITHOUT touching the engine or builder).
 *
 * The UI never builds sessions directly — it asks this service. Like the
 * tracker service, it exposes "today" and "by range" reads. Sessions exist
 * only in memory; nothing is written to SQLite.
 */
export class SessionService {
  private readonly engine: SessionEngine;
  private config: SessionConfig;

  constructor(
    private readonly repo: IEventRepository,
    rules?: SessionRule[],
    config: SessionConfig = DEFAULT_SESSION_CONFIG,
  ) {
    this.engine = new SessionEngine(rules);
    this.config = config;
  }

  /** Update config (e.g. thresholds split). Unsafe for already-handed-out
   * Session objects — UI re-queries after a config change. */
  setConfig(config: SessionConfig): void {
    this.config = config;
  }

  /** Sessions for the current local day. */
  getToday(): Session[] {
    return this.derive(this.repo.getToday());
  }

  /** Sessions whose events start inside [from, to) (ISO strings). */
  getByRange(from: string, to: string): Session[] {
    return this.derive(this.repo.getByRange(from, to));
  }

  /** Sessions over the entire stored history (newest-first events). */
  getAll(limit?: number): Session[] {
    return this.derive(this.repo.getAll(limit));
  }

  private derive(events: Event[]): Session[] {
    return this.engine.buildSessions(events, this.config);
  }
}