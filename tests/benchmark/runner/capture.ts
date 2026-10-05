import type { CoachAction, CoachActionEvent, CoachMemory, CoachMessage } from '../../../src/coach/CoachModels';
import type { IntelligenceRun } from '../../../src/intelligence/IntelligenceModels';
import type { ReflectionPeriod, ReflectionPriority, ReflectionReport } from '../../../src/reflection/ReflectionModels';
import { toVerified, type VerifiedSession } from '../../../src/timeline/TimelineModels';
import type { StoredEventRef } from './ingest';
import type { BenchmarkRuntime } from './runtime';

/**
 * Read-only capture of what Reflect produced for one simulated day.
 *
 * Everything is read back through the same repositories and services the app
 * itself reads from, and stored as it is — nothing is renamed, re-scored or
 * tidied to make the comparison easier. Evaluation happens elsewhere.
 */

export interface CapturedClassification {
  contextId: string | null;
  context: string | null;
  areaId: string | null;
  area: string | null;
  intentId: string | null;
  intent: string | null;
  qualityId: string | null;
  quality: string | null;
  /** Where the classification came from: ai, user_rule, default, unclassified… */
  source: string | null;
}

/** One block of a timeline: an AI activity or a deterministic session. */
export interface CapturedBlock {
  id: string;
  kind: 'ai' | 'deterministic';
  startedAt: string;
  endedAt: string;
  /** Sum of the block's event durations. */
  activeMs: number;
  /** Envelope: end − start, including bridged gaps. */
  envelopeMs: number;
  /** Reflect `events.id` values owned by this block, chronological. */
  eventIds: number[];
  title: string;
  summary: string | null;
  classification: CapturedClassification;
  confidence: number | null;
  uncertainty: string[];
  /** Reflection's overlay: the work thread and the stated priority it was linked to. */
  thread: string | null;
  priorityId: string | null;
}

export interface CapturedTaxonomy {
  contexts: { id: string; name: string }[];
  areas: { id: string; name: string }[];
  intents: { id: string; name: string }[];
  qualities: { id: string; name: string }[];
}

export interface CapturedDay {
  dayNumber: number;
  date: string;
  period: ReflectionPeriod;
  /** Simulated instant at which the day's processing started. */
  processedAt: string;
  events: StoredEventRef[];
  priorities: Pick<ReflectionPriority, 'id' | 'text' | 'status'>[];
  /** Stage-2 sessionizer + rule classification, with no AI. The baseline. */
  deterministicSessions: CapturedBlock[];
  /** What the Timeline shows: AI activities where they exist, deterministic sessions elsewhere. */
  timeline: CapturedBlock[];
  intelligence: {
    runs: (Omit<IntelligenceRun, 'outputJson'> & { activitiesInOutput: number | null })[];
    /** Raw events of the day that no AI activity owns (shown through the deterministic fallback). */
    eventsWithoutAiActivity: number[];
  };
  reflection: {
    /** The day's current report (`fresh` or `stale`), or null when none was written. */
    report: ReflectionReport | null;
    /** The most recent attempt, when it is not the current report (a failure, or "not enough data"). */
    latestAttempt: Pick<ReflectionReport, 'id' | 'status' | 'error' | 'errorCategory' | 'attemptCount' | 'createdAt'> | null;
    /** Reports of longer periods written during this day's cycle (a closed week, month…). */
    otherReports: ReflectionReport[];
  };
  coach: {
    /** Recommendations created by this day's report. */
    actions: CoachAction[];
    /** Every action that existed before this day's report, as it stood afterwards. */
    earlierActions: CoachAction[];
    /** Lifecycle steps recorded while this day was processed (expiry, observation, …). */
    lifecycleEvents: CoachActionEvent[];
    memoriesAdded: CoachMemory[];
    memoriesActive: CoachMemory[];
    messages: CoachMessage[];
  };
}

function classificationOf(session: VerifiedSession): CapturedClassification {
  const c = session.classification;
  return {
    contextId: c?.context?.id ?? null,
    context: c?.context?.id ? c.context.name : null,
    areaId: c?.area?.id ?? null,
    area: c?.area?.id ? c.area.name : null,
    intentId: c?.intent?.id ?? null,
    intent: c?.intent?.id ? c.intent.name : null,
    qualityId: c?.quality?.id ?? null,
    quality: c?.quality?.id ? c.quality.name : null,
    source: c?.source ?? null,
  };
}

function toBlock(session: VerifiedSession, overlay: Map<string, { thread: string | null; priorityId: string | null }>): CapturedBlock {
  const fallbackTitle = [session.primaryApp, session.primaryUrl].filter(Boolean).join(' · ') || session.primaryTitle || 'Untitled activity';
  return {
    id: session.id,
    kind: session.ai ? 'ai' : 'deterministic',
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt.toISOString(),
    activeMs: session.activeDuration,
    envelopeMs: session.duration,
    eventIds: session.events.map((e) => e.id),
    title: session.customTitle ?? session.ai?.title ?? fallbackTitle,
    summary: session.ai?.summary ?? null,
    classification: classificationOf(session),
    confidence: session.ai?.confidence ?? null,
    uncertainty: session.ai?.uncertainty ?? [],
    thread: overlay.get(session.id)?.thread ?? null,
    priorityId: overlay.get(session.id)?.priorityId ?? null,
  };
}

