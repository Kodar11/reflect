/**
 * A small, deterministic text toolkit for criteria that have to compare
 * MEANING without comparing wording and without a second model.
 *
 * It is deliberately modest: text is reduced to a set of concepts (a light
 * stem, plus a short list of domain synonyms such as client ≈ freelance), and
 * an expected statement is "covered" to the extent its concepts appear in what
 * Reflect wrote. That recognises "an urgent client issue consumed time that
 * was available for product development" as the same idea as "client work
 * displaced planned product work" — and it will also be wrong sometimes. Every
 * verdict produced this way is marked `method: 'lexical'`, `confidence: 'low'`,
 * and the review packet shows expected and actual side by side.
 */

export type Verdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_APPLICABLE';

export interface Criterion {
  id: string;
  label: string;
  verdict: Verdict;
  /** structural: computed from ids, numbers and stored structure. lexical: heuristic concept match on free text. */
  method: 'structural' | 'lexical';
  /** How far the verdict can be trusted without a human look. */
  confidence: 'high' | 'low';
  detail: string;
  /** What the answer key expected, when the criterion comes from it. */
  expected?: string;
  /** 0..1 where a score exists (concept coverage, concordance…). */
  score?: number;
  /** Sentences / ids the verdict rests on. */
  evidence?: string[];
}

const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does doing for from had has have having he her his i if in into is it its ' +
    'just may might more most much must my no nor not of on once only or other our out over own same she should so some such than that the ' +
    'their them then there these they this those through to too under until up very was we were what when where which while who whom why ' +
    'will with would you your yours about above after again against all also am any because before below between both during each few ' +
    'further here how itself off still rather across one two day today user users observed captured available evidence activity activities ' +
    'event events desktop time period periods thing things something way made make makes making use used using get got going ' +
    'work works worked working'
  ).split(' '),
);

/** Domain synonyms: every word in a group counts as the same concept. */
const CONCEPT_GROUPS: Record<string, string[]> = {
  product: ['saas', 'product', 'mvp', 'app', 'startup'],
  client: ['client', 'clients', 'freelance', 'freelancing', 'customer', 'contract', 'engagement'],
  lead: ['lead', 'leads', 'prospect', 'prospective', 'outreach', 'proposal', 'pipeline', 'linkedin', 'inquiry', 'acquisition', 'opportunity'],
  fragment: ['fragment', 'fragmented', 'fragmentation', 'switch', 'switches', 'switching', 'scattered', 'pieces', 'broke', 'broken', 'interleaved', 'short'],
  displace: ['displace', 'displaced', 'interrupt', 'interrupted', 'interruption', 'consumed', 'crowded', 'diverted', 'deferred', 'instead', 'postponed', 'delayed', 'unexpected', 'unplanned', 'urgent'],
  progress: ['progress', 'progressed', 'advance', 'advanced', 'forward', 'moved', 'shipped', 'momentum', 'headway'],
  build: ['implement', 'implemented', 'implementation', 'build', 'built', 'coding', 'development', 'developed', 'create', 'created', 'engineering', 'feature'],
  finish: ['complete', 'completed', 'finish', 'finished', 'close', 'closed', 'closure', 'handoff', 'delivered', 'delivery', 'done', 'resolved', 'wrap'],
  learn: ['learn', 'learning', 'tutorial', 'study', 'studied', 'course', 'reading'],
  research: ['research', 'researched', 'investigate', 'investigated', 'investigation', 'explore', 'explored'],
  plan: ['plan', 'planning', 'planned', 'roadmap', 'schedule', 'scheduled', 'prepare', 'preparation', 'checklist'],
  offline: ['offline', 'unobserved', 'untracked', 'away', 'gap', 'gaps', 'unobservable'],
  leisure: ['youtube', 'video', 'videos', 'entertainment', 'leisure', 'break', 'breaks'],
  talk: ['communication', 'communicate', 'email', 'emails', 'message', 'messages', 'slack', 'call', 'meeting', 'reply', 'replied', 'followup', 'follow'],
  focus: ['focus', 'focused', 'uninterrupted', 'sustained', 'block', 'deep', 'concentrated', 'protect', 'protected'],
  test: ['test', 'tested', 'testing', 'verify', 'verified', 'verification', 'check', 'checked', 'staging', 'retest'],
  feedback: ['feedback', 'tester', 'testers', 'beta', 'rollout', 'release'],
  measure: ['analytics', 'metrics', 'activation', 'usage', 'measure', 'measured', 'experiment'],
  bug: ['bug', 'issue', 'fix', 'fixed', 'problem', 'debug', 'debugging', 'error'],
  launch: ['launch', 'launched', 'launching'],
  unknown: ['cannot', 'unknown', 'unclear', 'uncertain', 'inferred', 'infer', 'establish', 'prove', 'proof', 'confirm', 'confirmed', 'visible'],
  evening: ['evening', 'night', 'late'],
  morning: ['morning', 'early'],
  afternoon: ['afternoon', 'midday'],
};

