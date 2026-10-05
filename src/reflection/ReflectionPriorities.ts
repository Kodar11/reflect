import type { PriorityEvent, ReflectionPriority } from './ReflectionModels.js';
import { formatDay } from './ReflectionPeriods.js';

/**
 * Priority normalization. Pure.
 *
 * Onboarding stores priorities as free-form text and keeps doing so. This
 * module turns that text into a time-aware model: each row is one interval
 * during which the user said something mattered. Reflection only ever
 * compares behaviour against priorities that applied AT THE TIME, so a
 * priority stated months ago is never silently assumed to still be current.
 *
 * A priority keeps ONE id for its whole life. Pausing, completing, renaming,
 * dropping and taking it up again are events on that id; the stretches during
 * which it applied are its intervals. The current row says what it is now,
 * the events say what it was — neither replaces the other.
 */

/** Identity of a stated priority: case/spacing/punctuation-insensitive. */
export function priorityKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface PrioritySyncPlan {
  insert: { text: string; normalizedKey: string; activeFrom: string; lastConfirmedAt: string }[];
  /** A dropped priority stated again: the same id, a new interval from now. */
  reactivate: { id: string; text: string }[];
  /** A reworded priority: the same id, the same interval, new wording. */
  rename: { id: string; text: string; normalizedKey: string; previousText: string }[];
  /** Rows no longer stated in the profile. */
  archiveIds: string[];
  /** Rows still stated: their `lastConfirmedAt` moves forward. */
  confirmIds: string[];
  confirmedAt: string;
}

export interface PrioritySyncOptions {
  nowIso: string;
  /** When the profile carrying these priorities was last saved. */
  confirmedAt: string;
  /** Used as `activeFrom` on the very first sync, when Reflect cannot know
   * when each priority was added — typically the profile's creation time. */
  initialActiveFrom: string;
}

/**
 * Reconcile the stored priority intervals with what the profile states now.
 *
 * - newly stated text                           → a new priority
 * - a dropped priority stated again             → the same id, a NEW interval
 * - one wording replaced by a similar one       → renamed in place
 * - still stated                                → reconfirmed
 * - no longer stated                            → interval is archived
 * A priority the user paused or completed stays that way while it remains in
 * the profile; only the user reactivates it.
 */
export function planPrioritySync(
  existing: ReflectionPriority[],
  stated: string[],
  options: PrioritySyncOptions,
): PrioritySyncPlan {
  const latestByKey = new Map<string, ReflectionPriority>();
  for (const p of existing) {
    const current = latestByKey.get(p.normalizedKey);
    if (!current || p.activeFrom > current.activeFrom) latestByKey.set(p.normalizedKey, p);
  }

  const plan: PrioritySyncPlan = { insert: [], reactivate: [], rename: [], archiveIds: [], confirmIds: [], confirmedAt: options.confirmedAt };
  const statedKeys = new Set<string>();
  const firstSync = existing.length === 0;

  for (const text of stated) {
    const key = priorityKey(text);
    if (!key || statedKeys.has(key)) continue;
    statedKeys.add(key);
    const latest = latestByKey.get(key);
    if (latest?.status === 'archived') {
      plan.reactivate.push({ id: latest.id, text: text.trim() });
    } else if (!latest) {
      plan.insert.push({
        text: text.trim(),
        normalizedKey: key,
        activeFrom: firstSync ? options.initialActiveFrom : options.nowIso,
        lastConfirmedAt: options.confirmedAt,
      });
    } else if (latest.lastConfirmedAt < options.confirmedAt) {
      plan.confirmIds.push(latest.id);
    }
  }

  for (const p of existing) {
    if (p.status !== 'archived' && !statedKeys.has(p.normalizedKey)) plan.archiveIds.push(p.id);
  }

  // One wording went away and one similar wording arrived: the same priority,
  // reworded. Anything less clear-cut stays "one dropped, one new".
  if (!firstSync && plan.insert.length === 1 && plan.archiveIds.length === 1) {
    const gone = existing.find((p) => p.id === plan.archiveIds[0])!;
    const arrived = plan.insert[0];
    if (isRewording(gone.text, arrived.text)) {
      plan.rename.push({ id: gone.id, text: arrived.text, normalizedKey: arrived.normalizedKey, previousText: gone.text });
      plan.insert = [];
      plan.archiveIds = [];
    }
  }
  return plan;
}

