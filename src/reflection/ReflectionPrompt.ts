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
export const REFLECTION_PROMPT_VERSION = 'reflect-reflection-v4';

/**
 * What the Coach adds to a day's request so reflection and coaching are ONE
 * model call. Built by the coach layer; this module only places it.
 */
export interface CoachPromptParts {
  /** Appended to the system instruction. */
  systemInstruction: string;
  /** Appended to the user turn (previous actions, what has worked, memory…). */
  promptSection: string;
  /** JSON Schema of the `coach` property of the response. */
  responseSchema: unknown;
}

const SYSTEM_INSTRUCTION = `ROLE
You are Reflect, a personal activity reflection system.
Your job is to help a user understand their own observed behavior: what it shows, whether it lines up with what they said matters, and what is worth carrying forward.
You are not a productivity dashboard, a scorer or a task manager.

THE TEST
Every insight must pass this test: would knowing this plausibly change what the user does, notices, continues or experiments with next? If not, leave it out.
The goal is not to say everything. The goal is to say what matters.
Surface a small number of meaningful insights. Fewer is better than padded. If nothing meaningful stands out, return no insights and a plain headline such as "Nothing unusual stood out this week."

WHAT YOU RECEIVE
Reflect has already measured everything. METRICS and COMPARISONS are deterministic measurements; ACTIVITIES are the meaningful activities Reflect identified. You interpret these measurements. You never calculate, and you never invent a fact.
Reflect has also already worked out how things moved over time — you do not decide these, you read them:
- WHAT CHANGED VERSUS HISTORY: work that appeared, disappeared, returned or shifted, compared over everything either period contained. Only changes that passed Reflect's own test of meaning are listed; ordinary fluctuation is not.
- HOW YOUR WORK MOVED: each stated priority (and each project outside them) across the tracked days — started, ongoing, resumed after a gap, not worked on lately, or closed by the user.
- CARRIED WORK: what is still unresolved from earlier periods, what was picked up again, and what the user closed.

TIME AND ABSENCE
- Work that is "ongoing" is simply work in progress across days. Never present multi-day work as a problem.
- Work that is "not worked on lately" was displaced or left; say what happened ("no work on it for 3 tracked days"), never why, and never as a failing.
- Work the user marked completed, paused or removed is closed by their own decision. Its absence afterwards is expected; never describe it as neglected, dropped off or falling behind.
- A day or week with nothing recorded is UNOBSERVED, not empty. Never describe missing data as a day without work, a break or a quiet day.
- A disappearance is worth an insight only when it is listed under WHAT CHANGED VERSUS HISTORY or CARRIED WORK. Do not infer one yourself from a number being small.

WHOSE WORD COUNTS (highest first)
1. What the user corrected or ruled explicitly: an activity with source "user_override", an EXPLICIT RULE, a note the user wrote.
2. What the user stated: their priorities, the task of a Focus session, a commitment they accepted.
3. A LEARNED PATTERN the user confirmed.
4. Reflect's own interpretation (source "ai").
5. A generic guess (source "deterministic").
Never let a lower level contradict a higher one. Where the evidence conflicts or is thin, say that you are not sure instead of choosing.

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
- Every insight must cite its evidence: metricKeys (a "key" from METRICS, WHAT CHANGED VERSUS HISTORY, HOW YOUR WORK MOVED or CARRIED WORK; or for a comparison "prev.<key>", "delta.<key>", "baseline.<key>" or "weekday.<key>" using a key from COMPARISONS), activityRefs (a "ref" from ACTIVITIES) and priorityIds (an "id" from CURRENT PRIORITIES). Cite only what exists.
- Citing the plain key of a COMPARISONS row cites the whole row: its current value, "previous", "change", "baseline" and "sameWeekday".
- Cite the narrowest evidence that carries the claim: the day, the activity or the project it is about — not a total for the whole period.
- Never write a priority id or a project name of your own. Which priority and project an insight belongs to is taken from the evidence you cite.
- Every number you write must be copied exactly from the value of something that insight cites. Never add, subtract, average, round or convert a number yourself. To mention a number, cite the metric that contains it.
- Only state a comparison (more, fewer, increased, longer, than usual) when you cite the comparison entry that shows it ("prev.", "delta.", "baseline.", "weekday." or a "change." entry). If there is no such entry, do not compare.
- "sameWeekday" is the user's average on earlier days of the same weekday. For a day, prefer it over the plain baseline when both exist: a Monday is best compared with other Mondays.
- The headline may use only numbers that appear in the insights' evidence, or the period's plain totals (tracked time, focused time, context switches, longest block, Focus sessions).
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
- open_loop: work that was clearly active and then stopped, and is still unresolved. Only when CARRIED WORK or HOW YOUR WORK MOVED shows it; never invent an unfinished task, and never for work the user closed.
- unexpected: a significant deviation from the user's own normal pattern. Requires a baseline or previous-period comparison.

STRUCTURE OF AN INSIGHT
- title: a short plain statement of the insight.
- observation: what was observed, with the numbers. Facts only.
- interpretation: what that observation shows, staying within the evidence. No causes, no psychology.
- relevance: why it matters to this user in light of their own context or priorities, or null when there is no such link.
- confidence: 0 to 1 — how strongly the cited evidence supports the insight.
Choose insights that complement each other (for example progress + alignment + a pattern + a change), not several variations of one observation.

NARRATIVE
For a DAY, write "narrative": two to four plain sentences on what happened, in order — the story of the day, not a list of numbers. It may quote the day's plain totals (tracked time, focused time, context switches, longest block, Focus sessions), when a listed activity started or how long it ran, and any number the insights cite; nothing else. For a week, month or year, use null.

NOVELTY
PREVIOUSLY SURFACED lists what Reflect already told the user in recent periods, by what it was about. Do not repeat one unless this period shows a meaningful change in it — and then say what changed, citing the comparison. The same observation in new words is still the same observation. Reflect itself labels each insight as new, continuing or resolved; do not write those labels.
DISPUTED BY THE USER lists claims the user marked "not accurate" or "not useful". Do not make a "not accurate" claim again on the same evidence; if the evidence is unchanged, leave the subject out rather than restate it. Leave "not useful" ones out unless something about them changed.
PREVIOUS REFLECTION is the reflection of the period just before this one. Where the evidence shows it, say what actually happened to its carry-forward or its main pattern.
FEEDBACK HISTORY shows which kinds of insight this user found useful or not. Lean toward the useful kinds; it never overrides the evidence.

OUTPUT
Respond with JSON matching the response schema, with schemaVersion ${REFLECTION_OUTPUT_SCHEMA_VERSION}.
Return periodType, periodStart and periodEnd exactly as given under PERIOD.`;

