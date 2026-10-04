import { randomUUID } from 'node:crypto';
import type { IEventRepository } from '../database/EventRepository.js';
import type { IIntelligenceRepository } from '../database/IntelligenceRepository.js';
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../database/CategorizationRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { RuleCondition } from '../categorization/Classification.js';
import type { Event } from '../models/Event.js';
import type { OnboardingStatus } from '../profile/UserProfile.js';
import { GeminiError, type IGeminiClient } from './GeminiClient.js';
import {
  INTELLIGENCE_SCHEMA_VERSION,
  type AllowedTaxonomy,
  type AnalysisPromptInput,
  type AnalysisResult,
  type BacklogResult,
  type FocusContextInput,
  type IntelligenceActivity,
  type IntelligenceErrorCategory,
  type IntelligenceRun,
  type PreprocessResult,
  type PreviousActivityInput,
  type ReconcilePlan,
  type UserContextProvider,
  type UserRuleInput,
  type ValidatedActivity,
} from './IntelligenceModels.js';
import { preprocessEvents, sortChronologically } from './IntelligencePreprocessor.js';
import {
  PROMPT_VERSION,
  buildAnalysisPrompt,
  buildResponseJsonSchema,
  buildRetryFeedback,
  buildSystemInstruction,
} from './IntelligencePrompt.js';
import { validateAnalysisOutput } from './IntelligenceValidator.js';
import { planReconciliation } from './IntelligenceReconciler.js';

/**
 * `IntelligenceService` owns the analysis pipeline:
 *
 *   fetch events → preprocess → build context → Gemini → validate
 *     → reconcile → persist transactionally
 *
 * A window is the unit of SCHEDULING, not of understanding. Each analysis
 * covers the window plus the lookback context before it, and the model decides
 * the grouping of everything it is shown: activities recorded by the previous
 * analysis are provisional until the next one has seen what followed them.
 * That is what lets one task survive an hour boundary, an interruption, or a
 * first impression formed from two events.
 *
 * The manual trigger, the hourly scheduler and backlog recovery all go
 * through `analyzeWindow` — there is exactly one pipeline.
 *
 * Intelligence is an enhancement. Every public method resolves with a result
 * object and never throws; a failure leaves the previously persisted AI state
 * (and therefore the timeline) exactly as it was.
 */

const HOUR_MS = 60 * 60 * 1000;

/** One initial attempt + two retries. */
const MAX_ATTEMPTS = 3;
/** Delay before attempt 2 and attempt 3. */
const RETRY_DELAYS_MS = [1_000, 4_000];

/** How far back startup/hourly reconciliation looks for unanalysed windows. */
const BACKLOG_LOOKBACK_MS = 48 * HOUR_MS;
/** A window whose output keeps being rejected is not retried forever. */
const MAX_REJECTED_RUNS_PER_WINDOW = 3;
const REJECTION_CATEGORIES: IntelligenceErrorCategory[] = ['malformed_output', 'validation'];
/** Failures that will hit every other window too — stop the cycle. */
const CYCLE_STOPPING_CATEGORIES: IntelligenceErrorCategory[] = ['missing_api_key', 'quota', 'network', 'api'];

/**
 * How far before the window the evidence reaches. Events in this stretch were
 * analysed already; they are shown again, with their current activity, so the
 * new events are judged against what the user was actually doing and earlier
 * groupings can be revised with hindsight.
 */
const CONTEXT_LOOKBACK_MS = 2 * HOUR_MS;
/** Lookback evidence is context, not the subject: it is cut to the most recent items. */
const MAX_CONTEXT_EVIDENCE_ITEMS = 120;
/** Recorded activities described to the model, most recent first. */
const CONTINUITY_LIMIT = 12;
/** An activity is not continued across a longer stretch with nothing tracked at all. */
const MAX_CONTINUATION_GAP_MS = 30 * 60 * 1000;
const MAX_USER_RULES = 50;

