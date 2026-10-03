import type { TrackingRule } from '../../src/database/ActivityRuleRepository';
import type {
  ILearnedRuleCandidateRepository,
  NewLearnedRule,
} from '../../src/database/LearnedRuleCandidateRepository';
import type {
  CandidateEvidence,
  CandidateOccurrence,
  CandidateStatus,
  LearnedRuleCandidate,
  NewLearnedRuleCandidate,
} from '../../src/learning/LearnedRuleModels';

/**
 * In-memory stand-in for `LearnedRuleCandidateRepository` with the same
 * semantics: unique (pattern, classification) identity, an occurrence ledger
 * keyed by (candidate, key), all-or-nothing transactions, and learned rules
 * written into the shared rules list.
 */
export class FakeLearnedRuleRepository implements ILearnedRuleCandidateRepository {
  candidates: LearnedRuleCandidate[] = [];
  occurrences: CandidateOccurrence[] = [];

  constructor(public readonly rules: TrackingRule[] = []) {}

  transaction<T>(fn: () => T): T {
    const snapshot = {
      candidates: structuredClone(this.candidates),
      occurrences: structuredClone(this.occurrences),
      rules: structuredClone(this.rules),
    };
    try {
      return fn();
    } catch (err) {
      this.candidates = snapshot.candidates;
      this.occurrences = snapshot.occurrences;
      this.rules.splice(0, this.rules.length, ...snapshot.rules);
      throw err;
    }
  }

  getCandidate(id: string): LearnedRuleCandidate | null {
    const found = this.candidates.find((c) => c.id === id);
    return found ? structuredClone(found) : null;
  }

  findByPatternHash(patternHash: string, classificationHash: string): LearnedRuleCandidate | null {
    const found = this.candidates.find(
      (c) => c.patternHash === patternHash && c.classificationHash === classificationHash,
    );
    return found ? structuredClone(found) : null;
  }

  listCandidates(statuses?: CandidateStatus[]): LearnedRuleCandidate[] {
    return structuredClone(this.candidates)
      .filter((c) => !statuses || statuses.includes(c.status))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  createCandidate(candidate: NewLearnedRuleCandidate): LearnedRuleCandidate {
    const existing = this.findByPatternHash(candidate.patternHash, candidate.classificationHash);
    if (existing) return existing;
    this.candidates.push({
      id: candidate.id,
      patternHash: candidate.patternHash,
      classificationHash: candidate.classificationHash,
      conditions: structuredClone(candidate.conditions),
      classification: { ...candidate.classification },
      occurrenceCount: 0,
      distinctDayCount: 0,
      correctionCount: 0,
      conflictCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastCorrectionAt: null,
      lastSuggestedAt: null,
      suggestionCount: 0,
      status: 'pending',
      snoozedUntil: null,
      confirmedRuleId: null,
      createdAt: candidate.nowIso,
      updatedAt: candidate.nowIso,
    });
    return this.getCandidate(candidate.id)!;
  }

  findOccurrence(candidateId: string, occurrenceKey: string, eventIds: number[]): CandidateOccurrence | null {
    const own = this.occurrences.filter((o) => o.candidateId === candidateId);
    const found =
      own.find((o) => o.occurrenceKey === occurrenceKey) ??
      own.find((o) => o.anchorEventId !== null && eventIds.includes(o.anchorEventId));
    return found ? { ...found } : null;
  }

  saveOccurrence(occurrence: CandidateOccurrence): void {
    const index = this.occurrences.findIndex(
      (o) => o.candidateId === occurrence.candidateId && o.occurrenceKey === occurrence.occurrenceKey,
    );
    if (index >= 0) this.occurrences[index] = { ...occurrence };
    else this.occurrences.push({ ...occurrence });
  }

  listOccurrences(candidateId: string): CandidateOccurrence[] {
    return this.occurrences.filter((o) => o.candidateId === candidateId).map((o) => ({ ...o }));
  }

  updateEvidence(candidateId: string, evidence: CandidateEvidence, nowIso: string): void {
    this.patch(candidateId, { ...evidence, updatedAt: nowIso });
  }

  markSuggested(id: string, nowIso: string): void {
    const c = this.candidates.find((x) => x.id === id);
    if (c) this.patch(id, { lastSuggestedAt: nowIso, suggestionCount: c.suggestionCount + 1, updatedAt: nowIso });
  }

  snooze(id: string, untilIso: string, nowIso: string): void {
    const c = this.candidates.find((x) => x.id === id);
    if (c && (c.status === 'pending' || c.status === 'snoozed')) {
      this.patch(id, { status: 'snoozed', snoozedUntil: untilIso, updatedAt: nowIso });
    }
  }

  dismiss(id: string, nowIso: string): void {
    const c = this.candidates.find((x) => x.id === id);
    if (c && (c.status === 'pending' || c.status === 'snoozed')) {
      this.patch(id, { status: 'dismissed', snoozedUntil: null, updatedAt: nowIso });
    }
  }

  reactivate(id: string, nowIso: string): void {
    const c = this.candidates.find((x) => x.id === id);
    if (c && (c.status === 'snoozed' || c.status === 'dismissed')) {
      this.patch(id, { status: 'pending', snoozedUntil: null, lastSuggestedAt: null, updatedAt: nowIso });
    }
  }

  lastSuggestedAt(): string | null {
    return this.candidates.reduce<string | null>(
      (max, c) => (c.lastSuggestedAt && (max === null || c.lastSuggestedAt > max) ? c.lastSuggestedAt : max),
      null,
    );
  }

  insertLearnedRule(rule: NewLearnedRule): void {
    if (this.rules.some((r) => r.id === rule.id)) throw new Error('UNIQUE constraint failed: tracking_rules.id');
    this.rules.push({
      id: rule.id,
      activityId: rule.classification.contextId ?? '',
      conditions: JSON.stringify(rule.conditions),
      enabled: 1,
      priority: rule.priority,
      areaId: rule.classification.areaId,
      intentId: rule.classification.intentId,
      qualityId: rule.classification.qualityId,
      source: 'learned',
      learned: {
        candidateId: rule.candidateId,
        confirmedAt: rule.nowIso,
        userModifiedAt: null,
        correctionCount: 0,
        matchCount: 0,
        distinctDayCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
      },
    });
  }

  markConfirmed(candidateId: string, ruleId: string, nowIso: string): void {
    this.patch(candidateId, { status: 'confirmed', confirmedRuleId: ruleId, snoozedUntil: null, updatedAt: nowIso });
  }

  private patch(id: string, fields: Partial<LearnedRuleCandidate>): void {
    const index = this.candidates.findIndex((c) => c.id === id);
    if (index >= 0) this.candidates[index] = { ...this.candidates[index], ...fields };
  }
}
