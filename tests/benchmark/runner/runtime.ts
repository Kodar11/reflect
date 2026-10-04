import { ActivityRuleRepository } from '../../../src/database/ActivityRuleRepository';
import { CategorizationRepository } from '../../../src/database/CategorizationRepository';
import { CoachRepository } from '../../../src/database/CoachRepository';
import { Database } from '../../../src/database/Database';
import { EditRepository } from '../../../src/database/EditRepository';
import { EventRepository } from '../../../src/database/EventRepository';
import { FocusRepository } from '../../../src/database/FocusRepository';
import { IntelligenceRepository } from '../../../src/database/IntelligenceRepository';
import { LearnedRuleCandidateRepository } from '../../../src/database/LearnedRuleCandidateRepository';
import { ReflectionRepository } from '../../../src/database/ReflectionRepository';
import { UserProfileRepository } from '../../../src/database/UserProfileRepository';
import { CategorizationService } from '../../../src/categorization/CategorizationService';
import type { RuleCondition } from '../../../src/categorization/Classification';
import { CoachService } from '../../../src/coach/CoachService';
import type { IGeminiClient } from '../../../src/intelligence/GeminiClient';
import { UserProfileContextProvider } from '../../../src/intelligence/IntelligenceContext';
import { IntelligenceScheduler } from '../../../src/intelligence/IntelligenceScheduler';
import { IntelligenceService } from '../../../src/intelligence/IntelligenceService';
import { IntelligenceTimelineSource } from '../../../src/intelligence/IntelligenceTimelineSource';
import { describeClassification, describePattern } from '../../../src/learning/LearnedPattern';
import { LearnedRuleService } from '../../../src/learning/LearnedRuleService';
import { toLearningActivities } from '../../../src/learning/LearningTimeline';
import { toReflectionActivities } from '../../../src/reflection/ReflectionActivities';
import { ReflectionAnnotator } from '../../../src/reflection/ReflectionAnnotator';
import { ReflectionMetricsService } from '../../../src/reflection/ReflectionMetricsService';
import { DEFAULT_REFLECTION_CONFIG, type TaxonomyNames } from '../../../src/reflection/ReflectionModels';
import { setDayStartMinutes } from '../../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../../src/reflection/ReflectionScheduler';
import { ReflectionService } from '../../../src/reflection/ReflectionService';
import { SessionService } from '../../../src/session/SessionService';
import { TimelineService } from '../../../src/timeline/TimelineService';
import type { SimulatedClock } from './clock';

/**
 * The production service graph, constructed the way `src/electron/main.ts`
 * constructs it — minus what only exists on a real desktop (windows, tray,
 * IPC, the live tracker, Focus enforcement).
 *
 * Nothing here re-implements a pipeline step. The only substitutions are the
 * three seams production code exposes for exactly this purpose:
 *
 *   the database file   an isolated temporary file instead of userData
 *   `now`               the simulated clock
 *   scheduler timers    inert, so nothing fires on its own — the runner asks
 *                       for one cycle per simulated day, explicitly
 */

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Timers that never fire: the schedulers keep their logic and lose their cadence. */
const INERT_TIMERS = { setTimeout: () => null, clearTimeout: () => {} };

