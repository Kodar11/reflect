import type { Database } from './Database.js';
import {
  DEFAULT_FOCUS_PREFERENCES,
  normalizeFocusPreferences,
  type BlockedAttempt,
  type FocusEndReason,
  type FocusInterruption,
  type FocusPreferences,
  type FocusProfile,
  type FocusProfileRule,
  type FocusRule,
  type FocusSession,
} from '../focus/FocusModels.js';
import { parseBlockingConfig } from '../focus/BlockingConfig.js';

export interface IFocusRepository {
  // Profiles
  getProfiles(): FocusProfile[];
  getProfileById(id: string): FocusProfile | null;
  getDefaultProfile(): FocusProfile | null;
  insertProfile(profile: FocusProfile, ruleIds?: string[]): void;
  updateProfile(profile: FocusProfile, ruleIds?: string[]): void;
  deleteProfile(id: string): void;

  // Global rules
  getRules(): FocusRule[];
  getRuleById(id: string): FocusRule | null;
  insertRule(rule: FocusRule): void;
  updateRule(rule: FocusRule): void;
  deleteRule(id: string): void;
  getProfileRuleIds(profileId: string): string[];

  // Sessions
  getSessionById(id: string): FocusSession | null;
  getActiveSession(): FocusSession | null;
  /** Every session that has not ended (planned, active or paused), newest first. */
  getOpenSessions(): FocusSession[];
  getSessionsByRange(from: string, to: string): FocusSession[];
  getSessionsForDay(isoDate: string): FocusSession[];
  getAllSessions(limit?: number): FocusSession[];
  insertSession(session: FocusSession): void;
  updateSession(session: FocusSession): void;
  /** Remove a session that never started (a failed or interrupted start). */
  deleteSession(id: string): void;

  // Interruptions
  getInterruptions(sessionId: string): FocusInterruption[];
  insertInterruption(interruption: FocusInterruption): void;

  // Blocked attempts
  getBlockedAttempts(sessionId: string): BlockedAttempt[];
  insertBlockedAttempt(attempt: BlockedAttempt): void;

  // Preferences
  getPreferences(): FocusPreferences;
  savePreferences(preferences: FocusPreferences): void;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  is_default: number;
  mode: 'stopwatch' | 'countdown';
  default_duration_minutes: number | null;
  blocks_distractions: number;
  sound_cue: string | null;
  created_at: string;
  updated_at: string;
}

interface RuleRow {
  id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  action: 'block' | 'allow';
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRuleJoinRow {
  profile_id: string;
  rule_id: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  profile_id: string;
  task: string;
  notes: string | null;
  mode: 'stopwatch' | 'countdown';
  planned_duration_minutes: number | null;
  state: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled';
  started_at: string | null;
  ended_at: string | null;
  paused_at: string | null;
  total_pause_ms: number;
  elapsed_ms: number;
  blocking_lease_id: string | null;
  end_reason: FocusEndReason | null;
  end_note: string | null;
  blocking_config: string | null;
  created_at: string;
  updated_at: string;
}

interface InterruptionRow {
  id: string;
  session_id: string;
  type: 'pause' | 'resume' | 'idle' | 'user';
  reason: string | null;
  occurred_at: string;
  idle_ms: number | null;
  created_at: string;
}

interface BlockedAttemptRow {
  id: string;
  session_id: string;
  type: 'app' | 'website' | 'category';
  target: string;
  attempted_at: string;
  created_at: string;
}

export class FocusRepository implements IFocusRepository {
  private readonly getProfilesStmt;
  private readonly getProfileByIdStmt;
  private readonly getDefaultProfileStmt;
  private readonly insertProfileStmt;
  private readonly updateProfileStmt;
  private readonly deleteProfileStmt;

  private readonly getRulesStmt;
  private readonly getRuleByIdStmt;
  private readonly getProfileRuleIdsStmt;
  private readonly insertRuleStmt;
  private readonly updateRuleStmt;
  private readonly deleteRuleStmt;
  private readonly insertProfileRuleStmt;
  private readonly deleteProfileRulesStmt;

