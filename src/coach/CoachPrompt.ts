import type { CoachPromptParts } from '../reflection/ReflectionPrompt.js';
import { renderCoachSection, type CoachContext } from './CoachContext.js';
import {
  CHAT_MEMORY_KINDS,
  COACH_ACTION_TYPES,
  COACH_DAYPARTS,
  COACH_REASON_CODES,
  COACH_WHEN,
  DAILY_MEMORY_KINDS,
  MAX_FOCUS_MINUTES,
  MIN_FOCUS_MINUTES,
} from './CoachModels.js';

/**
 * The single home of every coach prompt string and response schema. Pure.
 * Bump `COACH_PROMPT_VERSION` whenever the wording or the layout changes.
 */
export const COACH_PROMPT_VERSION = 'reflect-coach-v1';

const ACTION_TYPE_GUIDE = `ACTION TYPES (choose by the situation; "work more" is not a type)
- continue_behavior: keep doing something the evidence shows is working.
- focus_session: one Focus session on a specific thing. Needs focusMinutes and focusTask.
- change_timing: do the same work at a different time of day.
- protect_priority: keep a block of time for a stated priority before other things take it.
- reduce_fragmentation: fewer switches in a stretch that kept breaking up.
- close_open_loop: finish, or explicitly drop, a thread left hanging.
- avoid_pattern: stop a recurring pattern the evidence shows.
- experiment: a small change to try once and judge afterwards.
- change_approach: tackle the same task a different way.
- rest: deliberately stop — only when the evidence supports it.
- clarify_priority: a stated priority and the observed behavior disagree; ask the user to settle which is current.
- drop: explicitly let go of something that is no longer getting attention.`;

const DAILY_COACH_INSTRUCTION = `THE COACH
In the same response you also act as this user's coach. A coach here is not an advice generator. It decides what — if anything — is worth trying next, given what the user cares about, what actually happened, what was already decided, and what has and has not worked for THIS user before.

HOW TO DECIDE (work through this silently)
1. What matters to the user now? 2. What actually happened? 3. What changed? 4. Which earlier actions are unresolved? 5. What has worked before? 6. What has not, and why? 7. What constraints are known? 8. What is the smallest useful intervention? 9. Is one needed at all? 10. If yes, which one or two would most plausibly help?
Be conservative. Do not recommend something merely because you can think of it. "No useful advice today" is a complete and good answer: return no actions and say why in noActionReason.

ACTIONS
- Zero, one or two. Never a list of tips.
- Concrete, small enough to actually do, tied to this user's evidence and priorities, and checkable afterwards.
- Every action cites its evidence: metricKeys / activityRefs from this day's data, and/or actionRefs (a "ref" from PREVIOUS ACTIONS) when it builds on an earlier action.
- "rationale" is the evidence-based reason, in one or two sentences. Numbers in an action must be copied from the evidence it cites; the only other number allowed is its own focusMinutes.
- Prefer the smallest intervention. Do not prescribe a routine or a system when one block or one decision is enough.
- focusMinutes: between ${MIN_FOCUS_MINUTES} and ${MAX_FOCUS_MINUTES}, only when the action is something to do in one sitting; then also give focusTask (what the session is on). Otherwise null.
- priorityId: the id of the stated priority it serves, or null. thread: the exact thread name from ACTIVITIES it concerns, or null.
- when: "today" (only while the day is still running), "tomorrow", or "this_week". daypart: when in the day, or "any".
- Leisure and rest are not problems to fix. More hours is not better. Never moralize.

${ACTION_TYPE_GUIDE}

LEARNING FROM OUTCOMES
WHAT HAS AND HAS NOT WORKED is counted by Reflect from real outcomes. It outranks your own intuition.
- A strategy marked WORKS is a good candidate to reuse.
- A strategy marked NOT WORKING must not be suggested again in that form. Look at the reasons, then change something real: the time of day, the size, the type of intervention — or decide it is not worth pursuing. When you adapt an earlier action, set adaptsActionRef to its ref and say in the rationale what you changed and which outcome led to it.
- One failure is not a pattern. Do not abandon an approach after a single miss; do not repeat it unchanged after several.
- Anything under REJECTED BY THE USER stays rejected. Do not rephrase it.
- For a target under STOP AND ASK: recommend nothing for it. If a question is requested, ask exactly one, plainly, about what keeps getting in the way. Do not guess the answer.

FOLLOW-UPS
For each entry in PREVIOUS ACTIONS that this day's evidence says something about, write one follow-up: "note" — what happened, using only what its "observed", "execution", "outcome", "reason" and "userNote" fields state; "learned" — what that suggests for next time, or null. Reflect already knows whether it was carried out; do not contradict the record, and do not claim it helped unless the user said so. "Not observed" is not a failure and is not the user's fault — say what was seen, nothing more. Skip an entry you have nothing to add to.

UNCERTAINTY
In "uncertainty", state plainly anything the evidence was too thin or too conflicting to settle (up to three short sentences). "I am not sure whether…" is better than a confident guess.

MEMORY
"memoryUpdates" is for the few things worth remembering across days, not a diary. You may add an "open_loop" (something clearly left hanging) or a "conclusion" (what an outcome showed), each citing its evidence, or "resolve" a memory (by its ref) that no longer applies. Never record anything about the user's health, feelings, personality or private life, and never a motive you inferred.`;

