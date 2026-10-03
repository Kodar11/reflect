import type { Database } from './Database.js';
import type { RuleCondition } from '../categorization/Classification.js';
import type {
  CandidateEvidence,
  CandidateOccurrence,
  CandidateStatus,
  ClassificationIds,
  LearnedRuleCandidate,
  NewLearnedRuleCandidate,
} from '../learning/LearnedRuleModels.js';

/**
 * Storage seam for learned-rule candidates. `LearnedRuleService` owns every
 * business rule; this repository only stores and retrieves. Tests substitute
 * an in-memory fake.
 *
 * Candidates hold structured conditions and counters only — no raw event
 * content. Raw events are referenced by id and never written.
 */
export interface ILearnedRuleCandidateRepository {
  /** Run `fn` atomically. All or nothing. */
  transaction<T>(fn: () => T): T;

  getCandidate(id: string): LearnedRuleCandidate | null;
  findByPatternHash(patternHash: string, classificationHash: string): LearnedRuleCandidate | null;
  /** All candidates, or only those in the given statuses. Ordered by id. */
  listCandidates(statuses?: CandidateStatus[]): LearnedRuleCandidate[];
  /** Idempotent: an existing candidate with the same identity is returned as is. */
  createCandidate(candidate: NewLearnedRuleCandidate): LearnedRuleCandidate;

  /**
   * The ledger row already standing for this activity, if any: same key, or an
   * anchor event that is one of the activity's events.
   */
  findOccurrence(candidateId: string, occurrenceKey: string, eventIds: number[]): CandidateOccurrence | null;
  saveOccurrence(occurrence: CandidateOccurrence): void;
  listOccurrences(candidateId: string): CandidateOccurrence[];
  updateEvidence(candidateId: string, evidence: CandidateEvidence, nowIso: string): void;

  markSuggested(id: string, nowIso: string): void;
  snooze(id: string, untilIso: string, nowIso: string): void;
  dismiss(id: string, nowIso: string): void;
  /** Back to 'pending' (explicit reactivation of a snoozed/dismissed candidate). */
  reactivate(id: string, nowIso: string): void;
  /** When any candidate was last shown — the global suggestion cooldown. */
  lastSuggestedAt(): string | null;

  /** Insert the `tracking_rules` row (source = 'learned') for a candidate. */
  insertLearnedRule(rule: NewLearnedRule): void;
  markConfirmed(candidateId: string, ruleId: string, nowIso: string): void;
}

export interface NewLearnedRule {
  id: string;
  candidateId: string;
  conditions: RuleCondition[];
  classification: ClassificationIds;
  priority: number;
  nowIso: string;
}

interface CandidateRow {
  id: string;
  pattern_hash: string;
  classification_hash: string;
  conditions_json: string;
  classification_json: string;
  occurrence_count: number;
  distinct_day_count: number;
  correction_count: number;
  conflict_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_correction_at: string | null;
  last_suggested_at: string | null;
  suggestion_count: number;
  status: string;
  snoozed_until: string | null;
  confirmed_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

interface OccurrenceRow {
  candidate_id: string;
  occurrence_key: string;
  anchor_event_id: number | null;
  local_day: string;
  occurred_at: string;
  is_correction: number;
  is_conflict: number;
}

export class LearnedRuleCandidateRepository implements ILearnedRuleCandidateRepository {
  private readonly getStmt;
  private readonly findByHashStmt;
  private readonly listStmt;
  private readonly insertStmt;

  private readonly findOccurrenceStmt;
  private readonly saveOccurrenceStmt;
  private readonly listOccurrencesStmt;
  private readonly updateEvidenceStmt;

  private readonly markSuggestedStmt;
  private readonly snoozeStmt;
  private readonly dismissStmt;
  private readonly reactivateStmt;
  private readonly lastSuggestedStmt;

  private readonly insertRuleStmt;
  private readonly markConfirmedStmt;

