import { useRef } from 'react';
import { Check } from 'lucide-react';
import { summaryView } from './focusView';
import { useDialog } from './useDialog';

interface FocusSummaryModalProps {
  summary: FocusSummaryDto;
  onClose: () => void;
}

/** The summary itself: what was planned and what happened — nothing more. */
export function FocusSummaryView({ summary, onClose }: FocusSummaryModalProps) {
  const view = summaryView(summary.session);
  const fulfilled = view.title === 'Focus complete';

  return (
    <div className="focus-summary">
      {fulfilled && (
        <div className="focus-summary-mark" aria-hidden="true">
          <Check size={22} strokeWidth={2.5} />
        </div>
      )}
      <div id="focus-summary-title" className="focus-summary-title">
        {view.title}
      </div>
      <div className="focus-task" title={view.task}>
        {view.task}
      </div>
      <div className="focus-summary-lines">
        {view.lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <div className="focus-meta" title={summary.profile.name}>
        {summary.profile.name}
      </div>
      <div className="focus-actions" style={{ maxWidth: 220, marginTop: 6 }}>
        <button type="button" className="focus-btn" data-variant="primary" autoFocus onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * A calm conclusion. No scores, charts or commentary: Focus's job is done,
 * and analysis belongs to Reflection.
 */
export function FocusSummaryModal({ summary, onClose }: FocusSummaryModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);

  return (
    <div
      className="focus-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="focus-dialog" role="dialog" aria-modal="true" aria-labelledby="focus-summary-title" style={{ padding: '32px 28px' }}>
        <FocusSummaryView summary={summary} onClose={onClose} />
      </div>
    </div>
  );
}
