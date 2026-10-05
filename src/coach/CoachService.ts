import { randomUUID } from 'node:crypto';
import type { ICoachRepository } from '../database/CoachRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { IReflectionRepository } from '../database/ReflectionRepository.js';
import { GeminiError, type IGeminiClient } from '../intelligence/GeminiClient.js';
import type { UserContextProvider } from '../intelligence/IntelligenceModels.js';
import { formatIntelligenceContext } from '../profile/UserProfile.js';
import type { CoachCheck, DailyCoachInput, DailyCoachSession, ReflectionCoachHook } from '../reflection/ReflectionCoachHook.js';
import { selectSupportingMetrics } from '../reflection/ReflectionMetrics.js';
import type { ReflectionMetricsService } from '../reflection/ReflectionMetricsService.js';
import {
  MEANINGFUL_ACTIVITY_MINUTES,
  type MetricSet,
  type ReflectionActivity,
  type ReflectionPeriod,
  type ReflectionPriority,
  type ReportCoachBlock,
} from '../reflection/ReflectionModels.js';
import {
  formatDay,
  formatLocalDateTime,
  localDayKey,
  periodContaining,
  previousPeriods,
  shiftPeriod,
} from '../reflection/ReflectionPeriods.js';
import { isPossiblyStale, priorityKey } from '../reflection/ReflectionPriorities.js';
import { addNumbersFrom, clean } from '../reflection/ReflectionValidator.js';
import { buildCoachContext, renderActionLine, type ActionRef, type CoachContext } from './CoachContext.js';
import { REASON_LABELS, effectivenessLines, learnedStatements } from './CoachEffectiveness.js';
import { CoachTransitionError, applyTransition, isTerminal, type CoachTransition } from './CoachLifecycle.js';
import { detectOpportunities, type CoachOpportunity } from './CoachOpportunities.js';
import {
  observationWindow,
  observeAction,
  resolveTarget,
  shiftWindowByDay,
  strategyKeyOf,
  type FocusFact,
} from './CoachMatching.js';
import {
  COACH_DAYPARTS,
  COACH_EXECUTIONS,
  COACH_LIMITS,
  COACH_OUTCOMES,
  COACH_REASON_CODES,
  COACH_WHEN,
  DEFAULT_COACH_CONFIG,
  MAX_FOCUS_MINUTES,
  MIN_FOCUS_MINUTES,
  normalizeCoachSettings,
  type CoachAction,
  type CoachActionSource,
  type CoachConfig,
  type CoachDaypart,
  type CoachExecution,
  type CoachLogger,
  type CoachMemory,
  type CoachMessage,
  type CoachMessageMeta,
  type CoachOutcome,
  type CoachReasonCode,
  type CoachSettings,
  type CoachWhen,
} from './CoachModels.js';
import {
  buildChatPrompt,
  buildChatResponseSchema,
  buildChatRetryFeedback,
  buildChatSystemInstruction,
  buildDailyCoachParts,
} from './CoachPrompt.js';
import {
  findSensitiveIssue,
  validateChat,
  validateDailyCoach,
  type ValidatedChat,
  type ValidatedCoach,
  type ValidatedCoachAction,
  type ValidatedMemoryAdd,
} from './CoachValidator.js';
import { pendingQuestion, toActionView, toMemoryView, type CoachActionView, type CoachStateView } from './CoachView.js';

/**
 * `CoachService` closes the loop:
 *
 *   observe → understand → DECIDE → act → MEASURE → feedback → LEARN → adapt
 *
 * It is the coaching half of a day's intelligence (`beginDaily`, called by
 * `ReflectionService` so reflection and coaching are one model request and
 * one transaction), the keeper of the action lifecycle (every decision,
 * observation and outcome goes through the pure state machine), the observer
 * that checks Reflect's own data for whether a commitment happened, and the
 * conversational coach — which reads and writes the very same actions and
 * memory.
 *
 * Coaching is an enhancement: every public method resolves with a result and
 * never throws, and nothing here can damage a reflection or an action that
 * was already stored.
 */

const CHAT_ATTEMPTS = 2;
const MAX_MESSAGE_LENGTH = 1000;
const CHAT_ACTIVITY_LIMIT = 15;
const CHAT_CLOSED_ACTIONS = 12;
const CHAT_RECENT_DAYS = 7;
const STATE_RECENT_MS = 7 * 86_400_000;
const STATE_MESSAGES = 40;

export interface CoachServiceDeps {
  repo: ICoachRepository;
  gemini: IGeminiClient;
  reflections: Pick<IReflectionRepository, 'listCurrentReports'>;
  metrics: Pick<ReflectionMetricsService, 'loadActivities' | 'computeCore'>;
  focus: Pick<IFocusRepository, 'getSessionsByRange' | 'getSessionById' | 'getInterruptions' | 'getActiveSession'>;
  userContext: UserContextProvider;
  /** Every stated priority, reconciled with the profile. */
  priorities: () => ReflectionPriority[];
  /** Called after anything the Coach panel shows has changed. */
  onChanged?: () => void;
  config?: CoachConfig;
  logger?: CoachLogger;
  now?: () => Date;
  newId?: () => string;
}

export type CoachActionResult =
  | { ok: true; action: CoachActionView; noteDropped?: boolean }
  | { ok: false; error: string };

export type CoachChatFailure = 'empty' | 'not_configured' | 'network' | 'api' | 'quota' | 'validation' | 'internal';

export type CoachChatResult =
  | { ok: true; messages: CoachMessage[] }
  | { ok: false; category: CoachChatFailure; message: string };

const CHAT_FAILURE_MESSAGES: Record<CoachChatFailure, string> = {
  empty: 'Write a question first.',
  not_configured: 'Gemini is not configured, so the Coach cannot answer yet.',
  network: 'Reflect could not reach Gemini. Nothing was changed — try again in a moment.',
  api: 'Gemini returned an error. Nothing was changed.',
  quota: 'The Gemini quota is exhausted for now. Nothing was changed.',
  validation: 'The Coach could not give an answer it could back up from your record, so it gave none. Try asking it another way.',
  internal: 'Something went wrong while answering. Nothing was changed.',
};

