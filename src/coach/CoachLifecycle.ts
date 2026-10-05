import type {
  CoachAction,
  CoachActionStatus,
  CoachDaypart,
  CoachExecution,
  CoachObservation,
  CoachOutcome,
  CoachReasonCode,
} from './CoachModels.js';

/**
 * The action state machine. Pure: `applyTransition` never mutates its input
 * and never reads a clock.
 *
 *   suggested ─accept──────────────▶ accepted ─observed / stated──▶ review ─outcome──▶ closed
 *       │  └─not now─▶ snoozed ─next day─▶ suggested          └─"didn't do it"──────▶ closed
 *       └─reject────▶ rejected
 *
 * Not every state is required: suggested → rejected is a complete lifecycle.
 * "I did it" (execution) and "it worked" (outcome) are recorded separately.
 */

export type CoachTransition =
  | { type: 'accept' }
  | { type: 'snooze'; until: string }
  | { type: 'reject'; reasonCode: CoachReasonCode | null; note: string | null }
  | { type: 'resurface'; targetStart: string | null; targetEnd: string | null }
  | { type: 'expire' }
  | { type: 'withdraw' }
  | {
      type: 'edit';
      patch: {
        title?: string;
        description?: string | null;
        focusMinutes?: number | null;
        focusTask?: string | null;
        daypart?: CoachDaypart;
        targetStart?: string | null;
        targetEnd?: string | null;
        strategyKey?: string;
      };
    }
  | { type: 'link_focus'; sessionId: string }
  | { type: 'observe'; observation: CoachObservation; execution: CoachExecution | null; executedAt: string | null }
  | { type: 'execution'; execution: CoachExecution; reasonCode: CoachReasonCode | null; note: string | null }
  | { type: 'outcome'; outcome: CoachOutcome; reasonCode: CoachReasonCode | null; note: string | null }
  | { type: 'timeout' };

export class CoachTransitionError extends Error {
  constructor(
    public readonly from: CoachActionStatus,
    public readonly transition: CoachTransition['type'],
  ) {
    super(`A ${from} action cannot ${transition.replace('_', ' ')}`);
    this.name = 'CoachTransitionError';
  }
}

const ALLOWED: Record<CoachTransition['type'], readonly CoachActionStatus[]> = {
  accept: ['suggested', 'snoozed'],
  snooze: ['suggested'],
  reject: ['suggested', 'snoozed'],
  resurface: ['snoozed'],
  expire: ['suggested', 'snoozed'],
  withdraw: ['suggested', 'snoozed'],
  edit: ['suggested', 'snoozed', 'accepted'],
  link_focus: ['suggested', 'snoozed', 'accepted', 'review'],
  observe: ['accepted', 'review'],
  // The user may always say what really happened, even after the fact.
  execution: ['accepted', 'review', 'closed'],
  outcome: ['accepted', 'review', 'closed'],
  timeout: ['review'],
};

export function canTransition(status: CoachActionStatus, type: CoachTransition['type']): boolean {
  return ALLOWED[type].includes(status);
}

/** A second "Not now" means the suggestion is not wanted in this form. */
export const MAX_SNOOZES = 1;

