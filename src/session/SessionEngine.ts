import type { Event } from '../models/Event.js';
import type { Session, SessionConfig } from './Session.js';
import { SessionBuilder } from './SessionBuilder.js';
import { DEFAULT_RULES, SessionRule } from './SessionRules.js';

/**
 * Deterministic façade over the session pipeline.
 *
 *   Event[] + SessionConfig  ──►  Session[]
 *
 * The engine holds **no state** and introduces no non-determinism: given the
 * same events and config, it always returns the same sessions. The factor
 * here is composition (builder + rules + statistics), and the constructor
 * accepts injected rules so a future stage can substitute an extended chain.
 *
 * Pure module: no React, no SQLite, no Electron, no Date.now / Math.random.
 */
export class SessionEngine {
  private readonly builder: SessionBuilder;

  constructor(rules: SessionRule[] = DEFAULT_RULES) {
    this.builder = new SessionBuilder(rules);
  }

  buildSessions(events: Event[], config: SessionConfig): Session[] {
    return this.builder.build(events, config);
  }
}