import { createHash } from 'node:crypto';
import type { RuleCondition, RuleConditionType, SessionLike } from '../categorization/Classification.js';
import {
  getDomain,
  matchConditions,
  normalizeAppName,
  normalizeCondition,
} from '../categorization/ClassificationRules.js';
import type { Event } from '../models/Event.js';
import type { Session } from '../session/Session.js';
import { computeStatistics } from '../session/SessionStatistics.js';
import {
  SUPPORTED_CONDITION_TYPES,
  type ClassificationIds,
  type ClassificationNames,
  type LearningActivity,
} from './LearnedRuleModels.js';

/**
 * Pattern identity. Pure and deterministic.
 *
 * A pattern is a set of rule conditions. Two patterns are the same pattern
 * when the deterministic matcher cannot tell them apart, so normalisation
 * follows the matcher's own semantics: values compare case-insensitively,
 * application names go through the alias table, domains lose `www.`.
 */

const TYPE_ORDER = new Map<string, number>(SUPPORTED_CONDITION_TYPES.map((type, index) => [type, index]));

export function isSupportedConditionType(type: string): type is RuleConditionType {
  return TYPE_ORDER.has(type);
}

/** The form of a value the matcher effectively compares. */
function matchKey(type: string, value: string): string {
  if (type === 'app_equals') return normalizeAppName(value);
  return value.trim().toLowerCase();
}

/** The form of a value that is stored and shown. */
function displayValue(type: string, value: string): string {
  const trimmed = value.trim();
  // The matcher compares against a bare host name, so store exactly that.
  if (type === 'domain_equals') return trimmed ? getDomain(trimmed).toLowerCase() : '';
  return trimmed;
}

/**
 * Trim, drop empties and unsupported types, deduplicate, and order
 * deterministically. Condition order in the input never matters.
 */
export function normalizeConditions(conditions: RuleCondition[]): RuleCondition[] {
  const byKey = new Map<string, RuleCondition>();
  for (const raw of conditions) {
    if (!raw || typeof raw.type !== 'string' || typeof raw.value !== 'string') continue;
    const { type } = normalizeCondition(raw);
    if (!isSupportedConditionType(type)) continue;
    const value = displayValue(type, raw.value);
    if (!value) continue;
    const key = `${type}:${matchKey(type, value)}`;
    if (!byKey.has(key)) byKey.set(key, { type, value });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => {
      const typeA = TYPE_ORDER.get(a.slice(0, a.indexOf(':'))) ?? 0;
      const typeB = TYPE_ORDER.get(b.slice(0, b.indexOf(':'))) ?? 0;
      if (typeA !== typeB) return typeA - typeB;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([, condition]) => condition);
}

/** Canonical keys of a pattern, sorted. The basis of hashing and comparison. */
export function conditionKeys(conditions: RuleCondition[]): string[] {
  return normalizeConditions(conditions).map((c) => `${c.type}:${matchKey(c.type, c.value)}`);
}

/**
 * Stable identity of a pattern. Depends only on the normalised conditions —
 * never on timestamps, event/session ids, or generated prose.
 */
export function patternHash(conditions: RuleCondition[]): string {
  return sha256(conditionKeys(conditions).join('\n'));
}

export function classificationHash(c: ClassificationIds): string {
  return sha256(JSON.stringify([c.contextId ?? null, c.areaId ?? null, c.intentId ?? null, c.qualityId ?? null]));
}

export function sameClassification(a: ClassificationIds, b: ClassificationIds): boolean {
  return (
    (a.contextId ?? null) === (b.contextId ?? null) &&
    (a.areaId ?? null) === (b.areaId ?? null) &&
    (a.intentId ?? null) === (b.intentId ?? null) &&
    (a.qualityId ?? null) === (b.qualityId ?? null)
  );
}

export function hasAnyClassification(c: ClassificationIds): boolean {
  return Boolean(c.contextId || c.areaId || c.intentId || c.qualityId);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Descriptions (grounded in the conditions, never in prose from a model) ──

/** `VS Code + “GameTheory”`, `coursera.org + “Operating Systems”`. */
export function describePattern(conditions: RuleCondition[]): string {
  return normalizeConditions(conditions)
    .map((c) => {
      switch (c.type) {
        case 'title_contains':
          return `“${c.value}”`;
        case 'url_starts_with':
          return `${c.value}…`;
        default:
          return c.value;
      }
    })
    .join(' + ');
}

/** `Personal · Create · Focused` — Context first when there is one. */
export function describeClassification(names: ClassificationNames): string {
  return [names.context, names.area, names.intent, names.quality].filter(Boolean).join(' · ');
}

/** `Seen 8 times across 4 days`. */
export function describeEvidence(occurrenceCount: number, distinctDayCount: number): string {
  const times = occurrenceCount === 1 ? 'once' : `${occurrenceCount} times`;
  const days = distinctDayCount === 1 ? '1 day' : `${distinctDayCount} days`;
  return `Seen ${times} across ${days}`;
}

// ── Matching ────────────────────────────────────────────────────────────────

export function toSessionLike(activity: LearningActivity): SessionLike {
  return {
    id: activityKey(activity),
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    primaryApp: activity.primaryApp,
    primaryBrowser: activity.primaryBrowser,
    primaryTitle: activity.primaryTitle,
    primaryUrl: activity.primaryUrl,
    appsUsed: activity.appsUsed,
    browserTabs: activity.browserTabs,
    events: activity.eventIds.map((id) => ({ id })),
  };
}

/** Whether the existing deterministic matcher accepts this activity. */
export function patternMatches(activity: LearningActivity, conditions: RuleCondition[]): boolean {
  return matchConditions(toSessionLike(activity), conditions);
}

/** Idempotency key of an activity: its AI activity id, else its first event. */
export function activityKey(activity: Pick<LearningActivity, 'aiActivityId' | 'eventIds'>): string {
  if (activity.aiActivityId) return `ai:${activity.aiActivityId}`;
  return `ev:${activity.eventIds.length > 0 ? Math.min(...activity.eventIds) : 'none'}`;
}

/** Local calendar day (`YYYY-MM-DD`) of an instant. */
export function localDay(iso: string | Date): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Derive an activity from raw events with the same statistics the timeline
 * uses, so "primary title" means the same thing here as it does to the rule
 * engine.
 */
export function activityFromEvents(
  events: Event[],
  aiActivityId: string | null,
  classification: ClassificationIds,
  classificationSource: string | null,
): LearningActivity | null {
  if (events.length === 0) return null;
  const ordered = [...events].sort((a, b) => {
    const d = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return d !== 0 ? d : a.id - b.id;
  });
  const session: Session = computeStatistics({
    id: 'learning',
    startedAt: new Date(0),
    endedAt: new Date(0),
    duration: 0,
    activeDuration: 0,
    events: ordered,
    appsUsed: [],
    browserTabs: [],
    eventCount: ordered.length,
  });
  return {
    aiActivityId,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt.toISOString(),
    activeDurationMs: session.activeDuration,
    primaryApp: session.primaryApp,
    primaryBrowser: session.primaryBrowser,
    primaryTitle: session.primaryTitle,
    primaryUrl: session.primaryUrl,
    appsUsed: session.appsUsed,
    browserTabs: session.browserTabs,
    eventIds: ordered.map((e) => e.id),
    classificationSource,
    classification,
  };
}