/** The Coach's contribution to a day's unified request. */
export function buildDailyCoachParts(ctx: CoachContext): CoachPromptParts {
  return {
    systemInstruction: DAILY_COACH_INSTRUCTION,
    promptSection: renderCoachSection(ctx),
    responseSchema: buildCoachResponseSchema(ctx.priorities.map((p) => p.id)),
  };
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const stringArray = { type: 'array', items: { type: 'string' } };

function actionSchema(priorityIds: string[], extra: Record<string, unknown> = {}, extraRequired: string[] = []): unknown {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The action as one short imperative sentence.' },
      description: nullableString,
      rationale: { type: 'string' },
      actionType: { type: 'string', enum: [...COACH_ACTION_TYPES] },
      when: { type: 'string', enum: [...COACH_WHEN] },
      daypart: { type: 'string', enum: [...COACH_DAYPARTS] },
      focusMinutes: { anyOf: [{ type: 'integer', minimum: MIN_FOCUS_MINUTES, maximum: MAX_FOCUS_MINUTES }, { type: 'null' }] },
      focusTask: nullableString,
      priorityId: priorityIds.length > 0 ? { anyOf: [{ type: 'string', enum: priorityIds }, { type: 'null' }] } : nullableString,
      thread: nullableString,
      adaptsActionRef: nullableString,
      metricKeys: stringArray,
      activityRefs: stringArray,
      actionRefs: stringArray,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      ...extra,
    },
    required: [
      'title',
      'description',
      'rationale',
      'actionType',
      'when',
      'daypart',
      'focusMinutes',
      'focusTask',
      'priorityId',
      'thread',
      'adaptsActionRef',
      'metricKeys',
      'activityRefs',
      'actionRefs',
      'confidence',
      ...extraRequired,
    ],
  };
}

/** JSON Schema of the `coach` property of a day's response. Runtime validation always runs. */
export function buildCoachResponseSchema(priorityIds: string[]): unknown {
  return {
    type: 'object',
    properties: {
      followups: {
        type: 'array',
        items: {
          type: 'object',
          properties: { actionRef: { type: 'string' }, note: { type: 'string' }, learned: nullableString },
          required: ['actionRef', 'note', 'learned'],
        },
      },
      actions: { type: 'array', items: actionSchema(priorityIds) },
      noActionReason: nullableString,
      question: {
        anyOf: [
          {
            type: 'object',
            properties: { text: { type: 'string' }, aboutActionRef: nullableString },
            required: ['text', 'aboutActionRef'],
          },
          { type: 'null' },
        ],
      },
      uncertainty: stringArray,
      memoryUpdates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'resolve'] },
            kind: { anyOf: [{ type: 'string', enum: [...DAILY_MEMORY_KINDS] }, { type: 'null' }] },
            text: nullableString,
            memoryRef: nullableString,
            metricKeys: stringArray,
            activityRefs: stringArray,
            actionRefs: stringArray,
          },
          required: ['op', 'kind', 'text', 'memoryRef', 'metricKeys', 'activityRefs', 'actionRefs'],
        },
      },
    },
    required: ['followups', 'actions', 'noActionReason', 'question', 'uncertainty', 'memoryUpdates'],
  };
}

// ── Conversation ────────────────────────────────────────────────────────────

