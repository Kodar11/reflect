import { randomUUID } from 'node:crypto';
import type { ActivityRuleRepository } from '../database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../database/CategorizationRepository.js';
import type { IEventRepository } from '../database/EventRepository.js';
import type { IIntelligenceRepository } from '../database/IntelligenceRepository.js';
import type { ILearnedRuleCandidateRepository } from '../database/LearnedRuleCandidateRepository.js';
import type { RuleCondition } from '../categorization/Classification.js';
import type { ClassificationCorrection, CorrectionObserver } from '../categorization/CategorizationService.js';
import { GeminiError, type IGeminiClient } from '../intelligence/GeminiClient.js';
import type { IntelligenceActivity, UserContextProvider } from '../intelligence/IntelligenceModels.js';
import { formatIntelligenceContext } from '../profile/UserProfile.js';
import {
  activityFromEvents,
  activityKey,
  classificationHash,
  describeClassification,
  describeEvidence,
  describePattern,
  hasAnyClassification,
  localDay,
  normalizeConditions,
  patternHash,
  patternMatches,
  sameClassification,
} from './LearnedPattern.js';
import {
  eligibilityBlockers,
  inGlobalCooldown,
  inSuggestionCooldown,
  isConsistent,
  isCoveredByRule,
  rankCandidates,
  summarizeEvidence,
  type EligibilityContext,
  type RuleForCoverage,
} from './LearnedRuleEligibility.js';
import {
  buildPatternPrompt,
  buildPatternResponseJsonSchema,
  buildPatternRetryFeedback,
  buildPatternSystemInstruction,
} from './LearnedPatternPrompt.js';
import { validatePatternProposal } from './LearnedPatternValidator.js';
import {
  DEFAULT_LEARNED_RULE_CONFIG,
  type CandidateStatus,
  type ClassificationIds,
  type ClassificationNames,
  type ConfirmResult,
  type LearnedRuleCandidate,
  type LearnedRuleCandidateView,
  type LearnedRuleConfig,
  type LearnedRuleSuggestion,
  type LearningActivity,
  type ObservationResult,
  type PatternEvidenceEvent,
  type PatternPromptInput,
  type SuggestionTrigger,
  type TrackResult,
} from './LearnedRuleModels.js';

/**
 * `LearnedRuleService` owns every business rule of pattern learning:
 *
 *   user correction ─► (Gemini, once) reusable pattern ─► candidate
 *   timeline activities ─► local deterministic matching ─► candidate evidence
 *   eligible candidate ─► suggestion ─► user confirms ─► tracking_rule (learned)
 *
 * Gemini is used only to generalise a correction into conditions. Counting
 * occurrences, eligibility and choosing what to suggest are all local and
 * deterministic. Nothing here ever creates a rule without the user's
 * confirmation, and nothing here writes to raw events.
 *
 * Learning is an enhancement: `observeCorrection` never rejects, and a failure
 * leaves the saved correction and every existing rule untouched.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One initial attempt + one retry with validation feedback. */
const MAX_EXTRACTION_ATTEMPTS = 2;
/** Occurrence tracking is re-run at most this often when driven by polling. */
const TRACK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The timeline is fetched by event start time, so an activity straddling the
 * start of a fetch range comes back truncated. Fetching this much earlier than
 * needed keeps every activity we actually look at whole.
 */
const FETCH_MARGIN_MS = DAY_MS;

const MAX_EVIDENCE_EVENTS = 25;
const MAX_CONTRAST_ACTIVITIES = 20;
const CONTRAST_LOOKBACK_MS = 3 * DAY_MS;
const MAX_EXISTING_RULES = 20;
const MAX_TEXT_LENGTH = 160;

/** Candidates that still accumulate evidence. */
const TRACKED_STATUSES: CandidateStatus[] = ['pending', 'snoozed', 'confirmed'];