export interface IntelligenceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface IntelligenceServiceDeps {
  events: IEventRepository;
  repo: IIntelligenceRepository;
  gemini: IGeminiClient;
  activityRules: Pick<ActivityRuleRepository, 'listActivities' | 'listRules'>;
  categorization: Pick<CategorizationRepository, 'listDimensionsByType'>;
  focus: Pick<IFocusRepository, 'getSessionsByRange' | 'getProfiles'>;
  userContext: UserContextProvider;
  /**
   * Event ids, within [from, to], that belong to timeline blocks the user has
   * edited or manually classified. They are never re-assigned by a run.
   */
  getUserEditedEventIds?: (from: string, to: string) => number[];
  logger?: IntelligenceLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface AnalyzeOptions {
  /** Re-analyse a window that already has a successful run. */
  force?: boolean;
}

export interface IntelligenceStatus {
  configured: boolean;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  /** Whether the next analysis would send user context. Never the contents. */
  hasUserContext: boolean;
  onboardingStatus: OnboardingStatus | null;
  /** Number of user-created rules the next analysis would send. */
  userRuleCount: number;
  recentRuns: Omit<IntelligenceRun, 'outputJson'>[];
}

const silentLogger: IntelligenceLogger = { info() {}, warn() {}, error() {} };

export class IntelligenceService {
  private readonly log: IntelligenceLogger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serialises analyses so two runs never reconcile concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private backlogRunning = false;