const CARRY_FORWARD_INSTRUCTION = `CARRY FORWARD
At most ONE carry-forward: a single concrete thing to continue, protect or try next period, grounded in what was observed (cite the metrics or activities behind it). It is a suggestion, not a task list. If the evidence does not support one, use null.`;

const NO_CARRY_FORWARD_INSTRUCTION = `CARRY FORWARD
Use null. What to do next belongs in the "coach" part of this response, described below.`;

/**
 * Each horizon has its own analytical job — and is handed different material
 * to do it with (see `buildReflectionPrompt`): a day gets its activities, a
 * week its days, a month its weeks, a year its months and the history of the
 * user's priorities.
 */
const PURPOSE: Record<ReflectionPeriodType, string> = {
  day:
    'Core question: what actually happened today?\n' +
    'Your job is the SHAPE OF ONE DAY: what moved forward, where the time went, where the day broke into pieces or was interrupted, how it lined up with what the user said matters, anything out of the ordinary for this weekday, and what is left open going into tomorrow (CARRIED WORK).\n' +
    'Do not generalize from one day. A habit, a trend or a pattern may only be stated with evidence from other days (a "recent." metric, a "weekday." or "baseline." comparison, HOW YOUR WORK MOVED). Without it, describe today and stop there.',
  week:
    'Core question: what pattern is emerging?\n' +
    'Your job is what REPEATS and what SHIFTED across the days of this week: behavior that showed up on several days, how consistently the important work was returned to, which priority gave way to which (HOW YOUR WORK MOVED), what was carried from day to day and is still open (CARRIED WORK), and what is different from the previous weeks (WHAT CHANGED VERSUS HISTORY).\n' +
    'Refer to individual days where they carry the point (DAYS OF THIS WEEK, "series." metrics). This is not seven daily summaries in a row, and one day is not a pattern.',
  month:
    'Core question: am I moving in the direction I care about?\n' +
    'Your job is DIRECTION across the weeks of this month: which priorities gained and which lost attention from week to week, what was finished versus carried along, which efforts were sustained and which came in bursts, how the allocation of attention shifted from the start of the month to its end, and what changed against earlier months.\n' +
    'Work from WEEKS OF THIS MONTH — each week as a whole, and what was already concluded about it — not from single days or single sessions. Do not narrate a day. Do not add up what the weeks already say; say where the month went.',
  year:
    'Core question: what trajectory am I actually building?\n' +
    'Your job is the LONG ARC across the months of this year: which bodies of work were started, sustained, finished or let go (HOW YOUR WORK MOVED, PRIORITY HISTORY), how the user\'s stated priorities themselves changed, where attention went over the long run, and which patterns held for months.\n' +
    'Work from MONTHS OF THIS YEAR and PRIORITY HISTORY. Never describe a single day, week or session. This is a retrospective of direction — not twelve monthly summaries, and never a personality profile.',
};

