/**
 * Categorization & Rules Engine — domain types.
 *
 * The classification model uses four independent dimensions:
 *   Context  — the specific project/domain (user-defined, stored as `activities`)
 *   Area     — broad life/work area (Work, Learning, Personal, Leisure)
 *   Intent   — what the user is doing (Create, Learn, Research, etc.)
 *   quality    — nature of engagement (Deep, Focused, Routine, Distracting, Break)
 *
 * These types are pure: no React, SQLite, Electron, Date.now, or Math.random.
 * Same inputs always yield the same outputs.
 */

/** A single dimension value (Area, Intent, or quality). */
export interface DimensionEntry {
  id: string;
  dimension: 'area' | 'intent' | 'quality';
  name: string;
  sortOrder: number;
}

/** A resolved dimension value in a Classification result. */
export interface DimensionValue {
  id: string | null;
  name: string;
  color?: string | null;
}

/** A context (= an Activity from the existing `activities` table). */
export interface ContextEntry {
  id: string;
  name: string;
  color: string;
}

/** Supported rule condition types. */
export type RuleConditionType =
  | 'app_equals'
  | 'browser_equals'
  | 'title_contains'
  | 'url_contains'
  | 'url_starts_with'
  | 'domain_equals';

/** A single declarative match condition on a rule. */
export interface RuleCondition {
  type: RuleConditionType | string;
  value: string;
}

/** A categorization rule: conditions → classification dimensions. */
export interface CategorizationRule {
  id: string;
  conditions: RuleCondition[];
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  priority: number;
  enabled: boolean;
}

/** A durable historical override keyed by event ids and an anchor event. */
export interface CategorizationOverride {
  id: string;
  eventIds: number[];
  /** Stable anchor: the first event id at the time of correction.
   *  Used to re-attach the override after timeline merge/split edits. */
  anchorEventId: number | null;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: string;
  ruleId: string | null;
}

/** The source of an event-level classification. */
export type EventClassificationSource =
  | 'user_override'
  | 'user_rule'
  | 'default'
  | 'unclassified';

/** A classification attached to a single raw event (not a session/timeline). */
export interface EventClassification {
  eventId: number;
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  source: EventClassificationSource;
  ruleId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Focus session as a context signal (does NOT force Area/Intent/quality). */
export interface FocusContextSignal {
  task: string;
  profileName: string;
  sessionStartedAt: string;
  sessionEndedAt: string;
}

/** The source of a classification — drives explainability. */
export type ClassificationSource =
  | 'user_override'
  | 'user_rule'
  | 'focus_context'
  | 'unclassified';

/** The full classification result attached to a session. */
export interface Classification {
  context: DimensionValue | null;
  area: DimensionValue | null;
  intent: DimensionValue | null;
  quality: DimensionValue | null;
  source: ClassificationSource;
  /** Human-readable explanation, e.g. "Rule: VS Code + Planmay". */
  reason: string;
  matchedRuleId: string | null;
  /** Human-readable summary of matched conditions, e.g. "app=VS Code, title~Planmay". */
  matchedConditions: string | null;
  isOverride: boolean;
}

/** The minimal session shape the engine needs to classify. */
export interface SessionLike {
  id: string;
  startedAt: Date | string;
  endedAt: Date | string;
  primaryApp?: string;
  primaryBrowser?: string;
  primaryTitle?: string;
  primaryUrl?: string;
  appsUsed: string[];
  browserTabs: string[];
  events: { id: number }[];
}

/** Input for classifying a single session. */
export interface ClassificationInput {
  session: SessionLike;
  rules: CategorizationRule[];
  overrides: CategorizationOverride[];
  contexts: ContextEntry[];
  dimensions: DimensionEntry[];
  focusSignals: FocusContextSignal[];
}

/** The unclassified sentinel. */
export const UNCLASSIFIED: Classification = {
  context: null,
  area: null,
  intent: null,
  quality: null,
  source: 'unclassified',
  reason: 'No matching rule',
  matchedRuleId: null,
  matchedConditions: null,
  isOverride: false,
};
