import { ArrowUpRight } from 'lucide-react';
import {
  FEEDBACK_OPTIONS,
  INSIGHT_TYPE_LABELS,
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

interface InsightCardProps {
  insight: ReflectionInsightDto;
  period: ReflectionPeriodDto;
  onFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) => void;
  onViewTimeline: (target: TimelineTarget) => void;
  /** Hide the type label when the section it sits in already says it. */
  hideLabel?: boolean;
}

/** One insight: what was observed, what it shows, why it matters — then its evidence. */
export function InsightCard({ insight, period, onFeedback, onViewTimeline, hideLabel }: InsightCardProps) {
  return (
    <article className="reflection-insight" data-insight-type={insight.type}>
      {!hideLabel && <div className="reflection-eyebrow">{INSIGHT_TYPE_LABELS[insight.type] ?? 'Insight'}</div>}
      <h3 className={`text-[17px] font-semibold text-default leading-snug ${hideLabel ? '' : 'mt-1.5'}`}>{insight.title}</h3>
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

      {/* "That wasn't what I was doing": the fix belongs in the Timeline, where it also teaches Reflect. */}
      {insight.feedback === 'inaccurate' && (
        <p className="text-[12.5px] text-muted mt-2">
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
      )}
    </article>
  );
}
