import { ArrowUpRight } from 'lucide-react';
import {
  CONTINUITY_LABELS,
  FEEDBACK_OPTIONS,
  INSIGHT_TYPE_LABELS,
  evidenceWhere,
  nextFeedback,
  timelineTargetFor,
  type TimelineTarget,
} from './reflectionView';

interface EvidenceListProps {
  evidence: ReflectionEvidenceDto[];
  period: ReflectionPeriodDto;
  onViewTimeline: (target: TimelineTarget) => void;
}

/**
 * "Why did Reflect tell me this?" — the measurements and activities behind a
 * statement, each one a link into the Timeline. Collapsed by default so the
 * narrative stays readable.
 */
export function EvidenceList({ evidence, period, onViewTimeline }: EvidenceListProps) {
  if (evidence.length === 0) return null;
  return (
    <details className="reflection-evidence">
      <summary>
        Evidence <span className="text-faint">· {evidence.length}</span>
      </summary>
      <ul className="mt-2 space-y-1.5">
        {evidence.map((item, index) => (
          <li key={`${item.metricKey ?? item.activityId ?? item.priorityId ?? 'e'}-${index}`} className="reflection-evidence-row">
            <span className="min-w-0">
              <span className="text-muted">{item.label}</span>
              {item.value !== undefined && item.value !== null && (
                <span className="text-default font-semibold"> — {String(item.value)}</span>
              )}
              {/* Where it comes from: the days the evidence is actually about. */}
              {evidenceWhere(item, period) && <span className="text-faint"> · {evidenceWhere(item, period)}</span>}
            </span>
            {item.kind !== 'priority' || item.metricKey ? (
              <button
                type="button"
                className="reflection-link shrink-0"
                onClick={() => onViewTimeline(timelineTargetFor(item, period))}
              >
                View in timeline
                <ArrowUpRight size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * What the page knows about how the activities behind "not accurate" insights
 * are linked, and how to correct a link. State lives in the page; the card
 * only renders it.
 */
export interface InsightCorrectionController {
  /** The activities the insight rests on, as they are linked now; `undefined` while unknown. */
  basisOf(insightId: string): ReflectionInsightBasisDto[] | undefined;
  /** `<insightId>:<evidenceIndex>` of the links the user removed in this visit. */
  unlinked: ReadonlySet<string>;
  busyKey: string | null;
  onUnlink(insight: ReflectionInsightDto, row: ReflectionInsightBasisDto): void;
}

/**
 * "Not accurate" is where a reading gets corrected. Each activity the insight
 * rests on is shown as Reflect links it NOW; a wrong link is fixed here (it
 * then holds for every activity of that kind, and the model never overwrites
 * it), a wrong classification on the Timeline. Reflections read both.
 */
function InsightCorrection({
  insight,
  period,
  correction,
  onViewTimeline,
}: {
  insight: ReflectionInsightDto;
  period: ReflectionPeriodDto;
  correction?: InsightCorrectionController | null;
  onViewTimeline: (target: TimelineTarget) => void;
}) {
  const basis = correction?.basisOf(insight.id) ?? [];
  return (
    <div className="text-[12.5px] text-muted mt-2 space-y-1.5">
      {basis.map((row) => {
        const key = `${insight.id}:${row.evidenceIndex}`;
        const unlinked = correction!.unlinked.has(key);
        return (
          <div key={row.evidenceIndex} className="reflection-evidence-row" data-testid="insight-basis">
            <span className="min-w-0">
              <span className="text-default">{row.title}</span>
              {row.thread && <span> · project “{row.thread}”</span>}
              {row.priority && !unlinked && (
                <span>
                  {' '}
                  · counted toward “{row.priority.text}”{row.linkedBy === 'user' ? ' (your correction)' : ''}
                </span>
              )}
              {unlinked && <span> · no longer counted toward that priority</span>}
            </span>
            {row.priority && !unlinked && (
              <button type="button" className="reflection-link shrink-0" disabled={correction!.busyKey === key} onClick={() => correction!.onUnlink(insight, row)}>
                Not work on that priority
              </button>
            )}
          </div>
        );
      })}
      <p>
        If an activity was misread,{' '}
        <button
          type="button"
          className="reflection-link"
          onClick={() => onViewTimeline(timelineTargetFor(insight.evidence.find((e) => e.kind === 'activity') ?? null, period))}
        >
          correct it in the timeline
        </button>{' '}
        — the next reflection will use your correction.
      </p>
    </div>
  );
}

interface InsightCardProps {
  insight: ReflectionInsightDto;
  period: ReflectionPeriodDto;
  /** How the activities behind a disputed insight are linked, and how to correct that. */
  correction?: InsightCorrectionController | null;
  onFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) => void;
  onViewTimeline: (target: TimelineTarget) => void;
  /** Hide the type label when the section it sits in already says it. */
  hideLabel?: boolean;
}

/** One insight: what was observed, what it shows, why it matters — then its evidence. */
export function InsightCard({ insight, period, correction, onFeedback, onViewTimeline, hideLabel }: InsightCardProps) {
  // What it is about, and whether Reflect has said it before.
  const about = [insight.priority ? `Priority: ${insight.priority.text}` : null, insight.thread ? `Project: ${insight.thread}` : null].filter(Boolean);
  const continuity = insight.continuity ? CONTINUITY_LABELS[insight.continuity] : null;
  return (
    <article className="reflection-insight" data-insight-type={insight.type} data-continuity={insight.continuity}>
      {!hideLabel && (
        <div className="reflection-eyebrow">
          {INSIGHT_TYPE_LABELS[insight.type] ?? 'Insight'}
          {continuity ? ` · ${continuity}` : ''}
        </div>
      )}
      <h3 className={`text-[17px] font-semibold text-default leading-snug ${hideLabel ? '' : 'mt-1.5'}`}>{insight.title}</h3>
      {(about.length > 0 || (hideLabel && continuity)) && (
        <div className="text-[12.5px] text-faint mt-1">{[hideLabel ? continuity : null, ...about].filter(Boolean).join(' · ')}</div>
      )}
      <p className="reflection-prose text-default mt-2">
        {insight.observation} {insight.interpretation}
      </p>
      {insight.relevance && <p className="reflection-prose text-muted mt-1.5">{insight.relevance}</p>}

      {/* Evidence toggle and feedback share one quiet line; opened evidence takes the full width below it. */}
      <div className="reflection-insight-footer">
        <EvidenceList evidence={insight.evidence} period={period} onViewTimeline={onViewTimeline} />
        <div className="reflection-feedback" role="group" aria-label="Was this insight useful?">
          {FEEDBACK_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={insight.feedback === option.value}
              onClick={() => onFeedback(insight.id, nextFeedback(insight.feedback, option.value))}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* "That wasn't what I was doing": the fix goes where the reading came from, and teaches Reflect. */}
      {insight.feedback === 'inaccurate' && <InsightCorrection insight={insight} period={period} correction={correction} onViewTimeline={onViewTimeline} />}
    </article>
  );
}
