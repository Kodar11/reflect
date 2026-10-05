import { z } from 'zod';
import { threadSlug } from '../reflection/ReflectionActivities.js';
import type { ReflectionEvidence } from '../reflection/ReflectionModels.js';
import { priorityKey } from '../reflection/ReflectionPriorities.js';
import {
  addMinutes,
  addNumbersFrom,
  clean,
  findLanguageIssue,
  unsupportedNumbers,
  type EvidenceToolkit,
} from '../reflection/ReflectionValidator.js';
import { renderActionLine, type CoachContext } from './CoachContext.js';
import { describeReasons, isBlocked } from './CoachEffectiveness.js';
import { canTransition } from './CoachLifecycle.js';
import { describeStrategy, isSameSuggestion, jaccard, resolveTarget, strategyKeyOf, targetKeyOf, titleSimilarity, tokensOf } from './CoachMatching.js';
import {
  CHAT_MEMORY_KINDS,
  COACH_ACTION_TYPES,
  COACH_DAYPARTS,
  COACH_LIMITS,
  COACH_REASON_CODES,
  COACH_VERDICTS,
  COACH_WHEN,
  DAILY_MEMORY_KINDS,
  MAX_FOCUS_MINUTES,
  MIN_FOCUS_MINUTES,
  TARGETED_ACTION_TYPES,
  type CoachAction,
  type CoachActionType,
  type CoachDaypart,
  type CoachExecution,
  type CoachMemoryKind,
  type CoachOutcome,
  type CoachReasonCode,
  type CoachVerdict,
  type CoachWhen,
} from './CoachModels.js';

/**
 * Runtime validation of everything the model says as the Coach. Pure.
 *
 * Nothing it returns is trusted. A recommendation must point at evidence that
 * exists, quote only numbers that evidence contains, stay free of judgment and
 * diagnosis — and it must not be something this user already has, already
 * turned down, or has already seen fail. The model proposes; the record
 * decides.
 *
 * Validation never throws and always returns the valid subset, so a bad coach
 * block can never take a good reflection down with it.
 */

// ── Language ────────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b(adhd|autis\w*|bipolar|ocd|dyslexi\w*|disorder|diagnos\w*|therap\w*|medicat\w*|illness|disease|insomnia|migraine)\b/i, 'a health or medical statement'],
  [/\b(religio\w*|politic\w*|sexual\w*|ethnic\w*|pregnan\w*)\b/i, 'a sensitive personal characteristic'],
  [/\b(personality|introvert\w*|extrovert\w*|perfectionis\w*|insecur\w*|self[- ]esteem|trauma\w*|lonel\w*)\b/i, 'a personality or psychological trait'],
];

/** Anything Reflect must never infer or keep about a person. */
export function findSensitiveIssue(text: string): string | null {
  for (const [re, name] of SENSITIVE_PATTERNS) if (re.test(text)) return name;
  return findLanguageIssue(text, ['psychology']);
}

const COACH_RULES = ['judgment', 'psychology', 'generic_advice'] as const;

// ── Schemas ─────────────────────────────────────────────────────────────────

const nullableText = z.preprocess((v) => (v === undefined || v === '' ? null : v), z.string().nullable());
const stringList = z.preprocess((v) => (v === undefined || v === null ? [] : v), z.array(z.string()));
const list = <T extends z.ZodTypeAny>(item: T) => z.preprocess((v) => (v === undefined || v === null ? [] : v), z.array(item));

const actionDraftSchema = z.object({
  title: z.string(),
  description: nullableText,
  rationale: z.string(),
  actionType: z.string(),
  when: z.string(),
  daypart: z.string(),
  focusMinutes: z.preprocess((v) => (v === undefined ? null : v), z.number().nullable()),
  focusTask: nullableText,
  priorityId: nullableText,
  thread: nullableText,
  adaptsActionRef: nullableText,
  metricKeys: stringList,
  activityRefs: stringList,
  actionRefs: stringList,
  confidence: z.preprocess((v) => (v === undefined ? 0.6 : v), z.number().min(0).max(1)),
  committed: z.boolean().optional(),
});

type ActionDraft = z.infer<typeof actionDraftSchema>;

/** The reasoning the model writes before its actions. Tolerated when absent; only `verdict` and `candidate` are read. */
const decisionSchema = z
  .object({ candidate: z.string().optional(), verdict: z.string().optional() })
  .passthrough()
  .nullish();

