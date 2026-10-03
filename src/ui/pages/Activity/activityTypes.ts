/**
 * Shared UI types for the Activity page.
 * These are renderer-facing DTOs/helpers, not backend domain types.
 */

export interface TrackerEventDto {
  id: number;
  watcher: string;
  app: string | null;
  browser: string | null;
  title: string | null;
  url: string | null;
  startedAt: string;
  endedAt: string;
  createdAt?: string | null;
}

export interface UsageRow {
  key: string;
  name: string;
  type: 'App' | 'Website';
  totalTime: number;
  sessionCount: number;
  lastUsed: Date;
  latestActivity: string;
  intervals: { startedAt: Date; endedAt: Date }[];
}

export interface ActivityDto {
  id: string;
  name: string;
  color: string;
}

export interface DimensionDto {
  id: string;
  dimension: 'area' | 'intent' | 'quality';
  name: string;
  sortOrder: number;
}

export interface RuleDto {
  id: string;
  activityId: string;
  conditions: string;
  enabled: number;
  priority: number;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  /** Provenance of the rule. One rules list; this is only a label. */
  source?: 'system' | 'user' | 'learned';
  /** Present on learned rules only. */
  learned?: {
    candidateId: string | null;
    confirmedAt: string | null;
    userModifiedAt: string | null;
    correctionCount: number;
    matchCount: number;
    distinctDayCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  } | null;
}

export interface RuleConditionDto {
  type: string;
  value: string;
}

export interface RuleEditorState {
  id: string;
  activityId: string;
  name: string;
  color: string;
  conditions: RuleConditionDto[];
  enabled: boolean;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  priority: number;
}

export interface EventClassificationEdit {
  contextId: string | null;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
}