export interface LearnedRuleLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LearnedRuleServiceDeps {
  repo: ILearnedRuleCandidateRepository;
  gemini: IGeminiClient;
  events: Pick<IEventRepository, 'getByIds'>;
  activityRules: Pick<ActivityRuleRepository, 'listRules' | 'listActivities'>;
  categorization: Pick<CategorizationRepository, 'listDimensions'>;
  /** Activities of the verified timeline within [from, to] (ISO). */
  getActivities: (fromIso: string, toIso: string) => LearningActivity[];
  /** Lets a correction be tied to the AI activity it corrected. */
  intelligence?: Pick<IIntelligenceRepository, 'getActiveMemberships' | 'getActivitiesByIds'>;
  userContext?: Pick<UserContextProvider, 'getUserContext'>;
  /** Called after a learned rule is created, so views can refresh. */
  onRulesChanged?: () => void;
  logger?: LearnedRuleLogger;
  now?: () => Date;
  newId?: () => string;
  config?: Partial<LearnedRuleConfig>;
}

const silentLogger: LearnedRuleLogger = { info() {}, warn() {}, error() {} };

export class LearnedRuleService implements CorrectionObserver {
  private readonly config: LearnedRuleConfig;
  private readonly log: LearnedRuleLogger;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Serialises observations so two corrections never race on one candidate. */
  private queue: Promise<unknown> = Promise.resolve();
  private extractionTimes: number[] = [];
  private lastTrackedMs = -Infinity;