const dailySchema = z.object({
  decision: decisionSchema,
  followups: list(z.object({ actionRef: z.string(), note: z.string(), learned: nullableText })),
  actions: list(actionDraftSchema),
  noActionReason: nullableText,
  question: z.object({ text: z.string(), aboutActionRef: nullableText }).nullish(),
  uncertainty: stringList,
  memoryUpdates: list(
    z.object({
      op: z.string(),
      kind: nullableText,
      text: nullableText,
      memoryRef: nullableText,
      metricKeys: stringList,
      activityRefs: stringList,
      actionRefs: stringList,
    }),
  ),
});

const chatSchema = z.object({
  reply: z.string(),
  proposedAction: actionDraftSchema.nullish(),
  actionUpdates: list(z.object({ actionRef: z.string(), update: z.string(), reasonCode: nullableText, note: nullableText })),
  memoryUpdates: list(z.object({ op: z.string(), kind: nullableText, text: nullableText, memoryRef: nullableText })),
  correctionActivityRef: nullableText,
});

// ── Results ─────────────────────────────────────────────────────────────────

export interface ValidatedCoachAction {
  title: string;
  description: string | null;
  rationale: string;
  actionType: CoachActionType;
  daypart: CoachDaypart;
  targetStart: string;
  targetEnd: string;
  focusMinutes: number | null;
  focusTask: string | null;
  priorityId: string | null;
  thread: string | null;
  strategyKey: string;
  targetKey: string | null;
  /** The earlier action this one adapts. */
  parentActionId: string | null;
  evidence: ReflectionEvidence[];
  sourceMetricKeys: string[];
  sourceActivityIds: string[];
  confidence: number;
}

export interface ValidatedMemoryAdd {
  kind: CoachMemoryKind;
  text: string;
  targetKey: string | null;
}

export interface ValidatedCoach {
  followups: { actionId: string; note: string; learned: string | null }[];
  actions: ValidatedCoachAction[];
  noActionReason: string | null;
  question: { text: string; actionId: string | null; targetKey: string | null } | null;
  uncertainty: string[];
  memoryAdds: ValidatedMemoryAdd[];
  memoryResolveIds: string[];
}

export interface CoachValidation {
  /** True when the response was acceptable exactly as returned. */
  ok: boolean;
  /** What to tell the model on a retry. */
  errors: string[];
  /** The part that fully validated — always usable. */
  coach: ValidatedCoach;
  /** What the model concluded before writing actions, when it said. For the log; never stored or shown. */
  decision: { verdict: CoachVerdict; candidate: string | null } | null;
  /** How many actions the model proposed, before any was checked. */
  proposed: number;
}

export function emptyCoach(): ValidatedCoach {
  return { followups: [], actions: [], noActionReason: null, question: null, uncertainty: [], memoryAdds: [], memoryResolveIds: [] };
}

const DEFAULT_NO_ACTION = 'Nothing in the evidence calls for a change right now.';

// ── Shared: one action draft ────────────────────────────────────────────────

interface DraftEnvironment {
  context: CoachContext;
  /** Alias → earlier action, for `actionRefs` / `adaptsActionRef`. */
  actionRefs: Map<string, CoachAction>;
  /** Evidence rules of the day's dataset; absent in conversation. */
  evidence: EvidenceToolkit | null;
  /** Numbers allowed regardless of what is cited. */
  extraNumbers: Set<string>;
  requireEvidence: boolean;
  /** Apply what has been learned: rejections, failed strategies, escalations. */
  enforceLearning: boolean;
}

function numbersOfAction(ref: string, action: CoachAction, now: Date): Set<string> {
  const set = new Set<string>();
  addNumbersFrom(set, renderActionLine(ref, action, now));
  return set;
}