export function createRuntime(dbPath: string, gemini: IGeminiClient, clock: SimulatedClock, logger: RuntimeLogger) {
  const now = clock.now;
  const db = new Database(dbPath);

  // ── Repositories ──
  const events = new EventRepository(db);
  const focusRepo = new FocusRepository(db);
  const editRepo = new EditRepository(db, (msg) => logger.warn(msg));
  const activityRuleRepo = new ActivityRuleRepository(db);
  const categorizationRepo = new CategorizationRepository(db);
  const intelligenceRepo = new IntelligenceRepository(db);
  const userProfileRepo = new UserProfileRepository(db, now);
  const reflectionRepo = new ReflectionRepository(db);
  const coachRepo = new CoachRepository(db);

  // ── Session + timeline + categorization ──
  const sessionService = new SessionService(events);
  const aiTimelineSource = new IntelligenceTimelineSource(intelligenceRepo, now);
  let learnedRuleService: LearnedRuleService | null = null;
  const categorizationService = new CategorizationService(activityRuleRepo, categorizationRepo, focusRepo, events, aiTimelineSource, {
    onCorrection: (correction) => learnedRuleService?.onCorrection(correction),
  });
  const timelineService = new TimelineService(sessionService, editRepo, activityRuleRepo, categorizationService, aiTimelineSource);

  // ── Intelligence ──
  const userContextProvider = new UserProfileContextProvider(userProfileRepo);
  learnedRuleService = new LearnedRuleService({
    repo: new LearnedRuleCandidateRepository(db),
    gemini,
    events,
    activityRules: activityRuleRepo,
    categorization: categorizationRepo,
    intelligence: intelligenceRepo,
    userContext: userContextProvider,
    getActivities: (from, to) => toLearningActivities(timelineService.getByRange(from, to)),
    logger,
    now,
  });
  const intelligenceService = new IntelligenceService({
    events,
    repo: intelligenceRepo,
    gemini,
    activityRules: activityRuleRepo,
    categorization: categorizationRepo,
    focus: focusRepo,
    userContext: userContextProvider,
    getUserEditedEventIds: (from, to) => timelineService.getUserEditedEventIds(from, to),
    logger,
    now,
  });

  // ── Reflection ──
  const taxonomy = (): TaxonomyNames => {
    const names = (dimension: 'area' | 'intent' | 'quality') =>
      Object.fromEntries(categorizationRepo.listDimensionsByType(dimension).map((d) => [d.id, d.name]));
    return {
      contexts: Object.fromEntries(activityRuleRepo.listActivities().map((a) => [a.id, a.name])),
      areas: names('area'),
      intents: names('intent'),
      qualities: names('quality'),
    };
  };
  const reflectionMetrics = new ReflectionMetricsService(
    {
      getActivities: (from, to) => toReflectionActivities(timelineService.getByRange(from, to), { start: from, end: to }),
      focus: focusRepo,
      taxonomy,
      firstEventAt: () => events.getFirstEventStart(),
    },
    reflectionRepo,
    { config: DEFAULT_REFLECTION_CONFIG, now },
  );
  const ruleLabels = (source: 'learned' | 'user') => (): string[] => {
    const names = taxonomy();
    const labels: string[] = [];
    for (const rule of activityRuleRepo.listRules()) {
      if (rule.source !== source || rule.enabled !== 1) continue;
      try {
        const pattern = describePattern(JSON.parse(rule.conditions) as RuleCondition[]);
        const classification = describeClassification({
          context: rule.activityId ? names.contexts[rule.activityId] ?? null : null,
          area: rule.areaId ? names.areas[rule.areaId] ?? null : null,
          intent: rule.intentId ? names.intents[rule.intentId] ?? null : null,
          quality: rule.qualityId ? names.qualities[rule.qualityId] ?? null : null,
        });
        if (pattern && classification) labels.push(`${pattern} ${source === 'user' ? 'is' : 'is usually'} ${classification}`);
      } catch {
        // Malformed rule conditions — same as production: not mentioned.
      }
      if (labels.length >= 10) break;
    }
    return labels;
  };

  // ── Coach ──
  setDayStartMinutes(coachRepo.getSettings().dayStartMinutes);
  let reflectionService: ReflectionService | null = null;
  const coachService = new CoachService({
    repo: coachRepo,
    gemini,
    reflections: reflectionRepo,
    metrics: reflectionMetrics,
    focus: focusRepo,
    userContext: userContextProvider,
    priorities: () => reflectionService?.syncPriorities() ?? reflectionRepo.listPriorities(),
    logger,
    now,
  });

  reflectionService = new ReflectionService({
    repo: reflectionRepo,
    gemini,
    metrics: reflectionMetrics,
    annotator: new ReflectionAnnotator({ gemini, repo: reflectionRepo, logger, now }),
    userContext: userContextProvider,
    profiles: userProfileRepo,
    taxonomy,
    learnedPatterns: ruleLabels('learned'),
    explicitRules: ruleLabels('user'),
    coach: coachService,
    dailyReflectionMinutes: () => coachService.getSettings().reflectionMinutes,
    logger,
    now,
  });
  const reflection = reflectionService;

  // ── Schedulers: production logic, no cadence of their own ──
  const reflectionScheduler = new ReflectionScheduler(reflection, { logger, now, timers: INERT_TIMERS });
  /** What `main.ts` does after a cycle that persisted new AI activities. */
  const onAnalyzed = () => {
    learnedRuleService?.trackOccurrences();
    const at = clock.peek().getTime();
    reflection.notifyDataChanged({
      kind: 'timeline',
      range: { start: new Date(at - 48 * 60 * 60 * 1000).toISOString(), end: new Date(at).toISOString() },
    });
  };
  const intelligenceScheduler = new IntelligenceScheduler(intelligenceService, { logger, now, timers: INERT_TIMERS, onAnalyzed });

  // `start()` is what marks the reflection scheduler runnable; with inert
  // timers it only recovers interrupted generations (there are none).
  reflectionScheduler.start();

  return {
    db,
    events,
    focusRepo,
    activityRuleRepo,
    categorizationRepo,
    intelligenceRepo,
    userProfileRepo,
    reflectionRepo,
    coachRepo,
    sessionService,
    categorizationService,
    timelineService,
    intelligenceService,
    intelligenceScheduler,
    reflectionMetrics,
    reflectionService: reflection,
    reflectionScheduler,
    coachService,
    taxonomy,
    onAnalyzed,
    close: () => {
      reflectionScheduler.stop();
      intelligenceScheduler.stop();
      db.close();
    },
  };
}

export type BenchmarkRuntime = ReturnType<typeof createRuntime>;
