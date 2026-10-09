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
 * Two kinds of problem are told apart:
 *
 *   an INVALID CLAIM — a number nothing holds, an activity that does not
 *   exist, a cause, a judgment, a pattern said again unchanged — is removed
 *   with the insight it sits in. Nothing makes such a claim acceptable.
 *
 *   a PRESENTATION PROBLEM in something that is true — a comparison cited by
 *   the key its row is listed under, a headline or a narrative sentence that
 *   cannot stand as written — is repaired: the citation is completed from the
 *   very entry that holds the quoted value, the sentence is replaced or left
 *   out. A repair never adds evidence and never changes what is claimed.
 *
 * `ok` means every claim stands (repairs, if any, are listed). Otherwise
 * `issues` locates each problem (field, insight, values); `salvaged` is what
 * remains after removing every unsupported insight, and the caller decides
 * whether that is enough or the model is asked again.
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

/** Which rule a problem broke. Stable: the retry instructions and the logs are keyed by it. */
export type ReflectionIssueCode =
  | 'schema'
  | 'period'
  | 'headline_empty'
  | 'headline_language'
  | 'headline_number'
  | 'narrative_language'
  | 'narrative_number'
  | 'insight_type'
  | 'insight_empty'
  | 'insight_unknown_evidence'
  | 'insight_no_evidence'
  | 'insight_needs_comparison'
  | 'insight_needs_priority_metric'
  | 'insight_needs_other_days'
  | 'insight_language'
  | 'insight_uncited_comparison'
  | 'insight_number'
  | 'insight_disputed'
  | 'insight_repeat'
  | 'insight_citation'
  | 'too_many_insights'
  | 'carry_forward';

/**
 * One problem, located. `resolution` says what became of it:
 *
 *   fatal     the response cannot be used as a whole (wrong period, wrong shape)
 *   removed   the claim it sits in was taken out; what is left is still true
 *   repaired  how something was WRITTEN was put right without touching what is claimed
 *             (a citation completed from the row the model was shown, a headline or a
 *             narrative sentence replaced or left out) — never a claim made supportable
 */
export interface ReflectionIssue {
  code: ReflectionIssueCode;
  field: 'response' | 'headline' | 'narrative' | 'insight' | 'carryForward';
  /** 0-based position of the insight in the model's response; null elsewhere. */
  index: number | null;
  /** The offending values (numbers, keys, wording), when the rule names any. */
  values: string[];
  message: string;
  resolution: 'fatal' | 'removed' | 'repaired';
}

export type ReflectionValidation =
  | { ok: true; reflection: ValidatedReflection; repairs?: ReflectionIssue[] }
  | {
      ok: false;
      errors: string[];
      /** Every problem behind `errors`, located (same order), followed by what was repaired. */
      issues: ReflectionIssue[];
      /** What fully validated, when at least one insight (or an honest "nothing") is left. */
      salvaged: ValidatedReflection | null;
      /**
       * The headline and narrative that validated, with whatever insights survived — offered even when
       * every proposed insight fell. `null` only when the response is unusable as a whole.
       */
      remainder: ValidatedReflection | null;
    };

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

// ── Citations ───────────────────────────────────────────────────────────────

/** The members of a COMPARISONS row, which the prompt lists under the row's plain key. */
const ROW_PREFIXES = ['delta.', 'prev.', 'weekday.', 'baseline.'] as const;

/** The comparison entries of the row `key` heads, most specific first. */
function comparisonRow(key: string, all: MetricSet): Metric[] {
  if (isComparisonKey(key)) return [];
  return ROW_PREFIXES.map((prefix) => all[prefix + key]).filter((m): m is Metric => m !== undefined);
}

/**
 * Other measurements of the SAME subject as `key` (`priority.<id>.minutes` → `.share`, `.sessions`). Only keys
 * that name a subject have siblings; the period-wide groups (`time.*`, `behavior.*`) do not.
 */
function siblingMetrics(key: string, all: MetricSet): Metric[] {
  const base = key.replace(COMPARISON_PREFIX, '');
  const family = base.slice(0, base.lastIndexOf('.') + 1);
  if (family.split('.').length < 3) return [];
  return Object.values(all).filter((m) => m.key !== base && m.key.startsWith(family) && !m.key.slice(family.length).includes('.'));
}

/** The plainest true headline there is: the period's own total. Never an interpretation. */
export function plainHeadline(metrics: MetricSet): string {
  const tracked = metrics['time.tracked_minutes'];
  return tracked ? `${tracked.label}: ${tracked.display}.` : 'Nothing could be stated about this period with enough evidence.';
}

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z“"'(])/;

// ── Validation ──────────────────────────────────────────────────────────────

