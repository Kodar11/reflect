import type { UserIntelligenceContext } from '../profile/UserProfile.js';
import type { ReflectionFeedbackRecord } from '../database/ReflectionRepository.js';
import {
  MEANINGFUL_ACTIVITY_MINUTES,
  REFLECTION_INPUT_SCHEMA_VERSION,
  type MetricSet,
  type PeriodDataset,
  type PromptActivity,
  type PromptComparison,
  type ReflectionActivity,
  type ReflectionConfig,
  type ReflectionDataSnapshot,
  type ReflectionInput,
  type ReflectionInsightType,
  type ReflectionReport,
  type TaxonomyNames,
} from './ReflectionModels.js';
import { describePeriod, formatDayShort, formatLocalDateTime } from './ReflectionPeriods.js';
import { isPossiblyStale } from './ReflectionPriorities.js';

/**
 * Deterministic dataset → compact model input. Pure.
 *
 * The model never sees raw events. It gets the user's own context, the
 * measured facts, a bounded list of meaningful activities (under short local
 * aliases), and what Reflect already told the user recently.
 */

const RECENT_REPORTS_FOR_NOVELTY = 4;
const MAX_PREVIOUSLY_SURFACED = 12;

export interface PreprocessContext {
  userContext: UserIntelligenceContext | null;
  taxonomy: TaxonomyNames;
  config: ReflectionConfig;
  nowIso: string;
  /** The current report of the immediately preceding period, if any. */
  previousReport: ReflectionReport | null;
  /** Current reports of earlier periods of the same type, newest first. */
  recentReports: ReflectionReport[];
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
  /** How often each claim signature appeared in the recent reports. */
  recentSignatures: Map<string, number>;
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
    if (!prev && !baseline) continue;
    // Comparison labels are "<measure> — <reference>"; keep the measure.
    const referenceLabel = (prev ?? baseline)!.label;
    out.push({
      key: metric.key,
      label: referenceLabel.slice(0, referenceLabel.lastIndexOf(' — ')),
      now: metric.display,
      ...(prev ? { previous: prev.display } : {}),
      ...(delta ? { change: delta.display } : {}),
      ...(baseline ? { baseline: baseline.display } : {}),
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

  // What was already said recently, so the same observation is not repeated.
  const recent = ctx.recentReports.slice(0, RECENT_REPORTS_FOR_NOVELTY);
  const recentSignatures = new Map<string, number>();
  const surfaced = new Map<string, { type: ReflectionInsightType; title: string; signature: string }>();
  for (const report of recent) {
    for (const signature of new Set(report.insights.map((i) => i.claimSignature))) {
      recentSignatures.set(signature, (recentSignatures.get(signature) ?? 0) + 1);
    }
    for (const insight of report.insights) {
      if (!surfaced.has(insight.claimSignature)) {
        surfaced.set(insight.claimSignature, { type: insight.type, title: insight.title, signature: insight.claimSignature });
      }
    }
  }

  const previous = ctx.previousReport;
  const label = describePeriod(period, ctx.nowIso);

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
    metrics: Object.values(dataset.metrics)
      .filter((m) => m.group !== 'comparison')
      .map((m) => ({ key: m.key, label: m.label, value: m.display })),
    comparisons: toComparisons(dataset.metrics),
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
    previouslySurfaced: [...surfaced.values()].slice(0, MAX_PREVIOUSLY_SURFACED).map((s) => ({
      ...s,
      timesSurfaced: recentSignatures.get(s.signature) ?? 1,
    })),
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
    })),
    notes: dataset.notes,
    userContextIncluded: ctx.userContext !== null,
    previousReportId: previous?.id ?? null,
  };

  return { input, activityByRef, recentSignatures, snapshot };
}
