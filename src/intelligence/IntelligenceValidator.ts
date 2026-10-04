import { z } from 'zod';
import type { AllowedTaxonomy, EvidenceItem, ValidatedActivity } from './IntelligenceModels.js';
import { INTELLIGENCE_SCHEMA_VERSION } from './IntelligenceModels.js';

/**
 * Runtime validation of the model's structured output. Pure.
 *
 * Nothing the model returns is trusted: shape, event ids, ownership,
 * timestamps, classification ids and continuation ids are all checked against
 * what Reflect actually sent. A result either passes whole or is rejected
 * whole — there is no partial acceptance.
 *
 * What is deliberately NOT checked is contiguity or listing order: an activity
 * is a task, and a task the user left and returned to owns events on both
 * sides of whatever interrupted it.
 */

/** Model timestamps may drift slightly from the clipped evidence bounds. */
const WINDOW_TOLERANCE_MS = 60_000;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 400;
const MAX_UNCERTAINTY_NOTES = 5;
const MAX_UNCERTAINTY_LENGTH = 200;

/** "" is how some responses spell "no value"; treat it as null. */
const nullableId = z.preprocess(
  (v) => (v === undefined || v === '' ? null : v),
  z.string().nullable(),
);

const activitySchema = z.object({
  temporaryId: z.string().min(1),
  continuationOfActivityId: nullableId,
  startedAt: z.string(),
  endedAt: z.string(),
  title: z.string().trim().min(1),
  summary: z.string().nullish(),
  eventIds: z.array(z.number().int()).min(1),
  contextId: nullableId,
  areaId: nullableId,
  intentId: nullableId,
  qualityId: nullableId,
  confidence: z.number().min(0).max(1),
  uncertainty: z.array(z.string()).nullish(),
});

const outputSchema = z.object({
  schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
  windowStart: z.string(),
  windowEnd: z.string(),
  activities: z.array(activitySchema),
  unassignedEventIds: z.array(z.number().int()).nullish(),
});

export interface ValidationContext {
  windowStart: string;
  windowEnd: string;
  /** Start of the evidence sent, when lookback context precedes the window. */
  evidenceStart?: string;
  /** The evidence that was sent, in the order it was sent (chronological). */
  evidence: EvidenceItem[];
  taxonomy: AllowedTaxonomy;
  /** Ids of the activities offered for continuation. */
  previousActivityIds: string[];
}

export type ValidationResult =
  | {
      ok: true;
      activities: ValidatedActivity[];
      /** Raw event ids the model explicitly left unassigned or never mentioned. */
      unassignedEventIds: number[];
    }
  | { ok: false; errors: string[] };