  private readonly getSessionByIdStmt;
  private readonly getActiveSessionStmt;
  private readonly getOpenSessionsStmt;
  private readonly deleteSessionStmt;
  private readonly getPreferencesStmt;
  private readonly savePreferencesStmt;
  private readonly getSessionsByRangeStmt;
  private readonly getSessionsForDayStmt;
  private readonly getAllSessionsStmt;
  private readonly insertSessionStmt;
  private readonly updateSessionStmt;

  private readonly getInterruptionsStmt;
  private readonly insertInterruptionStmt;

  private readonly getBlockedAttemptsStmt;
  private readonly insertBlockedAttemptStmt;

  constructor(private readonly db: Database) {
    this.getProfilesStmt = db.prepare('SELECT * FROM focus_profiles ORDER BY name');
    this.getProfileByIdStmt = db.prepare('SELECT * FROM focus_profiles WHERE id = @id');
    this.getDefaultProfileStmt = db.prepare('SELECT * FROM focus_profiles WHERE is_default = 1 LIMIT 1');
    this.insertProfileStmt = db.prepare(`
      INSERT INTO focus_profiles
        (id, name, description, is_default, mode, default_duration_minutes, blocks_distractions, sound_cue, created_at, updated_at)
      VALUES
        (@id, @name, @description, @is_default, @mode, @default_duration_minutes, @blocks_distractions, @sound_cue, @created_at, @updated_at)
    `);
    this.updateProfileStmt = db.prepare(`
      UPDATE focus_profiles SET
        name = @name,
        description = @description,
        is_default = @is_default,
        mode = @mode,
        default_duration_minutes = @default_duration_minutes,
        blocks_distractions = @blocks_distractions,
        sound_cue = @sound_cue,
        updated_at = @updated_at
      WHERE id = @id
    `);
    this.deleteProfileStmt = db.prepare('DELETE FROM focus_profiles WHERE id = @id');

    this.getRulesStmt = db.prepare('SELECT * FROM focus_rules ORDER BY type, target, created_at');
    this.getRuleByIdStmt = db.prepare('SELECT * FROM focus_rules WHERE id = @id');
    this.getProfileRuleIdsStmt = db.prepare(
      'SELECT rule_id FROM focus_profile_rules WHERE profile_id = @profile_id ORDER BY created_at',
    );
    this.insertRuleStmt = db.prepare(`
      INSERT INTO focus_rules
        (id, type, target, action, enabled, created_at, updated_at)
      VALUES
        (@id, @type, @target, @action, @enabled, @created_at, @updated_at)
    `);
    this.updateRuleStmt = db.prepare(`
      UPDATE focus_rules SET
        type = @type,
        target = @target,
        action = @action,
        enabled = @enabled,
        updated_at = @updated_at
      WHERE id = @id
    `);
    this.deleteRuleStmt = db.prepare('DELETE FROM focus_rules WHERE id = @id');
    this.insertProfileRuleStmt = db.prepare(`
      INSERT INTO focus_profile_rules (profile_id, rule_id, created_at, updated_at)
      VALUES (@profile_id, @rule_id, @created_at, @updated_at)
    `);
    this.deleteProfileRulesStmt = db.prepare(
      'DELETE FROM focus_profile_rules WHERE profile_id = @profile_id',
    );

    this.getSessionByIdStmt = db.prepare('SELECT * FROM focus_sessions WHERE id = @id');
    this.getActiveSessionStmt = db.prepare(`
      SELECT * FROM focus_sessions
      WHERE state IN ('planned', 'active', 'paused')
      ORDER BY created_at DESC LIMIT 1
    `);
    this.getOpenSessionsStmt = db.prepare(`
      SELECT * FROM focus_sessions
      WHERE state IN ('planned', 'active', 'paused')
      ORDER BY created_at DESC
    `);
    this.deleteSessionStmt = db.prepare('DELETE FROM focus_sessions WHERE id = @id');
    this.getPreferencesStmt = db.prepare('SELECT data FROM focus_preferences WHERE id = 1');
    this.savePreferencesStmt = db.prepare(`
      INSERT INTO focus_preferences (id, data, updated_at) VALUES (1, @data, @updated_at)
      ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    this.getSessionsByRangeStmt = db.prepare(`
      SELECT * FROM focus_sessions
      WHERE (started_at >= @from AND started_at < @to)
         OR (state IN ('planned', 'active', 'paused') AND started_at IS NULL)
      ORDER BY started_at ASC, created_at ASC
    `);
    this.getSessionsForDayStmt = db.prepare(`
      SELECT * FROM focus_sessions
      WHERE date(started_at) = date(@isoDate)
         OR (state IN ('planned', 'active', 'paused') AND started_at IS NULL)
      ORDER BY started_at ASC, created_at ASC
    `);
    this.getAllSessionsStmt = db.prepare(`
      SELECT * FROM focus_sessions
      ORDER BY started_at DESC, created_at DESC
      LIMIT @limit
    `);
    this.insertSessionStmt = db.prepare(`
      INSERT INTO focus_sessions
        (id, profile_id, task, notes, mode, planned_duration_minutes, state,
         started_at, ended_at, paused_at, total_pause_ms, elapsed_ms,
         blocking_lease_id, end_reason, end_note, blocking_config, created_at, updated_at)
      VALUES
        (@id, @profile_id, @task, @notes, @mode, @planned_duration_minutes, @state,
         @started_at, @ended_at, @paused_at, @total_pause_ms, @elapsed_ms,
         @blocking_lease_id, @end_reason, @end_note, @blocking_config, @created_at, @updated_at)
    `);
    this.updateSessionStmt = db.prepare(`
      UPDATE focus_sessions SET
        profile_id = @profile_id,
        task = @task,
        notes = @notes,
        mode = @mode,
        planned_duration_minutes = @planned_duration_minutes,
        state = @state,
        started_at = @started_at,
        ended_at = @ended_at,
        paused_at = @paused_at,
        total_pause_ms = @total_pause_ms,
        elapsed_ms = @elapsed_ms,
        blocking_lease_id = @blocking_lease_id,
        end_reason = @end_reason,
        end_note = @end_note,
        blocking_config = @blocking_config,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.getInterruptionsStmt = db.prepare(
      'SELECT * FROM focus_interruptions WHERE session_id = @session_id ORDER BY occurred_at ASC',
    );
    this.insertInterruptionStmt = db.prepare(`
      INSERT INTO focus_interruptions
        (id, session_id, type, reason, occurred_at, idle_ms, created_at)
      VALUES
        (@id, @session_id, @type, @reason, @occurred_at, @idle_ms, @created_at)
    `);

    this.getBlockedAttemptsStmt = db.prepare(
      'SELECT * FROM blocked_attempts WHERE session_id = @session_id ORDER BY attempted_at ASC',
    );
    this.insertBlockedAttemptStmt = db.prepare(`
      INSERT INTO blocked_attempts
        (id, session_id, type, target, attempted_at, created_at)
      VALUES
        (@id, @session_id, @type, @target, @attempted_at, @created_at)
    `);
  }

  getProfiles(): FocusProfile[] {
    const rows = this.getProfilesStmt.all() as ProfileRow[];
    return rows.map((r) => this.profileWithRules(r));
  }

  getProfileById(id: string): FocusProfile | null {
    const row = this.getProfileByIdStmt.get({ id }) as ProfileRow | undefined;
    return row ? this.profileWithRules(row) : null;
  }

  getDefaultProfile(): FocusProfile | null {
    const row = this.getDefaultProfileStmt.get() as ProfileRow | undefined;
    return row ? this.profileWithRules(row) : null;
  }

  private profileWithRules(row: ProfileRow): FocusProfile {
    const rulesStmt = this.db.prepare(`
      SELECT r.* FROM focus_rules r
      JOIN focus_profile_rules pr ON pr.rule_id = r.id
      WHERE pr.profile_id = @profile_id AND r.enabled = 1
      ORDER BY r.created_at ASC
    `);
    const rules = (rulesStmt.all({ profile_id: row.id }) as RuleRow[]).map((r) => rowToProfileRule(r, row.id));
    return rowToProfile(row, rules);
  }

  getRules(): FocusRule[] {
    return (this.getRulesStmt.all() as RuleRow[]).map(rowToRule);
  }

  getRuleById(id: string): FocusRule | null {
    const row = this.getRuleByIdStmt.get({ id }) as RuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  getProfileRuleIds(profileId: string): string[] {
    const rows = this.getProfileRuleIdsStmt.all({ profile_id: profileId }) as { rule_id: string }[];
    return rows.map((r) => r.rule_id);
  }

  insertRule(rule: FocusRule): void {
    this.insertRuleStmt.run(ruleToRow(rule));
  }

  updateRule(rule: FocusRule): void {
    this.updateRuleStmt.run(ruleToRow(rule));
  }

  deleteRule(id: string): void {
    this.deleteRuleStmt.run({ id });
  }

  insertProfile(profile: FocusProfile, ruleIds: string[] = []): void {
    this.db.transaction(() => {
      this.insertProfileStmt.run(profileToRow(profile));
      this.setProfileRules(profile.id, ruleIds, profile.createdAt);
    });
  }

  updateProfile(profile: FocusProfile, ruleIds: string[] = []): void {
    this.db.transaction(() => {
      this.updateProfileStmt.run(profileToRow(profile));
      this.setProfileRules(profile.id, ruleIds, profile.updatedAt);
    });
  }

  private setProfileRules(profileId: string, ruleIds: string[], timestamp: string): void {
    this.deleteProfileRulesStmt.run({ profile_id: profileId });
    for (const ruleId of ruleIds) {
      this.insertProfileRuleStmt.run({
        profile_id: profileId,
        rule_id: ruleId,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
  }

  deleteProfile(id: string): void {
    this.deleteProfileStmt.run({ id });
  }

  getSessionById(id: string): FocusSession | null {
    const row = this.getSessionByIdStmt.get({ id }) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getActiveSession(): FocusSession | null {
    const row = this.getActiveSessionStmt.get() as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getOpenSessions(): FocusSession[] {
    return (this.getOpenSessionsStmt.all() as SessionRow[]).map(rowToSession);
  }

  getSessionsByRange(from: string, to: string): FocusSession[] {
    return (this.getSessionsByRangeStmt.all({ from, to }) as SessionRow[]).map(rowToSession);
  }

  getSessionsForDay(isoDate: string): FocusSession[] {
    return (this.getSessionsForDayStmt.all({ isoDate }) as SessionRow[]).map(rowToSession);
  }

  getAllSessions(limit = 1000): FocusSession[] {
    return (this.getAllSessionsStmt.all({ limit }) as SessionRow[]).map(rowToSession);
  }

  insertSession(session: FocusSession): void {
    this.insertSessionStmt.run(sessionToRow(session));
  }

  updateSession(session: FocusSession): void {
    this.updateSessionStmt.run(sessionToRow(session));
  }

  deleteSession(id: string): void {
    this.deleteSessionStmt.run({ id });
  }

  getPreferences(): FocusPreferences {
    const row = this.getPreferencesStmt.get() as { data: string } | undefined;
    if (!row) return { ...DEFAULT_FOCUS_PREFERENCES };
    try {
      return normalizeFocusPreferences(JSON.parse(row.data));
    } catch {
      return { ...DEFAULT_FOCUS_PREFERENCES };
    }
  }

  savePreferences(preferences: FocusPreferences): void {
    this.savePreferencesStmt.run({
      data: JSON.stringify(normalizeFocusPreferences(preferences)),
      updated_at: new Date().toISOString(),
    });
  }

  getInterruptions(sessionId: string): FocusInterruption[] {
    return (this.getInterruptionsStmt.all({ session_id: sessionId }) as InterruptionRow[]).map(rowToInterruption);
  }

  insertInterruption(interruption: FocusInterruption): void {
    this.insertInterruptionStmt.run(interruptionToRow(interruption));
  }

  getBlockedAttempts(sessionId: string): BlockedAttempt[] {
    return (this.getBlockedAttemptsStmt.all({ session_id: sessionId }) as BlockedAttemptRow[]).map(rowToBlockedAttempt);
  }

  insertBlockedAttempt(attempt: BlockedAttempt): void {
    this.insertBlockedAttemptStmt.run(blockedAttemptToRow(attempt));
  }
}

function rowToProfile(r: ProfileRow, rules: FocusProfileRule[]): FocusProfile {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isDefault: Boolean(r.is_default),
    mode: r.mode,
    defaultDurationMinutes: r.default_duration_minutes,
    blocksDistractions: Boolean(r.blocks_distractions),
    soundCue: r.sound_cue,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rules,
  };
}

function profileToRow(p: FocusProfile): ProfileRow {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    is_default: p.isDefault ? 1 : 0,
    mode: p.mode,
    default_duration_minutes: p.defaultDurationMinutes,
    blocks_distractions: p.blocksDistractions ? 1 : 0,
    sound_cue: p.soundCue,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function rowToRule(r: RuleRow): FocusRule {
  return {
    id: r.id,
    type: r.type,
    target: r.target,
    action: r.action,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function ruleToRow(r: FocusRule): RuleRow {
  return {
    id: r.id,
    type: r.type,
    target: r.target,
    action: r.action,
    enabled: r.enabled ? 1 : 0,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function rowToProfileRule(r: RuleRow, profileId: string): FocusProfileRule {
  return {
    id: r.id,
    profileId,
    type: r.type,
    target: r.target,
    action: r.action,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToSession(r: SessionRow): FocusSession {
  return {
    id: r.id,
    profileId: r.profile_id,
    task: r.task,
    notes: r.notes,
    mode: r.mode,
    plannedDurationMinutes: r.planned_duration_minutes,
    state: r.state,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    pausedAt: r.paused_at,
    totalPauseMs: r.total_pause_ms,
    elapsedMs: r.elapsed_ms,
    blockingLeaseId: r.blocking_lease_id,
    endReason: r.end_reason,
    endNote: r.end_note,
    blockingConfig: parseBlockingConfig(r.blocking_config),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sessionToRow(s: FocusSession): SessionRow {
  return {
    id: s.id,
    profile_id: s.profileId,
    task: s.task,
    notes: s.notes,
    mode: s.mode,
    planned_duration_minutes: s.plannedDurationMinutes,
    state: s.state,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    paused_at: s.pausedAt,
    total_pause_ms: s.totalPauseMs,
    elapsed_ms: s.elapsedMs,
    blocking_lease_id: s.blockingLeaseId,
    end_reason: s.endReason,
    end_note: s.endNote,
    blocking_config: s.blockingConfig ? JSON.stringify(s.blockingConfig) : null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function rowToInterruption(r: InterruptionRow): FocusInterruption {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    reason: r.reason,
    occurredAt: r.occurred_at,
    idleMs: r.idle_ms,
    createdAt: r.created_at,
  };
}

function interruptionToRow(i: FocusInterruption): InterruptionRow {
  return {
    id: i.id,
    session_id: i.sessionId,
    type: i.type,
    reason: i.reason,
    occurred_at: i.occurredAt,
    idle_ms: i.idleMs,
    created_at: i.createdAt,
  };
}

function rowToBlockedAttempt(r: BlockedAttemptRow): BlockedAttempt {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    target: r.target,
    attemptedAt: r.attempted_at,
    createdAt: r.created_at,
  };
}

function blockedAttemptToRow(a: BlockedAttempt): BlockedAttemptRow {
  return {
    id: a.id,
    session_id: a.sessionId,
    type: a.type,
    target: a.target,
    attempted_at: a.attemptedAt,
    created_at: a.createdAt,
  };
}
