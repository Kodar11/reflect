import { useState } from 'react';
import { Play, Pause, Square } from 'lucide-react';
import type { UseFocusResult } from './useFocus';
import { formatClock } from './useFocus';

interface ActiveSessionCardProps {
  session: NonNullable<UseFocusResult['activeSession']>;
  onPause: UseFocusResult['pause'];
  onResume: UseFocusResult['resume'];
  onStop: UseFocusResult['stop'];
}

export function ActiveSessionCard({ session, onPause, onResume, onStop }: ActiveSessionCardProps) {
  const [showPauseMenu, setShowPauseMenu] = useState(false);
  const isOver = session.remainingMs !== null && session.remainingMs <= 0;
  const displayMs = isOver ? session.liveElapsedMs : (session.remainingMs ?? session.liveElapsedMs);
  const label = isOver ? 'Over' : session.remainingMs !== null ? 'Remaining' : 'Elapsed';
  const isRunning = session.isRunning;

  return (
    <div className="card p-6 flex flex-col items-center text-center gap-5 h-full">
      <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide text-accent">
        <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
        {isRunning ? 'Focusing' : 'Paused'}
      </div>

      <div>
        <div className="text-[16px] font-semibold text-default mb-1">{session.session.task}</div>
        <div className="text-[13px] text-muted">{session.profile.name}</div>
      </div>

      <div className="flex flex-col items-center">
        <div className="text-[56px] font-extrabold tracking-tight text-default font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatClock(displayMs)}
        </div>
        <div className="text-[12px] font-bold uppercase tracking-wider text-muted">{label}</div>
      </div>

      <div className="flex gap-3 w-full max-w-sm">
        {isRunning ? (
          <div className="flex-1 relative">
            <button
              onClick={() => setShowPauseMenu((v) => !v)}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-md border border-default bg-secondary text-default font-semibold text-[13px]"
            >
              <Pause size={15} /> Pause
            </button>
            {showPauseMenu && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-elevated border border-default rounded-lg shadow-lg p-2 space-y-1 z-10">
                {PAUSE_REASONS.map((reason) => (
                  <button
                    key={reason}
                    onClick={() => { onPause(reason); setShowPauseMenu(false); }}
                    className="w-full text-left px-3 py-2 rounded-md text-[12px] text-muted hover:bg-accent-soft hover:text-accent transition-colors"
                  >
                    {reason}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => onResume()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md border border-default bg-accent-soft text-accent font-semibold text-[13px]"
          >
            <Play size={15} /> Resume
          </button>
        )}
        <button
          onClick={() => onStop('completed')}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md font-semibold text-[13px]"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          <Square size={15} /> Stop
        </button>
      </div>

      <div className="w-full pt-4 border-t border-default text-left space-y-2">
        <div className="text-[12px] font-bold text-muted uppercase tracking-wide">Status</div>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: session.profile.blocksDistractions ? 'var(--success)' : 'var(--text-faint)' }} />
          {session.profile.blocksDistractions ? 'Blocking active' : 'Blocking disabled'}
        </div>
        <div className="text-[13px] text-muted">
          Started {new Date(session.session.startedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        {session.session.notes && (
          <div className="text-[13px] text-muted bg-secondary p-3 rounded-md border border-default">
            {session.session.notes}
          </div>
        )}
      </div>
    </div>
  );
}

const PAUSE_REASONS = ['Quick break', 'Phone call', 'Meeting', 'Distraction', 'Other'];
