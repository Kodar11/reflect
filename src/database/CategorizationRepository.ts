import type { Database } from './Database.js';
import type { CategorizationOverride, DimensionEntry } from '../categorization/Classification.js';

/**
 * Repository for the `classification_dimensions` and `categorization_overrides`
 * tables. Follows the existing repository conventions: prepared statements in
 * the constructor, named params, snake_case ↔ camelCase mapping, `Database`
 * injected.
 */

interface DimensionRow {
  id: string;
  dimension: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface OverrideRow {
  id: string;
  event_ids: string;
  anchor_event_id: number | null;
  context_id: string | null;
  area_id: string | null;
  intent_id: string | null;
  quality_id: string | null;
  source: string;
  rule_id: string | null;
  created_at: string;
  updated_at: string;
}

export class CategorizationRepository {
  private readonly listDimsStmt;
  private readonly listDimsByTypeStmt;
  private readonly saveDimStmt;
  private readonly deleteDimStmt;
  private readonly listOverridesStmt;
  private readonly saveOverrideStmt;
  private readonly deleteOverrideStmt;

  constructor(private readonly db: Database) {
    this.listDimsStmt = db.prepare('SELECT * FROM classification_dimensions ORDER BY dimension ASC, sort_order ASC, name ASC');
    this.listDimsByTypeStmt = db.prepare('SELECT * FROM classification_dimensions WHERE dimension = @dimension ORDER BY sort_order ASC, name ASC');
    this.saveDimStmt = db.prepare(
      `INSERT INTO classification_dimensions (id, dimension, name, sort_order, updated_at)
       VALUES (@id, @dimension, @name, @sort_order, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET dimension = @dimension, name = @name, sort_order = @sort_order, updated_at = CURRENT_TIMESTAMP`,
    );
    this.deleteDimStmt = db.prepare('DELETE FROM classification_dimensions WHERE id = ?');

    this.listOverridesStmt = db.prepare('SELECT * FROM categorization_overrides ORDER BY created_at DESC');
    this.saveOverrideStmt = db.prepare(
      `INSERT INTO categorization_overrides (id, event_ids, anchor_event_id, context_id, area_id, intent_id, quality_id, source, rule_id, updated_at)
       VALUES (@id, @event_ids, @anchor_event_id, @context_id, @area_id, @intent_id, @quality_id, @source, @rule_id, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         event_ids = @event_ids,
         anchor_event_id = @anchor_event_id,
         context_id = @context_id,
         area_id = @area_id,
         intent_id = @intent_id,
         quality_id = @quality_id,
         source = @source,
         rule_id = @rule_id,
         updated_at = CURRENT_TIMESTAMP`,
    );
    this.deleteOverrideStmt = db.prepare('DELETE FROM categorization_overrides WHERE id = ?');
  }

  // --- Dimensions ---

  listDimensions(): DimensionEntry[] {
    return (this.listDimsStmt.all() as DimensionRow[]).map(rowToDimension);
  }

  listDimensionsByType(dimension: 'area' | 'intent' | 'quality'): DimensionEntry[] {
    return (this.listDimsByTypeStmt.all({ dimension }) as DimensionRow[]).map(rowToDimension);
  }

  saveDimension(entry: DimensionEntry): void {
    this.saveDimStmt.run({
      id: entry.id,
      dimension: entry.dimension,
      name: entry.name,
      sort_order: entry.sortOrder,
    });
  }

  deleteDimension(id: string): void {
    this.deleteDimStmt.run(id);
  }

  // --- Overrides ---

  listOverrides(): CategorizationOverride[] {
    return (this.listOverridesStmt.all() as OverrideRow[]).map(rowToOverride);
  }

  saveOverride(override: CategorizationOverride): void {
    this.saveOverrideStmt.run({
      id: override.id,
      event_ids: JSON.stringify(override.eventIds),
      anchor_event_id: override.anchorEventId,
      context_id: override.contextId,
      area_id: override.areaId,
      intent_id: override.intentId,
      quality_id: override.qualityId,
      source: override.source,
      rule_id: override.ruleId,
    });
  }

  deleteOverride(id: string): void {
    this.deleteOverrideStmt.run(id);
  }
}

function rowToDimension(r: DimensionRow): DimensionEntry {
  return {
    id: r.id,
    dimension: r.dimension as 'area' | 'intent' | 'quality',
    name: r.name,
    sortOrder: r.sort_order,
  };
}

function rowToOverride(r: OverrideRow): CategorizationOverride {
  let eventIds: number[] = [];
  try {
    eventIds = JSON.parse(r.event_ids) as number[];
  } catch {
    // Stale/malformed row — return empty so it won't match anything.
  }
  return {
    id: r.id,
    eventIds,
    anchorEventId: r.anchor_event_id,
    contextId: r.context_id,
    areaId: r.area_id,
    intentId: r.intent_id,
    qualityId: r.quality_id,
    source: r.source,
    ruleId: r.rule_id,
  };
}