function checkActionDraft(draft: ActionDraft, label: string, env: DraftEnvironment): { action: ValidatedCoachAction | null; problems: string[] } {
  const { context } = env;
  const problems: string[] = [];

  if (!(COACH_ACTION_TYPES as readonly string[]).includes(draft.actionType)) problems.push(`${label}: unsupported action type "${draft.actionType}"`);
  const actionType = draft.actionType as CoachActionType;
  const daypart: CoachDaypart = (COACH_DAYPARTS as readonly string[]).includes(draft.daypart) ? (draft.daypart as CoachDaypart) : 'any';
  const when: CoachWhen = (COACH_WHEN as readonly string[]).includes(draft.when) ? (draft.when as CoachWhen) : 'tomorrow';

  const title = clean(draft.title, COACH_LIMITS.title);
  const description = draft.description ? clean(draft.description, COACH_LIMITS.description) || null : null;
  const rationale = clean(draft.rationale, COACH_LIMITS.rationale);
  if (title.length < 8 || isVagueTitle(title)) {
    problems.push(`${label}: title is too vague to act on — name the concrete thing to do and what it is on`);
  }
  if (rationale.length < 15) problems.push(`${label}: rationale is missing — say which evidence makes this worth doing`);

  let focusMinutes: number | null = null;
  if (draft.focusMinutes !== null) {
    if (!Number.isInteger(draft.focusMinutes) || draft.focusMinutes < MIN_FOCUS_MINUTES || draft.focusMinutes > MAX_FOCUS_MINUTES) {
      problems.push(`${label}: focusMinutes must be a whole number between ${MIN_FOCUS_MINUTES} and ${MAX_FOCUS_MINUTES}, or null`);
    } else {
      focusMinutes = draft.focusMinutes;
    }
  }
  if (actionType === 'focus_session' && draft.focusMinutes === null) problems.push(`${label}: a focus_session needs focusMinutes`);

  let priorityId: string | null = null;
  if (draft.priorityId) {
    if (context.priorities.some((p) => p.id === draft.priorityId)) priorityId = draft.priorityId;
    else problems.push(`${label}: priority "${draft.priorityId}" does not exist`);
  }
  // A thread is only a target when the evidence knows it; an unknown name is dropped, not trusted.
  const slug = draft.thread ? threadSlug(draft.thread) : '';
  const thread = slug ? context.knownThreads.find((t) => threadSlug(t) === slug) ?? null : null;
  const focusTask = focusMinutes
    ? clean(draft.focusTask ?? '', 100) || thread || context.priorities.find((p) => p.id === priorityId)?.text || null
    : null;

  // An action aimed at nothing in particular cannot be acted on, observed or learned from.
  if ((TARGETED_ACTION_TYPES as readonly string[]).includes(actionType) && priorityId === null && thread === null && !clean(draft.focusTask ?? '', 100)) {
    problems.push(`${label}: a ${actionType} action must say what it is aimed at — set priorityId, an exact thread name from ACTIVITIES, or focusTask`);
  }

  // ── Evidence ──
  const cited = env.evidence
    ? env.evidence.resolve(draft.metricKeys, draft.activityRefs, label, problems)
    : { metrics: [], activities: [] };
  const citedActions: { ref: string; action: CoachAction }[] = [];
  for (const ref of [...new Set([...draft.actionRefs, ...(draft.adaptsActionRef ? [draft.adaptsActionRef] : [])])]) {
    const action = env.actionRefs.get(ref);
    if (!action) problems.push(`${label}: action "${ref}" does not exist`);
    else citedActions.push({ ref, action });
  }
  if (env.requireEvidence && cited.metrics.length === 0 && cited.activities.length === 0 && citedActions.length === 0) {
    problems.push(`${label}: cites no evidence — every action must cite a metric, an activity or an earlier action`);
  }
  const parent = draft.adaptsActionRef ? env.actionRefs.get(draft.adaptsActionRef) ?? null : null;

  // ── Wording ──
  const everything = `${title} ${description ?? ''} ${rationale}`;
  const issue = findLanguageIssue(everything, COACH_RULES);
  if (issue) problems.push(`${label}: contains ${issue}; an action must follow from this user's evidence, without judgment`);

  const allowed = env.evidence ? env.evidence.allowedFor(cited.metrics, cited.activities) : new Set<string>();
  for (const n of env.extraNumbers) allowed.add(n);
  for (const { ref, action } of citedActions) for (const n of numbersOfAction(ref, action, context.now)) allowed.add(n);
  if (focusMinutes !== null) addMinutes(allowed, focusMinutes);
  for (const n of ['1', '2', '3']) allowed.add(n);
  const bad = unsupportedNumbers(everything, allowed);
  if (bad.length > 0) {
    problems.push(`${label}: number(s) ${bad.map((n) => `"${n}"`).join(', ')} are neither in its cited evidence nor its own focusMinutes`);
  }

  if (problems.length > 0) return { action: null, problems };

  const target = resolveTarget(when, daypart, context.reportDay, context.now);
  const candidate = {
    strategyKey: strategyKeyOf({ actionType, daypart, focusMinutes }),
    targetKey: targetKeyOf({ priorityId, thread }),
    title,
  };

  // ── What the record already says ──
  const twin = context.open.find((a) => isSameSuggestion(a, candidate, context.config.duplicateTitleOverlap));
  if (twin) {
    return { action: null, problems: [`${label}: the user already has this (“${twin.title}”); do not suggest it again`] };
  }
  if (env.enforceLearning) {
    const rejected = context.rejected.find(
      (a) =>
        isSameSuggestion(a, candidate, context.config.duplicateTitleOverlap) ||
        (a.reasonCode === 'not_relevant' && a.targetKey !== null && a.targetKey === candidate.targetKey),
    );
    if (rejected) {
      return { action: null, problems: [`${label}: the user rejected this (“${rejected.title}”); it must not come back in any wording`] };
    }
    // The user's own word that it did not help is enough, once, not to offer the very same thing again.
    const failed = context.failedRecently.find((a) => a.strategyKey === candidate.strategyKey && a.targetKey === candidate.targetKey);
    if (failed) {
      return {
        action: null,
        problems: [
          `${label}: the user said “${failed.title}” did not work${failed.reasonCode ? ` (${describeReasons({ [failed.reasonCode]: 1 })})` : ''}; ` +
            `this is the same ${describeStrategy(candidate.strategyKey)} for the same target — change the time of day, the size or the type, or leave it`,
        ],
      };
    }
    // "The timing was wrong" is about the time of day: a different kind of action at the same time repeats the failure.
    const mistimed = context.failedRecently.find((a) => a.reasonCode === 'bad_timing' && a.targetKey !== null && a.targetKey === candidate.targetKey && a.daypart !== 'any' && a.daypart === daypart);
    if (mistimed) {
      return {
        action: null,
        problems: [`${label}: the user said “${mistimed.title}” did not work because of bad timing; this is again in the ${daypart} — choose a different time of day, or leave it`],
      };
    }
    // Already done: the approach may be reused, the sentence may not. A repeat has to say what is newly open.
    const done = context.doneRecently.find((a) => a.targetKey === candidate.targetKey && titleSimilarity(a.title, candidate.title) >= context.config.duplicateTitleOverlap);
    if (done) {
      return {
        action: null,
        problems: [`${label}: the user already carried out “${done.title}” in the last few days; if something is open again, name what specifically (which item, which part) — or leave it`],
      };
    }
    // Sent before and never answered: the same thing again, the same way, is noise.
    const ignored = context.ignored.find((a) => a.strategyKey === candidate.strategyKey && a.targetKey === candidate.targetKey && isSameSuggestion(a, candidate, context.config.duplicateTitleOverlap) && titleSimilarity(a.title, candidate.title) >= context.config.duplicateTitleOverlap);
    if (ignored) {
      return {
        action: null,
        problems: [`${label}: “${ignored.title}” was suggested recently and never taken up; do not send the same thing again — make it more specific or smaller, or leave it`],
      };
    }
    const escalation = candidate.targetKey ? context.escalations.find((e) => e.targetKey === candidate.targetKey) : undefined;
    if (escalation) {
      return {
        action: null,
        problems: [`${label}: advice for “${escalation.label}” has not worked out ${escalation.failures} times; recommend nothing for it until the user has answered a question`],
      };
    }
    const blocked = isBlocked(context.effectiveness, candidate, context.config);
    if (blocked) {
      const reasons = describeReasons(blocked.reasons);
      return {
        action: null,
        problems: [
          `${label}: ${describeStrategy(candidate.strategyKey)} has not worked out ${blocked.failures} times for this user${reasons ? ` (${reasons})` : ''}; change the time of day, the size or the type — or drop it`,
        ],
      };
    }
  }

  return {
    action: {
      title,
      description,
      rationale,
      actionType,
      daypart,
      targetStart: target.start,
      targetEnd: target.end,
      focusMinutes,
      focusTask,
      priorityId,
      thread,
      strategyKey: candidate.strategyKey,
      targetKey: candidate.targetKey,
      parentActionId: parent?.id ?? null,
      evidence: [
        ...(env.evidence ? env.evidence.toEvidence(cited.metrics, cited.activities, priorityId ? [priorityId] : []) : []),
      ],
      sourceMetricKeys: cited.metrics.map((m) => m.key),
      sourceActivityIds: cited.activities.map((a) => a.id),
      confidence: draft.confidence,
    },
    problems: [],
  };
}

