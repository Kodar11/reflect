import type { CoachAction } from '../../../src/coach/CoachModels';
import { DEFAULT_COACH_CONFIG } from '../../../src/coach/CoachModels';
import type { CapturedDay } from '../runner/capture';
import type { SemanticConfig } from '../runner/config';
import type { EvaluationOnlyDay } from '../runner/dataset';
import { ACTION_TYPE_MAPPING, KNOWN_TARGETS, assessCoach, matchExpected, opportunityOf, targetMatches, type CoachAssessment } from './coachDimensions';
import { actionText, coachText, reflectionText, streamOfAction } from './corpus';
import { aimOfAction, hasStreams, type StreamContext } from './streams';
import {
  GENERIC_ADVICE,
  HEDGE,
  LEISURE,
  OFFLINE,
  PSYCHOLOGY,
  SPECULATION,
  STRONG_JUDGMENT,
  WEAK_JUDGMENT,
  conceptsOf,
  coverage,
  normalizeText,
  sentencesMatching,
  splitSentences,
  type Criterion,
  type Verdict,
} from './text';

/**
 * Coach evaluation: the thirteen questions, each answered PASS / PARTIAL /
 * FAIL / NOT_APPLICABLE. Nothing here compares wording with the answer key.
 *
 * Structure is checked structurally (how many actions, do their evidence ids
 * exist, are they tied to a priority, do they repeat something the user turned
 * down). Tone is checked with lexicons (psychological claims, judging leisure
 * or offline time, generic advice) — those verdicts are low-confidence and
 * carry the sentences they rest on.
 */

export { ACTION_TYPE_MAPPING, KNOWN_TARGETS };

export interface CoachEvaluationContext {
  semantic: SemanticConfig;
  knownBlockIds: Set<string>;
  /** Whether any earlier day produced a report. */
  hasHistory: boolean;
  /** When the previous day was captured (null on the first day). */
  previousProcessedAt?: string | null;
  /** Dataset ids of the day's YouTube / video events that the ground truth labels as work. */
  workVideoEventIds: number[];
  /** Dataset event id → the Reflect classification of the block that owns it. */
  predictedByEvent: Map<number, { area: string | null; quality: string | null; blockTitle: string }>;
  /** The persona's work streams and the day's evidence against them, when the answer key has them. */
  streams?: StreamContext;
}

export interface CoachEvaluation {
  actionCount: number;
  criteria: Criterion[];
  /** Opportunity, per-action quality, follow-through and adaptation — see `coachDimensions.ts`. */
  assessment: CoachAssessment;
}

const worst = (verdicts: Verdict[]): Verdict =>
  verdicts.includes('FAIL') ? 'FAIL' : verdicts.includes('PARTIAL') ? 'PARTIAL' : verdicts.includes('PASS') ? 'PASS' : 'NOT_APPLICABLE';

function shareVerdict(ok: number, total: number): Verdict {
  if (total === 0) return 'NOT_APPLICABLE';
  return ok === total ? 'PASS' : ok > 0 ? 'PARTIAL' : 'FAIL';
}

// ── "Things not to do" ──────────────────────────────────────────────────────

type ProhibitionFamily = 'video_misclassified' | 'leisure_judged' | 'offline_judged' | 'psychology' | 'recommendation' | 'overclaim';

function familyOf(item: string): ProhibitionFamily {
  const text = item.toLowerCase();
  if (/\b(classify|dismiss|assume|infer)\b/.test(text) && /\b(youtube|tutorial|video)\b/.test(text) && /\b(entertainment|distraction|unrelated)\b/.test(text)) return 'video_misclassified';
  if (/\b(motivation|stress|emotional|psychological|illness)\b/.test(text)) return 'psychology';
  if (/\b(offline|unobserved|gaps?|laptop usage|quieter|personal communication)\b/.test(text)) return 'offline_judged';
  if (/\b(youtube|leisure|entertainment|break)\b/.test(text)) return 'leisure_judged';
  if (/^do not (recommend|add|start|keep|make|expand|immediately|continue)\b/.test(text)) return 'recommendation';
  return 'overclaim';
}

