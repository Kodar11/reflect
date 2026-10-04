import type { ReflectionEvidence } from '../reflection/ReflectionModels.js';
import { REASON_LABELS } from './CoachEffectiveness.js';
import { pendingInput, type CoachPendingInput } from './CoachLifecycle.js';
import { describeTarget } from './CoachMatching.js';
import type {
  CoachAction,
  CoachActionSource,
  CoachActionStatus,
  CoachActionType,
  CoachExecution,
  CoachExecutionSource,
  CoachMemory,
  CoachMessage,
  CoachObservationKind,
  CoachOutcome,
  CoachReasonCode,
  CoachSettings,
} from './CoachModels.js';

/**
 * The Coach's read model — what the renderer is handed. Pure.
 *
 * The renderer never decides what an action's state means: the status line,
 * what the user is being asked, and whether Focus can run it are all settled
 * here, from the same record the Coach reasons over.
 */

export interface CoachActionView {
  id: string;
  source: CoachActionSource;
  reportId: string | null;
  title: string;
  description: string | null;
  rationale: string;
  actionType: CoachActionType;
  status: CoachActionStatus;
  execution: CoachExecution | null;
  executionSource: CoachExecutionSource | null;
  outcome: CoachOutcome | null;
  reasonCode: CoachReasonCode | null;
  note: string | null;
  /** `Tomorrow · morning`. */
  targetLabel: string | null;
  focusMinutes: number | null;
  focusTask: string | null;
  daypart: CoachAction['daypart'];
  evidence: ReflectionEvidence[];
  /** What Reflect saw, in plain statements. */
  observation: { kind: CoachObservationKind; facts: string[] } | null;
  /** What the user is being asked about this action, if anything. */
  pending: CoachPendingInput;
  /** One line saying where this action stands. */
  statusLine: string;
  /** Whether it can be run as a Focus session right now. */
  canStartFocus: boolean;
  /** The earlier action this one adapts. */
  adaptedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoachMemoryView {
  id: string;
  kind: CoachMemory['kind'];
  text: string;
  source: CoachMemory['source'];
  createdAt: string;
}

export interface CoachStateView {
  /** Whether Gemini is available for conversation. */
  configured: boolean;
  settings: CoachSettings;
  /** Suggestions waiting for a decision. */
  next: CoachActionView[];
  /** Accepted, or waiting for the user's word on what happened. */
  commitments: CoachActionView[];
  /** Recently finished. */
  recent: CoachActionView[];
  /** The actions of one report, when a report was asked for. */
  reportActions: CoachActionView[];
  /** What has been learned about what works for this user. */
  learned: { kind: 'works' | 'does_not_work'; text: string }[];
  memory: CoachMemoryView[];
  /** A question the Coach is waiting on. */
  question: { messageId: string; text: string; actionId: string | null } | null;
  messages: CoachMessage[];
}

const OUTCOME_WORDS: Record<CoachOutcome, string> = {
  worked: 'it worked',
  partly_worked: 'it partly worked',
  did_not_work: 'it didn’t work',
  not_applicable: 'not applicable',
};

/** One calm line: decision, what happened, what came of it. Never a judgment. */
export function actionStatusLine(action: CoachAction, now: Date): string {
  const target = describeTarget(action, now);
  const reason = action.reasonCode ? ` — ${REASON_LABELS[action.reasonCode]}` : '';
  const how = action.executionSource === 'observed' ? 'observed' : 'you said so';

  switch (action.status) {
    case 'suggested':
      return target ?? 'Suggested';
    case 'snoozed':
      return 'Not now — Reflect will ask once more';
    case 'accepted':
      return target ? `Accepted · ${target}` : 'Accepted';
    case 'rejected':
      return `Rejected${reason}`;
    case 'withdrawn':
      return 'Replaced by a newer reflection';
    case 'expired':
      return 'Not decided';
    case 'review': {
      if (action.execution === 'done') return `Carried out (${how}) — did it help?`;
      if (action.execution === 'partial') return `Partly carried out (${how}) — did it help?`;
      switch (action.observation?.kind) {
        case 'not_observed':
          return 'Not observed — did it happen?';
        case 'ambiguous':
          return 'Reflect can’t tell whether this happened — did it?';
        default:
          return 'Did this happen?';
      }
    }
    case 'closed': {
      if (action.outcome === 'not_applicable') return `Not applicable${action.reasonCode && action.reasonCode !== 'not_applicable' ? reason : ''}`;
      if (action.execution === 'not_done') return `Didn’t happen${reason}`;
      const did = action.execution === 'partial' ? 'Partly carried out' : action.execution === 'done' ? 'Carried out' : null;
      if (did && action.outcome) return `${did} · ${OUTCOME_WORDS[action.outcome]}${action.outcome === 'did_not_work' ? reason : ''}`;
      if (did) return `${did} (${how})`;
      return action.observation?.kind === 'not_observed' ? 'Not observed' : 'Closed';
    }
  }
}

export function toActionView(
  action: CoachAction,
  now: Date,
  options: { focusBusy: boolean; titleOf?: (id: string) => string | null } = { focusBusy: false },
): CoachActionView {
  const open = action.status === 'suggested' || action.status === 'accepted' || action.status === 'snoozed';
  const windowOpen = action.targetEnd === null || now.getTime() < Date.parse(action.targetEnd);
  return {
    id: action.id,
    source: action.source,
    reportId: action.reportId,
    title: action.title,
    description: action.description,
    rationale: action.rationale,
    actionType: action.actionType,
    status: action.status,
    execution: action.execution,
    executionSource: action.executionSource,
    outcome: action.outcome,
    reasonCode: action.reasonCode,
    note: action.note,
    targetLabel: describeTarget(action, now),
    focusMinutes: action.focusMinutes,
    focusTask: action.focusTask,
    daypart: action.daypart,
    evidence: action.evidence,
    observation: action.observation ? { kind: action.observation.kind, facts: action.observation.facts } : null,
    pending: pendingInput(action),
    statusLine: actionStatusLine(action, now),
    canStartFocus: action.focusMinutes !== null && open && windowOpen && !options.focusBusy && action.linkedFocusSessionId === null,
    adaptedFrom: action.parentActionId ? options.titleOf?.(action.parentActionId) ?? null : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

export function toMemoryView(memory: CoachMemory): CoachMemoryView {
  return { id: memory.id, kind: memory.kind, text: memory.text, source: memory.source, createdAt: memory.createdAt };
}

/** The latest coach question nobody has answered yet. */
export function pendingQuestion(messages: CoachMessage[]): CoachStateView['question'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return null;
    if (m.meta?.kind === 'question') return { messageId: m.id, text: m.text, actionId: m.meta.aboutActionId ?? null };
  }
  return null;
}