export function validateReflectionOutput(raw: unknown, ctx: ReflectionValidationContext): ReflectionValidation {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ReflectionIssue[] = parsed.error.issues.slice(0, 10).map((i) => ({
      code: 'schema',
      field: 'response',
      index: null,
      values: [i.path.join('.') || '(root)'],
      message: `schema: ${i.path.join('.') || '(root)'} — ${i.message}`,
      resolution: 'fatal',
    }));
    return { ok: false, errors: issues.map((i) => i.message), issues, salvaged: null, remainder: null };
  }
  const output = parsed.data;
  /** Problems that make the whole response unusable. */
  const fatal: ReflectionIssue[] = [];
  /** Problems confined to one insight (it is removed) or to the carry-forward. */
  const removed: ReflectionIssue[] = [];
  /** What was put right without changing any claim. */
  const repairs: ReflectionIssue[] = [];

  // Period: must be exactly the one requested.
  if (
    output.periodType !== ctx.period.type ||
    Date.parse(output.periodStart) !== Date.parse(ctx.period.start) ||
    Date.parse(output.periodEnd) !== Date.parse(ctx.period.end)
  ) {
    fatal.push({
      code: 'period',
      field: 'response',
      index: null,
      values: [],
      message: `period: expected ${ctx.period.type} ${ctx.period.start} → ${ctx.period.end}, got ${output.periodType} ${output.periodStart} → ${output.periodEnd}`,
      resolution: 'fatal',
    });
  }

  const priorityIds = new Set(ctx.priorities.map((p) => p.id));
  const { globalNumbers, resolve, allowedFor, toEvidence } = createEvidenceToolkit(ctx);

  // ── Insights ──
  const valid: (ValidatedInsight & { allowed: Set<string>; keySet: Set<string> })[] = [];
  output.insights.forEach((draft, index) => {
    const label = `insight ${index + 1}`;
    const problems: ReflectionIssue[] = [];
    const problem = (code: ReflectionIssueCode, message: string, values: string[] = []) =>
      problems.push({ code, field: 'insight', index, values, message: `${label}: ${message}`, resolution: 'removed' });

    if (!(REFLECTION_INSIGHT_TYPES as readonly string[]).includes(draft.type)) {
      problem('insight_type', `unsupported insight type "${draft.type}"`, [draft.type]);
    }
    const type = draft.type as ReflectionInsightType;

    const title = clean(draft.title, LIMITS.title);
    const observation = clean(draft.observation, LIMITS.observation);
    const interpretation = clean(draft.interpretation, LIMITS.interpretation);
    const relevance = draft.relevance ? clean(draft.relevance, LIMITS.relevance) || null : null;

    if (title.length < 4) problem('insight_empty', 'title is empty');
    if (observation.length < 15) problem('insight_empty', 'observation is empty or meaningless');
    if (interpretation.length < 10) problem('insight_empty', 'interpretation is empty or meaningless');

    const unknown: string[] = [];
    const resolved = resolve(draft.metricKeys, draft.activityRefs, label, unknown);
    for (const message of unknown) problems.push({ code: 'insight_unknown_evidence', field: 'insight', index, values: [], message, resolution: 'removed' });
    const activities = resolved.activities;
    const citedPriorities = [...new Set(draft.priorityIds)];
    for (const id of citedPriorities) {
      if (!priorityIds.has(id)) problem('insight_unknown_evidence', `priority "${id}" does not exist`, [id]);
    }
    if (resolved.metrics.length === 0 && activities.length === 0) {
      problem('insight_no_evidence', 'cites no evidence — every insight must cite at least one metric or activity');
    }

    const claim = `${title} ${observation} ${interpretation}`;
    const everything = `${claim} ${relevance ?? ''}`;
    const needsComparison = type === 'change_over_time' || type === 'unexpected';
    const comparative = COMPARATIVE_PATTERN.test(`${observation} ${interpretation}`);

    /** What the cited evidence fails to carry: a comparison that is stated, and numbers that are quoted. */
    const gaps = (metrics: Metric[]) => {
      const hasComparison = metrics.some((m) => isComparisonKey(m.key));
      return {
        hasComparison,
        typeNeedsComparison: needsComparison && !hasComparison,
        uncitedComparison: comparative && !hasComparison,
        numbers: unsupportedNumbers(everything, allowedFor(metrics, activities)),
      };
    };
    const open = (g: ReturnType<typeof gaps>) => g.typeNeedsComparison || g.uncitedComparison || g.numbers.length > 0;

    // A COMPARISONS row is listed under one key, and a subject's measurements sit side by side. A claim that
    // quotes the row's "previous" or "change", or a sibling value of the subject it cites, IS supported by what
    // Reflect supplied — only the citation is incomplete. It is completed when, and only when, that settles
    // every gap; nothing is added to evidence that does not hold the number or the comparison the text states.
    let metrics = resolved.metrics;
    let gap = gaps(metrics);
    if (open(gap) && metrics.length > 0) {
      const cited = new Set(metrics.map((m) => m.key));
      const added: Metric[] = [];
      const candidates = [...metrics.flatMap((m) => comparisonRow(m.key, ctx.metrics)), ...metrics.flatMap((m) => siblingMetrics(m.key, ctx.metrics))];
      let missing = new Set(gap.numbers);
      for (const candidate of candidates) {
        if (missing.size === 0) break;
        if (cited.has(candidate.key)) continue;
        const numbers = numbersOfMetric(candidate);
        if (![...missing].some((n) => numbers.has(n))) continue;
        cited.add(candidate.key);
        added.push(candidate);
        missing = new Set(gaps([...metrics, ...added]).numbers);
      }
      // A comparison is only ever completed through a value the text quotes from the row ("22m longer", "up
      // from 36m"). Wording alone ("more than last week") names no entry, so it is left as it was: uncited.
      const completed = [...metrics, ...added];
      if (added.length > 0 && !open(gaps(completed))) {
        metrics = completed;
        gap = gaps(metrics);
        repairs.push({
          code: 'insight_citation',
          field: 'insight',
          index,
          values: added.map((m) => m.key),
          message: `${label}: citation completed with ${added.map((m) => m.key).join(', ')} — the entries that hold what it states`,
          resolution: 'repaired',
        });
      }
    }

    if (gap.typeNeedsComparison) {
      problem('insight_needs_comparison', `a ${type} insight must cite a comparison (prev.*, delta.*, baseline.*, weekday.* or change.*)`);
    }
    // A project that happens to serve a priority is not, by itself, evidence about the priority.
    if (type === 'priority_alignment' && !metrics.some((m) => m.priorityId && !/(^|\.)thread\./.test(m.key)) && citedPriorities.length === 0) {
      problem('insight_needs_priority_metric', 'a priority_alignment insight must cite a priority metric');
    }
    // One day cannot show a habit. Such a claim needs evidence from other days.
    if (ctx.period.type === 'day' && MULTI_DAY_TYPES.includes(type) && !metrics.some((m) => MULTI_DAY_KEY.test(m.key))) {
      problem('insight_needs_other_days', `a ${type} insight about a single day must cite evidence from other days (recent.*, weekday.*, baseline.*, trajectory.* or carry.*)`);
    }

    const judgment = findPattern(everything, JUDGMENT_PATTERNS);
    if (judgment) problem('insight_language', `contains ${judgment}; describe, do not judge`, [judgment]);
    const psychology = findPattern(everything, PSYCHOLOGY_PATTERNS);
    if (psychology) problem('insight_language', `contains ${psychology}; Reflect has no evidence for it`, [psychology]);
    const causal = findPattern(claim, CAUSAL_PATTERNS);
    if (causal) problem('insight_language', `uses causal language (${causal}); describe what coincided, not what caused what`, [causal]);
    if (gap.uncitedComparison) problem('insight_uncited_comparison', 'states a comparison without citing a comparison metric');

    const allowed = allowedFor(metrics, activities);
    if (gap.numbers.length > 0) {
      problem('insight_number', `number(s) ${gap.numbers.map((n) => `"${n}"`).join(', ')} not found in its cited evidence`, gap.numbers);
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
      problem('insight_disputed', 'you marked this same claim "not accurate" and the evidence behind it has not changed — leave it out');
    }
    // What must not simply be said again: a standing pattern, work that is
    // lagging, and the general "your time went across your priorities" — new
    // progress on one body of work is still news and may recur.
    const repeatsItself = continuity.state === 'continuing' && continuity.timesBefore >= REPEAT_THRESHOLD;
    if (repeatsItself && (PATTERN_INSIGHT_TYPES.includes(type) || pattern === 'lagging' || isCollectiveSubject(subject.subjectKey)) && !gap.hasComparison) {
      problem(
        'insight_repeat',
        `this pattern was already surfaced in ${continuity.timesBefore} recent reports and has not changed; repeat it only with a comparison showing what changed`,
      );
    }

    if (problems.length > 0) {
      removed.push(...problems);
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
    removed.push({
      code: 'too_many_insights',
      field: 'response',
      index: null,
      values: [String(unique.length)],
      message: `too many insights: ${unique.length} returned, at most ${ctx.maxInsights} allowed — keep only the most meaningful`,
      resolution: 'removed',
    });
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

    if (problems.length > 0) {
      removed.push(...problems.map((message): ReflectionIssue => ({ code: 'carry_forward', field: 'carryForward', index: null, values: [], message, resolution: 'removed' })));
    } else {
      carryForward = {
        text,
        subjectKey: insightSubject(metrics, activities, []).subjectKey,
        sourceMetricKeys: metrics.map((m) => m.key),
        sourceActivityIds: activities.map((a) => a.id),
        evidence: toEvidence(metrics, activities, []),
      };
    }
  }

  // ── What the headline and the narrative may quote ──
  // The period's plain totals are measurements in their own right: stating one needs no insight behind it.
  const headlineNumbers = new Set(globalNumbers);
  for (const key of NARRATIVE_METRIC_KEYS) {
    const metric = ctx.metrics[key];
    if (metric) for (const n of numbersOfMetric(metric)) headlineNumbers.add(n);
  }
  for (const insight of selected) for (const n of insight.allowed) headlineNumbers.add(n);

  // ── Headline ──
  // A headline is one sentence ABOUT the insights. When it cannot be kept as written — empty, worded as a
  // judgment or a cause, or quoting a number nothing behind it holds — it is replaced by the title of the
  // strongest validated insight, or by the period's plain total. The claim it made is never kept.
  let headline = clean(output.headline, LIMITS.headline);
  const headlineLanguage =
    findPattern(headline, JUDGMENT_PATTERNS) ?? findPattern(headline, PSYCHOLOGY_PATTERNS) ?? findPattern(headline, CAUSAL_PATTERNS);
  const badHeadline = unsupportedNumbers(headline, headlineNumbers);
  const headlineProblem: { code: ReflectionIssueCode; message: string; values: string[] } | null =
    headline.length < 8
      ? { code: 'headline_empty', message: 'headline: empty or meaningless', values: [] }
      : headlineLanguage
        ? { code: 'headline_language', message: `headline: contains ${headlineLanguage}`, values: [headlineLanguage] }
        : badHeadline.length > 0
          ? { code: 'headline_number', message: `headline: number(s) ${badHeadline.map((n) => `"${n}"`).join(', ')} not found in the insights' evidence`, values: badHeadline }
          : null;
  if (headlineProblem) {
    repairs.push({ ...headlineProblem, field: 'headline', index: null, resolution: 'repaired' });
    headline = selected.length > 0 ? selected[0].title : plainHeadline(ctx.metrics);
  }

  // ── Narrative: "what happened", in order ──
  // It tells the period's story, so besides the totals and what the insights cite it may quote the activities
  // themselves (when one started, how long it ran). A sentence that states anything else, or that judges or
  // explains, is left out; the sentences around it stand on their own evidence.
  let narrative = output.narrative ? clean(output.narrative, LIMITS.narrative) || null : null;
  if (narrative) {
    const narrativeNumbers = new Set(headlineNumbers);
    narrativeNumbers.add(String(ctx.activityByRef.size));
    for (const activity of ctx.activityByRef.values()) for (const n of numbersOfActivity(activity)) narrativeNumbers.add(n);
    const kept: string[] = [];
    const badNumbers = new Set<string>();
    const badWording = new Set<string>();
    for (const sentence of narrative.split(SENTENCE_BREAK)) {
      const issue =
        findPattern(sentence, JUDGMENT_PATTERNS) ?? findPattern(sentence, PSYCHOLOGY_PATTERNS) ?? findPattern(sentence, CAUSAL_PATTERNS);
      const bad = unsupportedNumbers(sentence, narrativeNumbers);
      if (issue) badWording.add(issue);
      else if (bad.length > 0) for (const n of bad) badNumbers.add(n);
      else kept.push(sentence);
    }
    if (badWording.size > 0) {
      repairs.push({ code: 'narrative_language', field: 'narrative', index: null, values: [...badWording], message: `narrative: contains ${[...badWording].join(', ')}`, resolution: 'repaired' });
    }
    if (badNumbers.size > 0) {
      repairs.push({
        code: 'narrative_number',
        field: 'narrative',
        index: null,
        values: [...badNumbers],
        message: `narrative: number(s) ${[...badNumbers].map((n) => `"${n}"`).join(', ')} not found in the period's evidence`,
        resolution: 'repaired',
      });
    }
    narrative = kept.join(' ');
    if (narrative.length < 20) narrative = null;
  }

  const reflection: ValidatedReflection = {
    headline,
    narrative,
    insights: selected.map((full) => {
      const { allowed: _allowed, keySet: _keySet, ...insight } = full;
      return insight;
    }),
    carryForward,
  };

  if (fatal.length === 0 && removed.length === 0) return repairs.length > 0 ? { ok: true, reflection, repairs } : { ok: true, reflection };

  // Salvage keeps only what fully validated. It is not offered when the
  // response is unusable as a whole, or when every proposed insight fell —
  // then `remainder` still holds the headline and narrative that validated.
  const usable = fatal.length === 0;
  const salvageable = usable && (reflection.insights.length > 0 || output.insights.length === 0);
  return {
    ok: false,
    errors: [...fatal, ...removed].map((i) => i.message),
    issues: [...fatal, ...removed, ...repairs],
    salvaged: salvageable ? reflection : null,
    remainder: usable ? reflection : null,
  };
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
