import type { UserIntelligenceContext } from '../profile/UserProfile.js';
import type { InsightHistoryRow, ReflectionFeedbackRecord } from '../database/ReflectionRepository.js';
import type { PriorInsight } from './ReflectionIdentity.js';
import { formatMinutes } from './ReflectionMetrics.js';
import {
  MEANINGFUL_ACTIVITY_MINUTES,
  REFLECTION_INPUT_SCHEMA_VERSION,
  type Metric,
  type MetricSet,
  type PeriodDataset,
  type PromptActivity,
  type PromptComparison,
  type PromptMetric,
  type ReflectionActivity,
  type ReflectionConfig,
  type ReflectionDataSnapshot,
  type ReflectionInput,
  type ReflectionInsightType,
  type ReflectionPeriod,
  type ReflectionReport,
  type TaxonomyNames,
} from './ReflectionModels.js';
import { describePeriod, formatDayShort, formatLocalDateTime } from './ReflectionPeriods.js';
import { describePriorityEvents, isPossiblyStale } from './ReflectionPriorities.js';

/**
 * Deterministic dataset → compact model input. Pure.
 *
 * The model never sees raw events. It gets the user's own context, the
 * measured facts, the structure of how things moved over time, a bounded list
 * of meaningful activities (under short local aliases) for the short
 * horizons, and what Reflect already told the user.
 */

const MAX_PREVIOUSLY_SURFACED = 12;
const MAX_DISPUTED = 8;

export interface PreprocessContext {
  userContext: UserIntelligenceContext | null;
  taxonomy: TaxonomyNames;
  config: ReflectionConfig;
  nowIso: string;
  /** The current report of the immediately preceding period, if any. */
  previousReport: ReflectionReport | null;
  /** Insights of the earlier reports of this period type, newest period first. */
  history?: InsightHistoryRow[];
  /** The periods those reports cover, newest first — including reports that held no insight. */
  reportedPeriods?: Pick<ReflectionPeriod, 'key' | 'start'>[];
  feedback: ReflectionFeedbackRecord[];
  /** Human descriptions of the user's confirmed learned rules. */
  learnedPatterns: string[];
  /** Human descriptions of the rules the user wrote themselves. */
  explicitRules?: string[];
  /** The current report of the next larger period (a day's week), if any. */
  longerTermReport?: ReflectionReport | null;
}

export interface PreparedReflection {
  input: ReflectionInput;
  /** Prompt alias → activity, for resolving the model's references. */
  activityByRef: Map<string, ReflectionActivity>;
  /** What was said in the earlier reports looked at — what continuity is judged against. */
  history: PriorInsight[];
  /** Identities the user marked "not useful". */
  mutedIdentities: Set<string>;
  snapshot: ReflectionDataSnapshot;
}

