import type { Event } from '../models/Event.js';
import {
  getDefaultArea,
  getDomain,
  normalizeAppName,
} from '../categorization/DefaultClassificationRules.js';
import type { Session, SessionConfig } from './Session.js';
import {
  dateMs,
  durationMs,
  shouldStartNewSession,
  type SessionRule,
} from './SessionRules.js';

/**
 * Pure, evidence-based sessionization (Sessionization V2).
 *
 *   sorted Event[] + SessionConfig + SessionRule[]  ──►  Event[][] groups
 *
 * The algorithm walks the sorted event stream once and maintains two buffers:
 *   - `committed`  — events we are sure belong to the current session.
 *   - `candidate`  — events that might be a new activity; kept uncommitted
 *     until evidence reaches a threshold.
 *
 * Hard boundaries (manual split, AFK, gap) are still evaluated through the
 * existing rule chain. Activity transitions are decided by:
 *   - default classification area (Work, Leisure, Personal, Learning)
 *   - application / domain changes
 *   - duration of the candidate activity
 *
 * Same input + same config always yields the same grouping. No React, SQLite,
 * Electron, Date.now, or Math.random.
 */

/** Group sorted events into session-bound event groups. */
export function sessionize(
  events: Event[],
  config: SessionConfig,
  rules: SessionRule[],
): Event[][] {
  if (events.length === 0) return [];

  const sessions: Event[][] = [];
  let committed: Event[] = [events[0]];
  let committedSig = new GroupSignature(committed);
  let candidate: Event[] | null = null;
  let candidateSig: GroupSignature | null = null;

  function flushCurrentSession(): void {
    const all = [...committed, ...(candidate ?? [])];
    if (all.length > 0) sessions.push(all);
    committed = [];
    committedSig = new GroupSignature([]);
    candidate = null;
    candidateSig = null;
  }

  /**
   * Promote the candidate to the current in-flight session. The previous
   * committed block is pushed first (unless it is a short leading prelude,
   * in which case it is folded into the candidate).
   */
  function promoteCandidateToCurrent(): void {
    const leadingPrelude =
      sessions.length === 0 &&
      committed.length > 0 &&
      committedSig.totalDuration < config.shortInterruptionMs;

    if (leadingPrelude) {
      committed = [...committed, ...(candidate ?? [])];
      committedSig = new GroupSignature(committed);
    } else {
      if (committed.length > 0) sessions.push([...committed]);
      committed = candidate ? [...candidate] : [];
      committedSig = new GroupSignature(committed);
    }
    candidate = null;
    candidateSig = null;
  }

  /**
   * Finalize the candidate as a completed session. The previous committed
   * block and the candidate are both pushed (short prelude folded in).
   */
  function finalizeCandidate(): void {
    const leadingPrelude =
      sessions.length === 0 &&
      committed.length > 0 &&
      committedSig.totalDuration < config.shortInterruptionMs;

    if (leadingPrelude) {
      sessions.push([...committed, ...(candidate ?? [])]);
    } else {
      if (committed.length > 0) sessions.push([...committed]);
      if (candidate && candidate.length > 0) sessions.push([...candidate]);
    }
    committed = [];
    committedSig = new GroupSignature([]);
    candidate = null;
    candidateSig = null;
  }

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];

    // Hard boundaries (manual split, AFK, gap) are evaluated against the
    // in-flight session as the rule chain expects.
    const sessionView = toSession([...committed, ...(candidate ?? [])]);
    if (
      shouldStartNewSession(
        { session: sessionView, prev, cur, config },
        rules,
      )
    ) {
      flushCurrentSession();
      committed = [cur];
      committedSig = new GroupSignature(committed);
      continue;
    }

    if (candidate === null || candidateSig === null) {
      if (eventMatchesGroup(cur, committedSig)) {
        committed.push(cur);
        committedSig.add(cur);
      } else {
        candidate = [cur];
        candidateSig = new GroupSignature(candidate);
      }
      continue;
    }

    // We are currently observing a candidate transition.
    if (eventMatchesGroup(cur, candidateSig)) {
      candidate.push(cur);
      candidateSig.add(cur);

      if (shouldCommitCandidate(candidateSig, committedSig, config)) {
        promoteCandidateToCurrent();
      }
      continue;
    }

    if (eventMatchesGroup(cur, committedSig)) {
      // User returned to the original activity.
      if (shouldCommitCandidate(candidateSig, committedSig, config)) {
        finalizeCandidate();
        committed = [cur];
        committedSig = new GroupSignature(committed);
      } else {
        // Short/weak interruption — fold it back into the main session.
        committed.push(...candidate, cur);
        committedSig.addGroup(candidateSig);
        committedSig.add(cur);
        candidate = null;
        candidateSig = null;
      }
      continue;
    }

    // A third distinct activity appeared while a candidate was pending.
    if (shouldCommitCandidate(candidateSig, committedSig, config)) {
      finalizeCandidate();
      committed = [];
      committedSig = new GroupSignature([]);
      candidate = [cur];
      candidateSig = new GroupSignature(candidate);
    } else {
      // Candidate was too weak/short; fold it back and start a new candidate.
      committed.push(...candidate);
      committedSig.addGroup(candidateSig);
      candidate = [cur];
      candidateSig = new GroupSignature(candidate);
    }
  }

  // End of stream: resolve any pending candidate.
  // We are conservative with an unfinished stream: a trailing candidate is
  // committed only when the transition is strong (area change). Weak/
  // ambiguous trailing activity is merged back so live tracking does not
  // flicker between temporary and separate sessions.
  if (candidate && candidateSig) {
    const strongAtEnd =
      transitionStrength(committedSig, candidateSig) === 'strong' &&
      candidateSig.totalDuration >= config.shortInterruptionMs;
    if (strongAtEnd) {
      finalizeCandidate();
    } else {
      committed = [...committed, ...candidate];
      committedSig = new GroupSignature(committed);
      candidate = null;
      candidateSig = null;
    }
  }

  if (committed.length > 0) {
    sessions.push([...committed]);
  }

  return sessions.filter((s) => s.length > 0);
}

