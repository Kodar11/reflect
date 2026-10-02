import type { AllowedTaxonomy, AnalysisPromptInput, TaxonomyEntry } from './IntelligenceModels.js';
import { INTELLIGENCE_SCHEMA_VERSION } from './IntelligenceModels.js';

/**
 * The single home of every prompt string and of the structured-output schema.
 * Pure. Bump `PROMPT_VERSION` whenever the wording or the input layout
 * changes so persisted runs stay attributable to the prompt that produced
 * them.
 */
export const PROMPT_VERSION = 'reflect-activities-v1';

export function buildSystemInstruction(): string {
  return SYSTEM_INSTRUCTION;
}

const SYSTEM_INSTRUCTION = `ROLE
You are Reflect, a productivity understanding system.
Your job is to reconstruct what the user actually did from observed desktop activity.
The goal is a meaningful timeline of real human activities, not a list of application names.

PRIMARY OBJECTIVE
Infer meaningful activities from multiple pieces of evidence over time.
An activity represents one coherent underlying task or purpose.
Application switches do not automatically imply activity changes. For example
VS Code → Chrome → ChatGPT → Terminal → VS Code can all belong to the same activity when the evidence indicates continuity.
Conversely, the same application can contain several distinct activities: VS Code / Project A followed by VS Code / Project B may be two activities.

EVIDENCE PRINCIPLES
Weigh evidence in roughly this order:
1. Explicit user rules
2. Strong project / path / title / domain evidence
3. Focus task, when available
4. Multi-event continuity
5. Application / domain identity
6. Temporal continuity
Do not classify based only on application reputation. Do not assume that VS Code = work, YouTube = leisure, Chrome = browsing, or that ChatGPT implies one specific intent.
Applications are evidence, not conclusions.
A Focus task is evidence, not absolute truth: it should influence interpretation, but the observed activity determines what happened.

ACTIVITY BOUNDARY RULE
Create a new activity when the underlying user purpose changes.
Do NOT create a new activity merely because the user changed applications, opened a browser, used ChatGPT, used a terminal, briefly switched windows, or needed several tools for the same task.
Do create a new activity when the evidence supports a meaningful change in purpose, task or context.
Short interruptions generally stay part of the surrounding activity unless the evidence clearly supports a separate activity.

CONTINUITY RULE
The analysis window boundary is NOT an activity boundary.
PREVIOUS ACTIVITIES lists the most recent activities already recorded. If the evidence at the start of this window continues one of them, set continuationOfActivityId to that activity's existing id.
Do NOT invent a second activity for the same ongoing work. Use each previous id at most once, and use null for a genuinely new activity.

AMBIGUITY RULE
Do not fabricate certainty. When evidence is ambiguous: choose the most evidence-supported interpretation, lower the confidence, optionally describe the uncertainty briefly, and use null for a classification dimension when necessary.
Do not invent a project or purpose the evidence does not support. A modest but true title such as "Software development" is better than a fabricated specific task.

CLASSIFICATION RULE
For every activity determine Context, Area, Intent and Quality, using ONLY ids listed under ALLOWED CLASSIFICATIONS. Never invent an id; use null when no listed value fits or evidence is insufficient.
Context = one of the user's existing activity contexts.
Area, Intent, Quality = the taxonomies supplied by Reflect.
Quality describes the nature of the observed work pattern, not a moral judgment. Do NOT mark something "Distracting" merely because it is leisure. Do NOT mark something "Deep Work" merely because it happened in a coding application. Use actual evidence: continuity, interruptions, purpose, and focus context.

USER RULE PRIORITY
USER RULES were explicitly defined by the user and override generic assumptions. Evidence matching a user rule must be interpreted consistently with that rule.

TIMELINE QUALITY
The result is shown as a timeline. Looking at the sequence of activities, the user should understand where the hour actually went.
Prefer meaningful titles such as "Implement Reflect Gemini integration", "Research React Native architecture", "Study Game Theory" or "Design Reflect timeline UI" over "VS Code", "Chrome" or "Browser activity" — provided the evidence supports the richer description.

NO JUDGMENT
Do not invent psychological explanations. Do not infer motivation, mood, health, intelligence, or unrelated personal traits. Only interpret observed activity.

OUTPUT RULES
Respond with JSON matching the response schema, with schemaVersion ${INTELLIGENCE_SCHEMA_VERSION}.
- temporaryId: a short local label such as "a1". It is never stored.
- eventIds: only ids that appear under EVENTS, each in at most one activity, no duplicates. Every activity needs at least one event.
- Activities are listed in chronological order and must not overlap in time: all events of one activity come before all events of the next. If the user returns to an earlier task after a genuinely different activity, list it as a new activity.
- startedAt / endedAt: ISO-8601 timestamps bounding the activity's events, startedAt before endedAt.
- title: a short, specific, human description of the activity.
- summary: one sentence about what was done.
- confidence: a number from 0 to 1 for the interpretation as a whole.
- uncertainty: optional short notes such as "Project name inferred from window title". Never include step-by-step reasoning.
- unassignedEventIds: ids that cannot be meaningfully assigned. Use sparingly, only for genuinely noisy or ambiguous evidence.`;

