import { threadSlug } from '../reflection/ReflectionActivities.js';
import type { ReflectionPeriod, ReflectionPriority } from '../reflection/ReflectionModels.js';
import { formatDay, periodFromKey } from '../reflection/ReflectionPeriods.js';
import {
  REASON_LABELS,
  effectivenessLines,
  findEscalations,
  summarizeEffectiveness,
  type EffectivenessSummary,
  type Escalation,
} from './CoachEffectiveness.js';
import { isTerminal } from './CoachLifecycle.js';
import { describeTarget } from './CoachMatching.js';
import type { CoachAction, CoachConfig, CoachMemory, CoachMessage } from './CoachModels.js';

/**
 * Structured history → what the model is shown. Pure.
 *
 * Nothing here sends "the database": it selects the few earlier actions worth
 * following up, the record of what has and has not worked, the suggestions
 * the user turned down, and the durable memory — each under a short alias the
 * model cites and the backend resolves back to a canonical id.
 */

export interface ActionRef {
  ref: string;
  action: CoachAction;
}

export interface MemoryRef {
  ref: string;
  memory: CoachMemory;
}

export interface EscalationContext extends Escalation {
  label: string;
  /** A question about this target is already waiting for the user's answer. */
  alreadyAsked: boolean;
}

export interface CoachContext {
  now: Date;
  /** The day the reflection is about (targets are resolved relative to it). */
  reportDay: ReflectionPeriod;
  /** "today" is only a valid target while that day is still running. */
  allowToday: boolean;
  maxActions: number;
  /** Earlier actions worth saying something about, most relevant first. */
  followups: ActionRef[];
  /** Still open (awaiting a decision, accepted, or awaiting feedback). */
  open: CoachAction[];
  /** Explicitly turned down recently. */
  rejected: CoachAction[];
  effectiveness: EffectivenessSummary;
  escalations: EscalationContext[];
  memories: MemoryRef[];
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  /** Threads the day's evidence knows about. */
  knownThreads: string[];
  config: CoachConfig;
  targetLabel(targetKey: string | null): string | null;
}

export interface CoachContextInput {
  now: Date;
  reportDay: ReflectionPeriod;
  /** Every action inside the effectiveness lookback. */
  actions: CoachAction[];
  memories: CoachMemory[];
  messages: CoachMessage[];
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  knownThreads: string[];
  config: CoachConfig;
  /** Actions of the report being replaced: they are about to be withdrawn. */
  supersededReportId?: string | null;
}

/** Human name of a target key (`p:<priority id>` / `t:<thread slug>`). */
export function targetLabeller(
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[],
  actions: Pick<CoachAction, 'targetKey' | 'thread'>[],
  knownThreads: string[] = [],
): (targetKey: string | null) => string | null {
  const threadNames = new Map<string, string>();
  for (const a of actions) if (a.targetKey?.startsWith('t:') && a.thread) threadNames.set(a.targetKey, a.thread);
  return (targetKey) => {
    if (!targetKey) return null;
    if (targetKey.startsWith('p:')) return priorities.find((p) => p.id === targetKey.slice(2))?.text ?? null;
    const known = threadNames.get(targetKey);
    if (known) return known;
    const slug = targetKey.slice(2);
    return knownThreads.find((t) => threadSlug(t) === slug) ?? slug.replace(/-/g, ' ');
  };
}

/**
 * When the user last explained what was getting in the way of a target: the
 * first thing they said after the Coach asked about it. Failures before that
 * no longer count toward escalation.
 */
export function escalationResets(messages: CoachMessage[]): { resets: Map<string, string>; pending: Set<string> } {
  const resets = new Map<string, string>();
  const pending = new Set<string>();
  const ordered = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  ordered.forEach((message, index) => {
    const targetKey = message.role === 'coach' && message.meta?.kind === 'question' ? message.meta.targetKey : null;
    if (!targetKey) return;
    const answer = ordered.slice(index + 1).find((m) => m.role === 'user');
    if (answer) {
      resets.set(targetKey, answer.createdAt);
      pending.delete(targetKey);
    } else {
      pending.add(targetKey);
    }
  });
  return { resets, pending };
}