/** A very light stemmer: enough to make plan/planning/planned one token. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  for (const [suffix, replacement] of [
    ['ations', ''],
    ['ation', ''],
    ['ings', ''],
    ['ing', ''],
    ['edly', ''],
    ['ies', 'y'],
    ['ied', 'y'],
    ['ed', ''],
    ['es', ''],
    ['ly', ''],
    ['s', ''],
  ] as const) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length) + replacement;
      break;
    }
  }
  // "planning" → "plann" → "plan"
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !'aeiouls'.includes(w[w.length - 1])) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

const CONCEPT_OF = new Map<string, string>();
for (const [concept, words] of Object.entries(CONCEPT_GROUPS)) {
  for (const word of words) CONCEPT_OF.set(stem(word), concept);
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-');
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function words(text: string): string[] {
  return normalizeText(text).match(/[a-z][a-z0-9'-]*/g) ?? [];
}

/** The concepts a text mentions: a synonym-group id where one applies, else `w:<stem>`. */
export function conceptsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of words(text)) {
    const word = raw.replace(/^'+|'+$/g, '').replace(/'s$/, '');
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (STOPWORDS.has(stemmed)) continue;
    out.add(CONCEPT_OF.get(stemmed) ?? `w:${stemmed}`);
  }
  return out;
}

export interface Coverage {
  /** Share of the expected statement's concepts found in the actual text. */
  score: number;
  matched: string[];
  missing: string[];
}

const label = (concept: string) => (concept.startsWith('w:') ? concept.slice(2) : concept);

/** How much of `expected` is present in `actual` (a concept set, or text). */
export function coverage(expected: string, actual: Set<string> | string): Coverage {
  const want = conceptsOf(expected);
  const have = typeof actual === 'string' ? conceptsOf(actual) : actual;
  if (want.size === 0) return { score: 0, matched: [], missing: [] };
  const matched: string[] = [];
  const missing: string[] = [];
  for (const concept of want) (have.has(concept) ? matched : missing).push(label(concept));
  return { score: matched.length / want.size, matched, missing };
}

export function verdictFromCoverage(score: number, thresholds: { passCoverage: number; partialCoverage: number }): Verdict {
  return score >= thresholds.passCoverage ? 'PASS' : score >= thresholds.partialCoverage ? 'PARTIAL' : 'FAIL';
}

/** The sentence of `text` that best covers `expected`, for the review packet. */
export function bestSentence(expected: string, text: string): { sentence: string; score: number } | null {
  let best: { sentence: string; score: number } | null = null;
  for (const sentence of splitSentences(text)) {
    const score = coverage(expected, sentence).score;
    if (!best || score > best.score) best = { sentence, score };
  }
  return best && best.score > 0 ? best : null;
}

// ── Lexicons ────────────────────────────────────────────────────────────────