/** The per-window user turn: context blocks followed by the raw evidence. */
export function buildAnalysisPrompt(input: AnalysisPromptInput): string {
  const sections: string[] = [
    `ANALYSIS WINDOW\n${JSON.stringify({ windowStart: input.windowStart, windowEnd: input.windowEnd })}\n` +
      'Events are shown clipped to this window; an event may have started before it or continue after it.',

    `USER CONTEXT\n${JSON.stringify(input.userContext)}`,

    input.userRules.length > 0
      ? `USER RULES (explicitly created by the user)\n${lines(input.userRules)}`
      : 'USER RULES\nNone. The user has not defined any personal rules.',

    input.previousActivities.length > 0
      ? `PREVIOUS ACTIVITIES (already recorded, most recent last)\n${lines(input.previousActivities)}`
      : 'PREVIOUS ACTIVITIES\nNone. Every activity in this window is new (continuationOfActivityId = null).',

    input.focus.length > 0
      ? `FOCUS SESSIONS overlapping this window (evidence, not truth)\n${lines(input.focus)}`
      : 'FOCUS SESSIONS\nNone.',

    'ALLOWED CLASSIFICATIONS (use only these ids, or null)\n' +
      `contexts: ${JSON.stringify(input.taxonomy.contexts)}\n` +
      `areas: ${JSON.stringify(input.taxonomy.areas)}\n` +
      `intents: ${JSON.stringify(input.taxonomy.intents)}\n` +
      `qualities: ${JSON.stringify(input.taxonomy.qualities)}`,

    `EVENTS (${input.events.length}, chronological)\n${lines(input.events)}`,
  ];
  return sections.join('\n\n');
}

/** Appended to the prompt when a previous attempt was rejected locally. */
export function buildRetryFeedback(errors: string[]): string {
  return (
    'YOUR PREVIOUS RESPONSE WAS REJECTED\n' +
    errors.slice(0, 8).map((e) => `- ${e}`).join('\n') +
    '\nProduce a corrected response that follows every output rule.'
  );
}

/**
 * JSON Schema for Gemini structured output. Classification ids and
 * continuation ids are constrained to the supplied values, so the model
 * cannot emit an id Reflect did not offer. Runtime validation still runs.
 */
export function buildResponseJsonSchema(taxonomy: AllowedTaxonomy, previousActivityIds: string[]): unknown {
  const isoString = { type: 'string', description: 'ISO-8601 timestamp' };
  return {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      windowStart: isoString,
      windowEnd: isoString,
      activities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            temporaryId: { type: 'string' },
            continuationOfActivityId: nullableEnum(previousActivityIds),
            startedAt: isoString,
            endedAt: isoString,
            title: { type: 'string' },
            summary: { type: 'string' },
            eventIds: { type: 'array', items: { type: 'integer' } },
            contextId: nullableEnum(ids(taxonomy.contexts)),
            areaId: nullableEnum(ids(taxonomy.areas)),
            intentId: nullableEnum(ids(taxonomy.intents)),
            qualityId: nullableEnum(ids(taxonomy.qualities)),
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            uncertainty: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'temporaryId',
            'continuationOfActivityId',
            'startedAt',
            'endedAt',
            'title',
            'summary',
            'eventIds',
            'contextId',
            'areaId',
            'intentId',
            'qualityId',
            'confidence',
          ],
        },
      },
      unassignedEventIds: { type: 'array', items: { type: 'integer' } },
    },
    required: ['schemaVersion', 'windowStart', 'windowEnd', 'activities', 'unassignedEventIds'],
  };
}

function nullableEnum(values: string[]): unknown {
  if (values.length === 0) return { type: 'null' };
  return { anyOf: [{ type: 'string', enum: values }, { type: 'null' }] };
}

function ids(entries: TaxonomyEntry[]): string[] {
  return entries.map((e) => e.id);
}

/** One compact JSON object per line. */
function lines(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}
