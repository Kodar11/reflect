import {
  REFLECTION_INSIGHT_TYPES,
  REFLECTION_OUTPUT_SCHEMA_VERSION,
  type ReflectionInput,
  type ReflectionPeriodType,
} from './ReflectionModels.js';

/**
 * The single home of every reflection prompt string and of the
 * structured-output schema. Pure. Bump `REFLECTION_PROMPT_VERSION` whenever
 * the wording or the input layout changes so persisted reports stay
 * attributable to the prompt that produced them.
 */
export const REFLECTION_PROMPT_VERSION = 'reflect-reflection-v1';

const SYSTEM_INSTRUCTION = `ROLE
You are Reflect, a personal activity reflection system.
Your job is to help a user understand their own observed behavior: what it shows, whether it lines up with what they said matters, and what is worth carrying forward.
You are not a productivity dashboard, a scorer, a coach or a task manager.

THE TEST
Every insight must pass this test: would knowing this plausibly change what the user does, notices, continues or experiments with next? If not, leave it out.
The goal is not to say everything. The goal is to say what matters.
Surface a small number of meaningful insights. Fewer is better than padded. If nothing meaningful stands out, return no insights and a plain headline such as "Nothing unusual stood out this week."

WHAT YOU RECEIVE
Reflect has already measured everything. METRICS and COMPARISONS are deterministic measurements; ACTIVITIES are the meaningful activities Reflect identified. You interpret these measurements. You never calculate, and you never invent a fact.

PRINCIPLES
- Do not judge the user. Do not impose your own definition of productivity.
- Do not assume leisure is bad. Leisure, gaming, video and social activity are neutral facts; mention them only when the evidence makes them relevant, and never as something to fix.
- Do not infer psychology, motivation, mood, energy, health, intelligence or competence. Reflect has no evidence for any of them.
- Do not invent causes. Describe what happened together ("coincided with", "during", "alongside"); never say one thing caused another.
- Use the user's own stated priorities as the reference frame, and only when they genuinely add relevance. Many good insights have nothing to do with priorities.
- Describe; do not tell the user their priorities are wrong.
- Prefer evidence over advice. No generic self-help (breaks, water, sleep, Pomodoro, waking earlier, deleting apps).
- Do not repeat the same insight in different wording.

EVIDENCE RULES
- Every insight must cite its evidence: metricKeys (a "key" from METRICS, or for a comparison "prev.<key>", "delta.<key>" or "baseline.<key>" using a key from COMPARISONS), activityRefs (a "ref" from ACTIVITIES) and priorityIds (an "id" from CURRENT PRIORITIES). Cite only what exists.
- Every number you write must be copied exactly from the value of something that insight cites. Never add, subtract, average, round or convert a number yourself. To mention a number, cite the metric that contains it.
- Only state a comparison (more, fewer, increased, longer, than usual) when you cite the comparison entry that shows it. If COMPARISONS has no such entry, do not compare.
- The headline may use only numbers that appear in the insights' evidence.
- A time linked to a priority counts only the activities Reflect linked to it. Say "linked to" or "went toward"; do not claim it is everything the user did for that priority.

LANGUAGE RULES
- Never write: because, caused, due to, led to, as a result, resulted in, thanks to.
- Never write: wasted, unproductive, productive/productivity score, more productive, less productive, lazy, procrastinating, distracted, tired, stressed, burned out, unmotivated, should have, failed to.
- Write plainly and specifically, in the second person ("you"), like a calm briefing. No hype, no praise, no emoji.

PRIORITIES
CURRENT PRIORITIES are what the user told Reflect matters. A priority with possiblyStale = true has not been reconfirmed for a long time and may no longer be current: do not describe behavior as diverging from it; at most note neutrally how much time went toward it.
When CURRENT PRIORITIES is empty, do not write a priority_alignment insight.

INSIGHT TYPES (use the one that fits; not every period needs every type)
- progress: what moved forward.
- priority_alignment: what the user said matters vs where meaningful time went.
- time_attention_pattern: when and how attention was spent (time of day, length of blocks).
- fragmentation: where the period broke into many switches.
- consistency_momentum: how steadily something was returned to.
- recurring_behavior: a behavior that shows up repeatedly.
- change_over_time: what changed versus the previous period or the personal baseline. Requires a comparison.
- open_loop: a thread that was clearly active and then stopped. Only with evidence; never invent an unfinished task.
- unexpected: a significant deviation from the user's own normal pattern. Requires a baseline or previous-period comparison.

STRUCTURE OF AN INSIGHT
- title: a short plain statement of the insight.
- observation: what was observed, with the numbers. Facts only.
- interpretation: what that observation shows, staying within the evidence. No causes, no psychology.
- relevance: why it matters to this user in light of their own context or priorities, or null when there is no such link.
- suggestedAction: leave null. The single action belongs in carryForward.
- confidence: 0 to 1 — how strongly the cited evidence supports the insight.
Choose insights that complement each other (for example progress + alignment + a pattern + a change), not several variations of one observation.

CARRY FORWARD
At most ONE carry-forward: a single concrete thing to continue, protect or try next period, grounded in what was observed (cite the metrics or activities behind it). It is a suggestion, not a task list. If the evidence does not support one, use null.

NOVELTY
PREVIOUSLY SURFACED lists claims Reflect already made in recent periods. Do not repeat one unless this period shows a meaningful change in it — and then say what changed, citing the comparison.
PREVIOUS REFLECTION is the reflection of the period just before this one. Where the evidence shows it, say what actually happened to its carry-forward or its main pattern.
FEEDBACK HISTORY shows which kinds of insight this user found useful or not. Lean toward the useful kinds; it never overrides the evidence.

OUTPUT
Respond with JSON matching the response schema, with schemaVersion ${REFLECTION_OUTPUT_SCHEMA_VERSION}.
Return periodType, periodStart and periodEnd exactly as given under PERIOD.`;

