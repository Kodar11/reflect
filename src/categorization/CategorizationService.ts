import type { ActivityRuleRepository, Activity, TrackingRule } from '../database/ActivityRuleRepository.js';
import type { CategorizationRepository } from '../database/CategorizationRepository.js';
import type { IFocusRepository } from '../database/FocusRepository.js';
import type { FocusSession, FocusProfile } from '../focus/FocusModels.js';
import type { VerifiedSession } from '../timeline/TimelineModels.js';
import type {
  CategorizationOverride,
  CategorizationRule,
  Classification,
  ContextEntry,
  DimensionEntry,
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
    const ruleId = `rule_${randomUUID()}`;
    const conditions: RuleCondition[] = [];

    // Derive conditions from the session's primary attributes.
    if (session.primaryUrl) {
      // Extract domain for website-based rules.
      try {
        let host = session.primaryUrl;
        if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
        const u = new URL(host);
        const domain = u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
        conditions.push({ type: 'domain_equals', value: domain });
      } catch {
        conditions.push({ type: 'url_contains', value: session.primaryUrl });
      }
    } else if (session.primaryApp) {
      conditions.push({ type: 'app_equals', value: session.primaryApp });
    }

    if (conditions.length === 0) {
      // Can't create a meaningful rule without a matchable attribute.
      // Fall back to app_equals with empty — rule will never match.
      conditions.push({ type: 'app_equals', value: session.primaryApp ?? '' });
    }

    const rule: TrackingRule = {
      id: ruleId,
      activityId: classification.contextId ?? '',
      conditions: JSON.stringify(conditions),
      enabled: 1,
      priority: 10, // Remembered rules get higher priority than default rules.
      areaId: classification.areaId,
      intentId: classification.intentId,
      qualityId: classification.qualityId,
    };
    this.activityRuleRepo.saveRule(rule);
    return ruleId;
  }
}
