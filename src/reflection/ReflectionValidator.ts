import { z } from 'zod';
import {
  PATTERN_INSIGHT_TYPES,
  REFLECTION_INSIGHT_TYPES,
  REFLECTION_OUTPUT_SCHEMA_VERSION,
  type InsightContinuity,
  type Metric,
  type MetricSet,
  type ReflectionActivity,
  type ReflectionCarryForward,
  type ReflectionEvidence,
  type ReflectionInsightType,
  type ReflectionPeriod,
  type ReflectionPriority,
} from './ReflectionModels.js';
import { continuityOf, identityKeyOf, insightMagnitude, insightPattern, insightSubject, isCollectiveSubject, type PriorInsight } from './ReflectionIdentity.js';
import { formatMinutes } from './ReflectionMetrics.js';
import { formatLocalDateTime } from './ReflectionPeriods.js';
import { priorityKey } from './ReflectionPriorities.js';

/**
 * Runtime validation of the model's reflection. Pure.
 *
 * Nothing the model returns is trusted. Every insight must point at evidence
 * Reflect actually supplied, every number it quotes must come from that
 * evidence, and its wording must stay descriptive: no causes, no psychology,
 * no judgment, no generic advice.
 *
 * What an insight is ABOUT (priority, thread), whether it was said before and
 * how it relates to that are decided here, from the resolved evidence — the
 * model's self-reported confidence is only a floor, never the reason an
 * insight is believed.
 *
 * `ok` means the response is acceptable exactly as returned. Otherwise the
 * caller retries with `errors` as feedback; `salvaged` is what remains after
 * removing every unsupported insight, usable only once retries are exhausted.
 */

const MIN_CONFIDENCE = 0.4;
const DUPLICATE_EVIDENCE_OVERLAP = 0.6;
const DUPLICATE_TITLE_OVERLAP = 0.7;
/** A pattern surfaced in this many recent reports needs new evidence to return. */
const REPEAT_THRESHOLD = 2;

const LIMITS = { title: 120, observation: 500, interpretation: 500, relevance: 300, action: 240, headline: 240, narrative: 700 };

/** What counts as evidence spanning more than the one day being reflected on. */
const MULTI_DAY_KEY = /^(recent|weekday|baseline|prev|delta|change|trajectory|carry)\./;
/** Insight types that describe behaviour over several days; one day cannot show them alone. */
const MULTI_DAY_TYPES: readonly ReflectionInsightType[] = ['recurring_behavior', 'consistency_momentum'];

/** Plain totals the narrative may quote directly. */
export const NARRATIVE_METRIC_KEYS: readonly string[] = [
  'time.tracked_minutes',
  'time.focused_minutes',
  'behavior.switches',
  'block.longest_minutes',
  'focus.session_count',
  'focus.total_minutes',
];

const nullableText = z.preprocess((v) => (v === undefined || v === '' ? null : v), z.string().nullable());
const stringList = z.preprocess((v) => (v === undefined || v === null ? [] : v), z.array(z.string()));

const insightSchema = z.object({
  type: z.string(),
  title: z.string(),
  observation: z.string(),
  interpretation: z.string(),
  relevance: nullableText,
  metricKeys: stringList,
  activityRefs: stringList,
  priorityIds: stringList,
  confidence: z.number().min(0).max(1),
});

const outputSchema = z.object({
  schemaVersion: z.literal(REFLECTION_OUTPUT_SCHEMA_VERSION),
  periodType: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string(),
  narrative: nullableText,
  insights: z.array(insightSchema),
  carryForward: z
    .object({
      text: z.string(),
      sourceMetricKeys: stringList,
      sourceActivityRefs: stringList,
    })
    .nullish(),
});

export interface ReflectionValidationContext {
  period: ReflectionPeriod;
  /** Every metric (core + comparisons) the model was given, by key. */
  metrics: MetricSet;
  /** Prompt alias → activity. */
  activityByRef: Map<string, ReflectionActivity>;
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  maxInsights: number;
  /** Insights of the earlier reports of this period type, newest first. */
  history?: PriorInsight[];
  /**
   * Identities the user marked "not accurate" on evidence that has not
   * changed since. Saying the same thing again is refused.
   */
  disputedIdentities?: Set<string>;
  /** Identities the user marked "not useful": repeated only when something about them changed. */
  mutedIdentities?: Set<string>;
  /** Text whose numbers may always be quoted (the period's own label). */
  periodLabel: string;
}