  constructor(private readonly db: Database) {
    this.getStmt = db.prepare('SELECT * FROM learned_rule_candidates WHERE id = ?');
    this.findByHashStmt = db.prepare(
      `SELECT * FROM learned_rule_candidates
       WHERE pattern_hash = @pattern_hash AND classification_hash = @classification_hash`,
    );
    this.listStmt = db.prepare('SELECT * FROM learned_rule_candidates ORDER BY id ASC');
    // The unique (pattern_hash, classification_hash) index makes this idempotent.
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO learned_rule_candidates
         (id, pattern_hash, classification_hash, conditions_json, classification_json, status, created_at, updated_at)
       VALUES
         (@id, @pattern_hash, @classification_hash, @conditions_json, @classification_json, 'pending', @now, @now)`,
    );

    this.findOccurrenceStmt = db.prepare(
      `SELECT * FROM learned_rule_occurrences
       WHERE candidate_id = @candidate_id
         AND (occurrence_key = @occurrence_key
              OR anchor_event_id IN (SELECT value FROM json_each(@event_ids)))
       ORDER BY occurrence_key = @occurrence_key DESC, occurrence_key ASC
       LIMIT 1`,
    );
    this.saveOccurrenceStmt = db.prepare(
      `INSERT INTO learned_rule_occurrences
         (candidate_id, occurrence_key, anchor_event_id, local_day, occurred_at, is_correction, is_conflict)
       VALUES
         (@candidate_id, @occurrence_key, @anchor_event_id, @local_day, @occurred_at, @is_correction, @is_conflict)
       ON CONFLICT(candidate_id, occurrence_key) DO UPDATE SET
         anchor_event_id = @anchor_event_id,
         local_day = @local_day,
         occurred_at = @occurred_at,
         is_correction = @is_correction,
         is_conflict = @is_conflict`,
    );
    this.listOccurrencesStmt = db.prepare(
      `SELECT * FROM learned_rule_occurrences WHERE candidate_id = ? ORDER BY occurred_at ASC, occurrence_key ASC`,
    );
    this.updateEvidenceStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET occurrence_count = @occurrence_count,
           distinct_day_count = @distinct_day_count,
           correction_count = @correction_count,
           conflict_count = @conflict_count,
           first_seen_at = @first_seen_at,
           last_seen_at = @last_seen_at,
           last_correction_at = @last_correction_at,
           updated_at = @now
       WHERE id = @id`,
    );