const VAGUE_OPENERS = /^(focus|work|study|be|stay|keep|try|improve|manage|do|get|continue|make)\b/i;
const FILLER = new Set(['more', 'better', 'harder', 'on', 'your', 'my', 'the', 'a', 'an', 'to', 'up', 'it', 'going', 'goals', 'goal', 'work', 'working', 'things', 'tasks', 'task', 'time', 'consistent', 'focused', 'productive', 'priorities', 'progress', 'making', 'good']);

/**
 * "Study more." "Focus better." "Work on your goals." "Be more consistent." —
 * an opening verb with nothing concrete after it.
 */
export function isVagueTitle(title: string): boolean {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (!VAGUE_OPENERS.test(title.trim())) return false;
  return words.slice(1).filter((w) => !FILLER.has(w)).length === 0;
}

/** Share of `of`'s tokens that also appear in `within`. */
function containment(within: Set<string>, of: Set<string>): number {
  if (of.size === 0) return 0;
  let shared = 0;
  for (const t of of) if (within.has(t)) shared++;
  return shared / of.size;
}

function isDuplicateMemory(text: string, existing: { text: string; normalizedKey: string }[]): boolean {
  const key = priorityKey(text);
  const tokens = tokensOf(text);
  return existing.some((m) => m.normalizedKey === key || jaccard(tokensOf(m.text), tokens) >= 0.7);
}

