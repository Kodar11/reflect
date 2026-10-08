import { RotateCcw, Trash2, X } from 'lucide-react';
import type { EventPrivacyTarget } from '../../components/EventPrivacy';
import { fmtTime, humanDuration } from './activityUtils';

interface HiddenEventsPanelProps {
  events: HiddenEventDto[];
  onRestore: (eventId: number) => void;
  onDelete: (target: EventPrivacyTarget) => void;
  onClose: () => void;
}

/**
 * Events the user has hidden. They are kept so they can be restored, and are
 * part of nothing else in Reflect — this list is the only place they appear.
 */
export function HiddenEventsPanel({ events, onRestore, onDelete, onClose }: HiddenEventsPanelProps) {
  return (
    <section className="card rounded-xl border border-default mb-3" aria-label="Hidden events">
      <div className="card-section border-b border-default bg-secondary py-2 px-4 flex items-center justify-between gap-3">
        <div className="text-[12px] text-muted">
          Hidden events are left out of your timeline, activities, reflections, coaching and exports. Restore one to bring it back, or delete it for
          good.
        </div>
        <button type="button" className="btn btn-ghost p-1" title="Close" aria-label="Close hidden events" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {events.length === 0 ? (
        <div className="px-4 py-5 text-[12.5px] text-muted">No hidden events.</div>
      ) : (
        <ul className="overflow-auto" style={{ maxHeight: 220 }}>
          {events.map((e) => {
            const started = new Date(e.startedAt);
            const label = [e.app, e.title].filter(Boolean).join(' · ') || 'Untitled event';
            return (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2 border-b border-default text-[12.5px]">
                <span className="text-muted font-mono whitespace-nowrap">
                  {started.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {fmtTime(started)}
                </span>
                <span className="text-muted font-mono whitespace-nowrap">{humanDuration(new Date(e.endedAt).getTime() - started.getTime())}</span>
                <span className="flex-1 min-w-0 truncate text-default" title={label}>
                  {label}
                </span>
                <button type="button" className="btn btn-ghost text-[12px]" onClick={() => onRestore(e.id)}>
                  <RotateCcw size={13} />
                  <span>Restore</span>
                </button>
                <button type="button" className="btn btn-ghost p-1" title="Delete permanently" aria-label="Delete permanently" onClick={() => onDelete({ id: e.id, label })}>
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