export function validateAnalysisOutput(raw: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((i) => `schema: ${i.path.join('.') || '(root)'} — ${i.message}`),
    };
  }

  const output = parsed.data;
  const errors: string[] = [];

  const evidenceIndex = new Map<number, number>();
  /** Position of the evidence block each raw event belongs to. */
  const rawIndex = new Map<number, number>();
  ctx.evidence.forEach((item, index) => {
    evidenceIndex.set(item.id, index);
    for (const id of item.sourceEventIds) rawIndex.set(id, index);
  });

  const contextIds = idSet(ctx.taxonomy.contexts);
  const areaIds = idSet(ctx.taxonomy.areas);
  const intentIds = idSet(ctx.taxonomy.intents);
  const qualityIds = idSet(ctx.taxonomy.qualities);
  const previousIds = new Set(ctx.previousActivityIds);

  const ws = Date.parse(ctx.evidenceStart ?? ctx.windowStart);
  const we = Date.parse(ctx.windowEnd);

  const owner = new Map<number, string>();
  const usedContinuations = new Set<string>();
  const usedTemporaryIds = new Set<string>();

  for (const activity of output.activities) {
    const label = `activity ${activity.temporaryId}`;

    if (usedTemporaryIds.has(activity.temporaryId)) errors.push(`${label}: duplicate temporaryId`);
    usedTemporaryIds.add(activity.temporaryId);

    // Event ids: known, unique within the activity, owned by one activity.
    const seen = new Set<number>();
    for (const id of activity.eventIds) {
      const index = evidenceIndex.get(id);
      if (index === undefined) {
        errors.push(`${label}: unknown event id ${id}`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`${label}: event id ${id} listed more than once`);
        continue;
      }
      seen.add(id);
      const previousOwner = owner.get(id);
      if (previousOwner !== undefined) {
        errors.push(`event id ${id} is assigned to both ${previousOwner} and ${label}`);
        continue;
      }
      owner.set(id, label);
    }

    // Timestamps.
    const start = Date.parse(activity.startedAt);
    const end = Date.parse(activity.endedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      errors.push(`${label}: startedAt/endedAt must be valid ISO timestamps`);
    } else {
      if (start >= end) errors.push(`${label}: startedAt must be before endedAt`);
      if (end > we + WINDOW_TOLERANCE_MS) errors.push(`${label}: endedAt is after the analysis window`);
      // A continued activity legitimately started before the evidence shown.
      if (activity.continuationOfActivityId === null && start < ws - WINDOW_TOLERANCE_MS) {
        errors.push(`${label}: startedAt is before the first event shown`);
      }
    }

    // Classification ids.
    checkId(errors, label, 'contextId', activity.contextId, contextIds);
    checkId(errors, label, 'areaId', activity.areaId, areaIds);
    checkId(errors, label, 'intentId', activity.intentId, intentIds);
    checkId(errors, label, 'qualityId', activity.qualityId, qualityIds);

    // Continuation.
    const continuation = activity.continuationOfActivityId;
    if (continuation !== null) {
      if (!previousIds.has(continuation)) {
        errors.push(`${label}: continuationOfActivityId "${continuation}" is not one of the previous activities`);
      } else if (usedContinuations.has(continuation)) {
        errors.push(`${label}: previous activity "${continuation}" is continued more than once`);
      }
      usedContinuations.add(continuation);
    }
  }

  // Unassigned ids: known and not also assigned.
  for (const id of output.unassignedEventIds ?? []) {
    if (!evidenceIndex.has(id)) errors.push(`unassignedEventIds: unknown event id ${id}`);
    else if (owner.has(id)) errors.push(`event id ${id} is both assigned and unassigned`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const activities: ValidatedActivity[] = output.activities.map((activity) => {
    const items = activity.eventIds
      .map((id) => ctx.evidence[evidenceIndex.get(id)!])
      .sort((a, b) => evidenceIndex.get(a.id)! - evidenceIndex.get(b.id)!);
    return {
      temporaryId: activity.temporaryId,
      continuationOfActivityId: activity.continuationOfActivityId,
      startedAt: new Date(activity.startedAt).toISOString(),
      endedAt: new Date(activity.endedAt).toISOString(),
      title: truncate(activity.title.trim(), MAX_TITLE_LENGTH),
      summary: activity.summary?.trim() ? truncate(activity.summary.trim(), MAX_SUMMARY_LENGTH) : null,
      eventIds: items.flatMap((item) => item.sourceEventIds),
      contextId: activity.contextId,
      areaId: activity.areaId,
      intentId: activity.intentId,
      qualityId: activity.qualityId,
      confidence: activity.confidence,
      uncertainty: (activity.uncertainty ?? [])
        .map((note) => truncate(note.trim(), MAX_UNCERTAINTY_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_UNCERTAINTY_NOTES),
    };
  });

  // Listing order carries no meaning; activities are returned in the order they began.
  const firstIndex = (a: ValidatedActivity) => rawIndex.get(a.eventIds[0]) ?? 0;
  activities.sort((a, b) => firstIndex(a) - firstIndex(b));

  // Evidence the model neither assigned nor listed is treated as unassigned.
  const unassignedEventIds = ctx.evidence
    .filter((item) => !owner.has(item.id))
    .flatMap((item) => item.sourceEventIds);

  return { ok: true, activities, unassignedEventIds };
}

function checkId(errors: string[], label: string, field: string, value: string | null, allowed: Set<string>): void {
  if (value !== null && !allowed.has(value)) {
    errors.push(`${label}: ${field} "${value}" is not an allowed id`);
  }
}

function idSet(entries: { id: string }[]): Set<string> {
  return new Set(entries.map((e) => e.id));
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
