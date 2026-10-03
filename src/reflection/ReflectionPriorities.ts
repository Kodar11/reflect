import type { ReflectionPriority } from './ReflectionModels.js';

/**
 * Priority normalization. Pure.
 *
 * Onboarding stores priorities as free-form text and keeps doing so. This
 * module turns that text into a time-aware model: each row is one interval
 * during which the user said something mattered. Reflection only ever
 * compares behaviour against priorities that applied AT THE TIME, so a
 * priority stated months ago is never silently assumed to still be current.
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
 * - newly stated (or previously archived) text  → a NEW interval starts
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

  const plan: PrioritySyncPlan = { insert: [], archiveIds: [], confirmIds: [], confirmedAt: options.confirmedAt };
  const statedKeys = new Set<string>();
  const firstSync = existing.length === 0;

  for (const text of stated) {
    const key = priorityKey(text);
    if (!key || statedKeys.has(key)) continue;
    statedKeys.add(key);
    const latest = latestByKey.get(key);
    if (!latest || latest.status === 'archived') {
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
  return plan;
}

export function isSyncPlanEmpty(plan: PrioritySyncPlan): boolean {
  return plan.insert.length === 0 && plan.archiveIds.length === 0 && plan.confirmIds.length === 0;
}

/** Whether the priority applied at the instant `iso`. */
export function priorityActiveAt(priority: ReflectionPriority, iso: string): boolean {
  const t = Date.parse(iso);
  if (t < Date.parse(priority.activeFrom)) return false;
  return priority.activeUntil === null || t < Date.parse(priority.activeUntil);
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
    .filter((p) => {
      const from = Date.parse(p.activeFrom);
      const until = p.activeUntil === null ? Infinity : Date.parse(p.activeUntil);
      return from < end && until > start && until > from;
    })
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