export interface DecisionInput {
  reasonCode?: CoachReasonCode | null;
  note?: string | null;
}

export interface EditInput {
  title?: string;
  description?: string | null;
  focusMinutes?: number | null;
  focusTask?: string | null;
  when?: CoachWhen;
  daypart?: CoachDaypart;
}

const silentLogger: CoachLogger = { info() {}, warn() {}, error() {} };

export class CoachService implements ReflectionCoachHook {
  private readonly config: CoachConfig;
  private readonly log: CoachLogger;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** One conversation turn at a time. */
  private chatQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CoachServiceDeps) {
    this.config = deps.config ?? DEFAULT_COACH_CONFIG;
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  isConfigured(): boolean {
    return this.deps.gemini.isConfigured();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  getSettings(): CoachSettings {
    try {
      return this.deps.repo.getSettings();
    } catch (err) {
      this.log.error(`[COACH] Could not read settings: ${messageOf(err)}`);
      return normalizeCoachSettings(null);
    }
  }

  saveSettings(raw: unknown): CoachSettings {
    const settings = normalizeCoachSettings({ ...this.getSettings(), ...(raw && typeof raw === 'object' ? raw : {}) });
    try {
      this.deps.repo.saveSettings(settings, this.now().toISOString());
    } catch (err) {
      this.log.error(`[COACH] Could not save settings: ${messageOf(err)}`);
    }
    return this.getSettings();
  }

  // ── The daily pass (called by ReflectionService) ───────────────────────────

  async beginDaily(input: DailyCoachInput): Promise<DailyCoachSession<ValidatedCoach> | null> {
    const { period, now, dataset } = input;
    // A recommendation about "tomorrow" means nothing for a day long past.
    if (now.getTime() >= Date.parse(period.end) + this.config.dailyEligibilityMs) return null;

    // What happened to earlier commitments is settled first, from Reflect's own data.
    await this.observe(now);

    // Where a next move could come from, measured before the model is asked.
    let opportunities: CoachOpportunity[] = [];
    try {
      opportunities = detectOpportunities({
        lastKnown: await this.lastKnownWork(dataset),
        activities: dataset.activities,
        metrics: dataset.metrics,
        priorities: dataset.priorities,
        memories: this.deps.repo.listMemories().filter((m) => m.status === 'active'),
        openLoopsSince: new Date(now.getTime() - this.config.openLoopSignalMs).toISOString(),
      });
    } catch (err) {
      // Signals are an aid to the decision, never a precondition for it.
      this.log.error(`[COACH] Could not derive next-move signals: ${messageOf(err)}`);
    }
    const context = this.buildContext(now, period, dataset.priorities, threadsOf(dataset.activities), input.replacesReportId, {
      opportunities,
      activityRefOf: (id) => input.activityRefs?.get(id) ?? null,
    });
    this.log.info(
      `[COACH] Daily context: ${context.followups.length} action(s) to follow up, ${context.open.length} open, ` +
        `${context.rejected.length} rejected, ${context.ignored.length} never decided, ${context.failedRecently.length} reported as not working, ` +
        `${context.escalations.length} escalation(s), ${context.memories.length} memory item(s), ` +
        `${opportunities.length} next-move signal(s)${opportunities.length ? ` (${opportunities.map((o) => `${o.kind}:${o.strength}`).join(', ')})` : ''}.`,
    );

    return {
      parts: buildDailyCoachParts(context),
      validate: (raw, evidence): CoachCheck<ValidatedCoach> => {
        try {
          const result = validateDailyCoach({ raw, context, evidence });
          this.log.info(
            `[COACH] Decision: ${result.decision ? `${result.decision.verdict}${result.decision.candidate ? ` — candidate “${result.decision.candidate}”` : ''}` : 'not stated'}; ` +
              `${result.proposed} action(s) proposed, ${result.coach.actions.length} kept` +
              (result.errors.length ? `; problems: ${result.errors.slice(0, 3).join('; ')}` : '') +
              (result.coach.actions.length === 0 && result.coach.noActionReason ? `; reason given: ${result.coach.noActionReason}` : ''),
          );
          return { ok: result.ok, errors: result.errors, value: result.coach };
        } catch (err) {
          // A coach block that cannot even be checked is treated as absent.
          this.log.error(`[COACH] Validation error: ${messageOf(err)}`);
          return { ok: true, errors: [], value: validateDailyCoach({ raw: {}, context, evidence }).coach };
        }
      },
      plan: (coach, reportId, nowIso) => this.planDaily(coach, context, reportId, input.replacesReportId, nowIso),
    };
  }

  /**
   * For every priority that had no work today: the last activity linked to it
   * on its most recent earlier day — whether it was left mid-way or finished.
   */
  private async lastKnownWork(dataset: DailyCoachInput['dataset']): Promise<Record<string, { title: string; summary: string | null; dayLabel: string }>> {
    const out: Record<string, { title: string; summary: string | null; dayLabel: string }> = {};
    for (const p of dataset.priorities) {
      if (dataset.activities.some((a) => a.priorityId === p.id && a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)) continue;
      const lastDay = dataset.metrics[`recent.priority.${p.id}.last_day`];
      if (!lastDay?.range) continue;
      try {
        const earlier = await this.deps.metrics.loadActivities(lastDay.range.start, lastDay.range.end, dataset.priorities);
        const last = earlier
          .filter((a) => a.priorityId === p.id && a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)
          .sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1))
          .pop();
        if (last) out[p.id] = { title: last.title, summary: last.summary, dayLabel: lastDay.display };
      } catch {
        // An earlier day that cannot be loaded simply adds nothing.
      }
    }
    return out;
  }

  private buildContext(
    now: Date,
    reportDay: ReflectionPeriod,
    priorities: Pick<ReflectionPriority, 'id' | 'text'>[],
    threads: string[],
    supersededReportId: string | null = null,
    daily: { opportunities: CoachOpportunity[]; activityRefOf: (activityId: string) => string | null } | null = null,
  ): CoachContext {
    const { repo } = this.deps;
    const actions = repo.listActions(new Date(now.getTime() - this.config.effectivenessLookbackMs).toISOString());
    const knownThreads = [...new Set([...threads, ...actions.map((a) => a.thread).filter((t): t is string => t !== null)])];
    return buildCoachContext({
      now,
      reportDay,
      actions,
      memories: repo.listMemories(),
      messages: repo.listMessages(this.config.maxStoredMessages),
      priorities,
      knownThreads,
      config: this.config,
      supersededReportId,
      ...(daily ?? {}),
    });
  }

  /** Canonical rows for an accepted coach block, and the writes that store them. */
  private planDaily(
    coach: ValidatedCoach,
    context: CoachContext,
    reportId: string,
    replacesReportId: string | null,
    nowIso: string,
  ): { block: ReportCoachBlock; apply: () => void } {
    const originDayKey = context.reportDay.key;
    const actions = coach.actions.map((a) => this.newAction(a, { source: 'daily', reportId, originDayKey, nowIso, accepted: false }));
    const block: ReportCoachBlock = {
      actionIds: actions.map((a) => a.id),
      // The title is kept as it read when the follow-up was written.
      followups: coach.followups.map((f) => ({
        ...f,
        title: context.followups.find((x) => x.action.id === f.actionId)?.action.title ?? '',
      })),
      uncertainty: coach.uncertainty,
      noActionReason: coach.noActionReason,
      question: coach.question,
    };
    const { repo } = this.deps;

    const apply = () => {
      repo.transaction(() => {
        // A regenerated report replaces its own undecided suggestions. What the
        // user already decided on stays exactly as they left it.
        if (replacesReportId) {
          for (const old of repo.listActionsByReport(replacesReportId)) {
            if (old.status === 'suggested' || old.status === 'snoozed') this.persist(old, { type: 'withdraw' }, nowIso, { by: reportId });
          }
        }
        for (const action of actions) {
          repo.insertAction(action);
          repo.insertActionEvent({
            id: this.newId(),
            actionId: action.id,
            type: 'suggested',
            fromStatus: null,
            toStatus: 'suggested',
            detail: { reportId },
            createdAt: nowIso,
          });
        }
        this.applyMemory(coach.memoryAdds, coach.memoryResolveIds, [], 'coach', reportId, nowIso);
        if (coach.question) {
          repo.insertMessage({
            id: this.newId(),
            role: 'coach',
            text: coach.question.text,
            meta: { kind: 'question', aboutActionId: coach.question.actionId, targetKey: coach.question.targetKey, reportId },
            createdAt: nowIso,
          });
        }
      });
    };
    return { block, apply };
  }

  private newAction(
    a: ValidatedCoachAction,
    options: { source: CoachActionSource; reportId: string | null; originDayKey: string; nowIso: string; accepted: boolean },
  ): CoachAction {
    return {
      id: this.newId(),
      source: options.source,
      reportId: options.reportId,
      originDayKey: options.originDayKey,
      parentActionId: a.parentActionId,
      title: a.title,
      description: a.description,
      rationale: a.rationale,
      actionType: a.actionType,
      daypart: a.daypart,
      targetStart: a.targetStart,
      targetEnd: a.targetEnd,
      focusMinutes: a.focusMinutes,
      focusTask: a.focusTask,
      priorityId: a.priorityId,
      thread: a.thread,
      strategyKey: a.strategyKey,
      targetKey: a.targetKey,
      evidence: a.evidence,
      sourceMetricKeys: a.sourceMetricKeys,
      sourceActivityIds: a.sourceActivityIds,
      confidence: a.confidence,
      status: options.accepted ? 'accepted' : 'suggested',
      execution: null,
      executionSource: null,
      outcome: null,
      reasonCode: null,
      note: null,
      observation: null,
      linkedFocusSessionId: null,
      snoozedUntil: null,
      snoozeCount: 0,
      userEdited: false,
      createdAt: options.nowIso,
      acceptedAt: options.accepted ? options.nowIso : null,
      rejectedAt: null,
      executedAt: null,
      outcomeAt: null,
      closedAt: null,
      updatedAt: options.nowIso,
    };
  }

  /** Memory writes shared by the daily pass and the conversation. */
  private applyMemory(
    adds: ValidatedMemoryAdd[],
    resolveIds: string[],
    removeIds: string[],
    source: CoachMemory['source'],
    sourceRef: string,
    nowIso: string,
  ): string[] {
    const { repo } = this.deps;
    const ids: string[] = [];
    for (const add of adds) {
      const memory: CoachMemory = {
        id: this.newId(),
        kind: add.kind,
        text: add.text,
        normalizedKey: priorityKey(add.text),
        status: 'active',
        source,
        sourceRef,
        targetKey: add.targetKey,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      repo.insertMemory(memory);
      ids.push(memory.id);
    }
    const settle = (id: string, status: CoachMemory['status']) => {
      const memory = repo.getMemory(id);
      if (memory && memory.status === 'active') repo.updateMemory({ ...memory, status, updatedAt: nowIso });
    };
    for (const id of resolveIds) settle(id, 'resolved');
    for (const id of removeIds) settle(id, 'removed');

    // Memory stays small: the oldest things the Coach concluded give way first.
    const active = repo.listMemories().filter((m) => m.status === 'active');
    const excess = active.length - this.config.maxActiveMemories;
    if (excess > 0) {
      const oldestFirst = [...active].sort((a, b) => (a.source === b.source ? (a.createdAt < b.createdAt ? -1 : 1) : a.source === 'coach' ? -1 : 1));
      for (const memory of oldestFirst.slice(0, excess)) repo.updateMemory({ ...memory, status: 'resolved', updatedAt: nowIso });
    }
    return ids;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Apply one transition and record it. Throws `CoachTransitionError` when it is not allowed. */
  private persist(action: CoachAction, transition: CoachTransition, nowIso: string, detail: Record<string, unknown> | null = null): CoachAction {
    const next = applyTransition(action, transition, nowIso);
    const { repo } = this.deps;
    repo.transaction(() => {
      repo.updateAction(next);
      repo.insertActionEvent({
        id: this.newId(),
        actionId: action.id,
        type: transition.type,
        fromStatus: action.status,
        toStatus: next.status,
        detail,
        createdAt: nowIso,
      });
    });
    return next;
  }

  /** Run a user-initiated change; every failure becomes a result, never an exception. */
  private change(actionId: string, run: (action: CoachAction, nowIso: string) => { action: CoachAction; noteDropped?: boolean }): CoachActionResult {
    try {
      const action = this.deps.repo.getAction(actionId);
      if (!action) return { ok: false, error: 'That action no longer exists.' };
      const result = run(action, this.now().toISOString());
      this.notifyChanged();
      return { ok: true, action: this.view(result.action), ...(result.noteDropped ? { noteDropped: true } : {}) };
    } catch (err) {
      if (err instanceof CoachTransitionError) return { ok: false, error: `${err.message}.` };
      this.log.error(`[COACH] Could not update action ${actionId}: ${messageOf(err)}`);
      return { ok: false, error: 'The change could not be saved.' };
    }
  }

  /** The user's own words, trimmed — and never anything Reflect must not keep. */
  private note(raw: string | null | undefined): { note: string | null; dropped: boolean } {
    const note = raw ? clean(raw, COACH_LIMITS.note) || null : null;
    if (note && findSensitiveIssue(note)) return { note: null, dropped: true };
    return { note, dropped: false };
  }

  /** Accept, postpone ("Not now") or reject a suggestion. */
  decide(actionId: string, decision: 'accept' | 'not_now' | 'reject', input: DecisionInput = {}): CoachActionResult {
    const result = this.change(actionId, (action, nowIso) => {
      if (decision === 'accept') return { action: this.persist(action, { type: 'accept' }, nowIso) };
      if (decision === 'not_now') {
        const until = shiftPeriod(periodContaining('day', nowIso), 1).start;
        return { action: this.persist(action, { type: 'snooze', until }, nowIso) };
      }
      const { note, dropped } = this.note(input.note);
      const next = this.persist(action, { type: 'reject', reasonCode: reasonOf(input.reasonCode), note }, nowIso, {
        reasonCode: reasonOf(input.reasonCode),
      });
      return { action: next, noteDropped: dropped };
    });
    // An accepted action may already be under way.
    if (result.ok && decision === 'accept') void this.observe();
    return result;
  }

  /** Change a suggestion before (or while) committing to it. The user's wording is theirs. */
  edit(actionId: string, input: EditInput): CoachActionResult {
    return this.change(actionId, (action, nowIso) => {
      const patch: Extract<CoachTransition, { type: 'edit' }>['patch'] = {};
      if (input.title !== undefined) {
        const title = clean(input.title, COACH_LIMITS.title);
        if (title.length >= 4) patch.title = title;
      }
      if (input.description !== undefined) patch.description = input.description ? clean(input.description, COACH_LIMITS.description) || null : null;
      if (input.focusMinutes !== undefined) {
        patch.focusMinutes =
          input.focusMinutes === null
            ? null
            : Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, Math.round(Number(input.focusMinutes) || MIN_FOCUS_MINUTES)));
      }
      if (input.focusTask !== undefined) patch.focusTask = input.focusTask ? clean(input.focusTask, 100) || null : null;

      const daypart = input.daypart && (COACH_DAYPARTS as readonly string[]).includes(input.daypart) ? input.daypart : action.daypart;
      const when = input.when && (COACH_WHEN as readonly string[]).includes(input.when) ? input.when : null;
      if (when || daypart !== action.daypart) {
        const now = new Date(nowIso);
        const today = periodContaining('day', now);
        // Keep the day it was aimed at unless the user moved it.
        const base = when ? today : action.targetStart ? periodContaining('day', action.targetStart) : today;
        const target = when
          ? resolveTarget(when, daypart, today, now)
          : resolveTarget(Date.parse(base.end) <= now.getTime() ? 'tomorrow' : base.key === today.key ? 'today' : 'tomorrow', daypart, today, now);
        patch.daypart = daypart;
        patch.targetStart = target.start;
        patch.targetEnd = target.end;
      }
      const focusMinutes = patch.focusMinutes !== undefined ? patch.focusMinutes : action.focusMinutes;
      patch.strategyKey = strategyKeyOf({ actionType: action.actionType, daypart, focusMinutes });
      return { action: this.persist(action, { type: 'edit', patch }, nowIso, { fields: Object.keys(patch) }) };
    });
  }

  /** "I did it" / "partly" / "I didn't do it" — whether it happened, not whether it helped. */
  reportExecution(actionId: string, execution: CoachExecution, input: DecisionInput = {}): CoachActionResult {
    if (!(COACH_EXECUTIONS as readonly string[]).includes(execution)) return { ok: false, error: 'Unknown answer.' };
    return this.change(actionId, (action, nowIso) => {
      const { note, dropped } = this.note(input.note);
      const next = this.persist(action, { type: 'execution', execution, reasonCode: reasonOf(input.reasonCode), note }, nowIso, {
        execution,
        reasonCode: reasonOf(input.reasonCode),
      });
      return { action: next, noteDropped: dropped };
    });
  }

  /** "It worked" / "partly" / "it didn't work" / "not applicable" — and optionally why. */
  reportOutcome(actionId: string, outcome: CoachOutcome, input: DecisionInput = {}): CoachActionResult {
    if (!(COACH_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, error: 'Unknown answer.' };
    return this.change(actionId, (action, nowIso) => {
      const { note, dropped } = this.note(input.note);
      const next = this.persist(action, { type: 'outcome', outcome, reasonCode: reasonOf(input.reasonCode), note }, nowIso, {
        outcome,
        reasonCode: reasonOf(input.reasonCode),
      });
      return { action: next, noteDropped: dropped };
    });
  }

  /**
   * The Focus session that is running now was started for this action.
   * Starting it is a commitment; what the session then shows is the evidence.
   */
  linkFocus(actionId: string): CoachActionResult {
    return this.change(actionId, (action, nowIso) => {
      const session = this.deps.focus.getActiveSession();
      if (!session) throw new Error('No Focus session is running');
      return { action: this.persist(action, { type: 'link_focus', sessionId: session.id }, nowIso, { sessionId: session.id }) };
    });
  }

  /** A Focus session ended: whatever it was for can now be observed. */
  async onFocusEnded(): Promise<void> {
    await this.observe();
  }

  // ── Observation: did it actually happen? ───────────────────────────────────

  /**
   * One sweep over the open actions, using only Reflect's own data:
   * undecided suggestions whose moment passed expire, postponed ones come back
   * once, and accepted ones are checked against Focus sessions and the
   * timeline. Returns how many actions changed. Never throws.
   */
  async observe(at?: Date): Promise<number> {
    const now = at ?? this.now();
    const nowIso = now.toISOString();
    let changed = 0;
    try {
      const { repo } = this.deps;
      const open = repo
        .listActions(new Date(now.getTime() - this.config.effectivenessLookbackMs).toISOString())
        .filter((a) => !isTerminal(a.status));
      if (open.length === 0) return 0;
      const priorities = this.safePriorities();

      for (const action of open) {
        try {
          if (action.status === 'suggested') {
            if (action.targetEnd && now.getTime() >= Date.parse(action.targetEnd)) {
              this.persist(action, { type: 'expire' }, nowIso);
              changed++;
            }
          } else if (action.status === 'snoozed') {
            if (action.snoozedUntil && now.getTime() >= Date.parse(action.snoozedUntil)) {
              const shifted = shiftWindowByDay(action.targetStart, action.targetEnd);
              // Away for days: a suggestion whose moment has long gone is not brought back.
              const stale = shifted.end !== null && now.getTime() >= Date.parse(shifted.end);
              this.persist(action, stale ? { type: 'expire' } : { type: 'resurface', targetStart: shifted.start, targetEnd: shifted.end }, nowIso);
              changed++;
            }
          } else if (action.status === 'accepted') {
            if (await this.observeOne(action, now, priorities)) changed++;
          } else if (action.status === 'review') {
            const since = action.executedAt ?? action.observation?.observedAt ?? action.updatedAt;
            if (now.getTime() - Date.parse(since) >= this.config.reviewTimeoutMs) {
              this.persist(action, { type: 'timeout' }, nowIso);
              changed++;
            }
          }
        } catch (err) {
          this.log.error(`[COACH] Could not observe action ${action.id}: ${messageOf(err)}`);
        }
      }
    } catch (err) {
      this.log.error(`[COACH] Observation sweep failed: ${messageOf(err)}`);
    }
    if (changed > 0) this.notifyChanged();
    return changed;
  }

  private async observeOne(action: CoachAction, now: Date, priorities: ReflectionPriority[]): Promise<boolean> {
    const window = observationWindow(action, this.config);
    if (now.getTime() < Date.parse(window.start) && !action.linkedFocusSessionId) return false;
    const until = new Date(Math.min(now.getTime(), Date.parse(window.end))).toISOString();

    const focus = this.focusFacts(window.start, window.end, action.linkedFocusSessionId);
    const activities = until > window.start ? await this.deps.metrics.loadActivities(window.start, until, priorities) : [];
    const result = observeAction({
      action,
      nowIso: now.toISOString(),
      focus,
      activities,
      priorityText: action.priorityId ? priorities.find((p) => p.id === action.priorityId)?.text ?? null : null,
      config: this.config,
    });

    // Nothing conclusive yet, and nothing new to show: leave it alone.
    const conclusive = result.observation.final || result.observation.kind === 'executed';
    const sameAsBefore =
      action.observation !== null &&
      action.observation.kind === result.observation.kind &&
      action.observation.facts.join('|') === result.observation.facts.join('|');
    if (!conclusive && sameAsBefore) return false;

    this.persist(
      action,
      { type: 'observe', observation: result.observation, execution: result.execution, executedAt: result.executedAt },
      now.toISOString(),
      { kind: result.observation.kind, execution: result.execution },
    );
    return true;
  }

  /** Focus sessions that started inside [startIso, endIso) — plus the linked one — as evidence. */
  private focusFacts(startIso: string, endIso: string, linkedId: string | null): FocusFact[] {
    const { focus } = this.deps;
    const sessions = focus.getSessionsByRange(startIso, endIso).filter((s) => s.startedAt !== null && s.state !== 'planned');
    if (linkedId && !sessions.some((s) => s.id === linkedId)) {
      const linked = focus.getSessionById(linkedId);
      if (linked?.startedAt) sessions.push(linked);
    }
    return sessions.map((s) => ({
      id: s.id,
      task: s.task,
      startedAt: s.startedAt!,
      endedAt: s.endedAt,
      elapsedMinutes: s.elapsedMs / 60_000,
      plannedMinutes: s.plannedDurationMinutes,
      interruptionCount: focus.getInterruptions(s.id).filter((i) => i.type !== 'resume').length,
      endReason: s.endReason ?? (s.state === 'completed' ? 'completed' : s.state === 'cancelled' ? 'ended-early' : null),
      endNote: s.endNote,
    }));
  }

  // ── Read model ─────────────────────────────────────────────────────────────

  private view(action: CoachAction): CoachActionView {
    let focusBusy = false;
    try {
      focusBusy = this.deps.focus.getActiveSession() !== null;
    } catch {
      // Focus state is a convenience for the button; the action itself is unaffected.
    }
    return toActionView(action, this.now(), { focusBusy, titleOf: (id) => this.deps.repo.getAction(id)?.title ?? null });
  }

  /** Everything the Coach panel shows. Never calls Gemini. */
  getState(reportId?: string | null): CoachStateView {
    const now = this.now();
    const empty: CoachStateView = {
      configured: this.isConfigured(),
      settings: this.getSettings(),
      next: [],
      commitments: [],
      recent: [],
      reportActions: [],
      learned: [],
      memory: [],
      question: null,
      messages: [],
    };
    try {
      const { repo } = this.deps;
      const actions = repo.listActions(new Date(now.getTime() - this.config.effectivenessLookbackMs).toISOString());
      const priorities = this.safePriorities();
      const context = buildCoachContext({
        now,
        reportDay: periodContaining('day', now),
        actions,
        memories: repo.listMemories(),
        messages: repo.listMessages(this.config.maxStoredMessages),
        priorities,
        knownThreads: [],
        config: this.config,
      });
      const recentSince = new Date(now.getTime() - STATE_RECENT_MS).toISOString();
      const messages = repo.listMessages(STATE_MESSAGES);
      const oldestFirst = (a: CoachAction, b: CoachAction) => (a.createdAt < b.createdAt ? -1 : 1);
      return {
        ...empty,
        next: actions.filter((a) => a.status === 'suggested').sort(oldestFirst).map((a) => this.view(a)),
        commitments: actions
          .filter((a) => a.status === 'accepted' || a.status === 'review' || a.status === 'snoozed')
          // What needs the user's word comes first.
          .sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review') || oldestFirst(a, b))
          .map((a) => this.view(a)),
        recent: actions
          .filter((a) => (a.status === 'closed' || a.status === 'rejected') && (a.closedAt ?? a.updatedAt) >= recentSince)
          .sort((a, b) => ((a.closedAt ?? a.updatedAt) < (b.closedAt ?? b.updatedAt) ? 1 : -1))
          .slice(0, 6)
          .map((a) => this.view(a)),
        reportActions: reportId ? repo.listActionsByReport(reportId).filter((a) => a.status !== 'withdrawn').map((a) => this.view(a)) : [],
        learned: learnedStatements(context.effectiveness, context.targetLabel, this.config),
        memory: context.memories.map((m) => toMemoryView(m.memory)),
        question: pendingQuestion(messages),
        messages,
      };
    } catch (err) {
      this.log.error(`[COACH] Could not read coach state: ${messageOf(err)}`);
      return empty;
    }
  }

  /** "Forget this." */
  removeMemory(id: string): boolean {
    try {
      const memory = this.deps.repo.getMemory(id);
      if (!memory || memory.status === 'removed') return false;
      this.deps.repo.updateMemory({ ...memory, status: 'removed', updatedAt: this.now().toISOString() });
      this.notifyChanged();
      return true;
    } catch (err) {
      this.log.error(`[COACH] Could not remove memory: ${messageOf(err)}`);
      return false;
    }
  }

  // ── Conversation ───────────────────────────────────────────────────────────

  /** One turn of the conversation. Turns are answered in order; never throws. */
  chat(text: string): Promise<CoachChatResult> {
    const run = this.chatQueue.then(() => this.runChat(text));
    this.chatQueue = run.catch(() => undefined);
    return run;
  }

  private async runChat(raw: string): Promise<CoachChatResult> {
    const fail = (category: CoachChatFailure): CoachChatResult => ({ ok: false, category, message: CHAT_FAILURE_MESSAGES[category] });
    try {
      const text = clean(String(raw ?? ''), MAX_MESSAGE_LENGTH);
      if (text.length < 2) return fail('empty');
      const { gemini, repo } = this.deps;
      if (!gemini.isConfigured()) return fail('not_configured');

      const now = this.now();
      await this.observe(now);
      const prepared = await this.prepareChat(now, text);

      const systemInstruction = buildChatSystemInstruction();
      const responseJsonSchema = buildChatResponseSchema(prepared.context.priorities.map((p) => p.id));
      const contextNumbers = new Set<string>();
      addNumbersFrom(contextNumbers, prepared.prompt);

      let chat: ValidatedChat | null = null;
      let feedback: string[] | null = null;
      let category: CoachChatFailure = 'validation';
      for (let attempt = 1; attempt <= CHAT_ATTEMPTS; attempt++) {
        try {
          const response = await gemini.generateJson({
            systemInstruction,
            prompt: feedback ? `${prepared.prompt}\n\n${buildChatRetryFeedback(feedback)}` : prepared.prompt,
            responseJsonSchema,
          });
          let rawOutput: unknown;
          try {
            rawOutput = JSON.parse(response.text);
          } catch {
            feedback = ['The response was not valid JSON.'];
            continue;
          }
          const validation = validateChat({
            raw: rawOutput,
            context: prepared.context,
            actionRefs: prepared.actionRefs,
            activityRefs: prepared.activityRefs,
            contextNumbers,
            userTexts: [...prepared.userTexts, text],
          });
          // A grounded reply with a rejected side-effect is still worth a retry —
          // and still an answer if the retry does no better.
          if (validation.chat) chat = validation.chat;
          if (validation.ok) break;
          feedback = validation.errors;
          this.log.warn(`[COACH] Chat validation failed: ${validation.errors.slice(0, 3).join('; ')}`);
        } catch (err) {
          if (!(err instanceof GeminiError)) throw err;
          category = err.category === 'malformed_output' ? 'validation' : err.category === 'missing_api_key' ? 'not_configured' : err.category;
          this.log.warn(`[COACH] Chat request failed (${err.category}).`);
          if (!err.retryable) break;
          feedback = null;
        }
      }
      if (!chat) return fail(category);

      const nowIso = this.now().toISOString();
      const userMessage: CoachMessage = { id: this.newId(), role: 'user', text, meta: null, createdAt: nowIso };
      const coachMessage = this.applyChat(chat, prepared, userMessage, nowIso);
      repo.pruneMessages(this.config.maxStoredMessages);
      this.notifyChanged();
      if (chat.action?.committed || chat.actionUpdates.length > 0) void this.observe();
      return { ok: true, messages: [userMessage, coachMessage] };
    } catch (err) {
      this.log.error(`[COACH] Chat failed: ${messageOf(err)}`);
      return fail('internal');
    }
  }

  /** Persist a validated turn: both messages and everything it changed, atomically. */
  private applyChat(chat: ValidatedChat, prepared: PreparedChat, userMessage: CoachMessage, nowIso: string): CoachMessage {
    const { repo } = this.deps;
    const meta: CoachMessageMeta = { kind: 'reply', actions: [], memoryIds: [], correction: chat.correction };
    const coachMessage: CoachMessage = { id: this.newId(), role: 'coach', text: chat.reply, meta, createdAt: nowIso };

    repo.transaction(() => {
      repo.insertMessage(userMessage);

      for (const update of chat.actionUpdates) {
        const action = repo.getAction(update.actionId);
        if (!action) continue;
        try {
          const transition: CoachTransition =
            update.update.kind === 'accept'
              ? { type: 'accept' }
              : update.update.kind === 'reject'
                ? { type: 'reject', reasonCode: update.reasonCode, note: update.note }
                : update.update.kind === 'execution'
                  ? { type: 'execution', execution: update.update.execution, reasonCode: update.reasonCode, note: update.note }
                  : { type: 'outcome', outcome: update.update.outcome, reasonCode: update.reasonCode, note: update.note };
          const next = this.persist(action, transition, nowIso, { via: 'conversation', messageId: userMessage.id });
          meta.actions!.push({ actionId: next.id, change: describeChange(update.update) });
        } catch (err) {
          // The record moved on between the prompt and now; the reply still stands.
          this.log.warn(`[COACH] Skipped a conversational update: ${messageOf(err)}`);
        }
      }

      if (chat.action) {
        const action = this.newAction(chat.action, {
          source: 'conversation',
          reportId: null,
          originDayKey: localDayKey(nowIso),
          nowIso,
          accepted: chat.action.committed,
        });
        repo.insertAction(action);
        repo.insertActionEvent({
          id: this.newId(),
          actionId: action.id,
          type: chat.action.committed ? 'committed' : 'suggested',
          fromStatus: null,
          toStatus: action.status,
          detail: { via: 'conversation', messageId: userMessage.id },
          createdAt: nowIso,
        });
        meta.actions!.push({ actionId: action.id, change: chat.action.committed ? 'added as a commitment' : 'suggested' });
      }

      // What the user says in answer to a question is about what was asked.
      const adds = chat.memoryAdds.map((m) =>
        prepared.question?.targetKey && (m.kind === 'constraint' || m.kind === 'preference') ? { ...m, targetKey: prepared.question.targetKey } : m,
      );
      meta.memoryIds = this.applyMemory(adds, chat.memoryResolveIds, chat.memoryRemoveIds, 'user', userMessage.id, nowIso);
      repo.insertMessage(coachMessage);
    });
    return coachMessage;
  }

  /** Retrieve the structured history a turn needs — never the whole database. */
  private async prepareChat(now: Date, message: string): Promise<PreparedChat> {
    const { repo, metrics, reflections } = this.deps;
    const nowIso = now.toISOString();
    const today = periodContaining('day', now);
    const allPriorities = this.safePriorities();
    const active = allPriorities.filter((p) => p.status === 'active');

    const core = await metrics.computeCore(today, nowIso, allPriorities);
    const recent: { day: ReflectionPeriod; metrics: MetricSet }[] = [];
    for (const day of previousPeriods(today, CHAT_RECENT_DAYS)) {
      try {
        const result = await metrics.computeCore(day, day.end, allPriorities);
        if (result.activities.length > 0) recent.push({ day, metrics: result.metrics });
      } catch {
        // A day that cannot be loaded is simply not part of the context.
      }
    }

    const threads = [
      ...threadsOf(core.activities),
      ...recent.flatMap((r) => Object.values(r.metrics).map((m) => m.thread).filter((t): t is string => typeof t === 'string')),
    ];
    const base = this.buildContext(now, today, active, [...new Set(threads)]);

    // Everything still open, plus what was most recently settled.
    const all = repo.listActions(new Date(now.getTime() - this.config.effectivenessLookbackMs).toISOString());
    const listed = [
      ...all.filter((a) => !isTerminal(a.status)),
      ...all.filter((a) => isTerminal(a.status) && a.status !== 'withdrawn').slice(0, CHAT_CLOSED_ACTIONS),
    ];
    const followups: ActionRef[] = listed.map((action, index) => ({ ref: `k${index + 1}`, action }));
    const context: CoachContext = { ...base, followups };

    const activities = core.activities
      .filter((a) => a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)
      .sort((a, b) => b.durationMinutes - a.durationMinutes)
      .slice(0, CHAT_ACTIVITY_LIMIT)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    const activityRefs = new Map<string, { activityId: string; title: string; start: string; end: string }>();
    const activityLines = activities.map((a, index) => {
      const ref = `a${index + 1}`;
      activityRefs.set(ref, { activityId: a.id, title: a.title, start: a.startedAt, end: a.endedAt });
      return JSON.stringify({
        ref,
        start: formatLocalDateTime(a.startedAt),
        minutes: Math.round(a.durationMinutes),
        title: a.title,
        thread: a.thread,
        source: a.source,
      });
    });

    const messages = repo.listMessages(this.config.maxStoredMessages);
    const question = pendingQuestionFull(messages);
    const history = messages.filter((m) => m.meta?.kind !== 'error').slice(-this.config.chatHistoryMessages);
    const userContext = this.deps.userContext.getUserContext();
    const reports = [...safe(() => reflections.listCurrentReports('day', 2), []), ...safe(() => reflections.listCurrentReports('week', 1), [])];

    const sections = [
      `NOW\n${formatLocalDateTime(now)}`,
      userContext ? `ABOUT THE USER (in their own words)\n${formatIntelligenceContext(userContext)}` : 'ABOUT THE USER\nNot provided. Assume nothing.',
      active.length > 0
        ? `CURRENT PRIORITIES (stated by the user)\n${active
            .map((p) => JSON.stringify({ id: p.id, text: p.text, possiblyStale: isPossiblyStale(p, nowIso, 60) }))
            .join('\n')}`
        : 'CURRENT PRIORITIES\nNone stated.',
      `TODAY SO FAR (measured by Reflect)\n${metricLines(core.metrics, 'day')}`,
      activityLines.length > 0 ? `TODAY'S ACTIVITIES (chronological; refer to one by its ref)\n${activityLines.join('\n')}` : "TODAY'S ACTIVITIES\nNone yet.",
      recent.length > 0
        ? `RECENT DAYS (measured by Reflect)\n${recent.map((r) => `${formatDay(new Date(r.day.start))}: ${dayLine(r.metrics, active)}`).join('\n')}`
        : 'RECENT DAYS\nNo earlier days tracked.',
      reports.length > 0
        ? `LATEST REFLECTIONS (what Reflect already told the user)\n${reports
            .map(
              (r) =>
                `${r.period.type === 'day' ? formatDay(new Date(r.period.start)) : `Week of ${formatDay(new Date(r.period.start))}`}: ${r.headline ?? ''}` +
                (r.narrative ? ` ${r.narrative}` : '') +
                r.insights.map((i) => `\n  - ${i.title}: ${i.observation}`).join(''),
            )
            .join('\n')}`
        : '',
      followups.length > 0
        ? `ACTIONS (the record of what was suggested, decided, observed and said; refer to one by its ref)\n${followups
            .map((f) => renderActionLine(f.ref, f.action, now))
            .join('\n')}`
        : 'ACTIONS\nNone yet.',
      (() => {
        const lines = effectivenessLines(context.effectiveness, context.targetLabel, this.config);
        return lines.length > 0
          ? `WHAT HAS AND HAS NOT WORKED FOR THIS USER (counted by Reflect from real outcomes)\n${lines.map((l) => `- ${l}`).join('\n')}`
          : 'WHAT HAS AND HAS NOT WORKED FOR THIS USER\nNo outcomes recorded yet.';
      })(),
      context.rejected.length > 0
        ? `REJECTED BY THE USER\n${context.rejected
            .slice(0, 8)
            .map((a) => `- ${a.title}${a.reasonCode ? ` — ${REASON_LABELS[a.reasonCode]}` : ''}`)
            .join('\n')}`
        : '',
      context.memories.length > 0
        ? `COACH MEMORY (refer to one by its ref)\n${context.memories
            .map((m) => JSON.stringify({ ref: m.ref, kind: m.memory.kind, text: m.memory.text, from: m.memory.source }))
            .join('\n')}`
        : 'COACH MEMORY\nEmpty.',
      question ? `PENDING QUESTION (the Coach asked this and is waiting for the answer)\n${question.text}` : '',
    ];

    const prompt = buildChatPrompt({ sections, history: history.map((m) => ({ role: m.role, text: m.text })), message });
    return {
      context,
      actionRefs: new Map(followups.map((f) => [f.ref, f.action])),
      activityRefs,
      prompt,
      userTexts: history.filter((m) => m.role === 'user').map((m) => m.text),
      question,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private safePriorities(): ReflectionPriority[] {
    try {
      return this.deps.priorities();
    } catch (err) {
      this.log.error(`[COACH] Could not read priorities: ${messageOf(err)}`);
      return [];
    }
  }

  private notifyChanged(): void {
    try {
      this.deps.onChanged?.();
    } catch {
      // A UI notification must never affect the Coach.
    }
  }
}

interface PreparedChat {
  context: CoachContext;
  actionRefs: Map<string, CoachAction>;
  activityRefs: Map<string, { activityId: string; title: string; start: string; end: string }>;
  prompt: string;
  /** Earlier user messages still in view. */
  userTexts: string[];
  question: { text: string; targetKey: string | null } | null;
}

function pendingQuestionFull(messages: CoachMessage[]): { text: string; targetKey: string | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return null;
    if (m.meta?.kind === 'question') return { text: m.text, targetKey: m.meta.targetKey ?? null };
  }
  return null;
}

function threadsOf(activities: ReflectionActivity[]): string[] {
  return [...new Set(activities.map((a) => a.thread).filter((t): t is string => t !== null))];
}

function reasonOf(value: unknown): CoachReasonCode | null {
  return typeof value === 'string' && (COACH_REASON_CODES as readonly string[]).includes(value) ? (value as CoachReasonCode) : null;
}

function describeChange(update: ValidatedChat['actionUpdates'][number]['update']): string {
  switch (update.kind) {
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'execution':
      return update.execution === 'done' ? 'marked as done' : update.execution === 'partial' ? 'marked as partly done' : 'marked as not done';
    case 'outcome':
      return update.outcome === 'worked'
        ? 'recorded as having worked'
        : update.outcome === 'partly_worked'
          ? 'recorded as having partly worked'
          : update.outcome === 'did_not_work'
            ? 'recorded as not having worked'
            : 'marked as not applicable';
  }
}

/** The day's headline measurements, one per line. */
function metricLines(metrics: MetricSet, type: 'day'): string {
  const chosen = new Map(selectSupportingMetrics(metrics, type).map((m) => [m.key, m]));
  for (const metric of Object.values(metrics)) {
    if (/^(thread|priority)\.[^.]+\.minutes$/.test(metric.key) || /^focus\.(session_count|total_minutes|s\d+)$/.test(metric.key)) {
      chosen.set(metric.key, metric);
    }
  }
  const lines = [...chosen.values()].slice(0, 20).map((m) => `- ${m.label}: ${m.display}`);
  return lines.length > 0 ? lines.join('\n') : 'Nothing tracked yet today.';
}

/** One earlier day in a line. */
function dayLine(metrics: MetricSet, priorities: Pick<ReflectionPriority, 'id' | 'text'>[]): string {
  const parts: string[] = [];
  const add = (key: string, label: string) => {
    if (metrics[key]) parts.push(`${label} ${metrics[key].display}`);
  };
  add('time.tracked_minutes', 'tracked');
  add('time.focused_minutes', 'focused');
  add('behavior.switches', 'context switches');
  add('focus.session_count', 'Focus sessions');
  const top = Object.values(metrics)
    .filter((m) => /^thread\.[^.]+\.minutes$/.test(m.key) && typeof m.value === 'number')
    .sort((a, b) => (b.value as number) - (a.value as number))[0];
  if (top?.thread) parts.push(`main thread “${top.thread}” ${top.display}`);
  for (const p of priorities) {
    const linked = metrics[`priority.${p.id}.minutes`];
    if (linked) parts.push(`“${p.text}” ${linked.display}`);
  }
  return parts.join(', ');
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