// ── Daily ───────────────────────────────────────────────────────────────────

export interface DailyCoachValidationInput {
  raw: unknown;
  context: CoachContext;
  evidence: EvidenceToolkit;
}

export function validateDailyCoach(input: DailyCoachValidationInput): CoachValidation {
  const { context, evidence } = input;
  const coach = emptyCoach();
  const parsed = dailySchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 8).map((i) => `coach: ${i.path.join('.') || '(root)'} — ${i.message}`),
      coach: withEscalationFallback(coach, context),
      decision: null,
      proposed: 0,
    };
  }
  const output = parsed.data;
  const errors: string[] = [];
  const verdict = output.decision?.verdict;
  const decision: CoachValidation['decision'] =
    verdict && (COACH_VERDICTS as readonly string[]).includes(verdict)
      ? { verdict: verdict as CoachVerdict, candidate: clean(output.decision?.candidate ?? '', 160) || null }
      : null;
  // The model's own conclusion and its output must agree. This never asks for
  // an action the model did not itself judge to be worth making.
  if (decision?.verdict === 'act' && output.actions.length === 0) {
    errors.push(
      `decision: the verdict is "act"${decision.candidate ? ` (candidate: “${decision.candidate}”)` : ''} but no action was returned — write that action, or set the verdict to "no_useful_move" and give the reason in noActionReason`,
    );
  }
  const actionRefs = new Map(context.followups.map((f) => [f.ref, f.action]));

  // ── Follow-ups: what the record supports, nothing more ──
  const seen = new Set<string>();
  output.followups.forEach((draft, index) => {
    const label = `follow-up ${index + 1}`;
    const action = actionRefs.get(draft.actionRef);
    if (!action) {
      errors.push(`${label}: action "${draft.actionRef}" does not exist`);
      return;
    }
    if (seen.has(action.id)) return;
    const note = clean(draft.note, COACH_LIMITS.followup);
    const learned = draft.learned ? clean(draft.learned, COACH_LIMITS.followup) || null : null;
    if (note.length < 10) return;
    const text = `${note} ${learned ?? ''}`;
    const issue = findLanguageIssue(text, ['judgment', 'psychology']);
    const allowed = numbersOfAction(draft.actionRef, action, context.now);
    for (const n of evidence.globalNumbers) allowed.add(n);
    const bad = unsupportedNumbers(text, allowed);
    if (issue) errors.push(`${label}: contains ${issue}; say what was observed, without judging`);
    else if (bad.length > 0) errors.push(`${label}: number(s) ${bad.map((n) => `"${n}"`).join(', ')} are not in that action's record`);
    else if (action.outcome === null && /\b(it|this|that) (worked|helped)\b/i.test(note)) {
      errors.push(`${label}: says it worked, but the user has not said whether it helped`);
    } else {
      seen.add(action.id);
      coach.followups.push({ actionId: action.id, note, learned });
    }
  });

  // ── Actions ──
  const env: DraftEnvironment = {
    context,
    actionRefs,
    evidence,
    extraNumbers: evidence.globalNumbers,
    requireEvidence: true,
    enforceLearning: true,
  };
  const accepted: ValidatedCoachAction[] = [];
  output.actions.forEach((draft, index) => {
    const result = checkActionDraft(draft, `action ${index + 1}`, env);
    if (!result.action) {
      errors.push(...result.problems);
      return;
    }
    if (result.action.confidence < context.config.minConfidence) return; // weakly supported: quietly left out
    // Two versions of one idea are one idea.
    if (accepted.some((a) => isSameSuggestion(a, result.action!, context.config.duplicateTitleOverlap))) return;
    accepted.push(result.action);
  });
  if (accepted.length > context.maxActions) {
    errors.push(`too many actions: ${accepted.length} returned, at most ${context.maxActions} allowed — keep only what matters most`);
  }
  coach.actions = [...accepted].sort((a, b) => b.confidence - a.confidence).slice(0, context.maxActions);

  // ── "No useful advice today" is an answer, and it says why ──
  if (coach.actions.length === 0) {
    const reason = output.noActionReason ? clean(output.noActionReason, COACH_LIMITS.followup) : '';
    const usable = reason.length >= 10 && !findLanguageIssue(reason, ['judgment', 'psychology']) && unsupportedNumbers(reason, evidence.globalNumbers).length === 0;
    // When the model did propose something and none of it survived, there is no honest reason to state.
    coach.noActionReason = usable ? reason : output.actions.length === 0 ? DEFAULT_NO_ACTION : null;
  }

  // ── Question: only where the record calls for one ──
  const needsAsking = context.escalations.filter((e) => !e.alreadyAsked);
  if (output.question) {
    const text = clean(output.question.text, COACH_LIMITS.question);
    const about = output.question.aboutActionRef ? actionRefs.get(output.question.aboutActionRef) ?? null : null;
    const escalation = needsAsking.find((e) => about?.targetKey === e.targetKey) ?? needsAsking[0] ?? null;
    const allowed = new Set(evidence.globalNumbers);
    for (const f of context.followups) for (const n of numbersOfAction(f.ref, f.action, context.now)) allowed.add(n);
    for (const e of context.escalations) allowed.add(String(e.failures));
    const issue = findLanguageIssue(text, ['judgment', 'psychology']) ?? (findSensitiveIssue(text) ? 'a sensitive topic' : null);
    if (text.length < 10 || !text.includes('?')) errors.push('question: must be one plain question');
    else if (issue) errors.push(`question: contains ${issue}`);
    else if (unsupportedNumbers(text, allowed).length > 0) errors.push('question: quotes a number that is not in the record');
    else if (escalation || about) {
      coach.question = {
        text,
        actionId: about?.id ?? escalation?.actionIds[escalation.actionIds.length - 1] ?? null,
        targetKey: escalation?.targetKey ?? about?.targetKey ?? null,
      };
    }
  }

  // ── Uncertainty ──
  for (const raw of output.uncertainty.slice(0, 3)) {
    const text = clean(raw, 200);
    if (text.length < 10 || findLanguageIssue(text, ['judgment', 'psychology'])) continue;
    if (unsupportedNumbers(text, evidence.globalNumbers).length > 0) continue;
    coach.uncertainty.push(text);
  }

  // ── Memory: only what evidence supports, never anything sensitive ──
  const memoryRefs = new Map(context.memories.map((m) => [m.ref, m.memory]));
  const existing = context.memories.map((m) => m.memory);
  output.memoryUpdates.slice(0, context.config.maxMemoryUpdates).forEach((draft, index) => {
    const label = `memory update ${index + 1}`;
    if (draft.op === 'resolve') {
      const memory = draft.memoryRef ? memoryRefs.get(draft.memoryRef) : undefined;
      if (!memory) errors.push(`${label}: memory "${draft.memoryRef ?? ''}" does not exist`);
      else if (!coach.memoryResolveIds.includes(memory.id)) coach.memoryResolveIds.push(memory.id);
      return;
    }
    if (draft.op !== 'add') {
      errors.push(`${label}: unsupported operation "${draft.op}"`);
      return;
    }
    if (!draft.kind || !(DAILY_MEMORY_KINDS as readonly string[]).includes(draft.kind)) {
      errors.push(`${label}: a daily reflection may only remember an open_loop or a conclusion`);
      return;
    }
    const text = clean(draft.text ?? '', COACH_LIMITS.memory);
    if (text.length < 10) return;
    const sensitive = findSensitiveIssue(text) ?? findLanguageIssue(text, ['judgment']);
    if (sensitive) {
      errors.push(`${label}: contains ${sensitive}; Reflect never keeps that`);
      return;
    }
    const problems: string[] = [];
    const cited = evidence.resolve(draft.metricKeys, draft.activityRefs, label, problems);
    const citedActions = draft.actionRefs.map((ref) => actionRefs.get(ref)).filter((a): a is CoachAction => a !== undefined);
    if (problems.length > 0 || (cited.metrics.length === 0 && cited.activities.length === 0 && citedActions.length === 0)) {
      errors.push(...problems, `${label}: a memory must cite the evidence it rests on`);
      return;
    }
    if (isDuplicateMemory(text, [...existing, ...coach.memoryAdds.map((m) => ({ text: m.text, normalizedKey: priorityKey(m.text) }))])) return;
    // An open loop that today's action already covers is tracked by that action, not remembered twice.
    if (draft.kind === 'open_loop' && coach.actions.some((a) => containment(tokensOf(`${a.title} ${a.focusTask ?? ''}`), tokensOf(text)) >= 0.6)) return;
    coach.memoryAdds.push({ kind: draft.kind as CoachMemoryKind, text, targetKey: citedActions[0]?.targetKey ?? null });
  });

  return { ok: errors.length === 0, errors, coach: withEscalationFallback(coach, context), decision, proposed: output.actions.length };
}

