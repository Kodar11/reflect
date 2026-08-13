import type {
  CategorizationOverride,
  CategorizationRule,
  Classification,
  ClassificationInput,
  ContextEntry,
  DimensionEntry,
  DimensionValue,
  FocusContextSignal,
  SessionLike,
} from './Classification.js';
import { UNCLASSIFIED } from './Classification.js';
import { matchConditions, normalizeRuleConditions, sortRules, summarizeConditions } from './ClassificationRules.js';

/**
 * `ClassificationEngine` is the pure, deterministic classification layer.
 *
 * It takes a session + rules + overrides + focus signals + dimension
 * dictionaries and produces a `Classification` result. No React, SQLite,
 * Electron, Date.now, or Math.random. Same inputs → same output, always.
 *
 * Precedence (highest to lowest):
 *   1. USER OVERRIDE  — durable per-session correction keyed by event ids
 *   2. USER RULE      — declarative rules, ordered by priority → specificity → id
 *   3. FOCUS CONTEXT  — overlapping focus session provides context only
 *   4. UNCLASSIFIED   — all dimensions null
 */
export class ClassificationEngine {
  classify(input: ClassificationInput): Classification {
    const { session, rules, overrides, contexts, dimensions, focusSignals } = input;

    // 1. User override — always wins.
    const override = this.findOverride(session, overrides);
    if (override) {
      return this.buildFromOverride(override, contexts, dimensions);
    }

    // 2. User rules — ordered by priority → specificity → id.
    const sortedRules = sortRules(rules.filter((r) => r.enabled).map(normalizeRuleConditions));
    for (const rule of sortedRules) {
      if (matchConditions(session, rule.conditions)) {
        return this.buildFromRule(rule, contexts, dimensions);
      }
    }

    // 3. Focus context — overlapping focus session provides context only.
    const focusSignal = this.findFocusSignal(session, focusSignals);
    if (focusSignal) {
      return this.buildFromFocus(focusSignal, contexts);
    }

    // 4. Unclassified.
    return UNCLASSIFIED;
  }

  /**
   * Classify a batch of sessions. Returns a Map keyed by session id.
   * Each session is classified independently and deterministically.
   */
  classifyAll(
    sessions: SessionLike[],
    rules: CategorizationRule[],
    overrides: CategorizationOverride[],
    contexts: ContextEntry[],
    dimensions: DimensionEntry[],
    focusSignals: FocusContextSignal[],
  ): Map<string, Classification> {
    const result = new Map<string, Classification>();
    for (const session of sessions) {
      const input: ClassificationInput = {
        session,
        rules,
        overrides,
        contexts,
        dimensions,
        focusSignals,
      };
      result.set(session.id, this.classify(input));
    }
    return result;
  }

  // ── Override lookup ──────────────────────────────────────────────────────

  private findOverride(
    session: SessionLike,
    overrides: CategorizationOverride[],
  ): CategorizationOverride | null {
    if (session.events.length === 0) return null;
    const want = sortedKey(session.events.map((e) => e.id));
    const sessionEventIds = new Set(session.events.map((e) => e.id));

    for (const o of overrides) {
      // Exact event-set match (original behavior).
      if (sortedKey(o.eventIds) === want) return o;
      // Anchor fallback: override survives timeline edits as long as one
      // original event remains in the session.
      if (o.anchorEventId !== null && sessionEventIds.has(o.anchorEventId)) return o;
    }
    return null;
  }

  private buildFromOverride(
    override: CategorizationOverride,
    contexts: ContextEntry[],
    dimensions: DimensionEntry[],
  ): Classification {
    return {
      context: resolveDimension(override.contextId, contexts, 'context'),
      area: resolveDimension(override.areaId, dimensions, 'area'),
      intent: resolveDimension(override.intentId, dimensions, 'intent'),
      quality: resolveDimension(override.qualityId, dimensions, 'quality'),
      source: 'user_override',
      reason: 'Manually classified',
      matchedRuleId: override.ruleId,
      matchedConditions: null,
      isOverride: true,
    };
  }

  // ── Rule classification ──────────────────────────────────────────────────

  private buildFromRule(
    rule: CategorizationRule,
    contexts: ContextEntry[],
    dimensions: DimensionEntry[],
  ): Classification {
    const condSummary = summarizeConditions(rule.conditions);
    const ctxName = rule.contextId ? contexts.find((c) => c.id === rule.contextId)?.name ?? '' : '';
    const areaName = rule.areaId ? dimensions.find((d) => d.id === rule.areaId)?.name ?? '' : '';
    const intentName = rule.intentId ? dimensions.find((d) => d.id === rule.intentId)?.name ?? '' : '';
    const qualityName = rule.qualityId ? dimensions.find((d) => d.id === rule.qualityId)?.name ?? '' : '';
    const parts = [ctxName, areaName, intentName, qualityName].filter(Boolean).join(' · ');
    return {
      context: resolveDimension(rule.contextId, contexts, 'context'),
      area: resolveDimension(rule.areaId, dimensions, 'area'),
      intent: resolveDimension(rule.intentId, dimensions, 'intent'),
      quality: resolveDimension(rule.qualityId, dimensions, 'quality'),
      source: 'user_rule',
      reason: `Rule: ${condSummary} → ${parts}`,
      matchedRuleId: rule.id,
      matchedConditions: condSummary,
      isOverride: false,
    };
  }

  // ── Focus context ────────────────────────────────────────────────────────

  private findFocusSignal(
    session: SessionLike,
    focusSignals: FocusContextSignal[],
  ): FocusContextSignal | null {
    const sessionStart = new Date(session.startedAt).getTime();
    const sessionEnd = new Date(session.endedAt).getTime();
    for (const signal of focusSignals) {
      const focusStart = new Date(signal.sessionStartedAt).getTime();
      const focusEnd = new Date(signal.sessionEndedAt).getTime();
      const overlap = Math.min(sessionEnd, focusEnd) - Math.max(sessionStart, focusStart);
      if (overlap > 0) return signal;
    }
    return null;
  }

  private buildFromFocus(
    signal: FocusContextSignal,
    contexts: ContextEntry[],
  ): Classification {
    // Try to match the focus task to an existing context by name.
    const matched = contexts.find(
      (c) => c.name.toLowerCase() === signal.task.toLowerCase(),
    );
    const context: DimensionValue | null = matched
      ? { id: matched.id, name: matched.name, color: matched.color }
      : { id: null, name: signal.task, color: null };
    return {
      context,
      area: null,
      intent: null,
      quality: null,
      source: 'focus_context',
      reason: `Focus session: ${signal.task}`,
      matchedRuleId: null,
      matchedConditions: null,
      isOverride: false,
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function resolveDimension(
  id: string | null | undefined,
  pool: ContextEntry[] | DimensionEntry[],
  kind: 'context' | 'area' | 'intent' | 'quality',
): DimensionValue | null {
  if (!id) return null;
  if (kind === 'context') {
    const ctx = (pool as ContextEntry[]).find((c) => c.id === id);
    return ctx ? { id: ctx.id, name: ctx.name, color: ctx.color } : null;
  }
  const dim = (pool as DimensionEntry[]).find((d) => d.id === id);
  return dim ? { id: dim.id, name: dim.name } : null;
}

function sortedKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}
