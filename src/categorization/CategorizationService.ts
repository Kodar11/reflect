import type { ActivityRuleRepository, Activity, TrackingRule } from '../database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../database/CategorizationRepository.js';
import type { IEventRepository } from '../database/EventRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { FocusSession, FocusProfile } from '../focus/FocusModels.js';
import type { VerifiedSession } from '../timeline/TimelineModels.js';
import type {
  CategorizationOverride,
  CategorizationRule,
  Classification,
  ContextEntry,
  DimensionEntry,
  EventClassification,
  EventClassificationSource,
  FocusContextSignal,
  RuleCondition,
} from './Classification.js';
import { ClassificationEngine } from './ClassificationEngine.js';
import { randomUUID } from 'node:crypto';

/**
 * `CategorizationService` is the impure seam between persisted state and the
 * pure classification engine. It fetches rules, overrides, dimensions, and
 * focus context from repositories, builds the engine inputs, and attaches
 * `Classification` results onto `VerifiedSession` objects.
 *
 * Construction order in main.ts: after ActivityRuleRepository + FocusRepository,
 * before TimelineService.
 */
export class CategorizationService {
  private readonly engine = new ClassificationEngine();

  constructor(
    private readonly activityRuleRepo: ActivityRuleRepository,
    private readonly categorizationRepo: CategorizationRepository,
    private readonly focusRepo: IFocusRepository,
    private readonly eventRepo: IEventRepository,
    /** Told which events the user manually classified, so the intelligence
     * layer never overwrites that correction. */
    private readonly userEditGuard?: { lockActivitiesForEvents(eventIds: number[]): void },
  ) {}

