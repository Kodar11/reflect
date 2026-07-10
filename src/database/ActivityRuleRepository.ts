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
  activityId: string;
  conditions: string; // JSON string of condition list
  enabled: number; // 0 or 1
  priority: number;
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

    this.listRulesStmt = db.prepare('SELECT * FROM tracking_rules ORDER BY priority DESC, id ASC');
    this.insertRuleStmt = db.prepare(
      `INSERT INTO tracking_rules (id, activity_id, conditions, enabled, priority)
       VALUES (@id, @activity_id, @conditions, @enabled, @priority)
       ON CONFLICT(id) DO UPDATE SET 
         activity_id = @activity_id, 
         conditions = @conditions, 
         enabled = @enabled, 
         priority = @priority`
    );
    this.updateRuleStmt = db.prepare(
      `UPDATE tracking_rules SET activity_id = @activity_id, conditions = @conditions, enabled = @enabled, priority = @priority WHERE id = @id`
    );
    this.deleteRuleStmt = db.prepare('DELETE FROM tracking_rules WHERE id = ?');
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
    return this.listRulesStmt.all() as TrackingRule[];
  }

  saveRule(rule: TrackingRule): void {
    this.insertRuleStmt.run({
      id: rule.id,
      activity_id: rule.activityId,
      conditions: rule.conditions,
      enabled: rule.enabled,
      priority: rule.priority,
    });
  }

  updateRule(rule: TrackingRule): void {
    this.updateRuleStmt.run({
      id: rule.id,
      activity_id: rule.activityId,
      conditions: rule.conditions,
      enabled: rule.enabled,
      priority: rule.priority,
    });
  }

  deleteRule(id: string): void {
    this.deleteRuleStmt.run(id);
  }
}