export interface ValidatedInsight {
  type: ReflectionInsightType;
  title: string;
  observation: string;
  interpretation: string;
  relevance: string | null;
  confidence: number;
  sourceMetricKeys: string[];
  sourceActivityIds: string[];
  evidence: ReflectionEvidence[];
  claimSignature: string;
  identityKey: string;
  subjectKey: string | null;
  thread: string | null;
  priorityId: string | null;
  continuity: InsightContinuity;
  magnitude: number | null;
}

export interface ValidatedReflection {
  headline: string;
  narrative: string | null;
  insights: ValidatedInsight[];
  carryForward: ReflectionCarryForward | null;
}

export type ReflectionValidation =
  | { ok: true; reflection: ValidatedReflection }
  | { ok: false; errors: string[]; salvaged: ValidatedReflection | null };

// ── Language rules ──────────────────────────────────────────────────────────

const JUDGMENT_PATTERNS: [RegExp, string][] = [
  [/\bwast(e|ed|ing)\b/i, 'judgment ("wasted")'],
  [/\bunproductive\b/i, 'judgment ("unproductive")'],
  [/\b(more|less|most|least|highly|very|extremely) productive\b/i, 'a productivity judgment'],
  [/\bproductivity (score|rating|level|grade)\b/i, 'a productivity score'],
  [/\bexcellent productivity\b/i, 'a productivity judgment'],
  [/\blaz(y|iness)\b/i, 'judgment ("lazy")'],
  [/\bprocrastinat/i, 'judgment ("procrastinating")'],
  [/\bshould(n't| not)? have\b/i, 'judgment ("should have")'],
  [/\bfailed to\b/i, 'judgment ("failed to")'],
  [/\bbad habits?\b/i, 'judgment ("bad habit")'],
];

const PSYCHOLOGY_PATTERNS: [RegExp, string][] = [
  [/\btired(ness)?\b/i, 'a claim about tiredness'],
  [/\bexhaust(ed|ion)\b/i, 'a claim about exhaustion'],
  [/\bfatigued?\b/i, 'a claim about fatigue'],
  [/\bstress(ed|ful)?\b/i, 'a claim about stress'],
  [/\banxi(ous|ety)\b/i, 'a claim about anxiety'],
  [/\bburn(ed|t)?[- ]?out\b/i, 'a claim about burnout'],
  [/\bdepress(ed|ion)\b/i, 'a mental-health claim'],
  [/\b(un|de)?motivat(ed|ion)\b/i, 'a claim about motivation'],
  [/\bbored(om)?\b/i, 'a claim about boredom'],
  [/\boverwhelm(ed|ing)?\b/i, 'a claim about feeling overwhelmed'],
  [/\bdistracted\b/i, 'a claim about being distracted'],
  [/\bmood\b/i, 'a claim about mood'],
  [/\b(low|high|more|less) energy\b/i, 'a claim about energy'],
  [/\bwillpower\b/i, 'a claim about willpower'],
  [/\baddict(ed|ion)\b/i, 'a claim about addiction'],
];

const CAUSAL_PATTERNS: [RegExp, string][] = [
  [/\bbecause\b/i, '"because"'],
  [/\bcaus(e|ed|es|ing)\b/i, '"caused"'],
  [/\bdue to\b/i, '"due to"'],
  [/\b(led|leading) to\b/i, '"led to"'],
  [/\bas a result\b/i, '"as a result"'],
  [/\bresult(ed|ing|s)? in\b/i, '"resulted in"'],
  [/\bthanks to\b/i, '"thanks to"'],
  [/\bmade you\b/i, '"made you"'],
];

const GENERIC_ADVICE_PATTERNS: [RegExp, string][] = [
  [/\bpomodoro\b/i, 'Pomodoro'],
  [/\bdrink (more )?water\b/i, 'hydration advice'],
  [/\bhydrat/i, 'hydration advice'],
  [/\bwake up earlier\b/i, 'sleep-schedule advice'],
  [/\b(get|more|better) sleep\b/i, 'sleep advice'],
  [/\bmeditat/i, 'meditation advice'],
  [/\btake (regular |more |short |frequent |a )?breaks?\b/i, 'generic break advice'],
  [/\bdelete (your )?(social media|apps?)\b/i, 'app-deletion advice'],
  [/\bturn off (your )?notifications\b/i, 'notification advice'],
];

/** Wording that asserts a change; only allowed alongside a cited comparison. */
const COMPARATIVE_PATTERN =
  /\b(increased|decreased|than usual|than last|than (the |your )?previous|compared (with|to)|up from|down from|rose|fell|dropped)\b/i;

function findPattern(text: string, patterns: [RegExp, string][]): string | null {
  for (const [re, name] of patterns) if (re.test(text)) return name;
  return null;
}

export type LanguageRule = 'judgment' | 'psychology' | 'causal' | 'generic_advice';

const RULE_PATTERNS: Record<LanguageRule, [RegExp, string][]> = {
  judgment: JUDGMENT_PATTERNS,
  psychology: PSYCHOLOGY_PATTERNS,
  causal: CAUSAL_PATTERNS,
  generic_advice: GENERIC_ADVICE_PATTERNS,
};

/**
 * The first language rule `text` breaks, described for the model, or `null`.
 * Shared with the Coach so every sentence Reflect shows obeys the same rules.
 */
export function findLanguageIssue(text: string, rules: readonly LanguageRule[]): string | null {
  for (const rule of rules) {
    const hit = findPattern(text, RULE_PATTERNS[rule]);
    if (hit) return hit;
  }
  return null;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const NUMBER_RE = /\d+(?:[.,:]\d+)*/g;

function normalizeNumber(token: string): string {
  let t = token;
  if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
  t = t.replace(/^0+(?=\d)/, '');
  if (/^\d+\.0+$/.test(t)) t = t.slice(0, t.indexOf('.'));
  return t;
}

/** Every number written in `text`, normalized (`09:05` → `9:05`, `1,200` → `1200`). */
export function extractNumbers(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map(normalizeNumber);
}

export function addNumbersFrom(set: Set<string>, text: string): void {
  for (const n of extractNumbers(text)) {
    set.add(n);
    // `10:40` also licenses a plain "10" ("around 10 AM").
    if (n.includes(':')) set.add(n.slice(0, n.indexOf(':')));
  }
}

export function addMinutes(set: Set<string>, minutes: number): void {
  const m = Math.round(Math.abs(minutes));
  set.add(String(m));
  addNumbersFrom(set, formatMinutes(m));
  set.add(normalizeNumber((m / 60).toFixed(1)));
  set.add(String(Math.round(m / 60)));
}

function numbersOfMetric(metric: Metric): Set<string> {
  const set = new Set<string>();
  addNumbersFrom(set, metric.display);
  addNumbersFrom(set, metric.label);
  if (typeof metric.value === 'number') {
    if (metric.unit === 'minutes') addMinutes(set, metric.value);
    else if (metric.unit !== 'clock') addNumbersFrom(set, String(Math.abs(metric.value)));
  }
  return set;
}

function numbersOfActivity(activity: ReflectionActivity): Set<string> {
  const set = new Set<string>();
  addNumbersFrom(set, activity.title);
  addNumbersFrom(set, formatLocalDateTime(activity.startedAt));
  addNumbersFrom(set, formatLocalDateTime(activity.endedAt));
  addMinutes(set, activity.durationMinutes);
  return set;
}

export function unsupportedNumbers(text: string, allowed: Set<string>): string[] {
  return [...new Set(extractNumbers(text).filter((n) => !allowed.has(n)))];
}

// ── Claim identity ──────────────────────────────────────────────────────────

const COMPARISON_PREFIX = /^(prev|delta|baseline|weekday|change)\./;

export function isComparisonKey(key: string): boolean {
  return COMPARISON_PREFIX.test(key);
}

/**
 * Normalized identity of a claim: its type plus the measures it rests on,
 * independent of wording, of which sub-bucket was cited, and of whether the
 * current, previous or baseline value was quoted.
 */
export function claimSignature(type: ReflectionInsightType, metricKeys: string[]): string {
  const bases = metricKeys.map((k) => k.replace(COMPARISON_PREFIX, '').replace(/^series\.[^.]+\./, 'series.*.'));
  const unique = [...new Set(bases)].sort();
  return `${type}|${unique.length > 0 ? unique.join(',') : 'activities'}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

const titleTokens = (title: string) => new Set(priorityKey(title).split(' ').filter((t) => t.length > 2));

export function clean(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// ── Evidence resolution ─────────────────────────────────────────────────────

export interface EvidenceContext {
  metrics: MetricSet;
  activityByRef: Map<string, ReflectionActivity>;
  priorities: Pick<ReflectionPriority, 'id' | 'text'>[];
  periodLabel: string;
}

export interface EvidenceToolkit {
  /** Numbers that may always be quoted (the period's own label). */
  globalNumbers: Set<string>;
  /** Resolve cited keys / refs; anything that does not exist is reported in `problems`. */
  resolve(
    metricKeys: string[],
    activityRefs: string[],
    label: string,
    problems: string[],
  ): { metrics: Metric[]; activities: ReflectionActivity[] };
  /** Every number the cited evidence licenses. */
  allowedFor(metrics: Metric[], activities: ReflectionActivity[]): Set<string>;
  /** Self-contained evidence records to store with a claim. */
  toEvidence(metrics: Metric[], activities: ReflectionActivity[], citedPriorityIds: string[]): ReflectionEvidence[];
}

/**
 * The evidence rules, usable by anything that validates model output written
 * from a reflection dataset (the reflection itself, and the Coach).
 */
export function createEvidenceToolkit(ctx: EvidenceContext): EvidenceToolkit {
  const globalNumbers = new Set<string>();
  addNumbersFrom(globalNumbers, ctx.periodLabel);

  return {
    globalNumbers,
    resolve(metricKeys, activityRefs, label, problems) {
      const metrics: Metric[] = [];
      const activities: ReflectionActivity[] = [];
      for (const key of [...new Set(metricKeys)]) {
        const metric = ctx.metrics[key];
        if (!metric) problems.push(`${label}: metric "${key}" does not exist`);
        else metrics.push(metric);
      }
      for (const ref of [...new Set(activityRefs)]) {
        const activity = ctx.activityByRef.get(ref);
        if (!activity) problems.push(`${label}: activity "${ref}" does not exist`);
        else activities.push(activity);
      }
      return { metrics, activities };
    },
    allowedFor(metrics, activities) {
      const allowed = new Set(globalNumbers);
      for (const m of metrics) for (const n of numbersOfMetric(m)) allowed.add(n);
      for (const a of activities) for (const n of numbersOfActivity(a)) allowed.add(n);
      return allowed;
    },
    toEvidence(metrics, activities, citedPriorityIds) {
      const evidence: ReflectionEvidence[] = metrics.map((m) => ({
        kind: isComparisonKey(m.key) ? 'comparison' : m.key.startsWith('priority.') ? 'priority' : 'metric',
        metricKey: m.key,
        ...(m.priorityId ? { priorityId: m.priorityId } : {}),
        ...(m.thread ? { thread: m.thread } : {}),
        label: m.label,
        value: m.display,
        ...(m.range ? { period: m.range } : {}),
      }));
      for (const a of activities) {
        evidence.push({
          kind: 'activity',
          // The block id as of now; the events are what the reference rests on.
          activityId: a.id,
          ...(a.eventIds && a.eventIds.length > 0 ? { eventIds: a.eventIds } : {}),
          ...(a.priorityId ? { priorityId: a.priorityId } : {}),
          ...(a.thread ? { thread: a.thread } : {}),
          label: a.title,
          value: `${formatMinutes(a.durationMinutes)} · ${formatLocalDateTime(a.startedAt)}`,
          period: { start: a.startedAt, end: a.endedAt },
        });
      }
      // A priority the model cited is named on its own unless a priority measurement already names it.
      const covered = new Set(evidence.filter((e) => e.kind === 'priority').map((e) => e.priorityId));
      for (const id of citedPriorityIds) {
        if (covered.has(id)) continue;
        const priority = ctx.priorities.find((p) => p.id === id);
        if (priority) evidence.push({ kind: 'priority', priorityId: id, label: `Priority: ${priority.text}` });
      }
      return evidence;
    },
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateReflectionOutput(raw: unknown, ctx: ReflectionValidationContext): ReflectionValidation {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 10).map((i) => `schema: ${i.path.join('.') || '(root)'} — ${i.message}`),
      salvaged: null,
    };
  }
  const output = parsed.data;
  /** Problems that make the whole response unusable. */
  const fatal: string[] = [];
  /** Problems confined to one insight (it is removed) or to the carry-forward. */
  const errors: string[] = [];

  // Period: must be exactly the one requested.
  if (
    output.periodType !== ctx.period.type ||
    Date.parse(output.periodStart) !== Date.parse(ctx.period.start) ||
    Date.parse(output.periodEnd) !== Date.parse(ctx.period.end)
  ) {
    fatal.push(
      `period: expected ${ctx.period.type} ${ctx.period.start} → ${ctx.period.end}, got ${output.periodType} ${output.periodStart} → ${output.periodEnd}`,
    );
  }

  const priorityIds = new Set(ctx.priorities.map((p) => p.id));
  const { globalNumbers, resolve, allowedFor, toEvidence } = createEvidenceToolkit(ctx);

  // ── Insights ──
  const valid: (ValidatedInsight & { allowed: Set<string>; keySet: Set<string> })[] = [];
  output.insights.forEach((draft, index) => {
    const label = `insight ${index + 1}`;
    const problems: string[] = [];

    if (!(REFLECTION_INSIGHT_TYPES as readonly string[]).includes(draft.type)) {
      problems.push(`${label}: unsupported insight type "${draft.type}"`);
    }
    const type = draft.type as ReflectionInsightType;

    const title = clean(draft.title, LIMITS.title);
    const observation = clean(draft.observation, LIMITS.observation);
    const interpretation = clean(draft.interpretation, LIMITS.interpretation);
    const relevance = draft.relevance ? clean(draft.relevance, LIMITS.relevance) || null : null;

    if (title.length < 4) problems.push(`${label}: title is empty`);
    if (observation.length < 15) problems.push(`${label}: observation is empty or meaningless`);
    if (interpretation.length < 10) problems.push(`${label}: interpretation is empty or meaningless`);

    const { metrics, activities } = resolve(draft.metricKeys, draft.activityRefs, label, problems);
    const citedPriorities = [...new Set(draft.priorityIds)];
    for (const id of citedPriorities) {
      if (!priorityIds.has(id)) problems.push(`${label}: priority "${id}" does not exist`);
    }
    if (metrics.length === 0 && activities.length === 0) {
      problems.push(`${label}: cites no evidence — every insight must cite at least one metric or activity`);
    }

    const hasComparison = metrics.some((m) => isComparisonKey(m.key));
    if ((type === 'change_over_time' || type === 'unexpected') && !hasComparison) {
      problems.push(`${label}: a ${type} insight must cite a comparison (prev.*, delta.*, baseline.*, weekday.* or change.*)`);
    }
    // A project that happens to serve a priority is not, by itself, evidence about the priority.
    if (type === 'priority_alignment' && !metrics.some((m) => m.priorityId && !/(^|\.)thread\./.test(m.key)) && citedPriorities.length === 0) {
      problems.push(`${label}: a priority_alignment insight must cite a priority metric`);
    }
    // One day cannot show a habit. Such a claim needs evidence from other days.
    if (ctx.period.type === 'day' && MULTI_DAY_TYPES.includes(type) && !metrics.some((m) => MULTI_DAY_KEY.test(m.key))) {
      problems.push(`${label}: a ${type} insight about a single day must cite evidence from other days (recent.*, weekday.*, baseline.*, trajectory.* or carry.*)`);
    }

    const claim = `${title} ${observation} ${interpretation}`;
    const everything = `${claim} ${relevance ?? ''}`;
    const judgment = findPattern(everything, JUDGMENT_PATTERNS);
    if (judgment) problems.push(`${label}: contains ${judgment}; describe, do not judge`);
    const psychology = findPattern(everything, PSYCHOLOGY_PATTERNS);
    if (psychology) problems.push(`${label}: contains ${psychology}; Reflect has no evidence for it`);
    const causal = findPattern(claim, CAUSAL_PATTERNS);
    if (causal) problems.push(`${label}: uses causal language (${causal}); describe what coincided, not what caused what`);
    if (!hasComparison && COMPARATIVE_PATTERN.test(`${observation} ${interpretation}`)) {
      problems.push(`${label}: states a comparison without citing a comparison metric`);
    }

    const allowed = allowedFor(metrics, activities);
    const bad = unsupportedNumbers(everything, allowed);
    if (bad.length > 0) {
      problems.push(`${label}: number(s) ${bad.map((n) => `"${n}"`).join(', ')} not found in its cited evidence`);
    }

    const metricKeys = metrics.map((m) => m.key);
    const signature = claimSignature(type, metricKeys);

    // What the claim is about and how it relates to what was said before —
    // decided from the resolved evidence, never from the model's wording.
    const subject = insightSubject(metrics, activities, citedPriorities.filter((id) => priorityIds.has(id)));
    const pattern = insightPattern(type, metrics, subject);
    const identityKey = identityKeyOf(subject, pattern, metricKeys);
    const magnitude = insightMagnitude(subject, pattern, ctx.metrics);
    const continuity = continuityOf({ identityKey, subjectKey: subject.subjectKey, pattern, magnitude }, ctx.history ?? []);

    if (ctx.disputedIdentities?.has(identityKey)) {
      problems.push(`${label}: you marked this same claim "not accurate" and the evidence behind it has not changed — leave it out`);
    }
    // What must not simply be said again: a standing pattern, work that is
    // lagging, and the general "your time went across your priorities" — new
    // progress on one body of work is still news and may recur.
    const repeatsItself = continuity.state === 'continuing' && continuity.timesBefore >= REPEAT_THRESHOLD;
    if (repeatsItself && (PATTERN_INSIGHT_TYPES.includes(type) || pattern === 'lagging' || isCollectiveSubject(subject.subjectKey)) && !hasComparison) {
      problems.push(
        `${label}: this pattern was already surfaced in ${continuity.timesBefore} recent reports and has not changed; repeat it only with a comparison showing what changed`,
      );
    }

    if (problems.length > 0) {
      errors.push(...problems);
      return;
    }
    if (draft.confidence < MIN_CONFIDENCE) return; // weakly supported: quietly left out
    // "Not useful" is the user's call: the same thing is not said again while nothing about it moved.
    if (ctx.mutedIdentities?.has(identityKey) && (continuity.state === 'continuing' || continuity.state === 'recurred' || continuity.state === 'new')) return;

    valid.push({
      type,
      title,
      observation,
      interpretation,
      relevance,
      confidence: draft.confidence,
      sourceMetricKeys: metricKeys,
      sourceActivityIds: activities.map((a) => a.id),
      evidence: toEvidence(metrics, activities, citedPriorities),
      claimSignature: signature,
      identityKey,
      subjectKey: subject.subjectKey,
      thread: subject.thread,
      priorityId: subject.priorityId,
      continuity: continuity.state,
      magnitude,
      allowed,
      keySet: new Set(metricKeys.map((k) => k.replace(COMPARISON_PREFIX, ''))),
    });
  });

  // ── Duplicates (removed quietly; the stronger one stays) ──
  const unique: typeof valid = [];
  for (const insight of valid) {
    const twin = unique.findIndex(
      (other) =>
        // The same subject pointing the same way is one insight, however it is worded.
        (insight.subjectKey !== null && other.identityKey === insight.identityKey && (other.type === insight.type || insight.identityKey.endsWith('|lagging'))) ||
        (other.type === insight.type && jaccard(other.keySet, insight.keySet) >= DUPLICATE_EVIDENCE_OVERLAP) ||
        jaccard(titleTokens(other.title), titleTokens(insight.title)) >= DUPLICATE_TITLE_OVERLAP,
    );
    if (twin === -1) unique.push(insight);
    else if (insight.confidence > unique[twin].confidence) unique[twin] = insight;
  }

  // ── Count ──
  let selected = unique;
  if (unique.length > ctx.maxInsights) {
    errors.push(`too many insights: ${unique.length} returned, at most ${ctx.maxInsights} allowed — keep only the most meaningful`);
    selected = selectComplementary(unique, ctx.maxInsights);
  }

  // ── Carry-forward: exactly one grounded action, or none ──
  let carryForward: ReflectionCarryForward | null = null;
  if (output.carryForward) {
    const problems: string[] = [];
    const text = clean(output.carryForward.text, LIMITS.action);
    const { metrics, activities } = resolve(
      output.carryForward.sourceMetricKeys,
      output.carryForward.sourceActivityRefs,
      'carryForward',
      problems,
    );
    if (text.length < 8) problems.push('carryForward: text is empty');
    if (metrics.length === 0 && activities.length === 0) {
      problems.push('carryForward: must cite the metrics or activities it is grounded in');
    }
    const advice =
      findPattern(text, GENERIC_ADVICE_PATTERNS) ?? findPattern(text, JUDGMENT_PATTERNS) ?? findPattern(text, PSYCHOLOGY_PATTERNS);
    if (advice) problems.push(`carryForward: contains ${advice}; it must follow from the observed behavior`);
    const bad = unsupportedNumbers(text, allowedFor(metrics, activities));
    if (bad.length > 0) problems.push(`carryForward: number(s) ${bad.map((n) => `"${n}"`).join(', ')} not found in its cited evidence`);

    if (problems.length > 0) errors.push(...problems);
    else {
      carryForward = {
        text,
        subjectKey: insightSubject(metrics, activities, []).subjectKey,
        sourceMetricKeys: metrics.map((m) => m.key),
        sourceActivityIds: activities.map((a) => a.id),
        evidence: toEvidence(metrics, activities, []),
      };
    }
  }

  // ── Headline ──
  const headline = clean(output.headline, LIMITS.headline);
  if (headline.length < 8) fatal.push('headline: empty or meaningless');
  const headlineIssue =
    findPattern(headline, JUDGMENT_PATTERNS) ?? findPattern(headline, PSYCHOLOGY_PATTERNS) ?? findPattern(headline, CAUSAL_PATTERNS);
  if (headlineIssue) fatal.push(`headline: contains ${headlineIssue}`);
  const headlineNumbers = new Set(globalNumbers);
  for (const insight of selected) for (const n of insight.allowed) headlineNumbers.add(n);
  const badHeadline = unsupportedNumbers(headline, headlineNumbers);
  // An unsupported number in the headline is asked to be corrected like any
  // other problem. When no correction comes, the salvaged reflection carries
  // the title of its strongest validated insight instead — losing the whole
  // day (and the coaching written with it) over one number helps nobody.
  const fallbackHeadline = badHeadline.length > 0 && selected.length > 0 ? selected[0].title : null;
  if (badHeadline.length > 0) {
    (fallbackHeadline ? errors : fatal).push(`headline: number(s) ${badHeadline.map((n) => `"${n}"`).join(', ')} not found in the insights' evidence`);
  }

  // ── Narrative: "what happened", bound by the same rules as the headline ──
  let narrative = output.narrative ? clean(output.narrative, LIMITS.narrative) || null : null;
  if (narrative) {
    const issue =
      findPattern(narrative, JUDGMENT_PATTERNS) ?? findPattern(narrative, PSYCHOLOGY_PATTERNS) ?? findPattern(narrative, CAUSAL_PATTERNS);
    // The day's plain totals may be stated without a separate insight behind them.
    const narrativeNumbers = new Set(headlineNumbers);
    for (const key of NARRATIVE_METRIC_KEYS) {
      const metric = ctx.metrics[key];
      if (metric) for (const n of numbersOfMetric(metric)) narrativeNumbers.add(n);
    }
    const badNarrative = unsupportedNumbers(narrative, narrativeNumbers);
    if (issue) errors.push(`narrative: contains ${issue}`);
    else if (badNarrative.length > 0) {
      errors.push(`narrative: number(s) ${badNarrative.map((n) => `"${n}"`).join(', ')} not found in the insights' evidence`);
    }
    if (issue || badNarrative.length > 0 || narrative.length < 20) narrative = null;
  }

  const reflection: ValidatedReflection = {
    headline: fallbackHeadline ?? headline,
    narrative,
    insights: selected.map((full) => {
      const { allowed: _allowed, keySet: _keySet, ...insight } = full;
      return insight;
    }),
    carryForward,
  };

  if (fatal.length === 0 && errors.length === 0) return { ok: true, reflection };

  // Salvage keeps only what fully validated. It is not offered when the
  // response is unusable as a whole, or when every proposed insight fell.
  const salvageable = fatal.length === 0 && (reflection.insights.length > 0 || output.insights.length === 0);
  return { ok: false, errors: [...fatal, ...errors], salvaged: salvageable ? reflection : null };
}

/**
 * Choose a complementary set: the strongest insight of each type first, then
 * the strongest of what is left. Original (narrative) order is preserved.
 */
function selectComplementary<T extends ValidatedInsight>(insights: T[], max: number): T[] {
  const score = (i: T) =>
    i.confidence + 0.05 * Math.min(i.evidence.length, 4) + (i.sourceMetricKeys.some(isComparisonKey) ? 0.05 : 0);
  const ranked = insights
    .map((insight, index) => ({ insight, index, score: score(insight) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = new Set<number>();
  const types = new Set<ReflectionInsightType>();
  for (const r of ranked) {
    if (chosen.size >= max) break;
    if (types.has(r.insight.type)) continue;
    types.add(r.insight.type);
    chosen.add(r.index);
  }
  for (const r of ranked) {
    if (chosen.size >= max) break;
    chosen.add(r.index);
  }
  return insights.filter((_, index) => chosen.has(index));
}