/** The activities worth showing the model: the largest, plus any a metric points at. */
function selectActivities(dataset: PeriodDataset, max: number): ReflectionActivity[] {
  const cited = new Set<string>();
  for (const metric of Object.values(dataset.metrics)) for (const id of metric.activityIds ?? []) cited.add(id);

  const ranked = [...dataset.activities].sort(
    (a, b) => b.durationMinutes - a.durationMinutes || (a.startedAt < b.startedAt ? -1 : 1),
  );
  const chosen = new Map<string, ReflectionActivity>();
  for (const a of ranked) if (cited.has(a.id) && chosen.size < max) chosen.set(a.id, a);
  for (const a of ranked) {
    if (chosen.size >= max) break;
    if (a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES) chosen.set(a.id, a);
  }
  return [...chosen.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
}

function toComparisons(metrics: MetricSet): PromptComparison[] {
  const out: PromptComparison[] = [];
  for (const metric of Object.values(metrics)) {
    if (metric.group === 'comparison') continue;
    const prev = metrics[`prev.${metric.key}`];
    const delta = metrics[`delta.${metric.key}`];
    const baseline = metrics[`baseline.${metric.key}`];
    const weekday = metrics[`weekday.${metric.key}`];
    if (!prev && !baseline && !weekday) continue;
    // Comparison labels are "<measure> — <reference>"; keep the measure.
    const referenceLabel = (prev ?? baseline ?? weekday)!.label;
    out.push({
      key: metric.key,
      label: referenceLabel.slice(0, referenceLabel.lastIndexOf(' — ')),
      now: metric.display,
      ...(prev ? { previous: prev.display } : {}),
      ...(delta ? { change: delta.display } : {}),
      ...(baseline ? { baseline: baseline.display } : {}),
      ...(weekday ? { sameWeekday: weekday.display } : {}),
    });
  }
  return out;
}

export function summarizeFeedback(feedback: ReflectionFeedbackRecord[]): string[] {
  const byType = new Map<ReflectionInsightType, { useful: number; not_useful: number; inaccurate: number }>();
  for (const f of feedback) {
    const entry = byType.get(f.insightType) ?? { useful: 0, not_useful: 0, inaccurate: 0 };
    entry[f.feedbackType]++;
    byType.set(f.insightType, entry);
  }
  return [...byType.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([type, c]) => `${type}: ${c.useful} useful, ${c.not_useful} not useful, ${c.inaccurate} marked inaccurate`);
}

/** Earlier insights as continuity sees them: `periodsBack` 1 = the most recent earlier report. */
export function toPriorInsights(history: InsightHistoryRow[], reportedPeriods: Pick<ReflectionPeriod, 'key' | 'start'>[] = []): PriorInsight[] {
  // A report that said nothing still counts as a report: "said last time" means the report before this one.
  const periods = new Map<string, string>([...reportedPeriods.map((p) => [p.key, p.start] as const), ...history.map((h) => [h.period.key, h.period.start] as const)]);
  const order = [...periods.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([key]) => key);
  return history.map((h) => ({
    periodsBack: order.indexOf(h.period.key) + 1,
    periodKey: h.period.key,
    identityKey: h.identityKey,
    subjectKey: h.subjectKey,
    magnitude: h.magnitude,
    title: h.title,
    type: h.type,
    feedback: h.feedback,
  }));
}

const promptMetric = (m: Metric): PromptMetric => ({ key: m.key, label: m.label, value: m.display });

export function prepareReflection(dataset: PeriodDataset, ctx: PreprocessContext): PreparedReflection {
  const { period } = dataset;
  const name = (map: Record<string, string>, id: string | null) => (id ? map[id] ?? null : null);

  const selected = selectActivities(dataset, ctx.config.maxPromptActivities[period.type]);
  const activityByRef = new Map<string, ReflectionActivity>();
  const activities: PromptActivity[] = selected.map((a, index) => {
    const ref = `a${index + 1}`;
    activityByRef.set(ref, a);
    return {
      ref,
      start: formatLocalDateTime(a.startedAt),
      end: formatLocalDateTime(a.endedAt),
      minutes: Math.round(a.durationMinutes),
      title: a.title,
      summary: a.summary,
      context: name(ctx.taxonomy.contexts, a.contextId),
      area: name(ctx.taxonomy.areas, a.areaId),
      intent: name(ctx.taxonomy.intents, a.intentId),
      quality: name(ctx.taxonomy.qualities, a.qualityId),
      thread: a.thread,
      priorityId: a.priorityId,
      source: a.source,
      ...(a.note ? { note: a.note } : {}),
    };
  });

  const priorities = dataset.priorities.map((p) => ({
    id: p.id,
    text: p.text,
    statedOn: formatDayShort(new Date(p.activeFrom)),
    possiblyStale: isPossiblyStale(p, ctx.nowIso, ctx.config.priorityStaleAfterDays),
  }));

  // What was already said, by identity — so the same pattern is recognised
  // whatever words or metrics it came with last time.
  const history = toPriorInsights(ctx.history ?? [], ctx.reportedPeriods ?? []);
  const surfaced = new Map<string, { type: ReflectionInsightType; title: string; signature: string; periods: Set<string> }>();
  for (const h of [...history].sort((a, b) => a.periodsBack - b.periodsBack)) {
    const entry = surfaced.get(h.identityKey) ?? { type: h.type, title: h.title, signature: h.identityKey, periods: new Set<string>() };
    entry.periods.add(h.periodKey);
    surfaced.set(h.identityKey, entry);
  }

  const disputed = ctx.feedback
    .filter((f) => f.feedbackType !== 'useful' && f.title)
    .slice(0, MAX_DISPUTED)
    .map((f) => ({ title: f.title!, about: f.subjectKey ?? null, verdict: f.feedbackType as 'inaccurate' | 'not_useful' }));
  const mutedIdentities = new Set(ctx.feedback.filter((f) => f.feedbackType === 'not_useful' && f.identityKey).map((f) => f.identityKey!));

  const previous = ctx.previousReport;
  const label = describePeriod(period, ctx.nowIso);
  const metrics = Object.values(dataset.metrics);

  const input: ReflectionInput = {
    schemaVersion: REFLECTION_INPUT_SCHEMA_VERSION,
    period: {
      type: period.type,
      start: period.start,
      end: period.end,
      label: label.title === label.range ? label.range : `${label.title} (${label.range})`,
      isPartial: dataset.isPartial,
      coveredUntil: formatLocalDateTime(dataset.coveredUntil),
    },
    userContext: ctx.userContext
      ? {
          roles: ctx.userContext.roles,
          description: ctx.userContext.description,
          currentWork: ctx.userContext.currentWork,
          priorities: ctx.userContext.priorities,
          interests: ctx.userContext.interests,
          additionalContext: ctx.userContext.interpretationNotes,
        }
      : null,
    currentPriorities: priorities,
    activities,
    metrics: metrics.filter((m) => m.group !== 'comparison' && m.group !== 'history').map(promptMetric),
    comparisons: toComparisons(dataset.metrics),
    changes: metrics.filter((m) => m.key.startsWith('change.')).map(promptMetric),
    trajectories: metrics.filter((m) => m.key.startsWith('trajectory.')).map(promptMetric),
    carried: metrics.filter((m) => m.key.startsWith('carry.') || m.key.startsWith('coverage.')).map(promptMetric),
    notes: dataset.notes,
    learnedPatterns: ctx.learnedPatterns,
    explicitRules: ctx.explicitRules ?? [],
    longerTerm:
      ctx.longerTermReport && ctx.longerTermReport.headline
        ? {
            periodLabel: describePeriod(ctx.longerTermReport.period, ctx.nowIso).title,
            headline: ctx.longerTermReport.headline,
            insights: ctx.longerTermReport.insights.map((i) => `${i.type}: ${i.title}`),
          }
        : null,
    previousReflection:
      previous && previous.headline
        ? {
            periodLabel: describePeriod(previous.period, ctx.nowIso).range,
            headline: previous.headline,
            carryForward: previous.carryForward?.text ?? null,
            insights: previous.insights.map((i) => ({ type: i.type, title: i.title, observation: i.observation })),
          }
        : null,
    previouslySurfaced: [...surfaced.values()].slice(0, MAX_PREVIOUSLY_SURFACED).map(({ periods, ...s }) => ({ ...s, timesSurfaced: periods.size })),
    disputed,
    subPeriods: (dataset.subPeriods ?? []).map((b) => ({
      label: b.label,
      // Nothing observed is said as such: it is missing, not zero.
      tracked: b.trackedMinutes === null ? 'nothing recorded' : formatMinutes(b.trackedMinutes),
      focused: b.focusedMinutes === null ? null : formatMinutes(b.focusedMinutes),
      activeDays: b.activeDays,
      main: b.top.map((t) => `${t.label} (${formatMinutes(t.minutes)})`),
      reflection: b.headline,
    })),
    priorityHistory: describePriorityEvents(dataset.priorityEvents ?? []),
    feedbackHistory: summarizeFeedback(ctx.feedback),
    maxInsights: ctx.config.maxInsights[period.type],
  };

  const snapshot: ReflectionDataSnapshot = {
    period,
    coveredUntil: dataset.coveredUntil,
    isPartial: dataset.isPartial,
    priorities: dataset.priorities.map((p, index) => ({
      id: p.id,
      text: p.text,
      activeFrom: p.activeFrom,
      possiblyStale: priorities[index].possiblyStale,
    })),
    activePriorityIds: dataset.priorities.filter((p) => p.status === 'active').map((p) => p.id),
    activities: selected.map((a) => ({
      id: a.id,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      minutes: Math.round(a.durationMinutes),
      title: a.title,
      thread: a.thread,
      priorityId: a.priorityId,
      ...(a.eventIds ? { eventIds: a.eventIds } : {}),
    })),
    notes: dataset.notes,
    userContextIncluded: ctx.userContext !== null,
    previousReportId: previous?.id ?? null,
    carried: dataset.carried ?? [],
    trajectories: (dataset.trajectories ?? []).map((t) => ({
      key: t.key,
      label: t.label,
      status: t.status,
      idleTrackedDays: t.idleTrackedDays,
      activeDays: t.activeDays,
      trackedDays: t.trackedDays,
    })),
    changes: dataset.changes ?? [],
    ...(dataset.basis ? { basis: dataset.basis } : {}),
  };

  return { input, activityByRef, history, mutedIdentities, snapshot };
}