export function applyTransition(action: CoachAction, transition: CoachTransition, nowIso: string): CoachAction {
  if (!canTransition(action.status, transition.type)) throw new CoachTransitionError(action.status, transition.type);
  const next: CoachAction = { ...action, updatedAt: nowIso };

  switch (transition.type) {
    case 'accept':
      return { ...next, status: 'accepted', acceptedAt: nowIso, snoozedUntil: null };

    case 'snooze':
      // Asked a second time, "Not now" is an answer: bad timing.
      if (action.snoozeCount >= MAX_SNOOZES) {
        return { ...next, status: 'expired', reasonCode: action.reasonCode ?? 'bad_timing', closedAt: nowIso };
      }
      return { ...next, status: 'snoozed', snoozedUntil: transition.until, snoozeCount: action.snoozeCount + 1 };

    case 'reject':
      return {
        ...next,
        status: 'rejected',
        rejectedAt: nowIso,
        closedAt: nowIso,
        reasonCode: transition.reasonCode,
        note: transition.note ?? action.note,
        snoozedUntil: null,
      };

    case 'resurface':
      return { ...next, status: 'suggested', snoozedUntil: null, targetStart: transition.targetStart, targetEnd: transition.targetEnd };

    case 'expire':
      return { ...next, status: 'expired', closedAt: nowIso, snoozedUntil: null };

    case 'withdraw':
      return { ...next, status: 'withdrawn', closedAt: nowIso, snoozedUntil: null };

    case 'edit':
      return { ...next, ...definedOnly(transition.patch), userEdited: true };

    case 'link_focus':
      return {
        ...next,
        linkedFocusSessionId: transition.sessionId,
        // Starting it is a commitment.
        ...(action.status === 'suggested' || action.status === 'snoozed'
          ? { status: 'accepted' as const, acceptedAt: nowIso, snoozedUntil: null }
          : {}),
      };

    case 'observe': {
      // What the user said always outranks what Reflect inferred.
      const userSpoke = action.executionSource === 'user';
      const observed: CoachAction = { ...next, observation: transition.observation };
      const conclusive = transition.observation.final || transition.observation.kind === 'executed';
      if (!conclusive) return observed;
      return {
        ...observed,
        status: 'review',
        ...(userSpoke || transition.execution === null
          ? {}
          : { execution: transition.execution, executionSource: 'observed' as const, executedAt: transition.executedAt ?? nowIso }),
      };
    }

    case 'execution': {
      const base: CoachAction = {
        ...next,
        execution: transition.execution,
        executionSource: 'user',
        executedAt: transition.execution === 'not_done' ? null : action.executedAt ?? nowIso,
        reasonCode: transition.reasonCode ?? (transition.execution === 'not_done' ? action.reasonCode : null),
        note: transition.note ?? action.note,
      };
      // Not doing it ends the lifecycle; doing it leaves "did it help?" open.
      if (transition.execution === 'not_done') return { ...base, status: 'closed', outcome: null, outcomeAt: null, closedAt: nowIso };
      if (action.status === 'closed') return base.outcome ? base : { ...base, status: 'review', closedAt: null };
      return { ...base, status: 'review' };
    }

    case 'outcome': {
      const applicable = transition.outcome !== 'not_applicable';
      // Rating an outcome implies it was tried, unless Reflect or the user already said otherwise.
      const impliedDone = applicable && (action.execution === null || action.execution === 'not_done');
      return {
        ...next,
        status: 'closed',
        outcome: transition.outcome,
        outcomeAt: nowIso,
        closedAt: nowIso,
        reasonCode: transition.reasonCode ?? (applicable ? action.reasonCode : 'not_applicable'),
        note: transition.note ?? action.note,
        ...(impliedDone ? { execution: 'done' as const, executionSource: 'user' as const, executedAt: action.executedAt ?? nowIso } : {}),
      };
    }

    case 'timeout':
      return { ...next, status: 'closed', closedAt: nowIso };
  }
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** What the user still needs to tell Reflect about this action, if anything. */
export type CoachPendingInput = 'decision' | 'execution' | 'outcome' | null;

export function pendingInput(action: CoachAction): CoachPendingInput {
  if (action.status === 'suggested') return 'decision';
  if (action.status !== 'review') return null;
  return action.execution === null ? 'execution' : 'outcome';
}

/**
 * Who established that an action happened — kept as two separate facts.
 *
 *   userReported  the user said so ("I did it" / "partly" / "I didn't")
 *   observed      true   Reflect's own tracked activity shows it
 *                 false  its window passed and nothing matching was seen
 *                 null   unknown: not something Reflect can see, still open, or too little to call
 *
 * "The user said they did it" is never turned into "Reflect observed it", and
 * an action existing is never evidence that it was carried out.
 */
export interface ExecutionEvidence {
  userReported: boolean;
  observed: boolean | null;
}

export function executionEvidence(action: Pick<CoachAction, 'execution' | 'executionSource' | 'observation'>): ExecutionEvidence {
  const kind = action.observation?.kind ?? null;
  const observed =
    kind === 'executed' || kind === 'attempted' ? true : kind === 'not_observed' && action.observation?.final ? false : action.executionSource === 'observed' && action.execution !== null ? true : null;
  return { userReported: action.executionSource === 'user' && action.execution !== null, observed };
}

/** Is this action finished for good (nothing more will happen to it on its own)? */
export function isTerminal(status: CoachActionStatus): boolean {
  return status === 'closed' || status === 'rejected' || status === 'withdrawn' || status === 'expired';
}