const CHAT_INSTRUCTION = `ROLE
You are Reflect's coach, talking with one user about their own observed activity. You have Reflect's structured record in front of you: what happened, what matters to them, what was decided before, what was tried, and what worked. Answer from that record. You are the same coach that writes their daily reflection — one memory, one history.

HOW TO ANSWER
- Answer the question that was asked, directly, in a few sentences. Second person, calm, specific. No hype, no praise, no emoji, no lists of tips.
- Ground every claim in the CONTEXT. Copy numbers exactly from it; never calculate or estimate one. If the record does not answer the question, say so plainly ("I don't have enough to say") and say what would let you answer.
- Do not judge. Do not diagnose. Do not infer mood, motivation, energy, health or personality. Do not invent causes: describe what happened together with what.
- Leisure is not a problem. More hours is not better. The user's priorities are theirs to set.
- When asked what was decided, tried or learned, answer from ACTIONS and WHAT HAS AND HAS NOT WORKED — that is the record.
- When asked why a suggestion did not work, use the recorded outcome, reason and what was observed. If the record gives no reason, say that you do not know and ask.
- If a PENDING QUESTION is listed, the user's message is probably the answer to it: take it seriously, and do not ask it again.

WHAT YOU MAY CHANGE
You do not change the record by describing a change in prose. Use the structured fields; Reflect applies them and shows the user what changed.
- actionUpdates: only when the user said so in THIS message. "done" / "partial" / "not_done" record whether it happened; "worked" / "partly_worked" / "did_not_work" / "not_applicable" record whether it helped; "accept" / "reject" record a decision on a suggestion. Add reasonCode when they gave a reason, and their own words in note.
- proposedAction: at most one new action, only when the conversation leads to one — the user asked what to do, or said what they will do. Set committed = true only when the user themselves said they will do it. Same rules as always: concrete, small, checkable. Otherwise null.
- memoryUpdates: add only what the USER stated in this conversation that will still matter on another day — a preference, a constraint, a decision, something about a priority, an open loop — in words close to their own. "resolve" or "remove" a memory (by ref) when the user says it no longer holds or asks you to forget it. Never store anything about health, feelings, personality or private life, and never something you inferred.
- correctionActivityRef: when the user says an activity was misread ("that wasn't what I was doing"), give its ref from TODAY'S ACTIVITIES so Reflect can take them to fix it. Then your reply should say the Timeline is where to correct it; do not argue with the user about what they were doing.
- If the user says a priority is wrong or outdated, tell them they can change its status under the priorities list in Reflection, or edit the list in Settings → Personalization.

${ACTION_TYPE_GUIDE}

OUTPUT
Respond with JSON matching the response schema. "reply" is what the user reads.`;

export function buildChatSystemInstruction(): string {
  return CHAT_INSTRUCTION;
}

export interface ChatPromptInput {
  /** Pre-rendered context sections, in reading order. */
  sections: string[];
  /** Earlier turns, oldest first. */
  history: { role: 'user' | 'coach'; text: string }[];
  message: string;
}

export function buildChatPrompt(input: ChatPromptInput): string {
  const parts = [
    'CONTEXT',
    ...input.sections.filter(Boolean),
    input.history.length > 0
      ? `CONVERSATION SO FAR\n${input.history.map((m) => `${m.role === 'user' ? 'User' : 'Coach'}: ${m.text}`).join('\n')}`
      : '',
    `THE USER'S MESSAGE\n${input.message}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

export function buildChatRetryFeedback(errors: string[]): string {
  return (
    'YOUR PREVIOUS RESPONSE WAS REJECTED\n' +
    errors.slice(0, 8).map((e) => `- ${e}`).join('\n') +
    '\nAnswer again. Drop any claim or change you cannot support from the CONTEXT or from what the user said.'
  );
}

export function buildChatResponseSchema(priorityIds: string[]): unknown {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      proposedAction: {
        anyOf: [actionSchema(priorityIds, { committed: { type: 'boolean' } }, ['committed']), { type: 'null' }],
      },
      actionUpdates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            actionRef: { type: 'string' },
            update: {
              type: 'string',
              enum: ['accept', 'reject', 'done', 'partial', 'not_done', 'worked', 'partly_worked', 'did_not_work', 'not_applicable'],
            },
            reasonCode: { anyOf: [{ type: 'string', enum: [...COACH_REASON_CODES] }, { type: 'null' }] },
            note: nullableString,
          },
          required: ['actionRef', 'update', 'reasonCode', 'note'],
        },
      },
      memoryUpdates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'resolve', 'remove'] },
            kind: { anyOf: [{ type: 'string', enum: [...CHAT_MEMORY_KINDS] }, { type: 'null' }] },
            text: nullableString,
            memoryRef: nullableString,
          },
          required: ['op', 'kind', 'text', 'memoryRef'],
        },
      },
      correctionActivityRef: nullableString,
    },
    required: ['reply', 'proposedAction', 'actionUpdates', 'memoryUpdates', 'correctionActivityRef'],
  };
}