  constructor(private readonly deps: LearnedRuleServiceDeps) {
    this.config = { ...DEFAULT_LEARNED_RULE_CONFIG, ...deps.config };
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ── corrections → candidates ───────────────────────────────────────────────

  /** `CorrectionObserver`: fire-and-forget entry point used by categorization. */
  onCorrection(correction: ClassificationCorrection): void {
    void this.observeCorrection(correction);
  }

  /**
   * Learn from a manual correction that did not become an explicit rule.
   * Idempotent: observing the same corrected activity again neither creates a
   * second candidate nor counts a second correction.
   */
  observeCorrection(correction: ClassificationCorrection): Promise<ObservationResult> {
    const run = this.queue.then(() => this.runObservation(correction));
    this.queue = run.catch(() => undefined);
    return run.catch((err): ObservationResult => {
      this.log.error(`[LEARNING] Observation failed: ${messageOf(err)}`);
      return { status: 'skipped', reason: 'error', detail: messageOf(err) };
    });
  }

  private async runObservation(correction: ClassificationCorrection): Promise<ObservationResult> {
    const classification: ClassificationIds = {
      contextId: correction.contextId ?? null,
      areaId: correction.areaId ?? null,
      intentId: correction.intentId ?? null,
      qualityId: correction.qualityId ?? null,
    };
    if (!hasAnyClassification(classification)) return { status: 'skipped', reason: 'no_classification' };

    const taxonomy = this.loadTaxonomy();
    if (!taxonomy.isValid(classification)) return { status: 'skipped', reason: 'invalid_classification' };

    const events = this.deps.events.getByIds(correction.eventIds);
    const original = this.findAiActivity(events.map((e) => e.id));
    const activity = activityFromEvents(events, original?.id ?? null, classification, 'user_override');
    if (!activity) return { status: 'skipped', reason: 'no_events' };

    // 1. Local first. Every live candidate this activity matches gets the
    //    evidence (support or conflict). If one already stands for exactly this
    //    correction, there is nothing for Gemini to rediscover.
    const known = this.deps.repo.transaction(() => {
      let match: LearnedRuleCandidate | null = null;
      for (const candidate of this.deps.repo.listCandidates()) {
        if (!patternMatches(activity, candidate.conditions)) continue;
        // A dismissed candidate gathers no evidence, but it still answers
        // "is this pattern already known?" — Gemini is not asked again.
        if (TRACKED_STATUSES.includes(candidate.status)) this.recordActivity(candidate, activity);
        if (match === null && sameClassification(candidate.classification, classification)) match = candidate;
      }
      return match;
    });
    if (known) {
      this.log.info(`[LEARNING] Correction matched existing candidate ${known.id}; no extraction needed.`);
      return { status: 'candidate', candidateId: known.id, created: false, usedGemini: false };
    }

    // 2. A new kind of correction: ask Gemini for the reusable pattern.
    if (!this.deps.gemini.isConfigured()) {
      this.log.warn('[LEARNING] Pattern extraction unavailable: GEMINI_API_KEY is not set.');
      return { status: 'skipped', reason: 'gemini_unavailable' };
    }
    if (!this.takeExtractionSlot()) {
      this.log.warn('[LEARNING] Pattern extraction skipped: hourly limit reached.');
      return { status: 'skipped', reason: 'rate_limited' };
    }

    const extraction = await this.extractPattern(activity, events, original, classification, taxonomy);
    if (extraction.status !== 'pattern') return { status: 'skipped', reason: extraction.status, detail: extraction.detail };

    // 3. Store. The unique (pattern, classification) identity makes this idempotent.
    const hash = patternHash(extraction.pattern);
    const clsHash = classificationHash(classification);
    const nowIso = this.now().toISOString();
    const { candidate, created } = this.deps.repo.transaction(() => {
      const before = this.deps.repo.findByPatternHash(hash, clsHash);
      const stored = this.deps.repo.createCandidate({
        id: `lrc_${this.newId()}`,
        patternHash: hash,
        classificationHash: clsHash,
        conditions: extraction.pattern,
        classification,
        nowIso,
      });
      if (stored.status !== 'dismissed') this.recordActivity(stored, activity);
      return { candidate: stored, created: before === null };
    });
    this.log.info(
      `[LEARNING] Candidate ${created ? 'created' : 'updated'}: ${describePattern(candidate.conditions)} ` +
        `(${candidate.conditions.length} condition(s)).`,
    );
    return { status: 'candidate', candidateId: candidate.id, created, usedGemini: true };
  }

  private async extractPattern(
    activity: LearningActivity,
    events: { app: string | null; browser: string | null; title: string | null; url: string | null; startedAt: string; endedAt: string }[],
    original: IntelligenceActivity | null,
    classification: ClassificationIds,
    taxonomy: Taxonomy,
  ): Promise<
    | { status: 'pattern'; pattern: RuleCondition[] }
    | { status: 'no_pattern' | 'rejected' | 'error'; detail?: string }
  > {
    const input = this.buildPromptInput(activity, events, original, classification, taxonomy);
    const systemInstruction = buildPatternSystemInstruction();
    const basePrompt = buildPatternPrompt(input);
    const responseJsonSchema = buildPatternResponseJsonSchema(this.config.maxConditions);

    let feedback: string[] | null = null;
    for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt++) {
      let text: string;
      try {
        const response = await this.deps.gemini.generateJson({
          systemInstruction,
          prompt: feedback ? `${basePrompt}\n\n${buildPatternRetryFeedback(feedback)}` : basePrompt,
          responseJsonSchema,
        });
        text = response.text;
      } catch (err) {
        const detail = err instanceof GeminiError ? err.category : messageOf(err);
        this.log.warn(`[LEARNING] Gemini request failed (${detail}).`);
        return { status: 'error', detail };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        feedback = ['The response was not valid JSON.'];
        continue;
      }

      const validation = validatePatternProposal(raw, { activity, config: this.config });
      if (validation.ok) {
        if (validation.pattern === null) {
          this.log.info(`[LEARNING] No reusable pattern (${validation.reason}).`);
          return { status: 'no_pattern', detail: validation.reason };
        }
        return { status: 'pattern', pattern: validation.pattern };
      }
      feedback = validation.errors;
      this.log.warn(`[LEARNING] Proposal rejected: ${validation.errors.slice(0, 3).join('; ')}`);
    }
    return { status: 'rejected', detail: feedback?.slice(0, 3).join('; ') };
  }

  // ── activities → evidence (local, deterministic, idempotent) ──────────────

  /**
   * Match recent timeline activities against tracked candidates and update
   * their evidence. Never calls Gemini. Safe to run any number of times: an
   * activity contributes at most one occurrence per candidate.
   */
  trackOccurrences(): TrackResult {
    const now = this.now();
    this.lastTrackedMs = now.getTime();
    const result: TrackResult = { activitiesScanned: 0, occurrencesRecorded: 0 };
    try {
      const candidates = this.deps.repo.listCandidates(TRACKED_STATUSES);
      if (candidates.length === 0) return result;

      const cutoff = new Date(now.getTime() - this.config.trackingLookbackHours * HOUR_MS).toISOString();
      const from = new Date(now.getTime() - this.config.trackingLookbackHours * HOUR_MS - FETCH_MARGIN_MS).toISOString();
      const activities = this.deps
        .getActivities(from, now.toISOString())
        .filter((a) => a.eventIds.length > 0 && a.startedAt >= cutoff);
      result.activitiesScanned = activities.length;

      this.deps.repo.transaction(() => {
        for (const activity of activities) {
          const explicit = activity.classificationSource === 'user_override';
          // A glance at a window is not "the user's activity matched this pattern".
          if (!explicit && activity.activeDurationMs < this.config.minOccurrenceDurationMs) continue;
          for (const candidate of candidates) {
            if (!patternMatches(activity, candidate.conditions)) continue;
            if (this.recordActivity(candidate, activity)) result.occurrencesRecorded++;
          }
        }
      });
    } catch (err) {
      this.log.error(`[LEARNING] Occurrence tracking failed: ${messageOf(err)}`);
    }
    return result;
  }