/** Which earlier actions deserve a word in today's report, in order of importance. */
function selectFollowups(actions: CoachAction[], reportDay: ReflectionPeriod, max: number): CoachAction[] {
  const dayStart = reportDay.start;
  const recently = new Date(Date.parse(dayStart) - 2 * 86_400_000).toISOString();
  const rank = (a: CoachAction): number => {
    // Explicit rejections and never-decided suggestions are not followed up.
    if (a.status === 'rejected' || a.status === 'withdrawn' || a.status === 'expired' || a.status === 'suggested' || a.status === 'snoozed') return -1;
    if (a.status === 'review') return 4; // something happened (or did not) and nobody has spoken yet
    if (a.status === 'accepted') return 3; // an open commitment
    if (a.status === 'closed' && (a.closedAt ?? a.updatedAt) >= recently) {
      return a.outcome === 'did_not_work' || a.execution === 'not_done' ? 2 : 1;
    }
    return -1;
  };
  return actions
    .map((action) => ({ action, rank: rank(action) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => b.rank - a.rank || (a.action.updatedAt < b.action.updatedAt ? 1 : -1))
    .slice(0, max)
    .map((x) => x.action);
}

export function buildCoachContext(input: CoachContextInput): CoachContext {
  const { now, reportDay, config } = input;
  const nowIso = now.toISOString();
  // Suggestions of the report being regenerated will be withdrawn with it.
  const actions = input.actions.filter(
    (a) => !(input.supersededReportId && a.reportId === input.supersededReportId && (a.status === 'suggested' || a.status === 'snoozed')),
  );

  const { resets, pending } = escalationResets(input.messages);
  const targetLabel = targetLabeller(input.priorities, actions, input.knownThreads);
  const rejectedSince = new Date(now.getTime() - config.rejectionMemoryMs).toISOString();

  return {
    now,
    reportDay,
    allowToday: now.getTime() < Date.parse(reportDay.end),
    maxActions: config.maxActionsPerDay,
    followups: selectFollowups(actions, reportDay, config.maxFollowups).map((action, index) => ({ ref: `k${index + 1}`, action })),
    open: actions.filter((a) => !isTerminal(a.status)),
    rejected: actions.filter((a) => a.status === 'rejected' && (a.rejectedAt ?? a.updatedAt) >= rejectedSince),
    effectiveness: summarizeEffectiveness(actions, nowIso, config),
    escalations: findEscalations(actions, nowIso, config, resets).map((e) => ({
      ...e,
      label: targetLabel(e.targetKey) ?? e.targetKey,
      alreadyAsked: pending.has(e.targetKey),
    })),
    memories: input.memories
      .filter((m) => m.status === 'active')
      .slice(0, config.maxActiveMemories)
      .map((memory, index) => ({ ref: `m${index + 1}`, memory })),
    priorities: input.priorities,
    knownThreads: input.knownThreads,
    config,
    targetLabel,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** `accepted`, `done — observed`, `worked` … as plain words. */
export function describeActionState(action: CoachAction): { decision: string; execution: string | null; outcome: string | null } {
  const decision =
    action.status === 'rejected'
      ? 'rejected'
      : action.status === 'suggested'
        ? 'not decided yet'
        : action.status === 'snoozed'
          ? 'postponed (“not now”)'
          : action.status === 'expired'
            ? 'never decided'
            : action.status === 'withdrawn'
              ? 'withdrawn'
              : action.source === 'conversation' && action.acceptedAt === action.createdAt
                ? 'committed to by the user'
                : 'accepted';
  const executionWord =
    action.execution === 'done' ? 'carried out' : action.execution === 'partial' ? 'partly carried out' : action.execution === 'not_done' ? 'not carried out' : null;
  const execution = executionWord
    ? `${executionWord} (${action.executionSource === 'user' ? 'the user said so' : 'observed by Reflect'})`
    : action.observation?.kind === 'not_observed' && action.observation.final
      ? 'not observed (nothing matching was seen; the user has not said whether it happened)'
      : action.observation?.kind === 'ambiguous'
        ? 'unclear from the evidence — do not assume either way'
        : action.observation?.kind === 'unobservable' && action.observation.final
          ? 'not something Reflect can see; the user has not said'
          : action.status === 'accepted'
            ? 'still open'
            : null;
  const outcome =
    action.outcome === 'worked'
      ? 'the user said it worked'
      : action.outcome === 'partly_worked'
        ? 'the user said it partly worked'
        : action.outcome === 'did_not_work'
          ? 'the user said it did not work'
          : action.outcome === 'not_applicable'
            ? 'the user said it was not applicable'
            : null;
  return { decision, execution, outcome };
}

/** One earlier action exactly as the model sees it. */
export function renderActionLine(ref: string, action: CoachAction, now: Date): string {
  const state = describeActionState(action);
  const suggested = periodFromKey('day', action.originDayKey);
  return JSON.stringify({
    ref,
    title: action.title,
    type: action.actionType,
    suggestedOn: suggested ? formatDay(new Date(suggested.start)) : action.originDayKey,
    target: describeTarget(action, now),
    ...(action.focusMinutes ? { focusMinutes: action.focusMinutes } : {}),
    decision: state.decision,
    ...(state.execution ? { execution: state.execution } : {}),
    ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(action.reasonCode ? { reason: REASON_LABELS[action.reasonCode] } : {}),
    ...(action.note ? { userNote: action.note } : {}),
    ...(action.observation && action.observation.facts.length > 0 ? { observed: action.observation.facts } : {}),
  });
}

/** The coaching half of the daily request's user turn. */
export function renderCoachSection(ctx: CoachContext): string {
  const sections: string[] = ['COACH CONTEXT (everything below is Reflect\'s own structured record — not a guess)'];

  sections.push(
    ctx.followups.length > 0
      ? `PREVIOUS ACTIONS (what was decided earlier and what then happened; refer to one by its ref)\n${ctx.followups
          .map((f) => renderActionLine(f.ref, f.action, ctx.now))
          .join('\n')}`
      : 'PREVIOUS ACTIONS\nNone to follow up.',
  );

  const waiting = ctx.open.filter((a) => (a.status === 'suggested' || a.status === 'snoozed') && !ctx.followups.some((f) => f.action.id === a.id));
  if (waiting.length > 0) {
    sections.push(
      `ALREADY SUGGESTED, WAITING FOR THE USER (do not suggest these or anything like them again)\n${waiting
        .map((a) => `- ${a.title}${describeTarget(a, ctx.now) ? ` (${describeTarget(a, ctx.now)})` : ''}`)
        .join('\n')}`,
    );
  }

  const lines = effectivenessLines(ctx.effectiveness, ctx.targetLabel, ctx.config);
  sections.push(
    lines.length > 0
      ? `WHAT HAS AND HAS NOT WORKED FOR THIS USER (counted by Reflect from real outcomes)\n${lines.map((l) => `- ${l}`).join('\n')}`
      : 'WHAT HAS AND HAS NOT WORKED FOR THIS USER\nNo outcomes yet. Start small.',
  );

  if (ctx.rejected.length > 0) {
    sections.push(
      `REJECTED BY THE USER (never bring these back, in any wording)\n${ctx.rejected
        .slice(0, 8)
        .map((a) => `- ${a.title}${a.reasonCode ? ` — ${REASON_LABELS[a.reasonCode]}` : ''}${a.note ? ` (“${a.note}”)` : ''}`)
        .join('\n')}`,
    );
  }

  if (ctx.escalations.length > 0) {
    sections.push(
      `STOP AND ASK (advice for these keeps not working out)\n${ctx.escalations
        .map((e) =>
          e.alreadyAsked
            ? `- “${e.label}”: ${e.failures} attempts did not work out and a question to the user is still unanswered. Recommend nothing for it.`
            : `- “${e.label}”: ${e.failures} attempts did not work out. Recommend nothing for it. Ask ONE question in "question" to understand what keeps getting in the way.`,
        )
        .join('\n')}`,
    );
  }

  sections.push(
    ctx.memories.length > 0
      ? `COACH MEMORY (durable things the user told Reflect, or that were concluded from evidence; respect them)\n${ctx.memories
          .map((m) => JSON.stringify({ ref: m.ref, kind: m.memory.kind, text: m.memory.text, from: m.memory.source }))
          .join('\n')}`
      : 'COACH MEMORY\nEmpty.',
  );

  sections.push(
    `COACH LIMITS\nAt most ${ctx.maxActions} action${ctx.maxActions === 1 ? '' : 's'}; zero is a good answer when nothing needs changing. ` +
      (ctx.allowToday
        ? 'The day is still running: "today" means what is left of it.'
        : 'This day is over: use "tomorrow" (the day after it) or "this_week"; "today" is not available.'),
  );

  return sections.join('\n\n');
}