const PURPOSE: Record<ReflectionPeriodType, string> = {
  day:
    'Core question: what actually happened today?\n' +
    'Look at what moved forward, how time was allocated, where the day fragmented, anything notable, and what to carry into tomorrow.',
  week:
    'Core question: what pattern is emerging?\n' +
    'Look at progress across the week, alignment with current priorities, recurring behavior, fragmentation patterns, consistency, what changed from the previous week, and one useful thing to carry into next week. This is not a longer daily summary.',
  month:
    'Core question: am I moving in the direction I care about?\n' +
    'Look at progress against stated priorities, sustained versus inconsistent effort, which threads received attention, how behavior evolved across the month, meaningful changes versus the previous month, and a strategic carry-forward.',
  year:
    'Core question: what trajectory am I actually building?\n' +
    'Look at the threads that received sustained attention, how behavior evolved, priorities versus actual behavior, recurring long-term patterns and major shifts. This is a retrospective of the whole year, not twelve monthly summaries, and never a personality profile.',
};

export function buildReflectionSystemInstruction(): string {
  return SYSTEM_INSTRUCTION;
}

/** One compact JSON object per line. */
function lines(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

function userContextSection(context: ReflectionInput['userContext']): string {
  if (!context) return 'USER CONTEXT\nNot provided. Assume nothing about the user.';
  const out: string[] = [];
  if (context.roles.length) out.push(`Who the user is: ${context.roles.join(', ')}`);
  if (context.description) out.push(`In their words: ${context.description}`);
  if (context.currentWork.length) out.push(`Currently working on: ${context.currentWork.join(', ')}`);
  if (context.interests.length) out.push(`Outside work or study: ${context.interests.join(', ')}`);
  if (context.additionalContext) out.push(`Interpretation notes: ${context.additionalContext}`);
  return out.length > 0
    ? `USER CONTEXT (provided by the user about themselves)\n${out.join('\n')}`
    : 'USER CONTEXT\nNot provided. Assume nothing about the user.';
}

/** The per-report user turn: purpose, context, then the measured evidence. */
export function buildReflectionPrompt(input: ReflectionInput): string {
  const { period } = input;
  const sections: string[] = [
    `PERIOD\n${JSON.stringify({ periodType: period.type, periodStart: period.start, periodEnd: period.end })}\n` +
      `${period.label}.` +
      (period.isPartial
        ? ` This period is still in progress; the data covers it up to ${period.coveredUntil}. Speak about it "so far" and do not treat it as complete.`
        : ''),

    `PURPOSE OF THIS REFLECTION\n${PURPOSE[period.type]}`,

    userContextSection(input.userContext),

    input.currentPriorities.length > 0
      ? `CURRENT PRIORITIES (stated by the user; they applied during this period)\n${lines(input.currentPriorities)}`
      : 'CURRENT PRIORITIES\nNone stated.',

    input.notes.length > 0 ? `DATA NOTES (limits of what is known)\n${input.notes.map((n) => `- ${n}`).join('\n')}` : '',

    `METRICS (deterministic; cite by key, quote the value exactly)\n${lines(input.metrics)}`,

    input.comparisons.length > 0
      ? 'COMPARISONS (cite as prev.<key>, delta.<key> or baseline.<key>)\n' +
        '"previous" is the period just before this one; "baseline" is the user\'s own recent average.\n' +
        lines(input.comparisons)
      : 'COMPARISONS\nNone available. Do not compare this period with any other.',

    input.activities.length > 0
      ? `ACTIVITIES (${input.activities.length}, chronological, local time; cite by ref)\n${lines(input.activities)}`
      : 'ACTIVITIES\nNone.',

    input.learnedPatterns.length > 0
      ? `LEARNED PATTERNS (classification knowledge the user confirmed — context only, do not report it back)\n${input.learnedPatterns.map((p) => `- ${p}`).join('\n')}`
      : '',

    input.previousReflection
      ? `PREVIOUS REFLECTION (${input.previousReflection.periodLabel})\n${JSON.stringify(input.previousReflection)}`
      : 'PREVIOUS REFLECTION\nNone.',

    input.previouslySurfaced.length > 0
      ? `PREVIOUSLY SURFACED (recent periods)\n${lines(input.previouslySurfaced.map(({ type, title, timesSurfaced }) => ({ type, title, timesSurfaced })))}`
      : '',

    input.feedbackHistory.length > 0 ? `FEEDBACK HISTORY\n${input.feedbackHistory.map((f) => `- ${f}`).join('\n')}` : '',

    `LIMIT\nAt most ${input.maxInsights} insights. Fewer is fine; zero is fine.`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** Appended to the prompt when a previous attempt was rejected locally. */
export function buildReflectionRetryFeedback(errors: string[]): string {
  return (
    'YOUR PREVIOUS RESPONSE WAS REJECTED\n' +
    errors.slice(0, 10).map((e) => `- ${e}`).join('\n') +
    '\nProduce a corrected response. Drop any claim you cannot support with the cited evidence.'
  );
}

/**
 * JSON Schema for Gemini structured output. Priority ids are constrained to
 * the supplied values; metric keys and activity refs are checked at runtime
 * (the lists are too long to enumerate). Runtime validation always runs.
 */
export function buildReflectionResponseSchema(priorityIds: string[]): unknown {
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const stringArray = { type: 'array', items: { type: 'string' } };
  const priorityArray =
    priorityIds.length > 0 ? { type: 'array', items: { type: 'string', enum: priorityIds } } : { type: 'array', items: { type: 'string' } };
  return {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      periodType: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      periodStart: { type: 'string', description: 'ISO-8601 timestamp, exactly as given' },
      periodEnd: { type: 'string', description: 'ISO-8601 timestamp, exactly as given' },
      headline: { type: 'string' },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...REFLECTION_INSIGHT_TYPES] },
            title: { type: 'string' },
            observation: { type: 'string' },
            interpretation: { type: 'string' },
            relevance: nullableString,
            suggestedAction: nullableString,
            metricKeys: stringArray,
            activityRefs: stringArray,
            priorityIds: priorityArray,
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'type',
            'title',
            'observation',
            'interpretation',
            'relevance',
            'suggestedAction',
            'metricKeys',
            'activityRefs',
            'priorityIds',
            'confidence',
          ],
        },
      },
      carryForward: {
        anyOf: [
          {
            type: 'object',
            properties: {
              text: { type: 'string' },
              sourceMetricKeys: stringArray,
              sourceActivityRefs: stringArray,
            },
            required: ['text', 'sourceMetricKeys', 'sourceActivityRefs'],
          },
          { type: 'null' },
        ],
      },
    },
    required: ['schemaVersion', 'periodType', 'periodStart', 'periodEnd', 'headline', 'insights', 'carryForward'],
  };
}
