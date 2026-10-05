import { REASON_LABELS } from '../../../src/coach/CoachEffectiveness';
import { DEFAULT_COACH_CONFIG, type CoachAction, type CoachConfig } from '../../../src/coach/CoachModels';
import { detectOpportunities, orderSignals, withRecord, type CoachOpportunity } from '../../../src/coach/CoachOpportunities';
import { buildSituations, type PrioritySituation, type SituationDay } from '../../../src/coach/CoachSituation';
import { MEANINGFUL_ACTIVITY_MINUTES, type ReflectionActivity } from '../../../src/reflection/ReflectionModels';
import { formatDay } from '../../../src/reflection/ReflectionPeriods';
import type { CapturedBlock, CapturedDay } from './capture';

/**
 * The Coach's measurement layer, replayed over a stored run. No database, no
 * Gemini.
 *
 * A run keeps, for every day, the timeline Reflect built, the metrics the
 * day's report was written from and every Coach action as it stood. That is
 * everything the deterministic half of the Coach reads — so "what did Reflect
 * itself measure on day 12, before the model was asked anything?" can be
 * answered again, exactly, from the files.
 *
 * Two uses:
 *   - diagnosis: when a day was missed, was a candidate generated at all, how
 *     clearly, and did the record already cover it?
 *   - before/after for a change to the measurement layer, on the SAME
 *     activities — free of the noise a new model run adds.
 *
 * It replays the code as it is NOW over activities that were produced THEN.
 * For a fresh run the two coincide; for an older run the difference is the
 * point.
 */

export interface ReplayedDay {
  dayNumber: number;
  date: string;
  /** False when the day has no report to take metrics from (nothing was replayed). */
  replayed: boolean;
  situations: PrioritySituation[];
  /** Every measured signal, joined with the record; candidates first. */
  signals: CoachOpportunity[];
}

const SITUATION_DAYS = 4;

function toActivity(block: CapturedBlock): ReflectionActivity {
  return {
    id: block.id,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    durationMinutes: block.activeMs / 60_000,
    title: block.title,
    summary: block.summary,
    contextId: block.classification.contextId,
    areaId: block.classification.areaId,
    intentId: block.classification.intentId,
    qualityId: block.classification.qualityId,
    source: block.kind === 'ai' ? 'ai' : 'deterministic',
    app: null,
    domain: null,
    thread: block.thread,
    priorityId: block.priorityId,
  };
}

export function replayCoachSignals(days: CapturedDay[], config: CoachConfig = DEFAULT_COACH_CONFIG): ReplayedDay[] {
  const ordered = [...days].sort((a, b) => a.dayNumber - b.dayNumber);
  const activitiesOf = new Map(ordered.map((d) => [d.dayNumber, d.timeline.map(toActivity)]));

  return ordered.map((day, index) => {
    const report = day.reflection.report;
    const metrics = report?.metricsSnapshot ?? null;
    if (!report || !metrics) return { dayNumber: day.dayNumber, date: day.date, replayed: false, situations: [], signals: [] };

    const activities = activitiesOf.get(day.dayNumber)!;
    // The priorities that applied on the day are the ones its metrics were computed for.
    const priorities = day.priorities.filter((p) => p.status === 'active');
    const earlier = ordered.slice(0, index).reverse();
    const recentDays: SituationDay[] = earlier
      .slice(0, SITUATION_DAYS)
      .map((d) => ({ dayKey: d.period.key, dayLabel: formatDay(new Date(d.period.start)), activities: activitiesOf.get(d.dayNumber)! }))
      .filter((d) => d.activities.length > 0);

    // Suggestions made by this very report did not exist when the signals were measured.
    const actions: CoachAction[] = day.coach.earlierActions;
    const added = new Set(day.coach.memoriesAdded.map((m) => m.id));
    const memories = day.coach.memoriesActive.filter((m) => !added.has(m.id));

    const lastKnown: Record<string, { title: string; summary: string | null; dayLabel: string }> = {};
    for (const p of priorities) {
      if (activities.some((a) => a.priorityId === p.id && a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)) continue;
      const lastDay = metrics[`recent.priority.${p.id}.last_day`];
      if (!lastDay?.range) continue;
      const source = earlier.find((d) => d.period.start === lastDay.range!.start);
      const last = source
        ? activitiesOf
            .get(source.dayNumber)!
            .filter((a) => a.priorityId === p.id && a.durationMinutes >= MEANINGFUL_ACTIVITY_MINUTES)
            .sort((a, b) => (a.endedAt < b.endedAt ? -1 : 1))
            .pop()
        : undefined;
      if (last) lastKnown[p.id] = { title: last.title, summary: last.summary, dayLabel: lastDay.display };
    }

    const nowIso = report.createdAt;
    const situations = buildSituations({ priorities, activities, metrics, recentDays, actions });
    const measured = detectOpportunities({
      activities,
      metrics,
      priorities,
      memories,
      openLoopsSince: new Date(Date.parse(nowIso) - config.openLoopSignalMs).toISOString(),
      lastKnown,
      situations,
    });
    const signals = orderSignals(withRecord(measured, { actions, priorities, nowIso, config, reasonLabel: (code) => REASON_LABELS[code] }));
    return { dayNumber: day.dayNumber, date: day.date, replayed: true, situations, signals };
  });
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');

/** The replayed board, day by day: what was a candidate, and what the record already covered. */
export function renderReplay(days: ReplayedDay[], priorityText: (id: string) => string): string {
  const lines = ['# Coach measurement layer — replayed', '', 'What Reflect itself measured each day, before the model was asked anything. Candidates first; then what the record already covered.', ''];
  for (const day of days) {
    lines.push(`## Day ${day.dayNumber} — ${day.date}`, '');
    if (!day.replayed) {
      lines.push('_No report was stored for this day; nothing to replay._', '');
      continue;
    }
    const row = (s: CoachOpportunity) =>
      `| ${s.kind} | ${s.strength} | ${s.confidence ?? ''} | ${s.priorityId ? cell(priorityText(s.priorityId)) : '—'} | ${cell(s.item ?? '—')} | ${s.days ?? ''} | ${cell(s.record ? `${s.record.standing}: ${s.record.note}` : '')} |`;
    const candidates = day.signals.filter((s) => !s.record?.settled);
    const covered = day.signals.filter((s) => s.record?.settled);
    lines.push('| Signal | Strength | Confidence | Priority | Item | Days | Record |', '| --- | --- | --- | --- | --- | --- | --- |', ...candidates.map(row));
    if (candidates.length === 0) lines.push('| _none_ | | | | | | |');
    if (covered.length > 0) lines.push('', '_Already covered by the record:_', '', '| Signal | Strength | Confidence | Priority | Item | Days | Record |', '| --- | --- | --- | --- | --- | --- | --- |', ...covered.map(row));
    lines.push('');
  }
  return lines.join('\n');
}