export function isSyncPlanEmpty(plan: PrioritySyncPlan): boolean {
  return (
    plan.insert.length === 0 &&
    plan.archiveIds.length === 0 &&
    plan.confirmIds.length === 0 &&
    plan.reactivate.length === 0 &&
    plan.rename.length === 0
  );
}

/** The stretches during which the priority applied, oldest first. */
export function priorityIntervals(priority: ReflectionPriority): { from: string; until: string | null }[] {
  return priority.intervals && priority.intervals.length > 0
    ? priority.intervals
    : [{ from: priority.activeFrom, until: priority.activeUntil }];
}

/**
 * Intervals from the event log: 'stated' / 'reactivated' open a stretch,
 * 'paused' / 'completed' / 'archived' close it. A rename changes nothing.
 */
export function intervalsFromEvents(events: Pick<PriorityEvent, 'at' | 'type'>[]): { from: string; until: string | null }[] {
  const out: { from: string; until: string | null }[] = [];
  let open: { from: string; until: string | null } | null = null;
  for (const e of [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (e.type === 'stated' || e.type === 'reactivated') {
      if (!open) {
        open = { from: e.at, until: null };
        out.push(open);
      }
    } else if (e.type !== 'renamed' && open) {
      open.until = e.at;
      open = null;
    }
  }
  return out.filter((i) => i.until === null || i.until > i.from);
}

/** Whether the priority applied at the instant `iso`. */
export function priorityActiveAt(priority: ReflectionPriority, iso: string): boolean {
  const t = Date.parse(iso);
  return priorityIntervals(priority).some((i) => t >= Date.parse(i.from) && (i.until === null || t < Date.parse(i.until)));
}

/**
 * What the priority was at `iso`: applying, or why it was not. 'unstated'
 * means it had not been stated yet.
 */
export function priorityStateAt(priority: ReflectionPriority, iso: string): 'active' | 'paused' | 'completed' | 'archived' | 'unstated' {
  if (priorityActiveAt(priority, iso)) return 'active';
  const before = (priority.history ?? []).filter((e) => e.at <= iso && e.type !== 'renamed' && e.type !== 'stated' && e.type !== 'reactivated');
  const last = before[before.length - 1];
  if (last) return last.type as 'paused' | 'completed' | 'archived';
  if (Date.parse(iso) < Date.parse(priority.activeFrom)) return 'unstated';
  return priority.status === 'active' ? 'unstated' : priority.status;
}

/** Priorities that applied at any point in [start, end), oldest first. */
export function prioritiesActiveDuring(
  priorities: ReflectionPriority[],
  startIso: string,
  endIso: string,
): ReflectionPriority[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return priorities
    .filter((p) =>
      priorityIntervals(p).some((i) => {
        const from = Date.parse(i.from);
        const until = i.until === null ? Infinity : Date.parse(i.until);
        return from < end && until > start && until > from;
      }),
    )
    .sort((a, b) => (a.activeFrom < b.activeFrom ? -1 : a.activeFrom > b.activeFrom ? 1 : a.id < b.id ? -1 : 1));
}

/** An active priority nobody has reconfirmed for a long time. */
export function isPossiblyStale(priority: ReflectionPriority, nowIso: string, staleAfterDays: number): boolean {
  if (priority.status !== 'active') return false;
  return Date.parse(nowIso) - Date.parse(priority.lastConfirmedAt) > staleAfterDays * 86_400_000;
}

// ── Keyword matching (deterministic fallback for priority linking) ──────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'to', 'of', 'for', 'in', 'on', 'and', 'or', 'with', 'at', 'by', 'from', 'into',
  'this', 'that', 'new', 'more', 'some', 'up', 'out', 'be', 'is', 'get', 'getting', 'keep', 'it', 'its', 'as',
]);