  /**
   * Classify all verified sessions in-place. Called by TimelineService.applyEngine
   * after the timeline edit replay is complete.
   */
  classifySessions(sessions: VerifiedSession[]): void {
    if (sessions.length === 0) return;

    try {
      const rules = this.buildRules();
      const overrides = this.categorizationRepo.listOverrides();
      const contexts = this.buildContexts();
      const dimensions = this.categorizationRepo.listDimensions();
      const focusSignals = this.buildFocusSignals(sessions);

      const sessionLikes = sessions.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        primaryApp: s.primaryApp,
        primaryBrowser: s.primaryBrowser,
        primaryTitle: s.primaryTitle,
        primaryUrl: s.primaryUrl,
        appsUsed: s.appsUsed,
        browserTabs: s.browserTabs,
        events: s.events.map((e) => ({ id: e.id })),
      }));

      const results = this.engine.classifyAll(
        sessionLikes,
        rules,
        overrides,
        contexts,
        dimensions,
        focusSignals,
      );

      for (const s of sessions) {
        const cls = results.get(s.id);
        if (cls) {
          s.classification = cls;
        }
        // USER OVERRIDE > AI > deterministic. An AI-derived activity carries
        // its own interpretation; only a manual override outranks it.
        if (s.ai && cls?.source !== 'user_override') {
          const aiCls = this.engine.classifyFromAi(s.ai, contexts, dimensions);
          if (aiCls) s.classification = aiCls;
        }
      }
    } catch (e) {
      // Never throw — classification is a non-critical overlay. Sessions
      // pass through without classification if the engine fails.
      console.error('[CategorizationService] classifySessions error', e);
    }
  }

  /**
   * Save a manual correction (from the inspector or usage page).
   * If `remember` is true, also create/update a tracking rule with conditions
   * derived from the session's primary attributes.
   */
  saveOverride(
    eventIds: number[],
    classification: {
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
    },
    remember: boolean,
    sessionHint?: {
      primaryApp?: string;
      primaryUrl?: string;
      primaryTitle?: string;
    },
  ): { overrideId: string; ruleId: string | null } {
    const overrideId = randomUUID();
    let ruleId: string | null = null;

    if (remember && sessionHint) {
      ruleId = this.createRememberedRule(eventIds, classification, sessionHint);
    }

    const override: CategorizationOverride = {
      id: overrideId,
      eventIds,
      anchorEventId: eventIds.length > 0 ? eventIds[0] : null,
      contextId: classification.contextId,
      areaId: classification.areaId,
      intentId: classification.intentId,
      qualityId: classification.qualityId,
      source: 'user_override',
      ruleId,
    };
    this.categorizationRepo.saveOverride(override);

    try {
      this.userEditGuard?.lockActivitiesForEvents(eventIds);
    } catch (e) {
      // Non-critical: the override itself is saved and always wins on read.
      console.error('[CategorizationService] could not lock AI activities', e);
    }

    return { overrideId, ruleId };
  }

  /**
   * Get dimensions for UI dropdowns.
   */
  getDimensions(): {
    areas: DimensionEntry[];
    intents: DimensionEntry[];
    qualities: DimensionEntry[];
  } {
    return {
      areas: this.categorizationRepo.listDimensionsByType('area'),
      intents: this.categorizationRepo.listDimensionsByType('intent'),
      qualities: this.categorizationRepo.listDimensionsByType('quality'),
    };
  }

  /**
   * Get contexts (= activities) for UI dropdowns.
   */
  getContexts(): ContextEntry[] {
    return this.activityRuleRepo.listActivities().map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
    }));
  }

  listOverrides(): CategorizationOverride[] {
    return this.categorizationRepo.listOverrides();
  }

  deleteOverride(id: string): void {
    this.categorizationRepo.deleteOverride(id);
  }

  // --- Event-level classifications ---

  getEventClassification(eventId: number): EventClassification | null {
    return this.categorizationRepo.getEventClassification(eventId);
  }

  getEventClassifications(eventIds: number[]): EventClassification[] {
    return this.categorizationRepo.getEventClassifications(eventIds);
  }

  /**
   * Resolve the authoritative classification for each requested event.
   *
   * Precedence:
   *   1. Explicit event-level classification from `event_classifications`.
   *   2. First matching enabled tracking rule (priority → specificity → id).
   *   3. Deterministic default classification (inferred, never persisted).
   *   4. No entry (UI renders `—`).
   *
   * Rule-derived and default results are computed dynamically and are never
   * persisted.
   */
  getResolvedEventClassifications(eventIds: number[]): EventClassification[] {
    if (eventIds.length === 0) return [];

    const explicit = this.categorizationRepo.getEventClassifications(eventIds);

    try {
      const explicitById = new Map(explicit.map((c) => [c.eventId, c]));
      const unresolvedIds = eventIds.filter((id) => !explicitById.has(id));

      if (unresolvedIds.length === 0) return explicit;

      const events = this.eventRepo.getByIds(unresolvedIds);
      if (events.length === 0) return explicit;

      const rules = this.buildRules();
      const contexts = this.buildContexts();
      const dimensions = this.categorizationRepo.listDimensions();

      const derived: EventClassification[] = [];
      for (const event of events) {
        let classification = this.engine.classifyEvent(
          event,
          rules,
          contexts,
          dimensions,
        );
        if (classification.source !== 'user_rule') {
          classification = this.engine.classifyEventDefault(
            event,
            contexts,
            dimensions,
          );
        }
        if (
          classification.source === 'user_rule' ||
          classification.source === 'default'
        ) {
          derived.push({
            eventId: event.id,
            contextId: classification.context?.id ?? null,
            areaId: classification.area?.id ?? null,
            intentId: classification.intent?.id ?? null,
            qualityId: classification.quality?.id ?? null,
            source: classification.source,
            ruleId:
              classification.source === 'user_rule'
                ? classification.matchedRuleId
                : null,
          });
        }
      }

      return [...explicit, ...derived];
    } catch (e) {
      // Classification is a non-critical overlay. If rule resolution fails,
      // still return explicit classifications so the UI doesn't lose them.
      console.error(
        '[CategorizationService] getResolvedEventClassifications error',
        e,
      );
      return explicit;
    }
  }

  saveEventClassification(classification: EventClassification): void {
    const source = classification.source ?? 'user_override';
    this.validateEventClassificationSource(source);

    const ruleId = source === 'user_override' ? null : classification.ruleId;

    this.validateEventClassification({
      ...classification,
      source,
      ruleId,
    });

    this.categorizationRepo.saveEventClassification({
      ...classification,
      source,
      ruleId,
    });
  }

  deleteEventClassification(eventId: number): void {
    this.categorizationRepo.deleteEventClassification(eventId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private buildRules(): CategorizationRule[] {
    const rules = this.activityRuleRepo.listRules().filter((r) => r.enabled === 1);
    return rules.map((r) => {
      let conditions: RuleCondition[] = [];
      try {
        conditions = JSON.parse(r.conditions) as RuleCondition[];
      } catch {
        // Malformed conditions — rule will never match.
      }
      return {
        id: r.id,
        conditions,
        contextId: r.activityId || null,
        areaId: r.areaId,
        intentId: r.intentId,
        qualityId: r.qualityId,
        priority: r.priority,
        enabled: r.enabled === 1,
      };
    });
  }

  private buildContexts(): ContextEntry[] {
    return this.activityRuleRepo.listActivities().map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
    }));
  }

  private buildFocusSignals(sessions: VerifiedSession[]): FocusContextSignal[] {
    if (sessions.length === 0) return [];

    const earliest = sessions.reduce((min, s) => (s.startedAt < min ? s.startedAt : min), sessions[0].startedAt).toISOString();
    const latest = sessions.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), sessions[0].endedAt).toISOString();

    // Fetch focus sessions overlapping the session range.
    // getSessionsByRange uses started_at filtering, so we widen the window.
    const focusSessions = this.focusRepo.getSessionsByRange(earliest, latest);
    const profiles = new Map<string, FocusProfile>();
    for (const p of this.focusRepo.getProfiles()) {
      profiles.set(p.id, p);
    }

    const signals: FocusContextSignal[] = [];
    for (const fs of focusSessions) {
      if (!fs.startedAt || !fs.endedAt) continue;
      if (fs.state !== 'completed' && fs.state !== 'active' && fs.state !== 'paused') continue;
      const profile = profiles.get(fs.profileId);
      signals.push({
        task: fs.task,
        profileName: profile?.name ?? 'Focus',
        sessionStartedAt: fs.startedAt,
        sessionEndedAt: fs.endedAt,
      });
    }
    return signals;
  }

  /**
   * Create a reusable tracking rule from an event's raw metadata and its
   * classification. The activity/context must already exist.
   */
  rememberEventAsRule(
    eventId: number,
    classification: {
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
    },
    eventHint: {
      app?: string | null;
      title?: string | null;
      url?: string | null;
    },
  ): { ruleId: string; activityId: string } {
    if (!classification.contextId) {
      throw new Error('Cannot remember a rule without a Context');
    }

    const ruleId = `rule_${randomUUID()}`;
    const conditions = this.deriveConditionsFromHint({
      primaryUrl: eventHint.url,
      primaryApp: eventHint.app,
    });

    const rule: TrackingRule = {
      id: ruleId,
      activityId: classification.contextId,
      conditions: JSON.stringify(conditions),
      enabled: 1,
      priority: 10,
      areaId: classification.areaId,
      intentId: classification.intentId,
      qualityId: classification.qualityId,
      // "Remember for future" is the explicit way a user creates a rule.
      source: 'user',
    };
    this.activityRuleRepo.saveRule(rule);

    return { ruleId, activityId: classification.contextId };
  }

  private createRememberedRule(
    _eventIds: number[],
    classification: {
      contextId: string | null;
      areaId: string | null;
      intentId: string | null;
      qualityId: string | null;
    },
    session: {
      primaryApp?: string;
      primaryUrl?: string;
      primaryTitle?: string;
    },
  ): string {
    const { ruleId } = this.rememberEventAsRule(-1, classification, {
      app: session.primaryApp,
      title: session.primaryTitle,
      url: session.primaryUrl,
    });
    return ruleId;
  }

  private deriveConditionsFromHint(session: {
    primaryApp?: string | null;
    primaryUrl?: string | null;
  }): RuleCondition[] {
    const conditions: RuleCondition[] = [];

    if (session.primaryUrl) {
      try {
        let host = session.primaryUrl;
        if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
        const u = new URL(host);
        const domain = u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
        conditions.push({ type: 'domain_equals', value: domain });
      } catch {
        // If URL parsing fails, fall back to app_equals if possible.
        if (session.primaryApp) {
          conditions.push({ type: 'app_equals', value: session.primaryApp });
        }
      }
    } else if (session.primaryApp) {
      conditions.push({ type: 'app_equals', value: session.primaryApp });
    }

    if (conditions.length === 0) {
      // Can't create a meaningful rule without a matchable attribute.
      // Fall back to app_equals with empty — rule will never match.
      conditions.push({ type: 'app_equals', value: session.primaryApp ?? '' });
    }

    return conditions;
  }

  private validateEventClassificationSource(source: string): asserts source is EventClassificationSource {
    const valid: EventClassificationSource[] = ['user_override', 'user_rule', 'default', 'unclassified'];
    if (!valid.includes(source as EventClassificationSource)) {
      throw new Error(`Invalid event classification source: ${source}`);
    }
  }

  private validateEventClassification(classification: EventClassification): void {
    const activities = this.activityRuleRepo.listActivities();
    const activityIds = new Set(activities.map((a) => a.id));
    if (classification.contextId !== null && !activityIds.has(classification.contextId)) {
      throw new Error(`Invalid contextId: ${classification.contextId}`);
    }

    const dimensions = this.categorizationRepo.listDimensions();
    const dimById = new Map(dimensions.map((d) => [d.id, d]));
    this.validateDimension(classification.areaId, 'area', dimById);
    this.validateDimension(classification.intentId, 'intent', dimById);
    this.validateDimension(classification.qualityId, 'quality', dimById);

    if (classification.ruleId !== null) {
      const rules = this.activityRuleRepo.listRules();
      const ruleIds = new Set(rules.map((r) => r.id));
      if (!ruleIds.has(classification.ruleId)) {
        throw new Error(`Invalid ruleId: ${classification.ruleId}`);
      }
    }
  }

  private validateDimension(
    id: string | null,
    expectedDimension: 'area' | 'intent' | 'quality',
    dimById: Map<string, DimensionEntry>,
  ): void {
    if (id === null) return;
    const dim = dimById.get(id);
    if (!dim || dim.dimension !== expectedDimension) {
      throw new Error(`Invalid ${expectedDimension}Id: ${id}`);
    }
  }
}