  /**
   * Upsert the ledger row for (candidate, activity) and refresh the counters.
   * An activity the user explicitly classified is a correction when it agrees
   * with the candidate and a conflict when it does not. Returns whether
   * anything changed.
   */
  private recordActivity(candidate: LearnedRuleCandidate, activity: LearningActivity): boolean {
    const { repo } = this.deps;
    const explicit = activity.classificationSource === 'user_override';
    const agrees = sameClassification(activity.classification, candidate.classification);
    const isCorrection = explicit && agrees;
    const isConflict = explicit && !agrees;

    const key = activityKey(activity);
    const existing = repo.findOccurrence(candidate.id, key, activity.eventIds);
    if (existing && existing.isCorrection === isCorrection && existing.isConflict === isConflict) return false;

    repo.saveOccurrence({
      candidateId: candidate.id,
      occurrenceKey: existing?.occurrenceKey ?? key,
      anchorEventId: existing?.anchorEventId ?? (activity.eventIds.length > 0 ? Math.min(...activity.eventIds) : null),
      localDay: existing?.localDay ?? localDay(activity.startedAt),
      occurredAt: existing?.occurredAt ?? activity.startedAt,
      isCorrection,
      isConflict,
    });
    repo.updateEvidence(candidate.id, summarizeEvidence(repo.listOccurrences(candidate.id)), this.now().toISOString());
    return true;
  }

  // ── suggestions ────────────────────────────────────────────────────────────

