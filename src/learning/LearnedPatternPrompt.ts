import {
  LEARNED_PATTERN_SCHEMA_VERSION,
  SUPPORTED_CONDITION_TYPES,
  type PatternPromptInput,
} from './LearnedRuleModels.js';

/**
 * Prompt and structured-output schema for pattern extraction. Pure.
 *
 * Deliberately separate from the hourly activity-analysis prompt: this request
 * is made occasionally, for one corrected activity, and asks one question —
 * which observable conditions would recognise this kind of activity again.
 */
export const LEARNED_PATTERN_PROMPT_VERSION = 'reflect-learned-pattern-v1';

export function buildPatternSystemInstruction(): string {
  return SYSTEM_INSTRUCTION;
}

const SYSTEM_INSTRUCTION = `ROLE
You are helping Reflect learn reusable activity patterns from a user correction.
The user explicitly corrected how one activity was classified. That correction is a fact.

TASK
Identify the smallest stable, observable set of rule conditions that could recognise future occurrences of the same kind of activity — the combination of evidence that distinguishes the corrected activity from the user's other activities.
You are proposing a pattern. Reflect validates it, tracks it locally, and asks the user before it ever becomes a rule.

CONDITION TYPES (the only ones that exist)
- app_equals: the application name equals the value.
- browser_equals: the browser name equals the value.
- title_contains: the activity's primary window title contains the value.
- url_contains: the URL contains the value.
- url_starts_with: the URL starts with the value.
- domain_equals: the site's domain equals the value (no "www.", no path).
All conditions must hold together. Matching is case-insensitive.
Never use a condition type that is not listed. Never describe a pattern in prose instead of conditions.

EVIDENCE RULES
Use only evidence present in CORRECTED ACTIVITY and EVENTS. Every value must be text that actually appears there.
A title_contains value must be a fragment of PRIMARY TITLE.
Do not infer psychology, motivation, mood or unsupported intent.
Do not invent project names, relationships or meanings that the evidence does not show.

GENERALISATION
Do not memorise one exact event. A full window title such as "Lecture 7 — Prisoner's Dilemma — Game Theory" is too specific; a stable fragment such as "Game Theory" generalises.
Prefer the part of a title, path or URL that stays the same across sessions: a project or folder name, a course name, a domain.
Prefer combinations such as application + project name, domain alone, domain + title fragment, or application + title fragment.

DO NOT OVER-GENERALISE
Do not create broad patterns that would incorrectly match unrelated activities.
An application or browser on its own is usually too broad: the same editor or browser is used for many different things. Use one alone only when OTHER RECENT ACTIVITIES show nothing else done in it.
Check the proposed pattern against OTHER RECENT ACTIVITIES: it should not match those that are classified differently.
Do not repeat a pattern already listed under EXISTING RULES.

NO PATTERN
Return an empty conditions array when there is no reliable reusable pattern: the evidence is generic, mixed, or would only describe this single occasion. Returning no pattern is a correct answer. Do not invent one.

OUTPUT
Respond with JSON matching the response schema, with schemaVersion ${LEARNED_PATTERN_SCHEMA_VERSION}.
- conditions: the proposed conditions, or [] for no pattern.
- explanation: one short factual sentence naming the observable evidence used. No step-by-step reasoning.
- confidence: a number from 0 to 1 that the pattern will recognise future occurrences without matching unrelated activity.`;

/** The per-correction user turn. */
export function buildPatternPrompt(input: PatternPromptInput): string {
  const sections: string[] = [
    `CORRECTED ACTIVITY\n${JSON.stringify(input.activity)}\n` +
      'primary* fields are the dominant values of the activity; they are what conditions are matched against.',

    input.original
      ? `ORIGINAL INTERPRETATION (what Reflect had before the correction)\n${JSON.stringify(input.original)}`
      : 'ORIGINAL INTERPRETATION\nNone recorded.',

    `USER CORRECTION (explicit, authoritative)\n${JSON.stringify(input.corrected)}`,

    `EVENTS (${input.events.length} distinct observations in the corrected activity, longest first)\n${lines(input.events)}`,

    input.otherActivities.length > 0
      ? `OTHER RECENT ACTIVITIES (for contrast only — never a source of condition values)\n${lines(input.otherActivities)}`
      : 'OTHER RECENT ACTIVITIES\nNone available.',

    input.existingRules.length > 0
      ? `EXISTING RULES (already handled; do not propose these again)\n${lines(input.existingRules)}`
      : 'EXISTING RULES\nNone.',

    input.userContext
      ? `USER CONTEXT (provided by the user about themselves)\n${input.userContext}`
      : 'USER CONTEXT\nNot provided.',

    `LIMITS\nAt most ${input.maxConditions} conditions.`,
  ];
  return sections.join('\n\n');
}

/** Appended when the previous proposal was rejected locally. */
export function buildPatternRetryFeedback(errors: string[]): string {
  return (
    'YOUR PREVIOUS PROPOSAL WAS REJECTED\n' +
    errors.slice(0, 6).map((e) => `- ${e}`).join('\n') +
    '\nPropose a corrected pattern, or return an empty conditions array if no reliable pattern exists.'
  );
}

/**
 * JSON Schema for the structured response. Condition types are constrained to
 * the supported set; runtime validation still runs on whatever comes back.
 */
export function buildPatternResponseJsonSchema(maxConditions: number): unknown {
  return {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      conditions: {
        type: 'array',
        maxItems: maxConditions,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...SUPPORTED_CONDITION_TYPES] },
            value: { type: 'string' },
          },
          required: ['type', 'value'],
        },
      },
      explanation: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['schemaVersion', 'conditions', 'explanation', 'confidence'],
  };
}

/** One compact JSON object per line. */
function lines(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}