/**
 * When advice for something keeps not working out, the Coach asks — whether
 * or not the model remembered to. The question is deterministic.
 */
function withEscalationFallback(coach: ValidatedCoach, context: CoachContext): ValidatedCoach {
  if (coach.question) return coach;
  const escalation = context.escalations.find((e) => !e.alreadyAsked);
  if (!escalation) return coach;
  return {
    ...coach,
    question: {
      text: `${escalation.failures} suggestions about “${escalation.label}” have not worked out. Before suggesting another one, what keeps getting in the way?`,
      actionId: escalation.actionIds[escalation.actionIds.length - 1] ?? null,
      targetKey: escalation.targetKey,
    },
  };
}

// ── Conversation ────────────────────────────────────────────────────────────

export type ChatActionUpdate =
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'execution'; execution: CoachExecution }
  | { kind: 'outcome'; outcome: CoachOutcome };

export interface ValidatedChat {
  reply: string;
  action: (ValidatedCoachAction & { committed: boolean }) | null;
  actionUpdates: { actionId: string; update: ChatActionUpdate; reasonCode: CoachReasonCode | null; note: string | null }[];
  memoryAdds: ValidatedMemoryAdd[];
  memoryResolveIds: string[];
  memoryRemoveIds: string[];
  correction: { activityId: string; title: string; start: string; end: string } | null;
}