  /**
   * The one suggestion worth interrupting for right now, or null. Two triggers
   * share one candidate system and one cooldown:
   *   contextual — the current activity matches an eligible candidate
   *   daily      — end of day, for candidates seen today
   * Returning a suggestion records that it was shown.
   */
  nextSuggestion(): LearnedRuleSuggestion | null {
    try {
      const now = this.now();
      const nowMs = now.getTime();
      if (nowMs - this.lastTrackedMs >= TRACK_INTERVAL_MS) this.trackOccurrences();

      const { repo } = this.deps;
      if (inGlobalCooldown(repo.lastSuggestedAt(), nowMs, this.config)) return null;

      const ctx = this.eligibilityContext(nowMs);
      const eligible = ctx.all.filter(
        (c) => eligibilityBlockers(c, ctx).length === 0 && !inSuggestionCooldown(c, nowMs, this.config),
      );
      if (eligible.length === 0) return null;

      let chosen: LearnedRuleCandidate | undefined;
      let trigger: SuggestionTrigger = 'contextual';

      const current = this.currentActivity(now);
      if (current) {
        chosen = rankCandidates(
          eligible.filter((c) => patternMatches(current, c.conditions)),
          nowMs,
        )[0];
      }
      if (!chosen && now.getHours() >= this.config.endOfDayHour) {
        const today = localDay(now);
        chosen = rankCandidates(
          eligible.filter((c) => c.lastSeenAt !== null && localDay(c.lastSeenAt) === today),
          nowMs,
        )[0];
        trigger = 'daily';
      }
      if (!chosen) return null;

      repo.markSuggested(chosen.id, now.toISOString());
      return this.toSuggestion(chosen, trigger, this.loadTaxonomy());
    } catch (err) {
      this.log.error(`[LEARNING] Could not select a suggestion: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * Every candidate that is eligible right now, most relevant first. For the
   * Rules page, where the user came to look — so no cooldown applies and
   * nothing is recorded as shown.
   */
  listSuggestions(): LearnedRuleSuggestion[] {
    const nowMs = this.now().getTime();
    const ctx = this.eligibilityContext(nowMs);
    const taxonomy = this.loadTaxonomy();
    return rankCandidates(
      ctx.all.filter((c) => eligibilityBlockers(c, ctx).length === 0),
      nowMs,
    ).map((c) => this.toSuggestion(c, 'list', taxonomy));
  }

  // ── candidate access ───────────────────────────────────────────────────────

  listCandidates(statuses?: CandidateStatus[]): LearnedRuleCandidateView[] {
    const ctx = this.eligibilityContext(this.now().getTime());
    const taxonomy = this.loadTaxonomy();
    return ctx.all
      .filter((c) => !statuses || statuses.includes(c.status))
      .map((c) => this.toView(c, ctx, taxonomy));
  }

  getCandidate(id: string): LearnedRuleCandidateView | null {
    const ctx = this.eligibilityContext(this.now().getTime());
    const candidate = ctx.all.find((c) => c.id === id);
    return candidate ? this.toView(candidate, ctx, this.loadTaxonomy()) : null;
  }

  // ── user decisions ─────────────────────────────────────────────────────────

  /**
   * "Remember": turn a candidate into a `tracking_rules` row with
   * source = 'learned'. Everything is revalidated and the whole step is one
   * transaction. Confirming twice returns the same rule.
   */
  confirmCandidate(id: string): ConfirmResult {
    const { repo } = this.deps;
    const result = repo.transaction((): ConfirmResult => {
      const candidate = repo.getCandidate(id);
      if (!candidate) throw new Error(`Learned pattern not found: ${id}`);

      const rules = this.deps.activityRules.listRules();
      if (candidate.status === 'confirmed' && candidate.confirmedRuleId) {
        if (rules.some((r) => r.id === candidate.confirmedRuleId)) {
          return { ruleId: candidate.confirmedRuleId, created: false };
        }
      }
      if (candidate.status === 'dismissed') {
        throw new Error('This pattern was dismissed; restore it before remembering it.');
      }

      // Conditions: still supported, non-empty, bounded, and still the pattern
      // this candidate was identified by.
      const conditions = normalizeConditions(candidate.conditions);
      if (
        conditions.length === 0 ||
        conditions.length !== candidate.conditions.length ||
        conditions.length > this.config.maxConditions ||
        patternHash(conditions) !== candidate.patternHash
      ) {
        throw new Error('This pattern is no longer valid and cannot be remembered.');
      }

      // Classification: ids must still exist in the taxonomy.
      if (!hasAnyClassification(candidate.classification) || !this.loadTaxonomy().isValid(candidate.classification)) {
        throw new Error('The classification of this pattern no longer exists.');
      }

      // No duplicate: an explicit or learned rule must not already do this.
      if (isCoveredByRule(candidate, this.explicitRules())) {
        throw new Error('An existing rule already covers this pattern.');
      }

      const nowIso = this.now().toISOString();
      const ruleId = `rule_learned_${this.newId()}`;
      repo.insertLearnedRule({
        id: ruleId,
        candidateId: candidate.id,
        conditions,
        classification: candidate.classification,
        priority: this.config.learnedRulePriority,
        nowIso,
      });
      repo.markConfirmed(candidate.id, ruleId, nowIso);
      return { ruleId, created: true };
    });

    if (result.created) {
      this.log.info(`[LEARNING] Candidate ${id} confirmed as learned rule ${result.ruleId}.`);
      try {
        this.deps.onRulesChanged?.();
      } catch (err) {
        this.log.error(`[LEARNING] onRulesChanged failed: ${messageOf(err)}`);
      }
    }
    return result;
  }

  /** "Not now": hide the candidate for a while; it may come back. */
  snoozeCandidate(id: string): void {
    const now = this.now();
    const until = new Date(now.getTime() + this.config.resuggestAfterDays * DAY_MS).toISOString();
    this.deps.repo.snooze(id, until, now.toISOString());
  }

  /** "Never suggest this". */
  dismissCandidate(id: string): void {
    this.deps.repo.dismiss(id, this.now().toISOString());
  }

  /** Explicitly bring a snoozed or dismissed candidate back. */
  reactivateCandidate(id: string): void {
    this.deps.repo.reactivate(id, this.now().toISOString());
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private eligibilityContext(nowMs: number): EligibilityContext {
    return {
      nowMs,
      config: this.config,
      all: this.deps.repo.listCandidates(),
      rules: this.explicitRules(),
    };
  }

  /**
   * Rules that express the user's own knowledge (explicit + confirmed
   * learned). System defaults do not suppress learning: a learned rule
   * outranks them anyway.
   */
  private explicitRules(): RuleForCoverage[] {
    const rules: RuleForCoverage[] = [];
    for (const rule of this.deps.activityRules.listRules()) {
      if (rule.source === 'system') continue;
      let conditions: RuleCondition[];
      try {
        conditions = JSON.parse(rule.conditions) as RuleCondition[];
      } catch {
        continue;
      }
      if (!Array.isArray(conditions)) continue;
      rules.push({
        enabled: rule.enabled === 1,
        conditions,
        classification: {
          contextId: rule.activityId || null,
          areaId: rule.areaId,
          intentId: rule.intentId,
          qualityId: rule.qualityId,
        },
      });
    }
    return rules;
  }

  /** The most recent activity, if it is still going (or only just ended). */
  private currentActivity(now: Date): LearningActivity | null {
    const windowMs = this.config.contextualWindowMinutes * 60_000;
    const from = new Date(now.getTime() - FETCH_MARGIN_MS).toISOString();
    let latest: LearningActivity | null = null;
    for (const activity of this.deps.getActivities(from, now.toISOString())) {
      if (activity.eventIds.length === 0) continue;
      if (now.getTime() - Date.parse(activity.endedAt) > windowMs) continue;
      if (activity.activeDurationMs < this.config.minOccurrenceDurationMs) continue;
      if (latest === null || activity.endedAt > latest.endedAt) latest = activity;
    }
    return latest;
  }

  /** The active AI activity owning most of these events, if any. */
  private findAiActivity(eventIds: number[]): IntelligenceActivity | null {
    const intelligence = this.deps.intelligence;
    if (!intelligence || eventIds.length === 0) return null;
    try {
      const counts = new Map<string, number>();
      for (const m of intelligence.getActiveMemberships(eventIds)) {
        counts.set(m.activityId, (counts.get(m.activityId) ?? 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (!best) return null;
      return intelligence.getActivitiesByIds([best[0]])[0] ?? null;
    } catch (err) {
      this.log.warn(`[LEARNING] Could not resolve the corrected AI activity: ${messageOf(err)}`);
      return null;
    }
  }

  private takeExtractionSlot(): boolean {
    const nowMs = this.now().getTime();
    this.extractionTimes = this.extractionTimes.filter((t) => nowMs - t < HOUR_MS);
    if (this.extractionTimes.length >= this.config.maxExtractionsPerHour) return false;
    this.extractionTimes.push(nowMs);
    return true;
  }

  /** Only what extraction needs: no payloads, no ids, bounded text. */
  private buildPromptInput(
    activity: LearningActivity,
    events: { app: string | null; browser: string | null; title: string | null; url: string | null; startedAt: string; endedAt: string }[],
    original: IntelligenceActivity | null,
    classification: ClassificationIds,
    taxonomy: Taxonomy,
  ): PatternPromptInput {
    const grouped = new Map<string, PatternEvidenceEvent>();
    for (const e of events) {
      const item: PatternEvidenceEvent = {
        app: e.app,
        browser: e.browser,
        title: clip(e.title),
        url: clip(e.url),
        seconds: 0,
      };
      const key = JSON.stringify([item.app, item.browser, item.title, item.url]);
      const entry = grouped.get(key) ?? item;
      entry.seconds += Math.max(0, Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000));
      grouped.set(key, entry);
    }

    const ownEvents = new Set(activity.eventIds);
    const nowMs = this.now().getTime();
    const seen = new Set<string>();
    const otherActivities: PatternPromptInput['otherActivities'] = [];
    let recent: LearningActivity[] = [];
    try {
      recent = this.deps.getActivities(new Date(nowMs - CONTRAST_LOOKBACK_MS).toISOString(), new Date(nowMs).toISOString());
    } catch (err) {
      this.log.warn(`[LEARNING] Could not load contrast activities: ${messageOf(err)}`);
    }
    for (const other of [...recent].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
      if (other.eventIds.some((id) => ownEvents.has(id))) continue;
      const entry = {
        app: other.primaryApp ?? null,
        title: clip(other.primaryTitle ?? null),
        url: clip(other.primaryUrl ?? null),
      };
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      otherActivities.push({ ...entry, classification: taxonomy.names(other.classification) });
      if (otherActivities.length >= MAX_CONTRAST_ACTIVITIES) break;
    }

    const userContext = this.deps.userContext?.getUserContext() ?? null;
    return {
      correctedAt: this.now().toISOString(),
      activity: {
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
        primaryApp: activity.primaryApp ?? null,
        primaryBrowser: activity.primaryBrowser ?? null,
        primaryTitle: clip(activity.primaryTitle ?? null),
        primaryUrl: clip(activity.primaryUrl ?? null),
      },
      original: original
        ? { title: original.title, summary: original.summary, classification: taxonomy.names(original) }
        : null,
      corrected: taxonomy.names(classification),
      events: [...grouped.values()].sort((a, b) => b.seconds - a.seconds).slice(0, MAX_EVIDENCE_EVENTS),
      otherActivities,
      userContext: userContext ? formatIntelligenceContext(userContext) || null : null,
      existingRules: this.explicitRules()
        .filter((r) => r.enabled)
        .slice(0, MAX_EXISTING_RULES)
        .map((r) => ({ conditions: normalizeConditions(r.conditions), classification: taxonomy.names(r.classification) })),
      maxConditions: this.config.maxConditions,
    };
  }

  private loadTaxonomy(): Taxonomy {
    const contexts = new Map(this.deps.activityRules.listActivities().map((a) => [a.id, a.name]));
    const dimensions = new Map(this.deps.categorization.listDimensions().map((d) => [d.id, d]));
    const dimensionName = (id: string | null, kind: 'area' | 'intent' | 'quality'): string | null => {
      const d = id ? dimensions.get(id) : undefined;
      return d && d.dimension === kind ? d.name : null;
    };
    const dimensionOk = (id: string | null, kind: 'area' | 'intent' | 'quality'): boolean =>
      id === null || dimensions.get(id)?.dimension === kind;
    return {
      isValid: (c) =>
        (c.contextId === null || contexts.has(c.contextId)) &&
        dimensionOk(c.areaId, 'area') &&
        dimensionOk(c.intentId, 'intent') &&
        dimensionOk(c.qualityId, 'quality'),
      names: (c) => ({
        context: c.contextId ? contexts.get(c.contextId) ?? null : null,
        area: dimensionName(c.areaId, 'area'),
        intent: dimensionName(c.intentId, 'intent'),
        quality: dimensionName(c.qualityId, 'quality'),
      }),
    };
  }

  private toSuggestion(candidate: LearnedRuleCandidate, trigger: SuggestionTrigger, taxonomy: Taxonomy): LearnedRuleSuggestion {
    return {
      candidateId: candidate.id,
      trigger,
      conditions: candidate.conditions,
      patternLabel: describePattern(candidate.conditions),
      classification: candidate.classification,
      classificationLabel: describeClassification(taxonomy.names(candidate.classification)),
      evidenceLabel: describeEvidence(candidate.occurrenceCount, candidate.distinctDayCount),
      occurrenceCount: candidate.occurrenceCount,
      distinctDayCount: candidate.distinctDayCount,
      correctionCount: candidate.correctionCount,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
    };
  }

  private toView(candidate: LearnedRuleCandidate, ctx: EligibilityContext, taxonomy: Taxonomy): LearnedRuleCandidateView {
    const blockedBy = eligibilityBlockers(candidate, ctx);
    return {
      ...candidate,
      patternLabel: describePattern(candidate.conditions),
      classificationLabel: describeClassification(taxonomy.names(candidate.classification)),
      consistent: isConsistent(candidate, ctx.all),
      coveredByRule: isCoveredByRule(candidate, ctx.rules),
      eligible: blockedBy.length === 0,
      blockedBy,
    };
  }
}

interface Taxonomy {
  isValid(c: ClassificationIds): boolean;
  names(c: ClassificationIds): ClassificationNames;
}

function clip(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH - 1) + '…' : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
