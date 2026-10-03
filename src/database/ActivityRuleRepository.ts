import type { Database } from './Database.js';

export interface Activity {
  id: string;
  name: string;
  color: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TrackingRule {
  id: string;
  /** Context id. '' means the rule sets no Context. */
  activityId: string;
  conditions: string; // JSON string of condition list
  enabled: number; // 0 or 1
  priority: number;
  areaId: string | null;
  intentId: string | null;
  qualityId: string | null;
  /** Provenance. New rules default to 'user'; saving an existing rule keeps
   * its source. */
  source?: RuleSource;
  /** Present only on learned rules. Read-only: written when a candidate is
   * confirmed, never by `saveRule`. */
  learned?: LearnedRuleProvenance | null;
}

/**
 * 'system'  = seeded default,
 * 'user'    = explicitly created / remembered by the user,
 * 'learned' = pattern Reflect proposed and the user confirmed.
 */
export type RuleSource = 'system' | 'user' | 'learned';

/** How a learned rule originated. Evidence counters are read live from the
 * candidate it was confirmed from. */
export interface LearnedRuleProvenance {
  candidateId: string | null;
  confirmedAt: string | null;
  /** Set when the user edited the rule's conditions or classification. */
  userModifiedAt: string | null;
  correctionCount: number;
  matchCount: number;
  distinctDayCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export class ActivityRuleRepository {
  private readonly listActivitiesStmt;
  private readonly insertActivityStmt;
  private readonly updateActivityStmt;
  private readonly deleteActivityStmt;

  private readonly listRulesStmt;
  private readonly insertRuleStmt;
  private readonly updateRuleStmt;
  private readonly deleteRuleStmt;
  private readonly dismissCandidateForRuleStmt;

  constructor(private readonly db: Database) {
    this.listActivitiesStmt = db.prepare('SELECT * FROM activities ORDER BY name ASC');
    this.insertActivityStmt = db.prepare(
      `INSERT INTO activities (id, name, color, updated_at) 
       VALUES (@id, @name, @color, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET name = @name, color = @color, updated_at = CURRENT_TIMESTAMP`
    );
    this.updateActivityStmt = db.prepare(
      `UPDATE activities SET name = @name, color = @color, updated_at = CURRENT_TIMESTAMP WHERE id = @id`
    );
    this.deleteActivityStmt = db.prepare('DELETE FROM activities WHERE id = ?');

    this.listRulesStmt = db.prepare(
      `SELECT r.*,
              c.correction_count   AS learned_correction_count,
              c.occurrence_count   AS learned_match_count,
              c.distinct_day_count AS learned_distinct_day_count,
              c.first_seen_at      AS learned_first_seen_at,
              c.last_seen_at       AS learned_last_seen_at
       FROM tracking_rules r
       LEFT JOIN learned_rule_candidates c ON c.id = r.learned_from_candidate_id
       ORDER BY r.priority DESC, r.id ASC`,
    );
    // Editing what a learned rule matches or produces keeps source = 'learned'
    // (provenance is not lost) and stamps user_modified_at.
    this.insertRuleStmt = db.prepare(
      `INSERT INTO tracking_rules (id, activity_id, conditions, enabled, priority, area_id, intent_id, quality_id, source)
       VALUES (@id, @activity_id, @conditions, @enabled, @priority, @area_id, @intent_id, @quality_id, @source)
       ON CONFLICT(id) DO UPDATE SET 
         user_modified_at = CASE
           WHEN tracking_rules.source = 'learned' AND (
             tracking_rules.conditions IS NOT excluded.conditions
             OR tracking_rules.activity_id IS NOT excluded.activity_id
             OR tracking_rules.area_id IS NOT excluded.area_id
             OR tracking_rules.intent_id IS NOT excluded.intent_id
             OR tracking_rules.quality_id IS NOT excluded.quality_id
           ) THEN CURRENT_TIMESTAMP
           ELSE tracking_rules.user_modified_at
         END,
         activity_id = @activity_id, 
         conditions = @conditions, 
         enabled = @enabled, 
         priority = @priority,
         area_id = @area_id,
         intent_id = @intent_id,
         quality_id = @quality_id,
         updated_at = CURRENT_TIMESTAMP`
    );
    this.updateRuleStmt = db.prepare(
      `UPDATE tracking_rules SET activity_id = @activity_id, conditions = @conditions, enabled = @enabled, priority = @priority, area_id = @area_id, intent_id = @intent_id, quality_id = @quality_id, updated_at = CURRENT_TIMESTAMP WHERE id = @id`
    );
    this.deleteRuleStmt = db.prepare('DELETE FROM tracking_rules WHERE id = ?');
    // Deleting a learned rule is an explicit "no": its candidate must not be
    // suggested again.
    this.dismissCandidateForRuleStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET status = 'dismissed', confirmed_rule_id = NULL, updated_at = @now
       WHERE confirmed_rule_id = @rule_id`,
    );
  }

  // --- Activity CRUD ---
  listActivities(): Activity[] {
    return this.listActivitiesStmt.all() as Activity[];
  }

  saveActivity(activity: Activity): void {
    this.insertActivityStmt.run(activity);
  }

  updateActivity(activity: Activity): void {
    this.updateActivityStmt.run(activity);
  }

  deleteActivity(id: string): void {
    this.deleteActivityStmt.run(id);
  }

  // --- Rule CRUD ---
  listRules(): TrackingRule[] {
    return (this.listRulesStmt.all() as any[]).map(rowToRule);
  }

  saveRule(rule: TrackingRule): void {
    this.insertRuleStmt.run({
      id: rule.id,
      activity_id: rule.activityId || null,
      conditions: rule.conditions,
      enabled: rule.enabled,
      priority: rule.priority,
      area_id: rule.areaId ?? null,
      intent_id: rule.intentId ?? null,
      quality_id: rule.qualityId ?? null,
      source: rule.source ?? 'user',
    });
  }

  updateRule(rule: TrackingRule): void {
    this.updateRuleStmt.run({
      id: rule.id,
      activity_id: rule.activityId || null,
      conditions: rule.conditions,
      enabled: rule.enabled,
      priority: rule.priority,
      area_id: rule.areaId ?? null,
      intent_id: rule.intentId ?? null,
      quality_id: rule.qualityId ?? null,
    });
  }

  deleteRule(id: string): void {
    this.db.transaction(() => {
      this.dismissCandidateForRuleStmt.run({ rule_id: id, now: new Date().toISOString() });
      this.deleteRuleStmt.run(id);
    });
  }
}

function rowToRule(r: any): TrackingRule {
  const source: RuleSource = r.source === 'system' || r.source === 'learned' ? r.source : 'user';
  return {
    id: r.id,
    activityId: r.activity_id ?? '',
    conditions: r.conditions,
    enabled: r.enabled,
    priority: r.priority,
    areaId: r.area_id ?? null,
    intentId: r.intent_id ?? null,
    qualityId: r.quality_id ?? null,
    source,
    learned:
      source === 'learned'
        ? {
            candidateId: r.learned_from_candidate_id ?? null,
            confirmedAt: r.learned_confirmed_at ?? null,
            userModifiedAt: r.user_modified_at ?? null,
            correctionCount: r.learned_correction_count ?? 0,
            matchCount: r.learned_match_count ?? 0,
            distinctDayCount: r.learned_distinct_day_count ?? 0,
            firstSeenAt: r.learned_first_seen_at ?? null,
            lastSeenAt: r.learned_last_seen_at ?? null,
          }
        : null,
  };
}