export interface ChatValidation {
  ok: boolean;
  errors: string[];
  /** null when even the reply could not be used. */
  chat: ValidatedChat | null;
}

export interface ChatValidationInput {
  raw: unknown;
  context: CoachContext;
  /** Alias → action, for everything the conversation was shown. */
  actionRefs: Map<string, CoachAction>;
  activityRefs: Map<string, { activityId: string; title: string; start: string; end: string }>;
  /** Every number that appeared in the context the model was given. */
  contextNumbers: Set<string>;
  /** What the user wrote in this conversation, newest last. */
  userTexts: string[];
}

const UPDATE_KINDS: Record<string, ChatActionUpdate> = {
  accept: { kind: 'accept' },
  reject: { kind: 'reject' },
  done: { kind: 'execution', execution: 'done' },
  partial: { kind: 'execution', execution: 'partial' },
  not_done: { kind: 'execution', execution: 'not_done' },
  worked: { kind: 'outcome', outcome: 'worked' },
  partly_worked: { kind: 'outcome', outcome: 'partly_worked' },
  did_not_work: { kind: 'outcome', outcome: 'did_not_work' },
  not_applicable: { kind: 'outcome', outcome: 'not_applicable' },
};

export function validateChat(input: ChatValidationInput): ChatValidation {
  const { context } = input;
  const parsed = chatSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 8).map((i) => `schema: ${i.path.join('.') || '(root)'} — ${i.message}`),
      chat: null,
    };
  }
  const output = parsed.data;
  const errors: string[] = [];
  const userSaid = input.userTexts.join(' ');

  const numbers = new Set(input.contextNumbers);
  addNumbersFrom(numbers, userSaid);

  // ── Reply ──
  const reply = clean(output.reply, COACH_LIMITS.reply);
  let replyOk = reply.length >= 2;
  if (!replyOk) errors.push('reply: empty');
  // The user may raise how they feel; the Coach may not be the one to bring it up.
  const userRaised = findSensitiveIssue(userSaid) !== null || findLanguageIssue(userSaid, ['judgment']) !== null;
  const issue = userRaised ? null : findLanguageIssue(reply, ['judgment', 'psychology']) ?? findSensitiveIssue(reply);
  if (issue) {
    errors.push(`reply: contains ${issue}; describe what the record shows, without judging or diagnosing`);
    replyOk = false;
  }
  const bad = unsupportedNumbers(reply, numbers);
  if (bad.length > 0) {
    errors.push(`reply: number(s) ${bad.map((n) => `"${n}"`).join(', ')} are not in the context — copy numbers exactly or leave them out`);
    replyOk = false;
  }
  if (!replyOk) return { ok: false, errors, chat: null };

  const chat: ValidatedChat = {
    reply,
    action: null,
    actionUpdates: [],
    memoryAdds: [],
    memoryResolveIds: [],
    memoryRemoveIds: [],
    correction: null,
  };

  // ── A new action ──
  if (output.proposedAction) {
    const committed = output.proposedAction.committed === true;
    const result = checkActionDraft(output.proposedAction, 'proposedAction', {
      context,
      actionRefs: input.actionRefs,
      evidence: null,
      extraNumbers: numbers,
      requireEvidence: false,
      // What the user decides to do is theirs to decide, whatever the record says.
      enforceLearning: !committed,
    });
    if (result.action) chat.action = { ...result.action, committed };
    else errors.push(...result.problems);
  }

  // ── Changes to existing actions ──
  const touched = new Set<string>();
  output.actionUpdates.forEach((draft, index) => {
    const label = `actionUpdate ${index + 1}`;
    const action = input.actionRefs.get(draft.actionRef);
    const update = UPDATE_KINDS[draft.update];
    if (!action) return void errors.push(`${label}: action "${draft.actionRef}" does not exist`);
    if (!update) return void errors.push(`${label}: unsupported update "${draft.update}"`);
    if (!canTransition(action.status, update.kind)) {
      return void errors.push(`${label}: “${action.title}” is ${action.status}; it cannot be marked "${draft.update}"`);
    }
    if (touched.has(`${action.id}:${update.kind}`)) return;
    touched.add(`${action.id}:${update.kind}`);
    const reasonCode = draft.reasonCode && (COACH_REASON_CODES as readonly string[]).includes(draft.reasonCode) ? (draft.reasonCode as CoachReasonCode) : null;
    const note = draft.note ? clean(draft.note, COACH_LIMITS.note) || null : null;
    chat.actionUpdates.push({ actionId: action.id, update, reasonCode, note: note && !findSensitiveIssue(note) ? note : null });
  });

  // ── Memory: only what the user actually said ──
  const memoryRefs = new Map(context.memories.map((m) => [m.ref, m.memory]));
  const existing = context.memories.map((m) => m.memory);
  const said = tokensOf(userSaid);
  output.memoryUpdates.slice(0, context.config.maxMemoryUpdates).forEach((draft, index) => {
    const label = `memory update ${index + 1}`;
    if (draft.op === 'resolve' || draft.op === 'remove') {
      const memory = draft.memoryRef ? memoryRefs.get(draft.memoryRef) : undefined;
      if (!memory) return void errors.push(`${label}: memory "${draft.memoryRef ?? ''}" does not exist`);
      const bucket = draft.op === 'resolve' ? chat.memoryResolveIds : chat.memoryRemoveIds;
      if (!bucket.includes(memory.id)) bucket.push(memory.id);
      return;
    }
    if (draft.op !== 'add') return void errors.push(`${label}: unsupported operation "${draft.op}"`);
    if (!draft.kind || !(CHAT_MEMORY_KINDS as readonly string[]).includes(draft.kind)) {
      return void errors.push(`${label}: unsupported memory kind "${draft.kind ?? ''}"`);
    }
    const text = clean(draft.text ?? '', COACH_LIMITS.memory);
    if (text.length < 8) return;
    const sensitive = findSensitiveIssue(text) ?? findLanguageIssue(text, ['judgment']);
    if (sensitive) return void errors.push(`${label}: contains ${sensitive}; Reflect never keeps that`);
    // A memory the user did not say is a memory Reflect made up.
    const tokens = tokensOf(text);
    let shared = 0;
    for (const t of tokens) if (said.has(t)) shared++;
    if (tokens.size === 0 || shared / tokens.size < 0.5) {
      return void errors.push(`${label}: “${text}” is not something the user said; remember only what they stated`);
    }
    if (isDuplicateMemory(text, [...existing, ...chat.memoryAdds.map((m) => ({ text: m.text, normalizedKey: priorityKey(m.text) }))])) return;
    chat.memoryAdds.push({ kind: draft.kind as CoachMemoryKind, text, targetKey: null });
  });

  if (output.correctionActivityRef) chat.correction = input.activityRefs.get(output.correctionActivityRef) ?? null;

  return { ok: errors.length === 0, errors, chat };
}