  constructor(private readonly deps: IntelligenceServiceDeps) {
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isConfigured(): boolean {
    return this.deps.gemini.isConfigured();
  }

  /** Analyse [windowStart, windowEnd). Idempotent unless `force` is set. */
  analyzeWindow(windowStart: string | Date, windowEnd: string | Date, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const run = this.queue.then(() => this.runAnalysis(windowStart, windowEnd, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** "Analyse the last N minutes" — the manual prototype trigger. */
  analyzeRecent(minutes = 60, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const end = this.now();
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : 60;
    const start = new Date(end.getTime() - safeMinutes * 60_000);
    return this.analyzeWindow(start, end, options);
  }

  /**
   * Analyse every complete, hour-aligned window in the lookback period that
   * has events but no successful run yet, oldest first. Used on startup (work
   * done before a shutdown is not lost) and by the hourly scheduler.
   */
  async processBacklog(): Promise<BacklogResult> {
    if (this.backlogRunning) return { status: 'busy', windowsConsidered: 0, results: [] };
    this.backlogRunning = true;
    const results: AnalysisResult[] = [];
    let considered = 0;
    try {
      if (!this.isConfigured()) {
        this.log.warn('[INTELLIGENCE] Backlog skipped: GEMINI_API_KEY is not set.');
        return { status: 'unavailable', reason: 'missing_api_key', windowsConsidered: 0, results };
      }

      for (const window of this.pendingWindows()) {
        considered++;
        const result = await this.analyzeWindow(window.start, window.end);
        results.push(result);
        if (result.status === 'failed' && CYCLE_STOPPING_CATEGORIES.includes(result.category)) {
          this.log.warn(`[INTELLIGENCE] Backlog stopped (${result.category}); remaining windows wait for the next cycle.`);
          return { status: 'stopped', reason: result.category, windowsConsidered: considered, results };
        }
      }
      return { status: 'completed', windowsConsidered: considered, results };
    } catch (err) {
      this.log.error(`[INTELLIGENCE] Backlog error: ${messageOf(err)}`);
      return { status: 'stopped', reason: 'internal', windowsConsidered: considered, results };
    } finally {
      this.backlogRunning = false;
    }
  }

  /** Fail runs a previous process left 'running' so their windows are retried. */
  recoverInterruptedRuns(): number {
    try {
      const count = this.deps.repo.failInterruptedRuns(this.now().toISOString());
      if (count > 0) this.log.warn(`[INTELLIGENCE] Marked ${count} interrupted run(s) as failed.`);
      return count;
    } catch (err) {
      this.log.error(`[INTELLIGENCE] Could not recover interrupted runs: ${messageOf(err)}`);
      return 0;
    }
  }

  getStatus(): IntelligenceStatus {
    let recentRuns: Omit<IntelligenceRun, 'outputJson'>[] = [];
    try {
      recentRuns = this.deps.repo.listRecentRuns(20).map(({ outputJson: _output, ...run }) => run);
    } catch (err) {
      this.log.error(`[INTELLIGENCE] Could not list runs: ${messageOf(err)}`);
    }
    let hasUserContext = false;
    let onboardingStatus: OnboardingStatus | null = null;
    let userRuleCount = 0;
    try {
      hasUserContext = this.deps.userContext.getUserContext() !== null;
      onboardingStatus = this.deps.userContext.getOnboardingStatus();
      userRuleCount = this.buildUserRules().length;
    } catch (err) {
      this.log.error(`[INTELLIGENCE] Could not read context status: ${messageOf(err)}`);
    }
    return {
      configured: this.isConfigured(),
      model: this.deps.gemini.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      hasUserContext,
      onboardingStatus,
      userRuleCount,
      recentRuns,
    };
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  private async runAnalysis(
    windowStartInput: string | Date,
    windowEndInput: string | Date,
    options: AnalyzeOptions,
  ): Promise<AnalysisResult> {
    const startMs = new Date(windowStartInput).getTime();
    const endMs = new Date(windowEndInput).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
      return {
        status: 'failed',
        category: 'internal',
        error: 'Invalid analysis window',
        runId: null,
        windowStart: String(windowStartInput),
        windowEnd: String(windowEndInput),
        attempts: 0,
      };
    }
    const windowStart = new Date(startMs).toISOString();
    const windowEnd = new Date(endMs).toISOString();
    const fail = (
      category: IntelligenceErrorCategory,
      error: string,
      runId: string | null,
      attempts: number,
    ): AnalysisResult => ({ status: 'failed', category, error, runId, windowStart, windowEnd, attempts });

    let runId: string | null = null;
    let attempts = 0;
    try {
      if (!options.force && this.deps.repo.hasSucceededRun(windowStart, windowEnd)) {
        return { status: 'skipped', reason: 'already_analyzed', windowStart, windowEnd };
      }

      if (preprocessEvents(this.deps.events.getOverlapping(windowStart, windowEnd), windowStart, windowEnd).items.length === 0) {
        return { status: 'skipped', reason: 'no_events', windowStart, windowEnd };
      }
      const { evidenceStart, events, evidence } = this.gatherEvidence(startMs, windowEnd);

      // Missing key: clear, non-fatal, and nothing is written.
      if (!this.deps.gemini.isConfigured()) {
        this.log.warn('[INTELLIGENCE] Analysis unavailable: GEMINI_API_KEY is not set.');
        return fail('missing_api_key', 'GEMINI_API_KEY is not set', null, 0);
      }

      this.log.info(
        `[INTELLIGENCE] Analysis started: window ${windowStart} → ${windowEnd}, ` +
          `${events.length} raw events, ${evidence.items.length} evidence items (context from ${evidenceStart}).`,
      );

      const taxonomy = this.buildTaxonomy();
      const ownerOf = new Map(
        this.deps.repo.getActiveMemberships(events.map((e) => e.id)).map((m) => [m.eventId, m.activityId]),
      );
      const previous = this.continuityActivities(evidenceStart, windowEnd, [...new Set(ownerOf.values())]);
      const offered = new Set(previous.map((a) => a.id));
      // Read per analysis (never cached) so profile edits apply immediately.
      const userContext = this.deps.userContext.getUserContext();
      const userRules = this.buildUserRules();
      this.log.info(
        `[INTELLIGENCE] Context: user context ${userContext ? 'present' : 'not provided'}, ${userRules.length} user rule(s).`,
      );
      const promptInput: AnalysisPromptInput = {
        evidenceStart,
        windowStart,
        windowEnd,
        userContext,
        userRules,
        previousActivities: previous.map(toPreviousInput),
        focus: this.buildFocusContext(startMs, endMs),
        taxonomy,
        events: evidence.items.map(({ sourceEventIds, ...event }) => {
          const activityId = sourceEventIds.map((id) => ownerOf.get(id)).find((id) => id !== undefined && offered.has(id));
          return activityId ? { ...event, activityId } : event;
        }),
      };
      const previousIds = previous.map((a) => a.id);
      const systemInstruction = buildSystemInstruction();
      const basePrompt = buildAnalysisPrompt(promptInput);
      const responseJsonSchema = buildResponseJsonSchema(taxonomy, previousIds);

      runId = randomUUID();
      this.deps.repo.createRun({
        id: runId,
        windowStart,
        windowEnd,
        model: this.deps.gemini.model,
        promptVersion: PROMPT_VERSION,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        nowIso: this.now().toISOString(),
      });

      let accepted: { activities: ValidatedActivity[]; raw: unknown; model: string } | null = null;
      let lastError: { category: IntelligenceErrorCategory; message: string } = {
        category: 'internal',
        message: 'No attempt was made',
      };
      let feedback: string[] | null = null;

      while (attempts < MAX_ATTEMPTS && !accepted) {
        if (attempts > 0) {
          const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          this.log.warn(
            `[INTELLIGENCE] Retry ${attempts}/${MAX_ATTEMPTS - 1} in ${delay}ms after ${lastError.category}.`,
          );
          await this.sleep(delay);
        }
        attempts++;
        this.deps.repo.recordAttempt(runId, attempts, this.now().toISOString());

        try {
          this.log.info(`[INTELLIGENCE] Gemini request started (attempt ${attempts}, model ${this.deps.gemini.model}).`);
          const response = await this.deps.gemini.generateJson({
            systemInstruction,
            prompt: feedback ? `${basePrompt}\n\n${buildRetryFeedback(feedback)}` : basePrompt,
            responseJsonSchema,
          });
          this.log.info('[INTELLIGENCE] Gemini response received.');

          let raw: unknown;
          try {
            raw = JSON.parse(response.text);
          } catch {
            lastError = { category: 'malformed_output', message: 'Response was not valid JSON' };
            feedback = ['The response was not valid JSON.'];
            this.log.warn('[INTELLIGENCE] Malformed structured output (not JSON).');
            continue;
          }

          const validation = validateAnalysisOutput(raw, {
            windowStart,
            windowEnd,
            evidenceStart,
            evidence: evidence.items,
            taxonomy,
            previousActivityIds: previousIds,
          });
          if (!validation.ok) {
            lastError = { category: 'validation', message: validation.errors.slice(0, 5).join('; ') };
            feedback = validation.errors;
            this.log.warn(`[INTELLIGENCE] Validation failed: ${validation.errors.length} problem(s). ${lastError.message}`);
            continue;
          }
          accepted = { activities: validation.activities, raw, model: response.modelVersion };
        } catch (err) {
          if (!(err instanceof GeminiError)) throw err;
          lastError = { category: err.category, message: err.message };
          this.log.warn(`[INTELLIGENCE] Gemini request failed (${err.category}).`);
          if (!err.retryable) break;
        }
      }

      if (!accepted) {
        this.failRun(runId, lastError.category, lastError.message);
        this.log.error(
          `[INTELLIGENCE] Analysis failed after ${attempts} attempt(s): ${lastError.category} — ${lastError.message}`,
        );
        return fail(lastError.category, lastError.message, runId, attempts);
      }
      this.log.info(`[INTELLIGENCE] Gemini success: ${accepted.activities.length} activities generated.`);

      // ── reconcile + persist (all or nothing) ──
      let plan: ReconcilePlan;
      try {
        plan = this.reconcile(events, accepted.activities, evidence.droppedEventIds, previous, evidenceStart, windowEnd);
        this.deps.repo.commitRun({
          runId,
          windowStart,
          windowEnd,
          model: accepted.model,
          attemptCount: attempts,
          outputJson: JSON.stringify(accepted.raw),
          plan,
          nowIso: this.now().toISOString(),
        });
      } catch (err) {
        const message = messageOf(err);
        this.failRun(runId, 'persistence', message);
        this.log.error(`[INTELLIGENCE] Persistence failed; previous AI state kept: ${message}`);
        return fail('persistence', message, runId, attempts);
      }

      this.log.info(
        `[INTELLIGENCE] Persisted run ${runId}: ${plan.create.length} created, ${plan.extend.length} extended, ` +
          `${plan.detach.length} adjusted, ${plan.userProtectedEventIds.length} user-protected event(s) left untouched.`,
      );
      return {
        status: 'succeeded',
        runId,
        windowStart,
        windowEnd,
        attempts,
        eventCount: events.length,
        activitiesCreated: plan.create.length,
        activitiesExtended: plan.extend.length,
      };
    } catch (err) {
      const message = messageOf(err);
      if (runId) this.failRun(runId, 'internal', message);
      this.log.error(`[INTELLIGENCE] Analysis failed (internal): ${message}`);
      return fail('internal', message, runId, attempts);
    }
  }

  /**
   * The evidence for a window: its own events plus the lookback context. The
   * lookback is shortened when it alone would crowd the prompt; the window's
   * own events are never cut.
   */
  private gatherEvidence(
    windowStartMs: number,
    windowEnd: string,
  ): { evidenceStart: string; events: Event[]; evidence: PreprocessResult } {
    const load = (evidenceStart: string) => {
      const events = sortChronologically(this.deps.events.getOverlapping(evidenceStart, windowEnd));
      return { evidenceStart, events, evidence: preprocessEvents(events, evidenceStart, windowEnd) };
    };
    const full = load(new Date(windowStartMs - CONTEXT_LOOKBACK_MS).toISOString());
    const context = full.evidence.items.filter((item) => Date.parse(item.endedAt) <= windowStartMs);
    if (context.length <= MAX_CONTEXT_EVIDENCE_ITEMS) return full;
    return load(context[context.length - MAX_CONTEXT_EVIDENCE_ITEMS].startedAt);
  }

  /**
   * Recorded activities the model may continue: every activity that owns
   * evidence it is shown, and the most recent ones reaching into that stretch.
   * Oldest first.
   */
  private continuityActivities(evidenceStart: string, windowEnd: string, ownerIds: string[]): IntelligenceActivity[] {
    const { repo } = this.deps;
    const byId = new Map<string, IntelligenceActivity>();
    for (const activity of repo.listContinuityActivities(windowEnd, evidenceStart, CONTINUITY_LIMIT)) {
      byId.set(activity.id, activity);
    }
    for (const activity of repo.getActivitiesByIds(ownerIds.filter((id) => !byId.has(id)))) {
      if (activity.supersededAt === null) byId.set(activity.id, activity);
    }
    return [...byId.values()].sort(
      (a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt) || Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
  }

  private reconcile(
    events: Event[],
    activities: ValidatedActivity[],
    droppedEventIds: number[],
    previous: IntelligenceActivity[],
    windowStart: string,
    windowEnd: string,
  ): ReconcilePlan {
    const { repo } = this.deps;
    const eventIds = events.map((e) => e.id);
    const nowIso = this.now().toISOString();

    // Anything the user edited in this region is off limits. AI activities
    // behind those edits are locked first so the rule holds from here on.
    const windowIds = new Set(eventIds);
    const protectedEventIds = new Set(
      (this.deps.getUserEditedEventIds?.(windowStart, windowEnd) ?? []).filter((id) => windowIds.has(id)),
    );
    if (protectedEventIds.size > 0) repo.lockActivitiesForEvents([...protectedEventIds], nowIso);

    const memberships = new Map(
      repo.getActiveMemberships(eventIds).map((m) => [m.eventId, { activityId: m.activityId, userLocked: m.userLocked }]),
    );
    // Re-read lock state: a previous activity may just have been locked.
    const current = new Map(repo.getActivitiesByIds(previous.map((a) => a.id)).map((a) => [a.id, a]));

    return planReconciliation({
      windowEvents: events.map((e) => ({ id: e.id, startedAt: e.startedAt, endedAt: e.endedAt })),
      activities,
      droppedEventIds,
      memberships,
      previous: new Map(
        previous.map((a) => {
          const fresh = current.get(a.id) ?? a;
          return [a.id, { userLocked: fresh.userLocked || fresh.supersededAt !== null, endedAt: fresh.endedAt }];
        }),
      ),
      protectedEventIds,
      maxContinuationGapMs: MAX_CONTINUATION_GAP_MS,
      newId: () => `ai-${randomUUID()}`,
    });
  }

  private failRun(runId: string, category: IntelligenceErrorCategory, message: string): void {
    try {
      this.deps.repo.failRun(runId, category, message.slice(0, 1000), this.now().toISOString());
    } catch (err) {
      this.log.error(`[INTELLIGENCE] Could not record run failure: ${messageOf(err)}`);
    }
  }

  // ── backlog ────────────────────────────────────────────────────────────────

  /** Complete local-hour windows with events and no successful run, oldest first. */
  private pendingWindows(): { start: string; end: string }[] {
    const now = this.now();
    const currentHour = new Date(now);
    currentHour.setMinutes(0, 0, 0);

    const pending: { start: string; end: string }[] = [];
    for (let end = currentHour.getTime() - BACKLOG_LOOKBACK_MS + HOUR_MS; end <= currentHour.getTime(); end += HOUR_MS) {
      const start = new Date(end - HOUR_MS).toISOString();
      const endIso = new Date(end).toISOString();
      if (this.deps.repo.hasSucceededRun(start, endIso)) continue;
      if (this.deps.events.getOverlapping(start, endIso).length === 0) continue;
      if (this.deps.repo.countFailedRuns(start, endIso, REJECTION_CATEGORIES) >= MAX_REJECTED_RUNS_PER_WINDOW) continue;
      pending.push({ start, end: endIso });
    }
    return pending;
  }

  // ── context builders ───────────────────────────────────────────────────────

  private buildTaxonomy(): AllowedTaxonomy {
    const dims = (type: 'area' | 'intent' | 'quality') =>
      this.deps.categorization.listDimensionsByType(type).map((d) => ({ id: d.id, name: d.name }));
    return {
      contexts: this.deps.activityRules.listActivities().map((a) => ({ id: a.id, name: a.name })),
      areas: dims('area'),
      intents: dims('intent'),
      qualities: dims('quality'),
    };
  }

  /** Only rules the user explicitly created or confirmed (learned) — never
   * seeded/system defaults. */
  private buildUserRules(): UserRuleInput[] {
    const rules: UserRuleInput[] = [];
    for (const rule of this.deps.activityRules.listRules()) {
      if (rule.enabled !== 1 || (rule.source !== 'user' && rule.source !== 'learned')) continue;
      let conditions: RuleCondition[];
      try {
        conditions = JSON.parse(rule.conditions) as RuleCondition[];
      } catch {
        continue;
      }
      if (!Array.isArray(conditions) || conditions.length === 0) continue;
      rules.push({
        id: rule.id,
        conditions: conditions.map((c) => ({ type: c.type, value: c.value })),
        classification: {
          contextId: rule.activityId || null,
          areaId: rule.areaId,
          intentId: rule.intentId,
          qualityId: rule.qualityId,
        },
      });
      if (rules.length >= MAX_USER_RULES) break;
    }
    return rules;
  }

  private buildFocusContext(startMs: number, endMs: number): FocusContextInput[] {
    const { focus } = this.deps;
    const sessions = focus.getSessionsByRange(
      new Date(startMs - 24 * HOUR_MS).toISOString(),
      new Date(endMs).toISOString(),
    );
    const profileNames = new Map(focus.getProfiles().map((p) => [p.id, p.name]));
    const result: FocusContextInput[] = [];
    for (const session of sessions) {
      if (!session.startedAt || session.state === 'planned' || session.state === 'cancelled') continue;
      const sessionStart = Date.parse(session.startedAt);
      const sessionEnd = session.endedAt ? Date.parse(session.endedAt) : Infinity;
      if (sessionStart >= endMs || sessionEnd <= startMs) continue;
      result.push({
        task: session.task,
        profileName: profileNames.get(session.profileId) ?? 'Focus',
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      });
    }
    return result;
  }
}

function toPreviousInput(activity: IntelligenceActivity): PreviousActivityInput {
  return {
    id: activity.id,
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    title: activity.title,
    summary: activity.summary,
    contextId: activity.contextId,
    areaId: activity.areaId,
    intentId: activity.intentId,
    qualityId: activity.qualityId,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