/** Deterministic signature of an event group used for transition decisions. */
class GroupSignature {
  private readonly appTotals = new Map<string, number>();
  private readonly domainTotals = new Map<string, number>();
  private readonly areaTotals = new Map<string, number>();
  private readonly firstSeen = new Map<string, number>();
  totalDuration = 0;

  constructor(events: Event[]) {
    for (const e of events) this.add(e);
  }

  add(e: Event): void {
    const dur = durationMs(e);
    this.totalDuration += dur;
    this.addKey(this.appTotals, normalizeAppName(e.app), dur, e.startedAt);
    this.addKey(this.domainTotals, domainOf(e), dur, e.startedAt);
    this.addKey(this.areaTotals, getDefaultArea(e), dur, e.startedAt);
  }

  addGroup(other: GroupSignature): void {
    mergeTotals(this.appTotals, other.appTotals, this.firstSeen, other.firstSeen);
    mergeTotals(this.domainTotals, other.domainTotals, this.firstSeen, other.firstSeen);
    mergeTotals(this.areaTotals, other.areaTotals, this.firstSeen, other.firstSeen);
    this.totalDuration += other.totalDuration;
  }

  get primaryApp(): string | undefined {
    return pickPrimary(this.appTotals, this.firstSeen);
  }

  get primaryDomain(): string | undefined {
    return pickPrimary(this.domainTotals, this.firstSeen);
  }

  get primaryArea(): string | undefined {
    return pickPrimary(this.areaTotals, this.firstSeen);
  }

  private addKey(
    totals: Map<string, number>,
    key: string | null | undefined,
    dur: number,
    startedAt: string,
  ): void {
    if (!key) return;
    totals.set(key, (totals.get(key) ?? 0) + dur);
    if (!this.firstSeen.has(key)) {
      this.firstSeen.set(key, dateMs(startedAt));
    }
  }
}

function mergeTotals(
  into: Map<string, number>,
  from: Map<string, number>,
  intoFirst: Map<string, number>,
  fromFirst: Map<string, number>,
): void {
  for (const [key, dur] of from) {
    into.set(key, (into.get(key) ?? 0) + dur);
    if (!intoFirst.has(key)) {
      intoFirst.set(key, fromFirst.get(key) ?? 0);
    }
  }
}

function domainOf(e: Event): string | undefined {
  if (!e.url) return undefined;
  const d = getDomain(e.url);
  return d || undefined;
}

/** True if the event belongs to the same activity as the group. */
function eventMatchesGroup(e: Event, group: GroupSignature): boolean {
  const area = getDefaultArea(e);
  if (area && group.primaryArea && area === group.primaryArea) return true;

  const app = normalizeAppName(e.app);
  if (app && group.primaryApp && app === group.primaryApp) return true;

  const domain = domainOf(e);
  if (domain && group.primaryDomain && domain === group.primaryDomain) return true;

  return false;
}

type TransitionStrength = 'strong' | 'weak';

function transitionStrength(
  home: GroupSignature,
  candidate: GroupSignature,
): TransitionStrength {
  if (
    home.primaryArea &&
    candidate.primaryArea &&
    home.primaryArea !== candidate.primaryArea
  ) {
    return 'strong';
  }
  return 'weak';
}

/** Decide whether a candidate has accumulated enough evidence to split. */
function shouldCommitCandidate(
  candidate: GroupSignature,
  home: GroupSignature,
  config: SessionConfig,
): boolean {
  const strength = transitionStrength(home, candidate);
  if (strength === 'strong') {
    return candidate.totalDuration >= config.shortInterruptionMs;
  }
  return candidate.totalDuration >= config.candidateObservationMs;
}

/** Pick the value with the largest total duration; tie-break earliest start, then lex asc. */
function pickPrimary(
  totals: Map<string, number>,
  firstSeen: Map<string, number>,
): string | undefined {
  let best: string | undefined;
  let bestDur = -1;
  let bestStart = Infinity;

  for (const [key, dur] of totals) {
    const start = firstSeen.get(key) ?? Infinity;
    if (
      dur > bestDur ||
      (dur === bestDur && start < bestStart) ||
      (dur === bestDur && start === bestStart && (best === undefined || key < best))
    ) {
      best = key;
      bestDur = dur;
      bestStart = start;
    }
  }
  return best;
}

/** Minimal Session skeleton for the existing rule chain. */
function toSession(events: Event[]): Session {
  return {
    id: '',
    startedAt: new Date(0),
    endedAt: new Date(0),
    duration: 0,
    activeDuration: 0,
    events,
    appsUsed: [],
    browserTabs: [],
    eventCount: events.length,
  };
}