/** Verbs and generic nouns that say nothing about WHICH work is meant. */
const GENERIC = new Set([
  'launch', 'launching', 'finish', 'finishing', 'complete', 'completing', 'build', 'building', 'ship', 'shipping',
  'work', 'working', 'learn', 'learning', 'study', 'studying', 'improve', 'improving', 'start', 'starting', 'make',
  'making', 'do', 'doing', 'prepare', 'preparing', 'write', 'writing', 'practice', 'practicing', 'develop',
  'developing', 'create', 'creating', 'grow', 'growing', 'focus', 'release', 'releasing', 'project', 'projects',
  'app', 'course', 'courses', 'class', 'exam', 'exams', 'skill', 'skills', 'better', 'good', 'time', 'stuff',
]);

function tokenize(text: string): string[] {
  return priorityKey(text).split(' ').filter(Boolean);
}

/** Crude plural folding: `internships` → `internship`. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export interface PriorityTerms {
  /** Tokens that identify the work; ALL must appear for a match. */
  distinctive: string[];
  /** The priority minus stopwords and leading verbs, e.g. `project x`. */
  corePhrase: string;
}

export function priorityTerms(text: string): PriorityTerms {
  const core = tokenize(text).filter((t) => !STOPWORDS.has(t));
  const distinctive = [...new Set(core.filter((t) => t.length >= 3 && !GENERIC.has(t)).map(stem))];
  let first = 0;
  while (first < core.length - 1 && GENERIC.has(core[first]) && core[first] !== 'project') first++;
  return { distinctive, corePhrase: core.slice(first).join(' ') };
}

/**
 * Does `haystack` (an activity's title, summary, context, thread) plainly
 * refer to the priority? Conservative on purpose: a missed link understates a
 * priority's time, while a wrong link would invent progress.
 */
export function matchesPriorityByKeyword(priorityText: string, haystack: string): boolean {
  const terms = priorityTerms(priorityText);
  const tokens = tokenize(haystack);
  if (tokens.length === 0) return false;

  if (terms.distinctive.length > 0) {
    const present = new Set(tokens.map(stem));
    return terms.distinctive.every((t) => present.has(t));
  }
  // No distinctive word ("Project X"): require the whole phrase, in order.
  if (terms.corePhrase.split(' ').length < 2) return false;
  return ` ${tokens.join(' ')} `.includes(` ${terms.corePhrase} `);
}

const EVENT_WORDS: Record<PriorityEvent['type'], string> = {
  stated: 'you stated',
  paused: 'you paused',
  completed: 'you marked completed',
  reactivated: 'you took up again',
  renamed: 'you reworded',
  archived: 'you removed',
};

/** What happened to stated priorities, in plain words: `Fri, Oct 9 — you marked completed “Launch X”`. */
export function describePriorityEvents(events: PriorityEvent[]): string[] {
  return events.map((e) => {
    const when = formatDay(new Date(e.at));
    return e.type === 'renamed'
      ? `${when} — ${EVENT_WORDS.renamed} “${e.previousText ?? ''}” as “${e.text}”`
      : `${when} — ${EVENT_WORDS[e.type]} “${e.text}”`;
  });
}

/**
 * Is `next` a rewording of `previous` rather than a different priority?
 * Deterministic and conservative: the same core phrase, or at least half of
 * the identifying words in common.
 */
export function isRewording(previous: string, next: string): boolean {
  const a = priorityTerms(previous);
  const b = priorityTerms(next);
  if (a.corePhrase && a.corePhrase === b.corePhrase) return true;
  if (a.distinctive.length === 0 || b.distinctive.length === 0) {
    const [short, long] = a.corePhrase.length <= b.corePhrase.length ? [a.corePhrase, b.corePhrase] : [b.corePhrase, a.corePhrase];
    return short.split(' ').length >= 2 && ` ${long} `.includes(` ${short} `);
  }
  const shared = a.distinctive.filter((t) => b.distinctive.includes(t)).length;
  return shared > 0 && shared / new Set([...a.distinctive, ...b.distinctive]).size >= 0.5;
}
