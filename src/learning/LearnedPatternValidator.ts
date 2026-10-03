import { z } from 'zod';
import type { RuleCondition } from '../categorization/Classification.js';
import { conditionKeys, isSupportedConditionType, normalizeConditions, patternMatches } from './LearnedPattern.js';
import {
  LEARNED_PATTERN_SCHEMA_VERSION,
  type LearnedRuleConfig,
  type LearningActivity,
} from './LearnedRuleModels.js';

/**
 * Runtime validation of Gemini's pattern proposal. Pure.
 *
 * Gemini proposes; nothing it returns is trusted. A proposal is accepted
 * whole or rejected whole, and a rejection never touches existing rules.
 */

const proposalSchema = z.object({
  schemaVersion: z.literal(LEARNED_PATTERN_SCHEMA_VERSION),
  conditions: z.array(z.object({ type: z.string(), value: z.string() })),
  explanation: z.string().nullish(),
  confidence: z.number().min(0).max(1),
});

export interface PatternValidationContext {
  /** The corrected activity — the evidence the pattern must be observable in. */
  activity: LearningActivity;
  config: Pick<LearnedRuleConfig, 'maxConditions' | 'maxConditionValueLength' | 'minProposalConfidence'>;
}

export type PatternValidationResult =
  /** A usable pattern: normalised, deduplicated, deterministically ordered. */
  | { ok: true; pattern: RuleCondition[]; confidence: number }
  /** Gemini found no reliable pattern, or was not confident enough. Not an error. */
  | { ok: true; pattern: null; reason: 'no_pattern' | 'low_confidence' }
  | { ok: false; errors: string[] };

export function validatePatternProposal(raw: unknown, ctx: PatternValidationContext): PatternValidationResult {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 8).map((i) => `schema: ${i.path.join('.') || '(root)'} — ${i.message}`),
    };
  }
  const proposal = parsed.data;
  const { config, activity } = ctx;

  if (proposal.conditions.length === 0) return { ok: true, pattern: null, reason: 'no_pattern' };

  const errors: string[] = [];

  if (proposal.conditions.length > config.maxConditions) {
    errors.push(`too many conditions (${proposal.conditions.length}); at most ${config.maxConditions} are allowed`);
  }

  for (const condition of proposal.conditions) {
    // Exact supported names only — no legacy aliases, nothing invented.
    if (!isSupportedConditionType(condition.type)) {
      errors.push(`unsupported condition type "${condition.type}"`);
      continue;
    }
    const value = condition.value.trim();
    if (!value) {
      errors.push(`${condition.type}: value must not be empty`);
      continue;
    }
    if (value.length > config.maxConditionValueLength) {
      errors.push(`${condition.type}: value is too long to be a reusable pattern`);
      continue;
    }
    // Observability: the deterministic matcher itself must find this
    // condition (in the form it would be stored) in the corrected activity.
    if (!patternMatches(activity, normalizeConditions([{ type: condition.type, value }]))) {
      errors.push(`${condition.type} "${value}" is not present in the corrected activity`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const pattern = normalizeConditions(proposal.conditions);
  if (pattern.length === 0) return { ok: false, errors: ['no usable condition after normalisation'] };

  // A browser alone says nothing about what was being done in it.
  if (conditionKeys(pattern).every((key) => key.startsWith('browser_equals:'))) {
    return { ok: false, errors: ['a browser on its own is too broad to be a pattern'] };
  }

  // The pattern as a whole must recognise the activity it was learned from.
  if (!patternMatches(activity, pattern)) {
    return { ok: false, errors: ['the conditions together do not match the corrected activity'] };
  }

  if (proposal.confidence < config.minProposalConfidence) {
    return { ok: true, pattern: null, reason: 'low_confidence' };
  }

  return { ok: true, pattern, confidence: proposal.confidence };
}