/** Wording that marks a statement as uncertain, negated or deliberately not concluded. */
export const HEDGE =
  /\b(may|might|could|cannot|can't|can not|unclear|uncertain|unknown|not sure|unsure|whether|possibly|perhaps|appears?|seems?|suggests?|not (yet |been )?(known|clear|established|observed|visible|confirmed|tracked|recorded|shown)|no (evidence|way|record|sign)|does(n't| not) (show|establish|prove|say|tell|mean|confirm)|do(n't| not) (show|establish|prove|know|mean))\b/i;

/** Claims about the user's inner state. Reflect has no evidence for any of them. */
export const PSYCHOLOGY =
  /\b(stress(ed|ful)?|anxi(ous|ety)|motivat(ed|ion)|unmotivated|demotivat\w*|procrastinat\w*|lazy|laziness|burn(ed|t)?[- ]?out|burnout|overwhelm\w*|tired(ness)?|exhaust\w*|frustrat\w*|bored(om)?|avoidance|putting (it|this|that|them) off|mood|emotional(ly)?|fatigue\w*|willpower|self[- ]discipline|guilt\w*|demoraliz\w*|low energy|energy (dip|level|slump)|mental (state|health)|depress\w*|discourag\w*|lack(ed|ing)? (of )?(focus|discipline|motivation|commitment))\b/i;

/** Unambiguous value judgments. */
export const STRONG_JUDGMENT =
  /\b(wast(e|ed|ing)|unproductive|time[- ]?sink|harm(ful|ed|s)?|derail\w*|bad habit|indulg\w*|excessive(ly)?|too much|too long|lost (time|productivity|hours?)|missing (work|productivity|time)|missed (work|productivity)|slack(ed|ing)|should have (been )?work\w*|failed to|problematic)\b/i;

/** Wording that leans toward "this should be reduced". Weak on its own. */
export const WEAK_JUDGMENT = /\b(distract\w*|cut (down|back)|reduc(e|ed|ing)|limit(ed|ing)?|eliminat\w*|block(ed|ing)|minimi[sz]\w*|resist\w*|temptation)\b/i;

export const LEISURE = /\b(youtube|videos?|entertainment|leisure|breaks?|netflix|gaming|games?|reddit|twitter|instagram|social media|scrolling)\b/i;

export const OFFLINE = /\b(offline|away from|untracked|unobserved|not tracked|gaps?|no (tracked )?activity|idle|inactive|absent|lunch|dinner|stepped away)\b/i;

/** Guessing at what cannot be seen. */
export const SPECULATION = /\b(probably|presumably|must have|likely (were|was|spent)|no doubt|clearly were|obviously)\b/i;

/** Advice that would fit anyone on any day. */
export const GENERIC_ADVICE = [
  'take regular breaks',
  'take a break',
  'take breaks',
  'stay hydrated',
  'drink water',
  'enough sleep',
  'sleep earlier',
  'pomodoro',
  'wake up earlier',
  'waking earlier',
  'delete the app',
  'stay focused',
  'stay organized',
  'manage your time',
  'time management',
  'prioritize your tasks',
  'prioritise your tasks',
  'avoid distractions',
  'minimize distractions',
  'eliminate distractions',
  'work-life balance',
  'be more productive',
  'set clear goals',
  'to-do list',
  'work smarter',
  'stay motivated',
  'keep up the good work',
];

/** Sentences of `text` that match every given pattern. */
export function sentencesMatching(text: string, ...patterns: RegExp[]): string[] {
  return splitSentences(text).filter((sentence) => patterns.every((p) => p.test(sentence)));
}

// ── Work streams ────────────────────────────────────────────────────────────

const SAAS_STREAM = /\b(saas|mvp|product|beta|onboarding|dashboard|launch\w*|billing|activation|testers?|landing[- ]page|own app)\b/gi;
const FREELANCE_STREAM = /\b(clients?|freelanc\w*|leads?|prospects?|proposals?|outreach|linkedin|contract|invoice|discovery call|estimate|scope|deliverable|handoff)\b/gi;

/** Which of the dataset's two work streams a text is about, by the words it uses. */
export function streamOfText(text: string): 'Own SaaS' | 'Freelance' | null {
  const saas = (text.match(SAAS_STREAM) ?? []).length;
  const freelance = (text.match(FREELANCE_STREAM) ?? []).length;
  if (saas === 0 && freelance === 0) return null;
  if (saas === freelance) return null;
  return saas > freelance ? 'Own SaaS' : 'Freelance';
}

/** The dataset's work stream a stated priority belongs to. */
export function streamOfPriority(priorityText: string): 'Own SaaS' | 'Freelance' | null {
  return streamOfText(priorityText);
}