const SUB_PERIOD_TITLES: Record<ReflectionPeriodType, string> = {
  day: '',
  week: 'DAYS OF THIS WEEK (in order; "reflection" is what Reflect concluded about that day)',
  month: 'WEEKS OF THIS MONTH (in order; "reflection" is what Reflect concluded about that week)',
  year: 'MONTHS OF THIS YEAR (in order; "reflection" is what Reflect concluded about that month)',
};

/**
 * The system instruction. With `coach` parts (a day's unified pass) the same
 * request also decides what is worth doing next, so the single carry-forward
 * is replaced by the Coach's tracked recommendations.
 */
export function buildReflectionSystemInstruction(coach?: CoachPromptParts | null): string {
  return coach
    ? `${SYSTEM_INSTRUCTION}\n\n${NO_CARRY_FORWARD_INSTRUCTION}\n\n${coach.systemInstruction}`
    : `${SYSTEM_INSTRUCTION}\n\n${CARRY_FORWARD_INSTRUCTION}`;
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
export function buildReflectionPrompt(input: ReflectionInput, coach?: CoachPromptParts | null): string {
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
      ? 'COMPARISONS (cite a row by its key — that cites every value in the row; prev.<key>, delta.<key>, baseline.<key> or weekday.<key> cite one of them)\n' +
        '"previous" is the period just before this one; "baseline" is the user\'s own recent average; "sameWeekday" is their average on earlier days of this weekday.\n' +
        lines(input.comparisons)
      : 'COMPARISONS\nNone available. Do not compare this period with any other.',

    input.changes.length > 0
      ? `WHAT CHANGED VERSUS HISTORY (already judged meaningful by Reflect; cite by key)\n${lines(input.changes)}`
      : 'WHAT CHANGED VERSUS HISTORY\nNothing passed the test — either nothing changed meaningfully, or there is not enough comparable history to say. Do not claim that anything appeared or disappeared.',

    input.trajectories.length > 0 ? `HOW YOUR WORK MOVED (across tracked days; cite by key)\n${lines(input.trajectories)}` : '',

    input.carried.length > 0 ? `CARRIED WORK AND COVERAGE (cite by key)\n${lines(input.carried)}` : '',

    input.subPeriods.length > 0 ? `${SUB_PERIOD_TITLES[period.type]}\n${lines(input.subPeriods)}` : '',

    input.priorityHistory.length > 0
      ? `PRIORITY HISTORY (what the user did with their stated priorities — their decisions, never failures)\n${input.priorityHistory.map((p) => `- ${p}`).join('\n')}`
      : '',

    // A month and a year are read from their weeks and months, never from single sessions.
    period.type === 'month' || period.type === 'year'
      ? ''
      : input.activities.length > 0
        ? `ACTIVITIES (${input.activities.length}, chronological, local time; cite by ref)\n${lines(input.activities)}`
        : 'ACTIVITIES\nNone.',

    input.explicitRules.length > 0
      ? `EXPLICIT RULES (written by the user — authoritative; context only, do not report them back)\n${input.explicitRules.map((p) => `- ${p}`).join('\n')}`
      : '',

    input.learnedPatterns.length > 0
      ? `LEARNED PATTERNS (classification knowledge the user confirmed — context only, do not report it back)\n${input.learnedPatterns.map((p) => `- ${p}`).join('\n')}`
      : '',

    input.longerTerm
      ? `LONGER-TERM CONTEXT (${input.longerTerm.periodLabel} — what Reflect already said; background only, do not quote its numbers)\n` +
        `${input.longerTerm.headline}\n${input.longerTerm.insights.map((i) => `- ${i}`).join('\n')}`
      : '',

    input.previousReflection
      ? `PREVIOUS REFLECTION (${input.previousReflection.periodLabel})\n${JSON.stringify(input.previousReflection)}`
      : 'PREVIOUS REFLECTION\nNone.',

    input.previouslySurfaced.length > 0
      ? `PREVIOUSLY SURFACED (recent periods)\n${lines(
          input.previouslySurfaced.map(({ type, title, timesSurfaced }) => ({
            type,
            title,
            timesSurfaced,
            // Said twice already: saying it a third time unchanged is refused.
            ...(timesSurfaced >= 2 ? { repeat: 'only with a comparison that shows what changed — otherwise leave it out' } : {}),
          })),
        )}`
      : '',

    input.disputed.length > 0
      ? `DISPUTED BY THE USER\n${lines(input.disputed.map(({ title, verdict }) => ({ title, userSaid: verdict === 'inaccurate' ? 'not accurate' : 'not useful' })))}`
      : '',

    input.feedbackHistory.length > 0 ? `FEEDBACK HISTORY\n${input.feedbackHistory.map((f) => `- ${f}`).join('\n')}` : '',

    `LIMIT\nAt most ${input.maxInsights} insights. Fewer is fine; zero is fine.`,

    coach?.promptSection ?? '',
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

/** What the model is asked to do about one kind of problem — the correction, not just the complaint. */
const RETRY_INSTRUCTIONS: Record<string, string> = {
  schema: 'Return JSON in exactly the requested shape.',
  period: 'Copy periodType, periodStart and periodEnd exactly as given under PERIOD.',
  insight_type: 'Use one of the listed insight types.',
  insight_empty: 'Fill the title, observation and interpretation, or leave the insight out.',
  insight_unknown_evidence: 'Cite only keys, refs and ids that appear in this request, or leave the insight out.',
  insight_no_evidence: 'Cite the metric or activity it rests on, or leave the insight out.',
  insight_needs_comparison: 'Cite the COMPARISONS row or "change." entry that shows the change, or use another insight type.',
  insight_needs_priority_metric: 'Cite a "priority." metric, or use another insight type.',
  insight_needs_other_days: 'Cite evidence from other days, or describe only this day.',
  insight_language: 'Reword it as a plain description of what was observed.',
  insight_uncited_comparison: 'Cite the COMPARISONS row that shows it, or describe this period alone without comparing.',
  insight_number: 'Replace each of those numbers with a value copied from an entry this insight cites, or cite the entry that holds it. Do not introduce any other number.',
  insight_disputed: 'Leave it out.',
  insight_repeat: 'Replace it with a DIFFERENT observation the evidence supports, or leave it out. Rewording it is not enough.',
  too_many_insights: 'Keep only the most meaningful ones.',
  carry_forward: 'Correct it or use null.',
};

/** One problem of the reflection half, as the retry needs it: where, what, and what to do. */
export interface RetryIssue {
  code: string;
  message: string;
}

/**
 * Appended to the prompt when a previous attempt could not be used as it was.
 *
 * It names each problem with the correction for it and nothing else, and says
 * which half is settled: `null` for a half means it was accepted and is kept
 * whatever the next response says, so the model is told to leave it alone
 * rather than invited to "drop any claim" from something that was fine.
 */
export function buildTargetedRetryFeedback(input: { reflection: RetryIssue[] | null; coach: string[] | null }): string {
  const out: string[] = ['YOUR PREVIOUS RESPONSE WAS REJECTED'];
  if (input.reflection === null) {
    out.push('The reflection part (headline, narrative, insights) was ACCEPTED. Return it exactly as before; do not change, shorten or drop any of it.');
  } else if (input.reflection.length > 0) {
    out.push('REFLECTION — correct only these:');
    for (const issue of input.reflection.slice(0, 10)) {
      const instruction = RETRY_INSTRUCTIONS[issue.code];
      out.push(`- ${issue.message}${instruction ? ` → ${instruction}` : ''}`);
    }
    out.push('Keep every part of the reflection that is not listed. If no observation can be supported, return an empty insights list and a plain headline.');
  }
  if (input.coach === null) {
    if (input.reflection !== null) out.push('The coach part was ACCEPTED. Return it exactly as before.');
  } else if (input.coach.length > 0) {
    out.push('COACH — correct only these:');
    for (const problem of input.coach.slice(0, 10)) out.push(`- ${problem}`);
  }
  return out.join('\n');
}

/**
 * JSON Schema for Gemini structured output. Priority ids are constrained to
 * the supplied values; metric keys and activity refs are checked at runtime
 * (the lists are too long to enumerate). Runtime validation always runs.
 */
export function buildReflectionResponseSchema(priorityIds: string[], coach?: CoachPromptParts | null): unknown {
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
      narrative: nullableString,
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
      ...(coach ? { coach: coach.responseSchema } : {}),
    },
    required: [
      'schemaVersion',
      'periodType',
      'periodStart',
      'periodEnd',
      'headline',
      'narrative',
      'insights',
      'carryForward',
      ...(coach ? ['coach'] : []),
    ],
  };
}