export function captureTaxonomy(runtime: Pick<BenchmarkRuntime, 'activityRuleRepo' | 'categorizationRepo'>): CapturedTaxonomy {
  const dims = (type: 'area' | 'intent' | 'quality') => runtime.categorizationRepo.listDimensionsByType(type).map((d) => ({ id: d.id, name: d.name }));
  return {
    contexts: runtime.activityRuleRepo.listActivities().map((a) => ({ id: a.id, name: a.name })),
    areas: dims('area'),
    intents: dims('intent'),
    qualities: dims('quality'),
  };
}

export interface CaptureInput {
  dayNumber: number;
  date: string;
  period: ReflectionPeriod;
  processedAt: string;
  events: StoredEventRef[];
  /** Ids of every coach action / memory that existed before this day was processed. */
  actionIdsBefore: Set<string>;
  memoryIdsBefore: Set<string>;
  /** Report ids of longer periods generated in this day's cycle. */
  otherReportIds: string[];
}

export async function captureDay(runtime: BenchmarkRuntime, input: CaptureInput): Promise<CapturedDay> {
  const { period } = input;
  const priorities = runtime.reflectionService.syncPriorities();

  // Reflection's own overlay (thread + priority link) for the day's blocks.
  const overlay = new Map<string, { thread: string | null; priorityId: string | null }>();
  for (const activity of await runtime.reflectionMetrics.loadActivities(period.start, period.end, priorities)) {
    overlay.set(activity.id, { thread: activity.thread, priorityId: activity.priorityId });
  }

  const timeline = runtime.timelineService.getByRange(period.start, period.end).filter((s) => !s.hidden);
  const deterministic = runtime.sessionService.getByRange(period.start, period.end).map((s) => toVerified(s));
  runtime.categorizationService.classifySessions(deterministic);

  const dayEventIds = new Set(input.events.map((e) => e.eventId));
  const aiOwned = new Set(timeline.filter((s) => s.ai).flatMap((s) => s.events.map((e) => e.id)));

  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.end);
  const runs = runtime.intelligenceRepo
    .listRecentRuns(5000)
    .filter((run) => Date.parse(run.windowStart) < endMs && Date.parse(run.windowEnd) > startMs)
    .sort((a, b) => (a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : 0))
    .map(({ outputJson, ...run }) => ({ ...run, activitiesInOutput: countActivities(outputJson) }));

  const report = runtime.reflectionRepo.getCurrentReport('day', period.key);
  const attempt = runtime.reflectionRepo.getLatestAttempt('day', period.key);
  const latestAttempt =
    attempt && attempt.id !== report?.id
      ? { id: attempt.id, status: attempt.status, error: attempt.error, errorCategory: attempt.errorCategory, attemptCount: attempt.attemptCount, createdAt: attempt.createdAt }
      : null;

  const allActions = runtime.coachRepo.listActions(new Date(0).toISOString());
  const actions = report ? runtime.coachRepo.listActionsByReport(report.id) : [];
  const memories = runtime.coachRepo.listMemories();

  return {
    dayNumber: input.dayNumber,
    date: input.date,
    period,
    processedAt: input.processedAt,
    events: input.events,
    priorities: priorities.map((p) => ({ id: p.id, text: p.text, status: p.status })),
    deterministicSessions: deterministic.map((s) => toBlock(s, new Map())),
    timeline: timeline.map((s) => toBlock(s, overlay)),
    intelligence: {
      runs,
      eventsWithoutAiActivity: [...dayEventIds].filter((id) => !aiOwned.has(id)),
    },
    reflection: {
      report,
      latestAttempt,
      otherReports: input.otherReportIds
        .map((id) => runtime.reflectionRepo.getReportById(id))
        .filter((r): r is ReflectionReport => r !== null),
    },
    coach: {
      actions,
      // Everything that is not this day's own recommendation — including history a scenario seeded during the day.
      earlierActions: allActions.filter((a) => !actions.some((own) => own.id === a.id)),
      lifecycleEvents: allActions
        .flatMap((a) => runtime.coachRepo.listActionEvents(a.id))
        .filter((e) => e.createdAt >= input.processedAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      memoriesAdded: memories.filter((m) => !input.memoryIdsBefore.has(m.id)),
      memoriesActive: memories.filter((m) => m.status === 'active'),
      messages: runtime.coachRepo.listMessages(200).filter((m) => m.createdAt >= input.processedAt),
    },
  };
}

function countActivities(outputJson: string | null): number | null {
  if (!outputJson) return null;
  try {
    const parsed = JSON.parse(outputJson) as { activities?: unknown };
    return Array.isArray(parsed.activities) ? parsed.activities.length : null;
  } catch {
    return null;
  }
}
