import type {
  InsightContinuity,
  Metric,
  MetricSet,
  ReflectionActivity,
  ReflectionInsightType,
} from './ReflectionModels.js';
import { threadSlug } from './ReflectionActivities.js';

/**
 * What an insight is ABOUT, and whether it is new. Pure.
 *
 * The model writes the sentence; the backend decides its identity. An insight
 * is the same underlying pattern as an earlier one when it has the same
 * subject (a stated priority, or a thread) and points the same way — whatever
 * its wording, its insight type, or the exact metrics it happened to cite.
 * "SaaS received less attention this week" and "Your SaaS work fell behind
 * again" are one pattern, seen twice.
 *
 * Canonical ids come from the evidence the backend resolved (metrics and
 * activities carry them); nothing here trusts an id the model wrote.
 */

/** Which way a claim about a subject points. */
export type InsightPattern =
  | 'lagging' // less attention, stalled, open, vanished
  | 'advancing' // progress, more attention, resumed, steady work
  | 'closed' // completed, paused or dropped by the user
  | 'alignment' // how time lines up with what was stated, no direction
  | 'timing'
  | 'fragmentation'
  | 'recurring'
  | 'shift'; // a change with no single direction

/** The subject of a claim about the stated priorities as a whole. */
export const ALL_PRIORITIES = 'p:*';

/** A claim about several priorities at once, rather than about one body of work. */
export const isCollectiveSubject = (subjectKey: string | null): boolean => subjectKey !== null && (subjectKey === ALL_PRIORITIES || subjectKey.includes('+'));

export interface InsightSubject {
  subjectKey: string | null;
  priorityId: string | null;
  thread: string | null;
}

/**
 * The subject of a claim, from its resolved evidence: the one priority it
 * rests on, else the one thread. Two priorities are kept as a pair (one set
 * against the other); three or more are "the stated priorities as a whole"
 * (`p:*`) — so "time was spread across your priorities" is recognised as the
 * same statement next time, whichever measurements it happens to cite.
 */
export function insightSubject(metrics: Metric[], activities: ReflectionActivity[], citedPriorityIds: string[]): InsightSubject {
  const priorities = new Set<string>(citedPriorityIds);
  const threads = new Map<string, string>();
  for (const m of metrics) {
    if (m.priorityId) priorities.add(m.priorityId);
    if (m.thread && threadSlug(m.thread)) threads.set(threadSlug(m.thread), m.thread);
  }
  for (const a of activities) {
    if (a.priorityId) priorities.add(a.priorityId);
    if (a.thread && threadSlug(a.thread)) threads.set(threadSlug(a.thread), a.thread);
  }
  const ids = [...priorities].sort();
  const thread = threads.size === 1 ? [...threads.values()][0] : null;
  if (ids.length === 1) return { subjectKey: `p:${ids[0]}`, priorityId: ids[0], thread };
  if (ids.length === 2) return { subjectKey: `p:${ids[0]}+${ids[1]}`, priorityId: null, thread: null };
  if (ids.length >= 3) return { subjectKey: ALL_PRIORITIES, priorityId: null, thread: null };
  if (ids.length === 0 && thread) return { subjectKey: `t:${threadSlug(thread)}`, priorityId: null, thread };
  return { subjectKey: null, priorityId: null, thread: null };
}

const TYPE_PATTERNS: Record<ReflectionInsightType, InsightPattern> = {
  progress: 'advancing',
  priority_alignment: 'alignment',
  time_attention_pattern: 'timing',
  fragmentation: 'fragmentation',
  consistency_momentum: 'advancing',
  recurring_behavior: 'recurring',
  change_over_time: 'shift',
  open_loop: 'lagging',
  unexpected: 'shift',
};

const STATE_PATTERNS: Record<string, InsightPattern> = {
  // change.* values
  vanished: 'lagging',
  decreased: 'lagging',
  appeared: 'advancing',
  returned: 'advancing',
  increased: 'advancing',
  // trajectory.* / carry.* values
  stalled: 'lagging',
  open: 'lagging',
  new: 'advancing',
  ongoing: 'advancing',
  resumed: 'advancing',
  progressing: 'advancing',
  completed: 'closed',
  paused: 'closed',
  dropped: 'closed',
};

/**
 * Which way the claim points — read from the measured direction of the
 * evidence about its subject, never from its wording. The insight type is
 * only the fallback when the evidence has no direction.
 */
export function insightPattern(type: ReflectionInsightType, metrics: Metric[], subject: InsightSubject): InsightPattern {
  const about = (m: Metric) =>
    subject.subjectKey === null ||
    (subject.priorityId !== null && m.priorityId === subject.priorityId) ||
    (subject.thread !== null && m.thread !== undefined && threadSlug(m.thread) === threadSlug(subject.thread));
  const votes = new Set<InsightPattern>();
  for (const m of metrics.filter(about)) {
    if (/^(change|trajectory|carry)\./.test(m.key) && typeof m.value === 'string' && STATE_PATTERNS[m.value]) votes.add(STATE_PATTERNS[m.value]);
    else if (/^delta\.(priority|thread)\.[^.]+\.minutes$/.test(m.key) && typeof m.value === 'number' && m.value !== 0) votes.add(m.value < 0 ? 'lagging' : 'advancing');
  }
  if (votes.size === 1) return [...votes][0];
  if (votes.has('closed')) return 'closed';
  if (votes.size > 1) return 'shift';
  // A statement about attention patterns stays what it is, whatever it cites.
  if (type === 'open_loop' && subject.subjectKey === null) return 'lagging';
  return TYPE_PATTERNS[type];
}