/** The part of a prohibition that says what must not be asserted or advised. */
function forbiddenPart(item: string): string {
  return item
    .replace(/^do not (immediately )?(recommend|assume|treat|interpret|infer|claim|conclude|overstate|criticize|label|call|classify|keep|add|start|make|expand|continue|dismiss|overreact to)\b/i, '')
    .replace(/\b(merely|simply|solely|just|only) because\b.*$/i, '')
    .replace(/\bbased (only )?on\b.*$/i, '')
    .replace(/\bfrom the\b.*$/i, '')
    .trim();
}

function checkProhibition(item: string, captured: CapturedDay, ctx: CoachEvaluationContext, text: { coach: string; all: string }): { verdict: Verdict; family: ProhibitionFamily; note: string; evidence: string[] } {
  const family = familyOf(item);
  const result = (verdict: Verdict, note: string, evidence: string[] = []) => ({ verdict, family, note, evidence: evidence.slice(0, 3) });

  switch (family) {
    case 'video_misclassified': {
      if (ctx.workVideoEventIds.length === 0) return result('NOT_APPLICABLE', 'no work-related video event in the ground truth');
      const wrong = ctx.workVideoEventIds
        .map((id) => ({ id, predicted: ctx.predictedByEvent.get(id) }))
        .filter(({ predicted }) => predicted && (predicted.area === 'Leisure' || predicted.quality === 'Distracting' || predicted.quality === 'Break / Idle'));
      return wrong.length > 0
        ? result('FAIL', 'a work-related video was classified as leisure / distracting / break', wrong.map((w) => `event ${w.id} → "${w.predicted!.blockTitle}" (${w.predicted!.area ?? '—'} / ${w.predicted!.quality ?? '—'})`))
        : result('PASS', 'work-related video was not classified as leisure, distracting or a break');
    }
    case 'psychology': {
      const hits = sentencesMatching(text.all, PSYCHOLOGY);
      const firm = hits.filter((s) => !HEDGE.test(s));
      return firm.length > 0 ? result('FAIL', 'a claim about inner state', firm) : hits.length > 0 ? result('PARTIAL', 'inner state is mentioned, hedged', hits) : result('PASS', 'no claim about inner state');
    }
    case 'offline_judged': {
      const strong = sentencesMatching(text.all, OFFLINE, STRONG_JUDGMENT);
      const weak = [...sentencesMatching(text.all, OFFLINE, SPECULATION), ...sentencesMatching(text.coach, OFFLINE, WEAK_JUDGMENT)];
      return strong.length > 0 ? result('FAIL', 'offline / low-usage time is judged', strong) : weak.length > 0 ? result('PARTIAL', 'offline time is speculated about or treated as something to reduce', weak) : result('PASS', 'offline time is not judged');
    }
    case 'leisure_judged': {
      const strong = sentencesMatching(text.all, LEISURE, STRONG_JUDGMENT);
      const weak = sentencesMatching(text.all, LEISURE, WEAK_JUDGMENT);
      return strong.length > 0 ? result('FAIL', 'leisure / a break is judged', strong) : weak.length > 0 ? result('PARTIAL', 'leisure / a break is framed as something to reduce', weak) : result('PASS', 'leisure is not judged');
    }
    case 'recommendation': {
      const forbidden = forbiddenPart(item);
      const scored = captured.coach.actions.map((a) => ({ action: a, score: coverage(forbidden, actionText(a)).score }));
      const dropsTarget = /\b(drop|dropping|abandon)\b/i.test(item) && captured.coach.actions.some((a) => a.actionType === 'drop');
      const best = scored.sort((a, b) => b.score - a.score)[0];
      if (dropsTarget) return result('FAIL', 'an action of type "drop" was recommended', captured.coach.actions.filter((a) => a.actionType === 'drop').map((a) => a.title));
      if (best && best.score >= ctx.semantic.passCoverage) return result('FAIL', `an action covers ${(best.score * 100).toFixed(0)}% of the prohibited recommendation`, [best.action.title]);
      if (best && best.score >= ctx.semantic.partialCoverage) return result('PARTIAL', `an action partly resembles the prohibited recommendation (${(best.score * 100).toFixed(0)}%)`, [best.action.title]);
      return result('PASS', 'no action resembles the prohibited recommendation');
    }
    case 'overclaim': {
      const forbidden = forbiddenPart(item);
      const close = splitSentences(text.all)
        .map((s) => ({ sentence: s, score: coverage(forbidden, s).score }))
        .filter((s) => s.score >= ctx.semantic.passCoverage);
      const firm = close.filter((s) => !HEDGE.test(s.sentence));
      if (firm.length > 0) return result('PARTIAL', 'a confident sentence is close to the prohibited conclusion — needs a human look', firm.map((s) => s.sentence));
      return result('PASS', close.length > 0 ? 'the topic is mentioned only with hedging' : 'the prohibited conclusion is not stated');
    }
  }
}

