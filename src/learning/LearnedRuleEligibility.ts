import type { RuleCondition } from '../categorization/Classification.js';
import { conditionKeys, sameClassification } from './LearnedPattern.js';
import type {
  CandidateEvidence,
  CandidateOccurrence,
  ClassificationIds,
  LearnedRuleCandidate,
  LearnedRuleConfig,
} from './LearnedRuleModels.js';

/**
 * Evidence, eligibility and suggestion choice. Pure and deterministic: no
 * clock, no randomness, no storage. `nowMs` is always passed in.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recompute a candidate's counters from its occurrence ledger. */
export function summarizeEvidence(occurrences: CandidateOccurrence[]): CandidateEvidence {
  const days = new Set<string>();
  let occurrenceCount = 0;
  let correctionCount = 0;
  let conflictCount = 0;
  let firstSeenAt: string | null = null;
  let lastSeenAt: string | null = null;
  let lastCorrectionAt: string | null = null;

  for (const o of occurrences) {
    // An activity the user classified differently is evidence AGAINST the
    // candidate; it never counts as the pattern having occurred.
    if (o.isConflict) {
      conflictCount++;
      continue;
    }
    occurrenceCount++;
    days.add(o.localDay);
    if (firstSeenAt === null || o.occurredAt < firstSeenAt) firstSeenAt = o.occurredAt;
    if (lastSeenAt === null || o.occurredAt > lastSeenAt) lastSeenAt = o.occurredAt;
    if (o.isCorrection) {
      correctionCount++;
      if (lastCorrectionAt === null || o.occurredAt > lastCorrectionAt) lastCorrectionAt = o.occurredAt;
    }
  }

  return {
    occurrenceCount,
    distinctDayCount: days.size,
    correctionCount,
    conflictCount,
    firstSeenAt,
    lastSeenAt,
    lastCorrectionAt,
  };
}

/**
 * A candidate is consistent when nothing says the same pattern means something
 * else: no matching activity was explicitly classified differently, and no
 * live sibling candidate pairs the same pattern with another classification.
 */
export function isConsistent(candidate: LearnedRuleCandidate, all: LearnedRuleCandidate[]): boolean {
  if (candidate.conflictCount > 0) return false;
  return !all.some(
    (other) =>
      other.id !== candidate.id &&
      other.patternHash === candidate.patternHash &&
      other.status !== 'dismissed' &&
      !sameClassification(other.classification, candidate.classification),
  );
}

export interface RuleForCoverage {
  enabled: boolean;
  conditions: RuleCondition[];
  classification: ClassificationIds;
}

/**
 * An enabled rule already covers a candidate when it has the same conditions
 * (whatever it classifies as — it would decide the outcome anyway), or when it
 * is broader and already yields the candidate's classification.
 */
export function isCoveredByRule(candidate: LearnedRuleCandidate, rules: RuleForCoverage[]): boolean {
  const candidateKeys = new Set(conditionKeys(candidate.conditions));
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const ruleKeys = conditionKeys(rule.conditions);
    if (ruleKeys.length === 0) continue;
    if (!ruleKeys.every((key) => candidateKeys.has(key))) continue;
    if (ruleKeys.length === candidateKeys.size) return true;
    if (sameClassification(rule.classification, candidate.classification)) return true;
  }
  return false;
}

export interface EligibilityContext {
  nowMs: number;
  config: LearnedRuleConfig;
  /** Every candidate, for the consistency check. */
  all: LearnedRuleCandidate[];
  rules: RuleForCoverage[];
}

/**
 * Why a candidate may not be suggested right now. Empty = eligible.
 *
 * Path A: ≥1 correction, ≥ minOccurrencesWithCorrection activities, ≥ minDistinctDays days.
 * Path B: ≥ minOccurrences activities, ≥ minDistinctDays days.
 * Both additionally require a consistent classification, recent evidence, a
 * live status, and no rule that already does the job.
 */
export function eligibilityBlockers(candidate: LearnedRuleCandidate, ctx: EligibilityContext): string[] {
  const { config, nowMs } = ctx;
  const blockers: string[] = [];

  if (candidate.status === 'confirmed') blockers.push('already_confirmed');
  if (candidate.status === 'dismissed') blockers.push('dismissed');
  if (candidate.status === 'snoozed') {
    const until = candidate.snoozedUntil ? Date.parse(candidate.snoozedUntil) : NaN;
    if (Number.isNaN(until) || until > nowMs) blockers.push('snoozed');
  }

  const enoughDays = candidate.distinctDayCount >= config.minDistinctDays;
  const pathA =
    candidate.correctionCount >= 1 && candidate.occurrenceCount >= config.minOccurrencesWithCorrection && enoughDays;
  const pathB = candidate.occurrenceCount >= config.minOccurrences && enoughDays;
  if (!pathA && !pathB) blockers.push('insufficient_evidence');

  if (!isConsistent(candidate, ctx.all)) blockers.push('inconsistent_classification');

  const lastSeen = candidate.lastSeenAt ? Date.parse(candidate.lastSeenAt) : NaN;
  if (Number.isNaN(lastSeen) || nowMs - lastSeen > config.recencyWindowDays * DAY_MS) blockers.push('not_recent');

  if (isCoveredByRule(candidate, ctx.rules)) blockers.push('covered_by_rule');

  return blockers;
}

export function isEligible(candidate: LearnedRuleCandidate, ctx: EligibilityContext): boolean {
  return eligibilityBlockers(candidate, ctx).length === 0;
}

/** The same candidate is not shown again until this long after its last showing. */
export function inSuggestionCooldown(candidate: LearnedRuleCandidate, nowMs: number, config: LearnedRuleConfig): boolean {
  if (!candidate.lastSuggestedAt) return false;
  const last = Date.parse(candidate.lastSuggestedAt);
  return !Number.isNaN(last) && nowMs - last < config.resuggestAfterDays * DAY_MS;
}

/**
 * Internal ordering value — never shown to the user. Built only from
 * observable evidence: corrections weigh most, then spread across days, then
 * volume, then how recently the pattern was seen; a candidate that has been
 * shown before yields to one that has not.
 */
export function relevance(candidate: LearnedRuleCandidate, nowMs: number): number {
  const lastSeen = candidate.lastSeenAt ? Date.parse(candidate.lastSeenAt) : NaN;
  const daysSinceSeen = Number.isNaN(lastSeen) ? 365 : Math.max(0, (nowMs - lastSeen) / DAY_MS);
  return (
    Math.min(candidate.correctionCount, 5) * 40 +
    Math.min(candidate.distinctDayCount, 10) * 15 +
    Math.min(candidate.occurrenceCount, 20) * 5 +
    Math.max(0, 30 - daysSinceSeen) -
    Math.min(candidate.suggestionCount, 5) * 10
  );
}

/** Most relevant first; ties broken by candidate id so the order is stable. */
export function rankCandidates(candidates: LearnedRuleCandidate[], nowMs: number): LearnedRuleCandidate[] {
  return [...candidates].sort((a, b) => {
    const diff = relevance(b, nowMs) - relevance(a, nowMs);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** No interrupting suggestion within the global cooldown of the previous one. */
export function inGlobalCooldown(lastSuggestedAtAny: string | null, nowMs: number, config: LearnedRuleConfig): boolean {
  if (!lastSuggestedAtAny) return false;
  const last = Date.parse(lastSuggestedAtAny);
  return !Number.isNaN(last) && nowMs - last < config.globalCooldownMinutes * 60_000;
}