const COMPARISON_PREFIX = /^(prev|delta|baseline|weekday)\./;

/** `<subject>|<pattern>`; for a claim about the period as a whole, the measures it rests on stand in for the subject. */
export function identityKeyOf(subject: InsightSubject, pattern: InsightPattern, metricKeys: string[]): string {
  if (subject.subjectKey) return `${subject.subjectKey}|${pattern}`;
  const bases = [...new Set(metricKeys.map((k) => k.replace(COMPARISON_PREFIX, '').replace(/^series\.[^.]+\./, 'series.*.').replace(/^recent\.\d{4}-\d{2}-\d{2}\./, 'recent.*.')))].sort();
  return `period|${pattern}|${bases.length > 0 ? bases.slice(0, 4).join(',') : 'activities'}`;
}

/**
 * How large the pattern is right now — what "stronger" is measured against
 * next time. For work that is lagging it is ALWAYS the tracked days it has
 * been idle (unknown when no stalled trajectory exists); for everything else
 * the time the subject received in the period. One unit per pattern, so two
 * magnitudes of the same identity are always comparable.
 */
export function insightMagnitude(subject: InsightSubject, pattern: InsightPattern, dataset: MetricSet): number | null {
  if (!subject.subjectKey || isCollectiveSubject(subject.subjectKey)) return null;
  const slug = subject.subjectKey.replace(':', '.');
  if (pattern === 'lagging') {
    const idle = dataset[`trajectory.${slug}.idle_days`];
    return idle && typeof idle.value === 'number' ? idle.value : null;
  }
  const key = subject.priorityId ? `priority.${subject.priorityId}.minutes` : subject.thread ? `thread.${threadSlug(subject.thread)}.minutes` : null;
  const minutes = key ? dataset[key] : undefined;
  return minutes && typeof minutes.value === 'number' ? minutes.value : null;
}

/** An insight of an earlier report, reduced to what continuity needs. */
export interface PriorInsight {
  /** 1 = the most recent earlier period of the same type that has a report. */
  periodsBack: number;
  periodKey: string;
  identityKey: string;
  subjectKey: string | null;
  magnitude: number | null;
  title: string;
  type: ReflectionInsightType;
  feedback: 'useful' | 'not_useful' | 'inaccurate' | null;
}

const MAGNITUDE_RATIO = 1.5;
/** The smallest move that counts: idle tracked days for lagging work, minutes otherwise. */
const MAGNITUDE_MIN_STEP = { idleDays: 2, minutes: 30 };

export interface ContinuityResult {
  state: InsightContinuity;
  /** How many of the earlier reports looked at carried this identity. */
  timesBefore: number;
}

/**
 * How a claim relates to what was already said.
 *
 *   new            not said in the reports looked at
 *   continuing     said last period too, and its size has not really moved
 *   strengthening  said last period, and it has grown markedly since
 *   weakening      said last period, and it has shrunk markedly since
 *   recurred       said before, then absent for at least one report, now back
 *                  (when it grew markedly over that silence it never went
 *                  away — that is strengthening, not a return)
 *   resolved       the subject was lagging last time and is now advancing or
 *                  was closed — the earlier concern no longer holds
 */
export function continuityOf(
  current: { identityKey: string; subjectKey: string | null; pattern: InsightPattern; magnitude: number | null },
  history: PriorInsight[],
): ContinuityResult {
  const same = history.filter((h) => h.identityKey === current.identityKey).sort((a, b) => a.periodsBack - b.periodsBack);
  const timesBefore = new Set(same.map((h) => h.periodKey)).size;
  if (same.length === 0) {
    const wasLagging =
      current.subjectKey !== null &&
      (current.pattern === 'advancing' || current.pattern === 'closed') &&
      history.some((h) => h.periodsBack <= 2 && h.subjectKey === current.subjectKey && h.identityKey === `${current.subjectKey}|lagging`);
    return { state: wasLagging ? 'resolved' : 'new', timesBefore: 0 };
  }
  const latest = same[0];
  const comparable = current.magnitude !== null && latest.magnitude !== null;
  const step = current.pattern === 'lagging' ? MAGNITUDE_MIN_STEP.idleDays : MAGNITUDE_MIN_STEP.minutes;
  const grew = comparable && current.magnitude! - latest.magnitude! >= step && current.magnitude! >= latest.magnitude! * MAGNITUDE_RATIO;
  const shrank = comparable && latest.magnitude! - current.magnitude! >= step && latest.magnitude! >= current.magnitude! * MAGNITUDE_RATIO;
  // Not said in the report just before: it either came back, or — when it
  // kept growing in the meantime — was simply not repeated while unchanged.
  if (latest.periodsBack > 1) return { state: grew ? 'strengthening' : 'recurred', timesBefore };
  return { state: grew ? 'strengthening' : shrank ? 'weakening' : 'continuing', timesBefore };
}