export function evaluateCoach(captured: CapturedDay, answer: EvaluationOnlyDay, ctx: CoachEvaluationContext): CoachEvaluation {
  const report = captured.reflection.report;
  const actions = captured.coach.actions;
  const block = report?.coach ?? null;
  const expected = answer.expectedCoachOutcome;
  const coach = coachText(captured);
  const all = `${reflectionText(report)}\n${coach}`;
  const metricKeys = new Set(Object.keys(report?.metricsSnapshot ?? {}));
  const criteria: Criterion[] = [];
  const opportunity = opportunityOf(expected);
  const assessment = assessCoach(captured, answer, { semantic: ctx.semantic, knownBlockIds: ctx.knownBlockIds, previousProcessedAt: ctx.previousProcessedAt ?? null, streams: ctx.streams });
  /** Whether the action is about a body of work the persona has: by stream when the key has streams, else by the founder set's words. */
  const registry = hasStreams(ctx.streams) ? ctx.streams : null;
  const onAStream = (a: (typeof actions)[number]) =>
    registry ? aimOfAction(a, captured.priorities, registry).streams.some((key) => registry.streams[key].kind === 'work') : streamOfAction(a, captured.priorities) !== null;

  const labels = {
    c1: '1. Recognised the important issue',
    c2: '2. Actions are grounded in observed evidence',
    c3: "3. Actions are aligned with the user's priorities",
    c4: '4. Actions are realistically actionable',
    c5: '5. Limited to 0–2 actions',
    c6: '6. No unsupported psychological claims',
    c7: '7. Leisure is not treated as inherently bad',
    c8: '8. Offline time is not judged',
    c9: '9. No generic advice',
    c10: '10. Nothing the answer key says must not be done',
    c11: '11. Used appropriate previous history',
    c12: '12. Did not repeat rejected or ineffective advice',
    c13: '13. Did not force an action when none was called for',
  };

  // No report means no coaching was delivered. That is a miss on the one
  // thing the user needed (the issue went unrecognised); the "did it avoid…"
  // criteria have nothing to judge and are not counted either way.
  if (!report) {
    return {
      actionCount: 0,
      assessment,
      criteria: Object.entries(labels).map(([id, label]): Criterion => {
        const missed = id === 'c1' && expected.primary_action !== null;
        return {
          id: `coach_${id}`,
          label,
          verdict: missed ? 'FAIL' : 'NOT_APPLICABLE',
          method: 'structural',
          confidence: 'high',
          detail: missed ? 'no daily report was generated, so nothing was recommended' : 'no daily report was generated; there is no coaching to assess',
        };
      }),
    };
  }

  // ── 1. Recognised the important issue ──
  {
    const primary = expected.primary_action;
    if (!primary) {
      criteria.push({ id: 'coach_c1', label: labels.c1, verdict: 'NOT_APPLICABLE', method: 'structural', confidence: 'high', detail: 'the answer key expects no action' });
    } else {
      const ranked = actions.map((a) => ({ action: a, ...matchExpected(primary, a, captured.priorities) })).sort((a, b) => b.rank - a.rank);
      const best = ranked[0];
      const verdict: Verdict = !best
        ? 'FAIL'
        : best.target && best.type !== 'different'
          ? 'PASS'
          : best.target || best.type !== 'different' || best.wording >= ctx.semantic.passCoverage
            ? 'PARTIAL'
            : 'FAIL';
      const secondary = expected.secondary_action;
      const secondaryBest = secondary
        ? actions.map((a) => ({ action: a, ...matchExpected(secondary, a, captured.priorities) })).filter((m) => m.action.id !== best?.action.id).sort((a, b) => b.rank - a.rank)[0]
        : null;
      criteria.push({
        id: 'coach_c1',
        label: labels.c1,
        verdict,
        method: 'structural',
        confidence: 'low',
        expected: `${primary.action_type} → ${primary.target}: ${primary.title} (${primary.reason})`,
        ...(best ? { score: Math.min(1, best.rank / 5) } : {}),
        detail: !best
          ? `no action was recommended${block?.noActionReason ? ` ("${block.noActionReason}")` : ''}`
          : `closest action "${best.action.title}" [${best.action.actionType}]: target ${best.target ? 'matches' : 'differs'}, type ${best.type}, wording coverage ${(best.wording * 100).toFixed(0)}%` +
            (secondary ? `; secondary (${secondary.action_type} → ${secondary.target}) ${secondaryBest && secondaryBest.target ? `addressed by "${secondaryBest.action.title}"` : 'not addressed'}` : ''),
        evidence: actions.map((a) => `${a.actionType}: ${a.title}`),
      });
    }
  }

  // ── 2. Grounded in evidence ──
  {
    const problems: string[] = [];
    let grounded = 0;
    for (const action of actions) {
      const missingMetrics = action.sourceMetricKeys.filter((k) => !metricKeys.has(k));
      const missingActivities = action.sourceActivityIds.filter((id) => !ctx.knownBlockIds.has(id));
      const ok = action.evidence.length > 0 && action.rationale.trim() !== '' && missingMetrics.length === 0 && missingActivities.length === 0;
      if (ok) grounded++;
      else problems.push(`"${action.title}": ${action.evidence.length === 0 ? 'no evidence; ' : ''}${missingMetrics.length ? `unknown metrics ${missingMetrics.join(', ')}; ` : ''}${missingActivities.length ? `unknown activities ${missingActivities.join(', ')}` : ''}`);
    }
    criteria.push({
      id: 'coach_c2',
      label: labels.c2,
      verdict: shareVerdict(grounded, actions.length),
      method: 'structural',
      confidence: 'high',
      detail: actions.length === 0 ? 'no actions' : `${grounded} of ${actions.length} action(s) cite evidence that resolves to stored metrics / activities`,
      ...(problems.length ? { evidence: problems } : {}),
    });
  }

  // ── 3. Aligned with priorities ──
  {
    const aligned = actions.filter(
      (a) => a.priorityId !== null || a.targetKey?.startsWith('p:') || onAStream(a) || targetMatches(opportunity.priority, a, captured.priorities),
    );
    criteria.push({
      id: 'coach_c3',
      label: labels.c3,
      verdict: shareVerdict(aligned.length, actions.length),
      method: 'structural',
      confidence: 'low',
      detail:
        actions.length === 0
          ? 'no actions'
          : `${aligned.length} of ${actions.length} action(s) are linked to a stated priority (${actions.filter((a) => a.priorityId !== null).length} by an explicit priority id, the rest by their thread)`,
    });
  }

  // ── 4. Actionable ──
  {
    const concrete = actions.filter((a) => (a.targetStart !== null || a.daypart !== 'any' || a.focusMinutes !== null || a.focusTask !== null) && a.title.trim().split(/\s+/).length >= 4);
    criteria.push({
      id: 'coach_c4',
      label: labels.c4,
      verdict: shareVerdict(concrete.length, actions.length),
      method: 'structural',
      confidence: 'low',
      detail: actions.length === 0 ? 'no actions' : `${concrete.length} of ${actions.length} action(s) name a concrete step with a time window, daypart or Focus length`,
      evidence: actions.map((a) => `${a.title} — ${a.daypart}${a.focusMinutes ? `, ${a.focusMinutes}m focus` : ''}${a.targetStart ? `, from ${a.targetStart}` : ''}`),
    });
  }

  // ── 5. 0–2 actions ──
  criteria.push({
    id: 'coach_c5',
    label: labels.c5,
    verdict: actions.length <= DEFAULT_COACH_CONFIG.maxActionsPerDay ? 'PASS' : 'FAIL',
    method: 'structural',
    confidence: 'high',
    detail: `${actions.length} action(s)`,
  });

  // ── 6. Psychological claims ──
  {
    const hits = sentencesMatching(all, PSYCHOLOGY);
    const firm = hits.filter((s) => !HEDGE.test(s));
    criteria.push({
      id: 'coach_c6',
      label: labels.c6,
      verdict: firm.length > 0 ? 'FAIL' : hits.length > 0 ? 'PARTIAL' : 'PASS',
      method: 'lexical',
      confidence: 'low',
      detail: firm.length > 0 ? `${firm.length} sentence(s) claim something about the user's inner state` : hits.length > 0 ? 'inner state is mentioned only with hedging' : 'no wording about motivation, stress, mood or energy',
      ...(hits.length ? { evidence: hits.slice(0, 4) } : {}),
    });
  }

  // ── 7. Leisure ──
  {
    const leisureInDay = answer.groundTruth.activities.some((a) => a.context === 'Leisure');
    const strong = sentencesMatching(all, LEISURE, STRONG_JUDGMENT);
    const weak = sentencesMatching(all, LEISURE, WEAK_JUDGMENT);
    const againstLeisure = actions.filter((a) => (a.actionType === 'avoid_pattern' || a.actionType === 'drop') && LEISURE.test(actionText(a)));
    const mentioned = LEISURE.test(all);
    criteria.push({
      id: 'coach_c7',
      label: labels.c7,
      verdict: strong.length > 0 || againstLeisure.length > 0 ? 'FAIL' : weak.length > 0 ? 'PARTIAL' : !leisureInDay && !mentioned ? 'NOT_APPLICABLE' : 'PASS',
      method: 'lexical',
      confidence: 'low',
      detail:
        strong.length > 0 || againstLeisure.length > 0
          ? 'leisure is judged, or an action is aimed against it'
          : weak.length > 0
            ? 'leisure appears next to wording about reducing or distraction'
            : !leisureInDay && !mentioned
              ? 'no leisure in the day and none mentioned'
              : mentioned
                ? 'leisure is mentioned without judgment'
                : 'leisure happened and was not made an issue',
      ...(strong.length || weak.length || againstLeisure.length ? { evidence: [...strong, ...againstLeisure.map((a) => a.title), ...weak].slice(0, 4) } : {}),
    });
  }

  // ── 8. Offline time ──
  {
    const strong = sentencesMatching(all, OFFLINE, STRONG_JUDGMENT);
    const weak = [...sentencesMatching(all, OFFLINE, SPECULATION), ...sentencesMatching(coach, OFFLINE, WEAK_JUDGMENT)];
    criteria.push({
      id: 'coach_c8',
      label: labels.c8,
      verdict: strong.length > 0 ? 'FAIL' : weak.length > 0 ? 'PARTIAL' : 'PASS',
      method: 'lexical',
      confidence: 'low',
      detail: strong.length > 0 ? 'offline / untracked time is judged' : weak.length > 0 ? 'offline time is speculated about, or framed as something to reduce' : 'offline time is not judged',
      ...(strong.length || weak.length ? { evidence: [...strong, ...weak].slice(0, 4) } : {}),
    });
  }

  // ── 9. Generic advice ──
  {
    const lowered = normalizeText(coach);
    const generic = GENERIC_ADVICE.filter((phrase) => lowered.includes(phrase));
    const specific = actions.filter((a) => (a.targetKey !== null || a.thread !== null || a.priorityId !== null) && (a.sourceMetricKeys.length > 0 || a.sourceActivityIds.length > 0));
    criteria.push({
      id: 'coach_c9',
      label: labels.c9,
      verdict: generic.length > 0 ? 'FAIL' : actions.length === 0 ? 'NOT_APPLICABLE' : shareVerdict(specific.length, actions.length),
      method: 'lexical',
      confidence: 'low',
      detail:
        generic.length > 0
          ? `generic phrasing: ${generic.join(', ')}`
          : actions.length === 0
            ? 'no actions'
            : `${specific.length} of ${actions.length} action(s) name a specific thread or priority and cite the day's own evidence`,
    });
  }

  // ── 10. Things not to do ──
  {
    const checks = expected.things_not_to_do.map((item) => ({ item, ...checkProhibition(item, captured, ctx, { coach, all }) }));
    criteria.push({
      id: 'coach_c10',
      label: labels.c10,
      verdict: checks.length === 0 ? 'NOT_APPLICABLE' : worst(checks.map((c) => c.verdict)),
      method: 'lexical',
      confidence: 'low',
      detail: checks.map((c) => `[${c.verdict}] ${c.item} — ${c.note}`).join(' | '),
      evidence: checks.flatMap((c) => c.evidence),
    });
  }

  // ── 11. Previous history ──
  {
    const historyKeys = [...report.insights.flatMap((i) => i.sourceMetricKeys), ...actions.flatMap((a) => a.sourceMetricKeys)].filter((k) => /^(recent|prev|delta|baseline)\./.test(k));
    const followups = block?.followups.length ?? 0;
    const conclusions = captured.coach.memoriesAdded.filter((m) => m.source === 'coach').length;
    const worded = /\b(yesterday|previous|earlier (day|days|this week)|again|last week|recent days|so far this week|second day|third day|in a row|than usual)\b/i.test(all);
    const structuredUse = followups > 0 || historyKeys.length > 0 || conclusions > 0;
    criteria.push({
      id: 'coach_c11',
      label: labels.c11,
      verdict: !ctx.hasHistory ? 'NOT_APPLICABLE' : structuredUse ? 'PASS' : worded ? 'PARTIAL' : 'FAIL',
      method: 'structural',
      confidence: 'low',
      detail: !ctx.hasHistory
        ? 'first day: there is no history yet'
        : `${followups} follow-up(s) on earlier actions, ${new Set(historyKeys).size} history metric(s) cited, ${conclusions} memory item(s) written` +
          (!structuredUse ? (worded ? '; history is referred to in words only' : '; nothing from earlier days is used') : ''),
      ...(historyKeys.length ? { evidence: [...new Set(historyKeys)].slice(0, 8) } : {}),
    });
  }

  // ── 12. Repeating rejected / ineffective advice ──
  {
    const turnedDown = captured.coach.earlierActions.filter((a) => a.status === 'rejected' || a.outcome === 'did_not_work');
    const expired = captured.coach.earlierActions.filter((a) => a.status === 'expired');
    const same = (a: CoachAction, b: CoachAction) => a.strategyKey === b.strategyKey && a.targetKey === b.targetKey;
    const similar = (a: CoachAction, b: CoachAction) => coverage(a.title, conceptsOf(b.title)).score >= DEFAULT_COACH_CONFIG.duplicateTitleOverlap;
    const repeats = actions.filter((a) => turnedDown.some((old) => same(a, old) || similar(a, old)));
    const repeatsOfExpired = actions.filter((a) => expired.some((old) => same(a, old)));
    criteria.push({
      id: 'coach_c12',
      label: labels.c12,
      verdict: turnedDown.length === 0 ? 'NOT_APPLICABLE' : repeats.length > 0 ? 'FAIL' : 'PASS',
      method: 'structural',
      confidence: 'high',
      detail:
        turnedDown.length === 0
          ? `no earlier advice was rejected or reported as not working in this run` + (repeatsOfExpired.length ? `; ${repeatsOfExpired.length} action(s) repeat the strategy and target of a suggestion that expired undecided` : '')
          : `${turnedDown.length} earlier action(s) were turned down or did not work; ${repeats.length} of today's action(s) repeat one`,
      ...(repeats.length || repeatsOfExpired.length ? { evidence: [...repeats, ...repeatsOfExpired].map((a) => `${a.strategyKey} → ${a.targetKey ?? 'general'}: ${a.title}`) } : {}),
    });
  }

  // ── 13. Forcing an action ──
  criteria.push({
    id: 'coach_c13',
    label: labels.c13,
    verdict: opportunity.strength !== 'none' ? 'NOT_APPLICABLE' : actions.length === 0 ? 'PASS' : 'FAIL',
    method: 'structural',
    confidence: 'high',
    detail:
      opportunity.strength !== 'none'
        ? `the answer key sees a ${opportunity.strength} opportunity for an action on this day`
        : actions.length === 0
          ? `no action was recommended${block?.noActionReason ? ` ("${block.noActionReason}")` : ''}`
          : `${actions.length} action(s) were recommended although none was called for`,
  });

  return { actionCount: actions.length, criteria, assessment };
}