    this.markSuggestedStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET last_suggested_at = @now, suggestion_count = suggestion_count + 1, updated_at = @now
       WHERE id = @id`,
    );
    this.snoozeStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET status = 'snoozed', snoozed_until = @until, updated_at = @now
       WHERE id = @id AND status IN ('pending', 'snoozed')`,
    );
    this.dismissStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET status = 'dismissed', snoozed_until = NULL, updated_at = @now
       WHERE id = @id AND status IN ('pending', 'snoozed')`,
    );
    this.reactivateStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET status = 'pending', snoozed_until = NULL, last_suggested_at = NULL, updated_at = @now
       WHERE id = @id AND status IN ('snoozed', 'dismissed')`,
    );
    this.lastSuggestedStmt = db.prepare(
      'SELECT MAX(last_suggested_at) AS last FROM learned_rule_candidates',
    );

    this.insertRuleStmt = db.prepare(
      `INSERT INTO tracking_rules
         (id, activity_id, conditions, enabled, priority, area_id, intent_id, quality_id,
          source, learned_from_candidate_id, learned_confirmed_at)
       VALUES
         (@id, @activity_id, @conditions, 1, @priority, @area_id, @intent_id, @quality_id,
          'learned', @candidate_id, @now)`,
    );
    this.markConfirmedStmt = db.prepare(
      `UPDATE learned_rule_candidates
       SET status = 'confirmed', confirmed_rule_id = @rule_id, snoozed_until = NULL, updated_at = @now
       WHERE id = @id`,
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  getCandidate(id: string): LearnedRuleCandidate | null {
    const row = this.getStmt.get(id) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  findByPatternHash(patternHash: string, classificationHash: string): LearnedRuleCandidate | null {
    const row = this.findByHashStmt.get({
      pattern_hash: patternHash,
      classification_hash: classificationHash,
    }) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  listCandidates(statuses?: CandidateStatus[]): LearnedRuleCandidate[] {
    const all = (this.listStmt.all() as CandidateRow[]).map(rowToCandidate);
    return statuses ? all.filter((c) => statuses.includes(c.status)) : all;
  }

  createCandidate(candidate: NewLearnedRuleCandidate): LearnedRuleCandidate {
    this.insertStmt.run({
      id: candidate.id,
      pattern_hash: candidate.patternHash,
      classification_hash: candidate.classificationHash,
      conditions_json: JSON.stringify(candidate.conditions),
      classification_json: JSON.stringify(candidate.classification),
      now: candidate.nowIso,
    });
    const stored = this.findByPatternHash(candidate.patternHash, candidate.classificationHash);
    if (!stored) throw new Error('Candidate could not be created');
    return stored;
  }

  findOccurrence(candidateId: string, occurrenceKey: string, eventIds: number[]): CandidateOccurrence | null {
    const row = this.findOccurrenceStmt.get({
      candidate_id: candidateId,
      occurrence_key: occurrenceKey,
      event_ids: JSON.stringify(eventIds),
    }) as OccurrenceRow | undefined;
    return row ? rowToOccurrence(row) : null;
  }

  saveOccurrence(occurrence: CandidateOccurrence): void {
    this.saveOccurrenceStmt.run({
      candidate_id: occurrence.candidateId,
      occurrence_key: occurrence.occurrenceKey,
      anchor_event_id: occurrence.anchorEventId,
      local_day: occurrence.localDay,
      occurred_at: occurrence.occurredAt,
      is_correction: occurrence.isCorrection ? 1 : 0,
      is_conflict: occurrence.isConflict ? 1 : 0,
    });
  }

  listOccurrences(candidateId: string): CandidateOccurrence[] {
    return (this.listOccurrencesStmt.all(candidateId) as OccurrenceRow[]).map(rowToOccurrence);
  }

  updateEvidence(candidateId: string, evidence: CandidateEvidence, nowIso: string): void {
    this.updateEvidenceStmt.run({
      id: candidateId,
      occurrence_count: evidence.occurrenceCount,
      distinct_day_count: evidence.distinctDayCount,
      correction_count: evidence.correctionCount,
      conflict_count: evidence.conflictCount,
      first_seen_at: evidence.firstSeenAt,
      last_seen_at: evidence.lastSeenAt,
      last_correction_at: evidence.lastCorrectionAt,
      now: nowIso,
    });
  }

  markSuggested(id: string, nowIso: string): void {
    this.markSuggestedStmt.run({ id, now: nowIso });
  }

  snooze(id: string, untilIso: string, nowIso: string): void {
    this.snoozeStmt.run({ id, until: untilIso, now: nowIso });
  }

  dismiss(id: string, nowIso: string): void {
    this.dismissStmt.run({ id, now: nowIso });
  }

  reactivate(id: string, nowIso: string): void {
    this.reactivateStmt.run({ id, now: nowIso });
  }

  lastSuggestedAt(): string | null {
    return (this.lastSuggestedStmt.get() as { last: string | null }).last ?? null;
  }

  insertLearnedRule(rule: NewLearnedRule): void {
    this.insertRuleStmt.run({
      id: rule.id,
      activity_id: rule.classification.contextId || null,
      conditions: JSON.stringify(rule.conditions),
      priority: rule.priority,
      area_id: rule.classification.areaId,
      intent_id: rule.classification.intentId,
      quality_id: rule.classification.qualityId,
      candidate_id: rule.candidateId,
      now: rule.nowIso,
    });
  }

  markConfirmed(candidateId: string, ruleId: string, nowIso: string): void {
    this.markConfirmedStmt.run({ id: candidateId, rule_id: ruleId, now: nowIso });
  }
}

function rowToCandidate(r: CandidateRow): LearnedRuleCandidate {
  return {
    id: r.id,
    patternHash: r.pattern_hash,
    classificationHash: r.classification_hash,
    conditions: parseJson<RuleCondition[]>(r.conditions_json, []),
    classification: parseJson<ClassificationIds>(r.classification_json, {
      contextId: null,
      areaId: null,
      intentId: null,
      qualityId: null,
    }),
    occurrenceCount: r.occurrence_count,
    distinctDayCount: r.distinct_day_count,
    correctionCount: r.correction_count,
    conflictCount: r.conflict_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    lastCorrectionAt: r.last_correction_at,
    lastSuggestedAt: r.last_suggested_at,
    suggestionCount: r.suggestion_count,
    status: r.status as CandidateStatus,
    snoozedUntil: r.snoozed_until,
    confirmedRuleId: r.confirmed_rule_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToOccurrence(r: OccurrenceRow): CandidateOccurrence {
  return {
    candidateId: r.candidate_id,
    occurrenceKey: r.occurrence_key,
    anchorEventId: r.anchor_event_id,
    localDay: r.local_day,
    occurredAt: r.occurred_at,
    isCorrection: r.is_correction === 1,
    isConflict: r.is_conflict === 1,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
